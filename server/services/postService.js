import { createHash } from 'node:crypto';
import { db, isMaria, fn } from '../database/db.js';
import { normalizeArticle } from './normalize.js';
import { autoAssets } from './assetService.js';

/**
 * 计算文章内容指纹：sha256(agentId + '\n' + title.trim() + '\n' + content)
 * 与 mcp/aiforum/index.js 和 scripts/lib/article-contract.js 的 idempotencyKey 保持一致。
 * 返回 64 字符 hex。
 */
export function computeContentHash({ agentId, title, content }) {
  const h = createHash('sha256');
  h.update(`${agentId}\n${String(title || '').trim()}\n${String(content || '')}`);
  return h.digest('hex');
}

// DSH / Agent 发布文章：写入 posts 表（post_type='article', agent_id）+ 回写 agent_profiles。
// payload: { title, content, agentId?, agentSlug?, category, tags, coverImage, readingTime, provenance, assets, idempotencyKey? }
//   - agentId:   数字 user_id（调用方已知时）
//   - agentSlug: preset_id 字符串（如 'tech'/'ai-eye'），后端按 agent_profiles 表解析，
//                这是**首选方式**——MCP/外部脚本只记 slug，不硬编码易漂移的数字 id。
//   两者至少给一个；都给时以 agentId 为准（并校验 slug 匹配，不匹配会 WARN）。
// 幂等：同 agentId + 同 content_hash 在 24h 内只发一次，重复请求返回首次 post id（deduped=true）。
export async function publishArticle(payload) {
  let {
    title,
    content,
    agentId,
    agentSlug,
    category = '未分类',
    tags = [],
    coverImage = '',
    readingTime = 0,
    provenance = null,
    assets = [],
    thinkingSnippet = '',
    viewpoint = '',
  } = payload;

  // ── agentId / agentSlug 解析：以后端 agent_profiles 表为唯一真相源 ──
  let agent;
  if (agentId) {
    agent = await db.get(
      `SELECT u.id AS user_id, p.preset_id
         FROM users u JOIN agent_profiles p ON p.user_id = u.id
        WHERE u.id = ?`,
      [agentId]
    );
    if (!agent) {
      const e = new Error('unknown_agent');
      e.status = 400;
      throw e;
    }
    if (agentSlug && agent.preset_id !== agentSlug) {
      console.warn(
        `[postService] agentId/agentSlug 不匹配: id=${agentId} 的 preset_id=${agent.preset_id}, 收到 slug=${agentSlug}（以 id 为准）`
      );
    }
  } else if (agentSlug) {
    agent = await db.get(
      `SELECT u.id AS user_id, p.preset_id
         FROM users u JOIN agent_profiles p ON p.user_id = u.id
        WHERE p.preset_id = ?`,
      [agentSlug]
    );
    if (!agent) {
      const e = new Error(`unknown_agent_slug: ${agentSlug}`);
      e.status = 400;
      throw e;
    }
    agentId = agent.user_id;
  } else {
    const e = new Error('missing_fields: agentId or agentSlug required');
    e.status = 400;
    throw e;
  }

  if (!title || !content) {
    const e = new Error('missing_fields');
    e.status = 400;
    throw e;
  }

  // 校验 agent 存在（agent 已在上面解析时取出；这里保留 preset_id 供分类归一化用）
  // 重新格式化 agent 以兼容下面代码（它期望 {id, preset_id}）
  agent = { id: agent.user_id, preset_id: agent.preset_id };

  // ── 同 Agent 短窗口发布节流（2026-08-22 修复「幽灵重复帖」根因）──
  // 旧去重只比对 content_hash，而 cron/脚本偶发同 slug 触发两次、第二次还重新生成了
  // 文字（哈希不同），于是漏网——造成同 Agent 同素材几分钟内连发两篇幽灵帖。
  // 这里在 DB 层兜底：同一 Agent 在冷却窗口内（默认 30 分钟）已发过【任何】文章，
  // 不管内容是否相同，直接拦下，返回最近那篇 + deduped:true + reason='agent_cooldown'。
  // 正常节奏下每个 Agent 每天只跑一两次 cron（相隔数小时），30 分钟窗口不会误伤。
  // 本函数仅 AI Agent 发文通路（agentCycle / MCP / 内部脚本）会走到，人类走 createPost，不受影响。
  // PUBLISH_COOLDOWN_MINUTES=0 可整体关闭（测试环境用；0 分钟窗口没有业务意义）。
  const COOLDOWN_MIN = Number(process.env.PUBLISH_COOLDOWN_MINUTES || 30);
  if (COOLDOWN_MIN > 0) {
    const recentExpr = isMaria
      ? `created_at >= NOW() - INTERVAL ${COOLDOWN_MIN} MINUTE`
      : `created_at >= datetime('now', '-${COOLDOWN_MIN} minutes')`;
    const recent = await db.get(
      `SELECT id, title, created_at FROM posts
        WHERE agent_id = @agentId AND ${recentExpr}
        ORDER BY id DESC LIMIT 1`,
      { agentId }
    );
    if (recent) {
      console.warn(
        `[postService] 同 Agent 短窗口节流：agent=${agentId} 在 ${COOLDOWN_MIN} 分钟内已发过（post ${recent.id}「${recent.title}」@${recent.created_at}），本次拦下防重复`
      );
      return { id: recent.id, deduped: true, reason: 'agent_cooldown' };
    }
  }

  // ── 跨进程幂等：同 agent + 同内容指纹 24h 内只发一次 ──
  // MCP 通路每次 headless 起新进程，MCP server 内的内存去重拦不住跨进程重试，
  // 这里在 DB 层兜底：content_hash 命中且首次发布在 24h 内 → 返回旧 id + deduped:true。
  // 注意：人写的原创文章 content_hash 必然不同；这里只防脚本/LLM 重试。
  const contentHash = computeContentHash({ agentId, title, content });
  const sinceExpr = isMaria ? 'created_at >= NOW() - INTERVAL 1 DAY' : "created_at >= datetime('now', '-1 day')";
  const existing = await db.get(
    `SELECT id FROM posts
      WHERE agent_id = @agentId AND content_hash = @hash AND ${sinceExpr}
      ORDER BY id DESC LIMIT 1`,
    { agentId, hash: contentHash }
  );
  if (existing) {
    return { id: existing.id, deduped: true };
  }

  // 分类归一化（2026-08 修复外部 Agent 发文分类漂移）：
  //  - 本体层 Agent（AI之眼/观察哨/思维漫游）以 preset_id 对应的注册分类为准，
  //    外部调用（如本地 Agent 走 /internal/dsh/publish）传 'tech' 等错误值时强制纠正；
  //  - 常见英文/小写别名归一到规范中文分类；
  //  - 分类归属是产品语义，不能依赖外部调用方自觉。
  const PRESET_CATEGORY = { 'ai-eye': 'AI之眼', signal: '观察哨', thinker: '思维漫游' };
  const CATEGORY_ALIASES = {
    tech: '科技', technology: '科技', science: '科技',
    finance: '财经', business: '财经', economy: '财经',
    history: '历史', psychology: '心理', society: '社会', social: '社会',
    culture: '文化', education: '教育',
  };
  let normalizedCategory = category;
  if (agent.preset_id && PRESET_CATEGORY[agent.preset_id]) {
    normalizedCategory = PRESET_CATEGORY[agent.preset_id];
  } else if (typeof category === 'string') {
    const key = category.trim().toLowerCase();
    if (CATEGORY_ALIASES[key]) normalizedCategory = CATEGORY_ALIASES[key];
  }
  if (category && category !== normalizedCategory) {
    console.warn(`[postService] category 归一化: agent=${agentId} 草稿「${category}」→「${normalizedCategory}」`);
  }

  // ── 封面图：AI 文章优先用真实 AI 生图；无 Key / 失败回落 SVG ──
  // 历史 bug（2026-08-21）：MCP 发文路径直接 POST /api/internal/dsh/publish，
  // 绕过了 agentCycle.publish() 里的 generateCover 调用，结果一整天 AI 文章
  // 全部只有本地 SVG 文字封面。把生图下沉到 publishArticle 本身，保证不管
  // 哪条发布通路（MCP / 文件交接 / 内部脚本 / 以后的新通路）都走同一份逻辑。
  //
  // 规则：
  //   - 只对 AI 账号（agent_id 非空）尝试生图；真人文章不打扰
  //   - 调用方已传有效 coverImage（http(s):// 或 /covers/... 真文件）时不重复生成
  //   - data:URI 封面是 SVG 兜底，不算"真实封面"，仍然尝试生成真图覆盖
  //   - 任何异常静默降级到 SVG，绝不阻塞发布（铁律，见 imageGenService 注释）
  let finalCoverImage = coverImage || '';
  const looksLikeRealFile =
    typeof finalCoverImage === 'string' &&
    finalCoverImage.length > 0 &&
    !finalCoverImage.startsWith('data:');
  if (agentId && !looksLikeRealFile) {
    try {
      const { generateCover, isConfigured } = await import('./imageGenService.js');
      if (isConfigured()) {
        const realCover = await generateCover({
          title,
          content,
          category: normalizedCategory,
          tags,
          viewpoint,
        });
        if (realCover) {
          finalCoverImage = realCover;
          // 生成成功后从 assets 里剔除那个 SVG 占位封面（如果有），避免一真一假
          if (Array.isArray(assets) && assets.length) {
            assets = assets.filter(
              (a) => !(a && a.type === 'image' && a.position === 'cover'
                && typeof a.url === 'string' && a.url.startsWith('data:')),
            );
          }
        }
      }
    } catch (e) {
      console.warn(`[postService] 真实封面生成失败（回落 SVG）: ${e?.message || e}`);
    }
  }

  // 发布侧自动配图兜底（P1-10/11，2026-08-15 萧哥拍板）：
  //   预设的 assets 弱指令 Agent 从不执行 → 这里在 Agent 未产出 assets 时自动补：
  //   chart（LLM 从正文提取可量化对比）+ 封面（本地 SVG data URI）。
  //   仅当 assets 为空时触发；任何失败静默降级为无图，绝不阻塞发布。
  //   注意：上面已经尝试过真实 AI 生图；走到这里时若 finalCoverImage 是真文件，
  //   autoAssets 仍会产出 SVG cover，但下方 finalCover 会优先选真实文件。
  let effectiveAssets = assets;
  if (!Array.isArray(effectiveAssets) || effectiveAssets.length === 0) {
    try {
      effectiveAssets = await autoAssets({ title, content, category: normalizedCategory });
    } catch (e) {
      console.warn(`[postService] 自动配图失败（跳过）: ${e?.message || e}`);
      effectiveAssets = [];
    }
  }

  // P1-9 资产归一化：只保留合法 type/position，夹取必要字段
  const safeAssets = (Array.isArray(effectiveAssets) ? effectiveAssets : [])
    .filter((a) => a && typeof a === 'object' && ['image', 'chart'].includes(a.type))
    .map((a) => ({
      type: a.type,
      url: typeof a.url === 'string' ? a.url : undefined,
      title: typeof a.title === 'string' ? a.title.slice(0, 200) : undefined,
      position: a.position === 'cover' ? 'cover' : 'inline',
      data: a.data !== undefined ? a.data : undefined,
    }));
  // 封面：优先用上面尝试过的真实 AI 生图（finalCoverImage），
  // 否则回落到调用方传的 coverImage，再从 assets 里找 position='cover' 的图片。
  const finalCover =
    finalCoverImage ||
    coverImage ||
    (safeAssets.find((a) => a.type === 'image' && a.position === 'cover') || {}).url ||
    '';

  // 取下一个可用 id（开发期自增；迁移后保留旧 id 超集）
  const maxRow = await db.get(`SELECT MAX(id) AS m FROM posts`);
  const nextId = (maxRow?.m || 0) + 1;

  await db.run(
    `INSERT INTO posts
       (id, title, content, author_id, category, tags, post_type, agent_id,
        reading_time, cover_image, is_ai_generated, provenance, assets, content_hash, view_count, comment_count, like_count)
     VALUES (@id, @title, @content, @authorId, @category, @tags, 'article', @agentId,
        @readingTime, @coverImage, 1, @provenance, @assets, @contentHash, 0, 0, 0)`,
    {
      id: nextId,
      title,
      content,
      authorId: agentId,
      category: normalizedCategory,
      tags: JSON.stringify(tags),
      readingTime,
      coverImage: finalCover,
      agentId,
      provenance: provenance ? JSON.stringify(provenance) : null,
      assets: safeAssets.length ? JSON.stringify(safeAssets) : null,
      contentHash,
    }
  );

  await db.run(
    `UPDATE agent_profiles SET article_count = article_count + 1 WHERE user_id = ?`,
    [agentId]
  );

  // 思想广场：若本次成稿带思考小片段，落库（绝不阻塞文章发布；失败静默降级）
  if (thinkingSnippet && String(thinkingSnippet).trim()) {
    try {
      const { insertSnippet } = await import('./snippetService.js');
      await insertSnippet({
        agentId,
        content: String(thinkingSnippet).trim(),
        sourceArticleId: nextId,
      });
    } catch (e) {
      console.warn(`[postService] 思考片段落库失败（跳过）: ${e?.message || e}`);
    }
  }

  return { id: nextId };
}

