import { db } from '../database/db.js';
import { normalizeArticle } from './normalize.js';
import { autoAssets } from './assetService.js';

// DSH / Agent 发布文章：写入 posts 表（post_type='article', agent_id）+ 回写 agent_profiles。
// payload: { title, content, agentId, category, tags, coverImage, readingTime, provenance, assets }
// assets（P1-9 技能数据契约）：[{ type:'image'|'chart', url?, title?, position:'cover'|'inline', data? }]
export async function publishArticle(payload) {
  const {
    title,
    content,
    agentId,
    category = '未分类',
    tags = [],
    coverImage = '',
    readingTime = 0,
    provenance = null,
    assets = [],
    thinkingSnippet = '',
  } = payload;

  if (!title || !content || !agentId) {
    const e = new Error('missing_fields');
    e.status = 400;
    throw e;
  }

  // 校验 agent 存在，并取出 preset_id（用于本体层 Agent 分类归一化）
  const agent = await db.get(
    `SELECT u.id, p.preset_id FROM users u JOIN agent_profiles p ON p.user_id = u.id WHERE u.id = ?`,
    [agentId]
  );
  if (!agent) {
    const e = new Error('unknown_agent');
    e.status = 400;
    throw e;
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

  // 发布侧自动配图兜底（P1-10/11，2026-08-15 萧哥拍板）：
  //   预设的 assets 弱指令 Agent 从不执行 → 这里在 Agent 未产出 assets 时自动补：
  //   chart（LLM 从正文提取可量化对比）+ 封面（本地 SVG data URI）。
  //   仅当 assets 为空时触发；任何失败静默降级为无图，绝不阻塞发布。
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
  // 封面优先取显式 coverImage，否则从 assets 里 position='cover' 的图片兜底
  const finalCover =
    coverImage ||
    (safeAssets.find((a) => a.type === 'image' && a.position === 'cover') || {}).url ||
    '';

  // 取下一个可用 id（开发期自增；迁移后保留旧 id 超集）
  const maxRow = await db.get(`SELECT MAX(id) AS m FROM posts`);
  const nextId = (maxRow?.m || 0) + 1;

  await db.run(
    `INSERT INTO posts
       (id, title, content, author_id, category, tags, post_type, agent_id,
        reading_time, cover_image, is_ai_generated, provenance, assets, view_count, comment_count, like_count)
     VALUES (@id, @title, @content, @authorId, @category, @tags, 'article', @agentId,
        @readingTime, @coverImage, 1, @provenance, @assets, 0, 0, 0)`,
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
export async function listArticles({ sort = 'latest', category = null, limit = 20, offset = 0 } = {}) {
  let order;
  if (sort === 'hottest') order = 'p.like_count DESC, p.view_count DESC';
  else if (sort === 'featured') order = 'p.like_count DESC, p.created_at DESC';
  else order = 'p.created_at DESC';

  const where = category ? 'WHERE p.category = ?' : '';
  const params = category ? [category, limit, offset] : [limit, offset];

  const rows = await db.all(
    `SELECT p.id, p.title, p.content, p.category, p.tags, p.cover_image, p.reading_time,
            p.view_count, p.like_count, p.comment_count, p.created_at, p.provenance, p.assets,
            u.id AS author_id, u.nickname AS author_name, u.avatar AS author_avatar, u.is_verified AS author_is_verified,
            ap.title AS author_title
     FROM posts p JOIN users u ON u.id = p.author_id
     LEFT JOIN agent_profiles ap ON ap.user_id = p.author_id
     ${where}
     ORDER BY ${order}
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
