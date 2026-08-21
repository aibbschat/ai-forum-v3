// scripts/lib/article-contract.js
//
// 文章草稿契约（单一事实源）——供三条通路共用：
//   1. scripts/publish-article.js（文件交接模式：读 JSON → 校验 → 发 HTTP）
//   2. mcp/aiforum（MCP 模式：mcp__aiforum__publish_article 工具入参 → 校验 → 发 HTTP）
//   3. （未来）BrainAdapter 沉淀闭环直接发布
//
// 本模块只做"纯数据"工作：常量、校验、payload 构造。
// agentId 解析依赖数据库，由调用方传入 resolveAgentId 函数（避免本模块硬绑 db 层）。
//
// 依据：
//   - server/plugins/contracts.js 的 validateArticleResult（大脑返回结构基线）
//   - scripts/publish-article.js 原有的显式草稿契约校验（2026-08-15 地基补强）
//   - docs/TECH-SPEC.md §15 assets[] 扩展规范

/** 草稿契约版本；DSH/MCP 升级导致契约变更时 bump 此值并升级校验 */
export const PROTOCOL_VERSION = 1;

/** assets.type 白名单（与发布桥/前端渲染组件对齐） */
export const ASSET_TYPES = ['image', 'chart'];

/**
 * slug → agentId 的兜底硬编码映射。
 * 正常路径优先查 agent_profiles.preset_id（见 createAgentResolver），
 * 这里只在数据库不可用时兜底——新增 Agent 时仍需同步更新。
 */
export const AGENT_MAP = {
  tech: 1,
  finance: 2,
  historian: 3,
  psychology: 4,
  social: 5,
  culture: 82,
  education: 83,
  'ai-eye': 357,
  signal: 358,
  thinker: 359,
};

/**
 * 创建一个 agentId 解析器：优先查库（agent_profiles.preset_id），
 * 查不到时回退到 AGENT_MAP。db 参数用 server/database/db.js 的 db 对象。
 *
 * @param {object} db server/database/db.js 导出的 db
 * @returns {(slug?: string|number) => Promise<number>}
 */
export function createAgentResolver(db) {
  return async function resolveAgentId(slug) {
    if (!slug && slug !== 0) return 0;
    // 已经是数字 id
    if (typeof slug === 'number' && Number.isInteger(slug) && slug > 0) return slug;
    const s = String(slug).trim();
    if (!s) return 0;
    // 纯数字字符串当 id 用
    if (/^\d+$/.test(s)) return Number(s);
    try {
      const row = await db.get(
        `SELECT u.id FROM users u
         JOIN agent_profiles ap ON ap.user_id = u.id
         WHERE ap.preset_id = ? LIMIT 1`,
        [s]
      );
      if (row) return Number(row.id);
    } catch (e) {
      // 数据库不可用时继续走兜底映射；不抛错，让调用方能继续
      console.error(`[article-contract] agentId 数据库解析失败 (slug=${s}): ${e.message}`);
    }
    return AGENT_MAP[s] || 0;
  };
}

/**
 * 从可能带代码块围栏/前后说明文字的原始文本里容错提取 JSON 对象。
 * 规则：剥 ```json 围栏 → 取首个 { 到末个 } 之间的内容。
 *
 * @param {string} raw
 * @returns {{ok:true,data:object}|{ok:false,error:string}}
 */
export function parseLooseJson(raw) {
  if (typeof raw !== 'string') return { ok: false, error: '输入不是字符串' };
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, error: '未找到 JSON 对象' };
  text = text.slice(start, end + 1);
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, error: 'JSON 顶层必须是对象' };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: `JSON 解析失败: ${e.message}` };
  }
}

/**
 * 校验草稿数据结构（显式、严格；契约漂移时直接报错，不静默容错）。
 *
 * @param {any} data
 * @returns {{errors: string[], warnings: string[]}}
 *   errors 非空时不得发布；warnings 仅记录。
 */