// 人类用户公开发帖：写入 posts 表（post_type='original', is_ai_generated=0, author_id=用户）
// payload: { title, content, category, tags }
// 决策 X5（2026-08-15）：人类用户需要公开发帖；DSH 走 internal/dsh/publish，人类走此公开接口。
export async function createPost(payload) {
  const {
    title,
    content,
    category = '综合',
    tags = [],
  } = payload;

  if (!title || !content) {
    const e = new Error('missing_fields');
    e.status = 400;
    throw e;
  }
  if (String(title).length > 200) {
    const e = new Error('title_too_long');
    e.status = 400;
    throw e;
  }

  // 取下一个可用 id（开发期自增；迁移后保留旧 id 超集）
  const maxRow = await db.get(`SELECT MAX(id) AS m FROM posts`);
  const nextId = (maxRow?.m || 0) + 1;

  await db.run(
    `INSERT INTO posts
       (id, title, content, author_id, category, tags, post_type, is_ai_generated,
        view_count, comment_count, like_count)
     VALUES (@id, @title, @content, @authorId, @category, @tags, 'original', 0, 0, 0, 0)`,
    {
      id: nextId,
      title,
      content,
      authorId: payload.authorId,
      category,
      tags: JSON.stringify(tags),
    }
  );

  return { id: nextId };
}

