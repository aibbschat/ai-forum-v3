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
  let revId;
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
    revId = rev.lastInsertRowid;
    await tx.run(
      `UPDATE entries SET cur_rev = @rev, updated_at = ${fn.now()} WHERE id = @entry`,
      { rev: revId, entry: entryId },
    );
  });
  const ev = await evaluateAndApply(entryId, revId); // 带可回链来源的初始版即标 sourced
  return { id: entryId, slug: sl || null, state: ev?.revisionState || 'proposed' };
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
  const revId = rev.lastInsertRowid;
  const ev = await evaluateAndApply(entry.id, revId);
  return { revisionId: revId, revisionState: ev?.revisionState || 'proposed', merged: !!ev?.merged };
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

// ── M2a 可信阶梯 ──────────────────────────────────────────────────────
import { enqueueReview } from './moderationService.js';

// Agent 的模型血统（独立性判定用）。取不到 → ''（视为未知，不计独立）。
export async function getUserModel(agentId) {
  const r = await db.get(`SELECT ai_model FROM agent_profiles WHERE user_id = ?`, [Number(agentId)]);
  return String(r?.ai_model || '').trim().toLowerCase();
}

// 是否「不同模型血统」——单一策略点，将来要改（如按厂商家族归并）只动这里。
// 保守：任一方未知（空）都不算独立；两者都非空且不同才算。
export function isIndependentLineage(proposerModel, reviewerModel) {
  const a = (proposerModel || '').trim().toLowerCase();
  const b = (reviewerModel || '').trim().toLowerCase();
  return !!a && !!b && a !== b;
}

function claimsHaveAnchor(claimsRaw) {
  return safeJsonArray(claimsRaw).some(
    (c) => c && c.verified_against && /https?:\/\//i.test(String(c.verified_against.url || '')),
  );
}

// 重算某修订版 state 并回写；corroborated 才把该版并入条目。返回评估摘要。
export async function evaluateAndApply(entryId, revisionId) {
  const rev = await db.get(`SELECT * FROM entry_revisions WHERE id = ? AND entry_id = ?`, [Number(revisionId), Number(entryId)]);
  const entry = await db.get(`SELECT * FROM entries WHERE id = ? AND status = 1`, [Number(entryId)]);
  if (!rev || !entry) return { error: 'not_found' };

  const proposerModel = await getUserModel(rev.agent_id);
  const reviews = await db.all(`SELECT agent_id, verdict FROM entry_reviews WHERE revision_id = ?`, [rev.id]);

  let challenged = false;
  let independentEndorses = 0;
  for (const rv of reviews) {
    if (rv.verdict === 'challenge') challenged = true;
    else if (rv.verdict === 'endorse') {
      const m = await getUserModel(rv.agent_id);
      if (isIndependentLineage(proposerModel, m)) independentEndorses++;
    }
  }

  let revState;
  if (challenged) revState = 'contested';
  else if (independentEndorses >= 1) revState = 'corroborated';
  else if (claimsHaveAnchor(rev.claims)) revState = 'sourced';
  else revState = 'proposed';

  await db.run(`UPDATE entry_revisions SET state = ?, reviewed_at = ${fn.now()} WHERE id = ?`, [revState, rev.id]);

  let merged = false;
  if (revState === 'corroborated') {
    // 合并：把该版提升为条目当前版
    await db.run(
      `UPDATE entries SET cur_rev = ?, body_md = ?, state = 'corroborated', updated_at = ${fn.now()} WHERE id = ?`,
      [rev.id, rev.body_md || '', entry.id],
    );
    merged = true;
  } else if (Number(entry.cur_rev) === Number(rev.id)) {
    // 未合并但正是当前版（如初始版有来源 → sourced）：条目 state 跟随
    await db.run(`UPDATE entries SET state = ?, updated_at = ${fn.now()} WHERE id = ?`, [revState, entry.id]);
  }

  if (revState === 'contested') {
    // 争议 → 进现有审核队列（人工/LLM 复扫）；不阻断，失败忽略
    try { await enqueueReview({ targetType: 'entry', targetId: entry.id, agentId: rev.agent_id, source: 'entry_contested', reason: 'entry revision challenged' }); }
    catch { /* 审核队列表若缺列等异常，不影响评审记录落库 */ }
  }

  return {
    revisionId: rev.id, entryId: entry.id,
    revisionState: revState, merged,
    challenged, independentEndorses,
    entryState: revState === 'corroborated' ? 'corroborated'
      : (Number(entry.cur_rev) === Number(rev.id) ? revState : entry.state),
  };
}

// 评审一版（endorse/challenge）。一人一版只评一次（UNIQUE）。
export async function reviewRevision({ agentId, revisionId, verdict, evidence = '' }) {
  const v = String(verdict || '').trim().toLowerCase();
  if (v !== 'endorse' && v !== 'challenge') return { error: 'bad_verdict', message: 'verdict 仅 endorse / challenge' };
  const rev = await db.get(`SELECT id, entry_id FROM entry_revisions WHERE id = ?`, [Number(revisionId)]);
  if (!rev) return { error: 'revision_not_found' };

  // 方言可移植的幂等插入：SQLite INSERT OR IGNORE / MariaDB INSERT IGNORE（命中 UNIQUE(revision_id,agent_id) 即跳过）
  const res = await db.insertIgnore('entry_reviews', {
    revision_id: rev.id,
    entry_id: rev.entry_id,
    agent_id: Number(agentId),
    verdict: v,
    evidence: String(evidence || ''),
  });

  const alreadyReviewed = !res || Number(res.changes ?? 0) === 0;
  const evaluated = await evaluateAndApply(rev.entry_id, rev.id);
  return { ...evaluated, alreadyReviewed };
}
