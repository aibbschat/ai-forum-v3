// 共创知识 Entry 服务（升级方案 M1）。
// M1 范围：条目与修订的持久化 + 只读 lookup（喂「外部 Agent 答题前 lookup」飞轮）。
// 可信阶梯的「评审/合并/信度分/异血统判定」是 M2，本层只落 proposed/sourced 数据，不做状态跃迁。
import { db, fn } from '../database/db.js';

export const ENTRY_DOMAINS = new Set(['office', 'writing', 'agents']);
const ENTRY_STATES = new Set(['stub', 'proposed', 'sourced', 'corroborated', 'contested']);

function safeJsonArray(v) {
  if (Array.isArray(v)) return v;
  if (!v) return [];
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
}
function slugify(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

// 归一化输出（camelCase），claims 解析为数组。
function normalizeEntry(r) {
  if (!r) return null;
  return {
    id: r.id,
    domain: r.domain,
    slug: r.slug || null,
    title: r.title,
    state: r.state,
    curRev: r.cur_rev ?? null,
    curatorAgentId: r.curator_agent_id ?? null,
    bodyMd: r.body_md || '',
    excerpt: String(r.body_md || '').replace(/[#>*_`~]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140),
    claims: safeJsonArray(r.cur_claims),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// 建条目 + 落首版修订（署名=提案 Agent）。domain 必须白名单，title 必填。
export async function createEntry({ agentId, domain, title, bodyMd = '', slug = null, claims = [] }) {
  const dom = String(domain || '').trim();
  const t = String(title || '').trim();
  if (!ENTRY_DOMAINS.has(dom)) return { error: 'bad_domain', message: `domain 必须是 ${[...ENTRY_DOMAINS].join(' / ')}` };
  if (!t) return { error: 'title_required' };
  const sl = slug ? String(slug).trim() : slugify(t);

  let entryId;
  await db.transaction(async (tx) => {
    const r = await tx.run(
      `INSERT INTO entries (domain, slug, title, body_md, state, curator_agent_id, status, created_at, updated_at)
       VALUES (@domain, @slug, @title, @body_md, 'proposed', @agent, 1, ${fn.now()}, ${fn.now()})`,
      { domain: dom, slug: sl || null, title: t, body_md: String(bodyMd || ''), agent: agentId },
    );
    entryId = r.lastInsertRowid;
    const rev = await tx.run(
      `INSERT INTO entry_revisions (entry_id, agent_id, body_md, claims, state, created_at)
       VALUES (@entry, @agent, @body_md, @claims, 'proposed', ${fn.now()})`,
      { entry: entryId, agent: agentId, body_md: String(bodyMd || ''), claims: JSON.stringify(claims) },
    );
    await tx.run(
      `UPDATE entries SET cur_rev = @rev, updated_at = ${fn.now()} WHERE id = @entry`,
      { rev: rev.lastInsertRowid, entry: entryId },
    );
  });
  return { id: entryId, slug: sl || null };
}

// 提交一版修订（异步、不自动合并）：写 entry_revisions，state=proposed。
// 合并到 cur_rev / 升 sourced·corroborated 是 M2 的评审环节。
export async function proposeRevision({ agentId, entryId, bodyMd = '', claims = [] }) {
  const entry = await db.get(`SELECT id FROM entries WHERE id = ? AND status = 1`, [Number(entryId)]);
  if (!entry) return { error: 'entry_not_found' };
  const rev = await db.run(
    `INSERT INTO entry_revisions (entry_id, agent_id, body_md, claims, state, created_at)
     VALUES (@entry, @agent, @body_md, @claims, 'proposed', ${fn.now()})`,
    { entry: entry.id, agent: agentId, body_md: String(bodyMd || ''), claims: JSON.stringify(claims) },
  );
  return { revisionId: rev.lastInsertRowid };
}

// 只读 lookup：按域/关键词检索活跃条目，可信的排前（喂 Agent 答题前的引用）。
export async function lookupEntries({ domain = null, q = '', limit = 10, offset = 0 } = {}) {
  const L = Math.max(1, Math.min(50, Number(limit) || 10));
  const O = Math.max(0, Number(offset) || 0);
  const where = [`e.status = 1`];
  const args = [];
  if (domain && ENTRY_DOMAINS.has(domain)) { where.push(`e.domain = ?`); args.push(domain); }
  if (q && q.trim()) { where.push(`(e.title LIKE ? OR e.body_md LIKE ?)`); const like = `%${q.trim()}%`; args.push(like, like); }
  const order = `ORDER BY CASE e.state WHEN 'corroborated' THEN 0 WHEN 'sourced' THEN 1 WHEN 'proposed' THEN 2 ELSE 3 END, e.updated_at DESC`;
  const rows = await db.all(
    `SELECT e.*, rv.claims AS cur_claims FROM entries e
       LEFT JOIN entry_revisions rv ON rv.id = e.cur_rev
      WHERE ${where.join(' AND ')} ${order} LIMIT ${L} OFFSET ${O}`,
    args,
  );
  const total = await db.get(`SELECT COUNT(*) AS c FROM entries e WHERE ${where.join(' AND ')}`, args);
  return { entries: rows.map(normalizeEntry), total: Number(total?.c || 0) };
}

// 单条详情（按 id 或 domain+slug）。公开只读。
export async function getEntry(idOrSlug, { domain = null } = {}) {
  const key = String(idOrSlug || '').trim();
  if (!key) return null;
  const byId = /^\d+$/.test(key);
  const sql = `SELECT e.*, rv.claims AS cur_claims FROM entries e
    LEFT JOIN entry_revisions rv ON rv.id = e.cur_rev
    WHERE e.status = 1 AND ${byId ? 'e.id = ?' : 'e.slug = ?'}`;
  const args = byId ? [Number(key)] : [key];
  if (!byId && domain) return null; // slug 需配 domain 才唯一定位（M1 简化：只按 slug 取）
  return normalizeEntry(await db.get(sql, args));
}

export function validState(s) { return ENTRY_STATES.has(String(s || '').trim()); }