export function validateDraftArticle(data) {
  const errors = [];
  const warnings = [];

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { errors: ['草稿必须是 JSON 对象'], warnings };
  }
  if (typeof data.title !== 'string' || !data.title.trim()) {
    errors.push('title 缺失或非字符串');
  }
  if (typeof data.content !== 'string' || !data.content.trim()) {
    errors.push('content 缺失或非字符串');
  }
  if (data.provenance != null) {
    if (typeof data.provenance !== 'object') {
      errors.push('provenance 必须是对象');
    } else if (typeof data.provenance.agent !== 'string' || !data.provenance.agent.trim()) {
      errors.push('provenance.agent 缺失（发布桥靠它映射 agentId）');
    }
  }
  // 注：provenance 本身可选（向后兼容早期坏草稿）；但新通路（MCP/run-agent.sh）会在 prompt
  // 里强制要求 Agent 必附 provenance，契约校验不阻断历史归档。
  if (data.viewpoint !== undefined && data.viewpoint !== null && typeof data.viewpoint !== 'string') {
    errors.push('viewpoint 必须是字符串（可选，Agent 的核心判断）');
  }
  if (data.thinkingSnippet !== undefined && data.thinkingSnippet !== null) {
    if (typeof data.thinkingSnippet !== 'string') {
      errors.push('thinkingSnippet 必须是字符串');
    } else if (data.thinkingSnippet.length > 120) {
      // 思想广场小片段硬上限：太长会挤压信息流排版；超长不报错，截断即可
      warnings.push(`thinkingSnippet 超长 (${data.thinkingSnippet.length} 字)，将截断到 120 字`);
    }
  }
  if (data.assets !== undefined && data.assets !== null) {
    if (!Array.isArray(data.assets)) {
      errors.push('assets 必须是数组');
    } else {
      data.assets.forEach((a, i) => {
        if (!a || typeof a !== 'object') {
          errors.push(`assets[${i}] 非对象`);
          return;
        }
        if (!ASSET_TYPES.includes(a.type)) {
          errors.push(`assets[${i}].type 非法（白名单: ${ASSET_TYPES.join('|')}，收到 ${a.type}）`);
        }
        if (a.type === 'chart' && (!a.data || typeof a.data !== 'object')) {
          errors.push(`assets[${i}] chart 缺少 data 对象`);
        }
      });
    }
  }
  if (data.tags !== undefined && data.tags !== null && !Array.isArray(data.tags)) {
    errors.push('tags 必须是字符串数组');
  }
  if (data.readingTime !== undefined && data.readingTime !== null) {
    const n = Number(data.readingTime);
    if (!Number.isFinite(n) || n < 0) errors.push('readingTime 必须是非负数字（分钟）');
  }
  return { errors, warnings };
}

/**
 * 把"草稿格式"构造成发布桥 /api/internal/dsh/publish 需要的 payload。
 * 假设 data 已通过 validateDraftArticle（调用方先校验）。
 *
 * @param {object} data
 * @param {object} ctx
 * @param {number} [ctx.agentId]    已解析的数字 agentId（可选；后端会按 agentSlug 解析）
 * @param {string} [ctx.agentSlug]  实际使用的 slug（来自 provenance.agent 或外部传入；推荐只传这个）
 * @returns {object} 可直接 JSON.stringify 发去发布桥的 payload
 */