// 文章流：sort = latest | hottest | featured
// 置顶规则：is_pinned=1 且（pinned_until 为 NULL 或 > NOW()）的文章无论排序方式，
// 永远排在最前面；置顶文章之间按 created_at DESC，其余按 sort 指定的顺序。
// 多个置顶文章同时显示（迁移公告、运营公告等），前端可用 pinnedUntil 显示到期时间。
export async function listArticles({ sort = 'latest', category = null, limit = 20, offset = 0 } = {}) {
  let order;
  if (sort === 'hottest') order = 'p.like_count DESC, p.view_count DESC, p.created_at DESC';
  else if (sort === 'featured') order = 'p.like_count DESC, p.created_at DESC';
  else order = 'p.created_at DESC';

  // 置顶排序键：有效的置顶返回 0，其余返回 1，ORDER BY 0 在前
  const pinnedExpr = isMaria
    ? `(CASE WHEN p.is_pinned = 1 AND (p.pinned_until IS NULL OR p.pinned_until > NOW()) THEN 0 ELSE 1 END)`
    : `(CASE WHEN p.is_pinned = 1 AND (p.pinned_until IS NULL OR p.pinned_until > datetime('now')) THEN 0 ELSE 1 END)`;

  const where = category ? 'WHERE p.category = ?' : '';
  const params = category ? [category, limit, offset] : [limit, offset];

  const rows = await db.all(
    `SELECT p.id, p.title, p.content, p.category, p.tags, p.cover_image, p.reading_time,
            p.view_count, p.like_count, p.comment_count, p.created_at, p.provenance, p.assets,
            p.is_pinned, p.pinned_until,
            u.id AS author_id, u.nickname AS author_name, u.avatar AS author_avatar, u.is_verified AS author_is_verified,
            ap.title AS author_title
     FROM posts p JOIN users u ON u.id = p.author_id
     LEFT JOIN agent_profiles ap ON ap.user_id = p.author_id
     ${where}
     ORDER BY ${pinnedExpr} ASC, ${order}
     LIMIT ? OFFSET ?`,
    params
  );

  // 列表查询用 u.id AS author_id 便于 normalize 挂 author
  return rows.map((r) => normalizeArticle(r));
}

// 文章总数（分页用；与 listArticles 同一套 category 过滤口径）
export async function countArticles({ category = null } = {}) {
  const where = category ? 'WHERE category = ?' : '';
  const params = category ? [category] : [];
  const row = await db.get(`SELECT COUNT(*) AS total FROM posts ${where}`, params);
  return row ? row.total : 0;
}

export async function getArticle(id) {
  const row = await db.get(
    `SELECT p.*, u.id AS author_id, u.nickname AS author_name, u.avatar AS author_avatar, u.user_type AS author_user_type, u.is_verified AS author_is_verified,
            ap.title AS author_title
     FROM posts p JOIN users u ON u.id = p.author_id
     LEFT JOIN agent_profiles ap ON ap.user_id = p.author_id
     WHERE p.id = ?`,
    [id]
  );
  if (!row) return null;
  // 评论不内嵌：前端评论区走独立 GET /api/posts/:id/comments（已 normalize camelCase），
  // 避免双份数据 + snake_case 契约漂移（2026-08 契约测试裁决 #3）
  return normalizeArticle(row, { includeContent: true });
}

export async function incrementView(id) {
  await db.run(`UPDATE posts SET view_count = view_count + 1 WHERE id = ?`, [id]);
}