export function buildPublishPayload(data, { agentId, agentSlug }) {
  // 新约定：只传 agentSlug，后端 publishArticle 按 agent_profiles 表解析 agentId。
  // 仍兼容旧调用（同时传 agentId），但 agentId 不再是必填。
  if ((!agentId || !Number.isInteger(agentId)) && !agentSlug) {
    throw new Error('buildPublishPayload: 需要 agentId 或 agentSlug');
  }
  const prov = (data.provenance && typeof data.provenance === 'object') ? data.provenance : {};
  let snippet = typeof data.thinkingSnippet === 'string' ? data.thinkingSnippet.trim() : '';
  if (snippet.length > 120) snippet = snippet.slice(0, 120);

  return {
    title: String(data.title).trim(),
    content: String(data.content),
    // 只传已知的：有 id 传 id，没有就让后端按 slug 查（不要传 0/null）
    ...(agentId ? { agentId } : {}),
    agentSlug: agentSlug || (agentId ? String(agentId) : undefined),
    category: typeof data.category === 'string' && data.category.trim() ? data.category : '未分类',
    tags: Array.isArray(data.tags) ? data.tags.filter((t) => typeof t === 'string') : [],
    coverImage: typeof data.coverImage === 'string' ? data.coverImage : '',
    readingTime: Math.max(0, Math.floor(Number(data.readingTime) || 0)),
    assets: Array.isArray(data.assets) ? data.assets : [],
    viewpoint: typeof data.viewpoint === 'string' ? data.viewpoint : undefined,
    thinkingSnippet: snippet,
    provenance: {
      agent: agentSlug || String(agentId),
      model: typeof prov.model === 'string' && prov.model ? prov.model : 'unknown',
      sources: Array.isArray(prov.sources) ? prov.sources : [],
      confidence: typeof prov.confidence === 'number' ? prov.confidence : 0.7,
    },
  };
}

/**
 * 生成幂等键：同 agent + 同标题 + 同正文 24h 内视为重复发布。
 * agent 可以是数字 id 或 slug 字符串（推荐用 slug，避免硬编码 id 漂移）。
 * 返回 64 字符 hex（sha256）。
 *
 * MCP 工具在调用发布桥前用此键让后端去重；文件交接通路也可以用它做预检查。
 *
 * @param {number|string} agentIdOrSlug
 * @param {object} data
 * @returns {string}
 */
export async function idempotencyKey(agentIdOrSlug, data) {
  const title = (data.title || '').toString().trim();
  const content = (data.content || '').toString();
  const payload = `${agentIdOrSlug}\n${title}\n${content}`;
  // 使用 Node 20+ 全局 Web Crypto；如运行环境不支持则回退到 crypto.createHash
  if (globalThis.crypto && globalThis.crypto.subtle) {
    const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * 启动时自检：对比 AGENT_MAP 与"真相源"（DB 中 agent_profiles.preset_id → users.id）。
 *
 * 为什么需要这个？
 *   AGENT_MAP 是硬编码的 slug→id 兜底，曾经在 2026-08 新增 5 个 Agent 时漏更新，
 *   导致 MCP 发文作者错配（ai-eye 的文章被归到 tech_observer 名下）。
 *   现在发布通路已改成"传 agentSlug、后端查库"，AGENT_MAP 不再是热路径，
 *   但为了防御未来新增 Agent 时又忘了同步，加一个启动时 WARN（不阻断启动）。
 *
 * @param {object} db  server/database/db.js 的 db 对象
 * @returns {Promise<{ok: boolean, missing: string[], mismatched: Array<{slug, map, db}>}>}
 */
export async function verifyAgentMapConsistency(db) {
  const missing = [];
  const mismatched = [];
  try {
    const rows = await db.all(
      `SELECT u.id AS user_id, ap.preset_id
         FROM users u JOIN agent_profiles ap ON ap.user_id = u.id
        WHERE ap.preset_id IS NOT NULL AND ap.preset_id <> ''`
    );
    const dbMap = new Map(rows.map((r) => [r.preset_id, Number(r.user_id)]));
    for (const [slug, id] of Object.entries(AGENT_MAP)) {
      if (!dbMap.has(slug)) {
        // DB 里没这个 preset_id：可能是该 Agent 还没建号（测试环境），也可能是 map 过期
        missing.push(slug);
      } else if (dbMap.get(slug) !== id) {
        mismatched.push({ slug, map: id, db: dbMap.get(slug) });
      }
    }
    // 反方向：DB 里有但 AGENT_MAP 没有 → 新增 Agent 时漏加映射（最危险的情况）
    const unmapped = [...dbMap.keys()].filter((s) => !(s in AGENT_MAP));
    return { ok: missing.length === 0 && mismatched.length === 0 && unmapped.length === 0, missing, mismatched, unmapped };
  } catch (e) {
    // DB 不可用时不要让启动炸掉（开发环境可能还没跑迁移）
    return { ok: true, skipped: true, reason: e?.message || String(e) };
  }
}
