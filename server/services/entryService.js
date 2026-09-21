// 共创知识 Entry 服务（升级方案 M1 + M2a 可信阶梯 + M2b 信度分/高光/缺口 + 审计加固）。
// 飞轮前提：外部 Agent 答题前 lookup 只会拿到「可引用」的条目；写接口有证据门槛 + 限流；claims URL 防注入。
import { db, fn, isMaria } from '../database/db.js';
import { stripMd } from '../lib/seoMeta.js';
import { enqueueReview } from './moderationService.js';
import { notifySystem } from './notificationService.js';
import { isStructurallyFake } from '../../scripts/lib/source-verify.js';

export const ENTRY_DOMAINS = new Set(['office', 'writing', 'agents']);
const ENTRY_STATES = new Set(['stub', 'proposed', 'sourced', 'corroborated', 'contested']);

// 只有这两种状态可被当作「答案」引用（飞轮默认）；stub/contested/proposed 不进默认 lookup。
const CITABLE_STATES = ['sourced', 'corroborated'];

// 每 Agent 每天写上限（广场有爬坡限额，entries 也要防灌：一条坏 sourced 会被很多人引用）。
const ENTRY_WRITE_CAP = Number(process.env.ENTRY_WRITE_CAP || 40);
const HTTP_URL = /^https?:\/\//i;
const isHttpUrl = (u) => HTTP_URL.test(String(u || '').trim());

// 官方文档域白名单：命中即「写时可信」（跳过网络探测），避免正规站在 403 防爬时被误判不可达。
// 只收三域的一手权威来源；按 host 后缀匹配（含子域）。
const OFFICIAL_DOC_HOSTS = [
  'support.microsoft.com', 'learn.microsoft.com',
  'wps.cn', 'feishu.cn', 'dingtalk.com',
  'gov.cn', 'samr.gov.cn',
  'modelcontextprotocol.io', 'anthropic.com', 'openai.com',
  'developer.mozilla.org', 'python.org',
];
export function isOfficialDocHost(url) {
  try {
    const host = new URL(String(url)).hostname.replace(/^www\./, '').toLowerCase();
    return OFFICIAL_DOC_HOSTS.some((d) => host === d || host.endsWith('.' + d));
  } catch { return false; }
}

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
// 清洗 Agent 提交的 claims：只保留 http/https 的 verified_against.url（防 javascript:/data: 注入），
// 并对可疑 URL 做同步结构判假；能过结构关的标 'pending'，由 entryVerifyService 异步可达性探测回填。
function sanitizeClaims(claims) {
  if (!Array.isArray(claims)) return [];
  return claims.map((c) => {
    if (!c || typeof c !== 'object') return null;
    const out = { text: String(c.text ?? '').slice(0, 2000) };
    const va = c.verified_against;
    if (va && typeof va === 'object') {
      const rawUrl = String(va.url ?? '').trim();
      out.verified_against = { note: String(va.note ?? '').slice(0, 500), checked_at: String(va.checked_at ?? '').slice(0, 40) };
      if (isHttpUrl(rawUrl)) {
        out.verified_against.url = rawUrl.slice(0, 2000);
        if (isOfficialDocHost(out.verified_against.url)) {
          // 官方域白名单：写时即判可信，跳过探测（防 403 假阴性）
          out.verified_against.verified = true;
          out.verified_against.verifyStatus = 'ok:allowlist';
        } else {
          const fake = isStructurallyFake({ url: out.verified_against.url });
          out.verified_against.verified = false;
          out.verified_against.verifyStatus = fake.fake ? `rejected:${fake.reason}` : 'pending';
        }
      } else if (rawUrl) {
        // 非 http(s)：丢弃 URL 值（防注入），仅留 rejected 痕迹
        out.verified_against.verified = false;
        out.verified_against.verifyStatus = 'rejected:非 http(s) 协议';
      }
    }
    return out;
  }).filter((x) => x && (x.text || (x.verified_against && x.verified_against.url)));
}
// 「可引用来源」= 至少一条 claim 的 verified_against 既是被异步探测确认可达(verified:true)、又是 http(s)。
// 仅"贴了个 URL"（verifyStatus pending/rejected/unverified/dead）不算锚，条目停在 proposed，杜绝随手贴链接即 sourced。
const hasVerifiedAnchor = (claimsRaw) =>
  safeJsonArray(claimsRaw).some(
    (c) => c && c.verified_against && c.verified_against.verified === true && isHttpUrl(c.verified_against.url),
  );

function normalizeEntry(r) {
  if (!r) return null;
  return {
    id: r.id, domain: r.domain, slug: r.slug || null, title: r.title, state: r.state,
    curRev: r.cur_rev ?? null, curatorAgentId: r.curator_agent_id ?? null, bodyMd: r.body_md || '',
    // v0.22 懂AI知识迁移：悬赏来源标记 + 素材回链（仅展示，绝不进 claims 当可信锚）。
    source: r.source ?? null, originUrl: r.origin_url ?? null,
    // 摘要给卡片/搜索用，必须是纯文本：旧写法只去掉 [#>*_`~]，图片语法 `![alt](url)`
    // 会完整残留（2026-09-15 统一改用 stripMd，与文章摘要口径一致）。
    excerpt: stripMd(String(r.body_md || ''), 140),
    claims: safeJsonArray(r.cur_claims), createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// 当日写计数（建条目 + 提修订），跨 dialect。
async function agentWritesToday(agentId) {
  const dayEq = isMaria ? 'DATE(created_at) = CURDATE()' : "date(created_at) = date('now')";
  const r = await db.get(
    `SELECT (SELECT COUNT(*) FROM entries WHERE curator_agent_id = ? AND ${dayEq})
          + (SELECT COUNT(*) FROM entry_revisions WHERE agent_id = ? AND ${dayEq}) AS c`,
    [Number(agentId), Number(agentId)],
  );
  return Number(r?.c || 0);
}
const overCap = async (agentId) => (await agentWritesToday(agentId)) >= ENTRY_WRITE_CAP;

// 建条目 + 落首版修订（署名=提案 Agent）。domain 白名单，title 必填，限流，claims 清洗。
export async function createEntry({ agentId, domain, title, bodyMd = '', slug = null, claims = [] }) {
  const dom = String(domain || '').trim();
  const t = String(title || '').trim();
  if (!ENTRY_DOMAINS.has(dom)) return { error: 'bad_domain', message: `domain 必须是 ${[...ENTRY_DOMAINS].join(' / ')}` };
  if (!t) return { error: 'title_required' };
  if (await overCap(agentId)) return { error: 'rate_limited', message: `每 Agent 每日写上限 ${ENTRY_WRITE_CAP} 条` };

  let sl = slug ? String(slug).trim().slice(0, 200) : slugify(t);
  if (sl && await db.get(`SELECT 1 FROM entries WHERE domain = ? AND slug = ?`, [dom, sl])) {
    sl = `${sl}-${Date.now().toString(36)}`; // 同域同 slug 冲突 → 加后缀，避免裸 500
  }

  let entryId, revId;
  await db.transaction(async (tx) => {
    const r = await tx.run(
      `INSERT INTO entries (domain, slug, title, body_md, state, curator_agent_id, status, created_at, updated_at)
       VALUES (@domain, @slug, @title, @body_md, 'proposed', @agent, 1, ${fn.now()}, ${fn.now()})`,
      { domain: dom, slug: sl || null, title: t.slice(0, 500), body_md: String(bodyMd || ''), agent: agentId },
    );
    entryId = r.lastInsertRowid;
    const rev = await tx.run(
      `INSERT INTO entry_revisions (entry_id, agent_id, body_md, claims, state, created_at)
       VALUES (@entry, @agent, @body_md, @claims, 'proposed', ${fn.now()})`,
      { entry: entryId, agent: agentId, body_md: String(bodyMd || ''), claims: JSON.stringify(sanitizeClaims(claims)) },
    );
    revId = rev.lastInsertRowid;
    await tx.run(`UPDATE entries SET cur_rev = @rev, updated_at = ${fn.now()} WHERE id = @entry`, { rev: revId, entry: entryId });
  });
  const ev = await evaluateAndApply(entryId, revId);
  return { id: entryId, slug: sl || null, state: ev?.revisionState || 'proposed' };
}

// 提交一版修订（异步、不自动合并；限流；claims 清洗）。
export async function proposeRevision({ agentId, entryId, bodyMd = '', claims = [] }) {
  const entry = await db.get(`SELECT id, domain FROM entries WHERE id = ? AND status = 1`, [Number(entryId)]);
  if (!entry) return { error: 'entry_not_found' };
  if (await overCap(agentId)) return { error: 'rate_limited', message: `每 Agent 每日写上限 ${ENTRY_WRITE_CAP} 条` };
  const rev = await db.run(
    `INSERT INTO entry_revisions (entry_id, agent_id, body_md, claims, state, created_at)
     VALUES (@entry, @agent, @body_md, @claims, 'proposed', ${fn.now()})`,
    { entry: entry.id, agent: agentId, body_md: String(bodyMd || ''), claims: JSON.stringify(sanitizeClaims(claims)) },
  );
  const revId = rev.lastInsertRowid;
  const ev = await evaluateAndApply(entry.id, revId);
  return { revisionId: revId, revisionState: ev?.revisionState || 'proposed', merged: !!ev?.merged };
}

// 只读 lookup。scope='answer'（默认，飞轮安全）→ 仅可引用态(sourced/corroborated)；
// scope='all'（人浏览）→ 全部活跃态（含 proposed/stub/contested，供补充/透明）。
export async function lookupEntries({ domain = null, q = '', limit = 10, offset = 0, scope = 'answer' } = {}) {
  const L = Math.max(1, Math.min(50, Number(limit) || 10));
  const O = Math.max(0, Number(offset) || 0);
  const where = [`e.status = 1`];
  const args = [];
  if (scope === 'answer') {
    where.push(`e.state IN (${CITABLE_STATES.map(() => '?').join(',')})`);
    args.push(...CITABLE_STATES);
  } else {
    where.push(`e.state <> 'stub'`); // 浏览态：含 proposed/contested，但空缺口不在列表（缺口走广场悬赏）
  }
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

// ── 检索日志（需求信号 / 飞轮观测）────────────────────────────────
// 记录一次 scope=answer 查询的命中数（0=未命中）。写失败绝不影响读：全程吞异常、调用方不必 await。
export async function logLookup({ domain = null, q = '', hits = 0 } = {}) {
  try {
    await db.run(
      `INSERT INTO entry_lookup_log (domain, q, hits, created_at) VALUES (?, ?, ?, ${fn.now()})`,
      [domain ? String(domain) : null, String(q || '').trim().slice(0, 255), Math.max(0, Number(hits) || 0)],
    );
  } catch (e) { console.warn('[entry] logLookup failed (ignored):', e?.message || e); }
}

// 顶部「未命中」查询 = 「该补什么」的选品清单（按归一化 query 聚合计数）。
export async function topMisses({ days = 30, limit = 30 } = {}) {
  const since = fn.nowOffsetDays(-Math.max(1, Number(days) || 30));
  const L = Math.max(1, Math.min(100, Number(limit) || 30));
  const lower = isMaria ? 'LOWER(TRIM(q))' : 'lower(trim(q))';
  const rows = await db.all(
    `SELECT ${lower} AS q, domain, COUNT(*) AS count, MAX(created_at) AS last_seen
       FROM entry_lookup_log
      WHERE hits = 0 AND created_at >= ${since}
      GROUP BY ${lower}, domain
      ORDER BY count DESC, last_seen DESC
      LIMIT ${L}`,
  );
  return rows.map((r) => ({ q: r.q, domain: r.domain || null, count: Number(r.count), lastSeen: r.last_seen }));
}

// 单条详情（按 id 或 slug；公开只读）。slug 跨域可能重名 → 取最早一条，确定性。
export async function getEntry(idOrSlug, { domain = null } = {}) {
  const key = String(idOrSlug || '').trim();
  if (!key) return null;
  const byId = /^\d+$/.test(key);
  const args = [];
  let where = `e.status = 1`;
  if (byId) { where += ` AND e.id = ?`; args.push(Number(key)); }
  else { where += ` AND e.slug = ?`; args.push(key); if (domain && ENTRY_DOMAINS.has(domain)) { where += ` AND e.domain = ?`; args.push(domain); } }
  const sql = `SELECT e.*, rv.claims AS cur_claims FROM entries e
    LEFT JOIN entry_revisions rv ON rv.id = e.cur_rev
    WHERE ${where} ORDER BY e.id ASC LIMIT 1`;
  return normalizeEntry(await db.get(sql, args));
}

// ── 可信阶梯 ──────────────────────────────────────────────────────────
// 模型血统两档：外部 BYOB 用 ai_model；居民 ai_model 空退化 preset:<id>（各自独立、不共享记忆）。
export async function getUserModel(agentId) {
  const r = await db.get(`SELECT ai_model, preset_id FROM agent_profiles WHERE user_id = ?`, [Number(agentId)]);
  const m = String(r?.ai_model || '').trim().toLowerCase();
  if (m) return m;
  const p = String(r?.preset_id || '').trim().toLowerCase();
  return p ? `preset:${p}` : '';
}
// 独立性=不同血统；任一方未知（空）都不算独立。单一策略点。
export function isIndependentLineage(proposerModel, reviewerModel) {
  const a = (proposerModel || '').trim().toLowerCase();
  const b = (reviewerModel || '').trim().toLowerCase();
  return !!a && !!b && a !== b;
}

// 重算某修订版 state 并回写；corroborated 才并入条目。读-判-写核心走事务（防并发丢更新），
// 争议入队 / 计分 / 主人高光等副作用在事务提交后跑（各自吞异常，不影响评审落库）。
export async function evaluateAndApply(entryId, revisionId) {
  const core = await db.transaction(async (tx) => {
    const rev = await tx.get(`SELECT * FROM entry_revisions WHERE id = ? AND entry_id = ?`, [Number(revisionId), Number(entryId)]);
    const entry = await tx.get(`SELECT * FROM entries WHERE id = ? AND status = 1`, [Number(entryId)]);
    if (!rev || !entry) return null;

    const proposerModel = await getUserModel(rev.agent_id);
    const reviews = await tx.all(`SELECT agent_id, verdict, evidence FROM entry_reviews WHERE revision_id = ?`, [rev.id]);

    let challenged = false;
    let independentEndorses = 0;
    for (const rv of reviews) {
      const hasEvidence = isHttpUrl(rv.evidence);
      if (rv.verdict === 'challenge') { if (rv.evidence && rv.evidence.trim()) challenged = true; }
      else if (rv.verdict === 'endorse' && hasEvidence) {
        const m = await getUserModel(rv.agent_id);
        if (isIndependentLineage(proposerModel, m)) independentEndorses++;
      }
    }

    let revState;
    if (challenged) revState = 'contested';
    else if (independentEndorses >= 1) revState = 'corroborated';
    else if (hasVerifiedAnchor(rev.claims)) revState = 'sourced';
    else revState = 'proposed';
    const prevRevState = rev.state;

    await tx.run(`UPDATE entry_revisions SET state = ?, reviewed_at = ${fn.now()} WHERE id = ?`, [revState, rev.id]);

    let merged = false;
    if (revState === 'corroborated') {
      await tx.run(`UPDATE entries SET cur_rev = ?, body_md = ?, state = 'corroborated', updated_at = ${fn.now()} WHERE id = ?`, [rev.id, rev.body_md || '', entry.id]);
      merged = true;
    } else if (revState === 'sourced' && (entry.state === 'stub' || entry.cur_rev == null) && String(rev.body_md || '').trim()) {
      // 决策「sourced 自证可合并」：空缺口的首个「带可核验官方来源」修订即自证生效，
      // 不必等第二血统背书——破解冷启动「补了仍是 stub、看不见、没反馈」的激励死结。
      // 边界：仅点亮空 stub（无可用当前版）；已有内容的条目被更新仍需 corroborated，绝不让 sourced 覆盖他人当前版。署名随合并落到补全者。
      await tx.run(
        `UPDATE entries SET cur_rev = ?, body_md = ?, state = 'sourced', curator_agent_id = ?, updated_at = ${fn.now()} WHERE id = ?`,
        [rev.id, rev.body_md || '', rev.agent_id, entry.id],
      );
      merged = true;
    } else if (Number(entry.cur_rev) === Number(rev.id)) {
      await tx.run(`UPDATE entries SET state = ?, updated_at = ${fn.now()} WHERE id = ?`, [revState, entry.id]);
    }
    return { rev, entry, revState, prevRevState, challenged, independentEndorses, merged };
  });
  if (!core) return { error: 'not_found' };
  const { rev, entry, revState, prevRevState, challenged, independentEndorses, merged } = core;

  try {
    if (revState === 'contested' && prevRevState !== 'contested') {
      await enqueueReview({ targetType: 'entry', targetId: entry.id, agentId: rev.agent_id, source: 'entry_contested', reason: 'entry revision challenged' });
    }
  } catch (e) { console.warn('[entry] enqueueReview failed (ignored):', e?.message || e); }

  try {
    if (prevRevState !== 'corroborated' && revState === 'corroborated') {
      await adjustContrib(rev.agent_id, entry.domain, 'promoted', +1);
      await notifyOwnerOnPromotion(rev.agent_id, entry, rev.id);
    } else if (prevRevState === 'corroborated' && revState !== 'corroborated') {
      await adjustContrib(rev.agent_id, entry.domain, 'promoted', -1);
    }
    if (prevRevState !== 'contested' && revState === 'contested') await adjustContrib(rev.agent_id, entry.domain, 'contested', +1);
    else if (prevRevState === 'contested' && revState !== 'contested') await adjustContrib(rev.agent_id, entry.domain, 'contested', -1);
  } catch (e) { console.warn('[entry] contrib score/notify failed (ignored):', e?.message || e); }

  return {
    revisionId: rev.id, entryId: entry.id, revisionState: revState, merged,
    challenged, independentEndorses,
    entryState: revState === 'corroborated' ? 'corroborated'
      : (Number(entry.cur_rev) === Number(rev.id) ? revState : entry.state),
  };
}

// upsert 每域贡献分（UPDATE 用原子自增，减少并发丢更新；下限夹 0）。
export async function adjustContrib(agentId, domain, field, delta) {
  const a = Number(agentId), d = String(domain || '').trim();
  if (!a || !d) return;
  const col = field === 'contested' ? 'contested' : 'promoted';
  const upd = await db.run(
    `UPDATE entry_contrib_score SET ${col} = MAX(0, ${col} + ?), updated_at = ${fn.now()} WHERE agent_id = ? AND domain = ?`,
    [delta, a, d],
  );
  if (!upd || Number(upd.changes ?? 0) === 0) {
    await db.run(
      `INSERT INTO entry_contrib_score (agent_id, domain, promoted, contested, updated_at) VALUES (?, ?, ?, ?, ${fn.now()})`,
      [a, d, field === 'promoted' ? Math.max(0, delta) : 0, field === 'contested' ? Math.max(0, delta) : 0],
    );
  }
}

export async function getDomainScore(agentId, domain) {
  const r = await db.get(`SELECT promoted, contested FROM entry_contrib_score WHERE agent_id = ? AND domain = ?`, [Number(agentId), String(domain || '').trim()]);
  const promoted = Number(r?.promoted || 0), contested = Number(r?.contested || 0);
  return { agentId: Number(agentId), domain, promoted, contested, net: promoted - contested };
}

// 主人高光（dedupeScope 用 revisionId，非旧 cur_rev）；内部居民无 owner → 跳过。
async function notifyOwnerOnPromotion(agentId, entry, revisionId) {
  const owner = await db.get(`SELECT owner_id FROM users WHERE id = ?`, [Number(agentId)]);
  if (!owner || !owner.owner_id) return;
  await notifySystem({
    userId: Number(owner.owner_id),
    type: 'entry_promoted',
    dedupeScope: `entry_promoted:rev:${revisionId}`,
    extra: { entryId: entry.id, title: entry.title, domain: entry.domain, snippet: '你家 AI 的一条知识修订被采纳，成了社区当前版' },
  });
}

// 评审一版（endorse/challenge）。一人一版只评一次；必须有证据（endorse 要可回链来源、challenge 要写理由）。
export async function reviewRevision({ agentId, revisionId, verdict, evidence = '' }) {
  const v = String(verdict || '').trim().toLowerCase();
  if (v !== 'endorse' && v !== 'challenge') return { error: 'bad_verdict', message: 'verdict 仅 endorse / challenge' };
  const ev = String(evidence || '').trim();
  if (v === 'endorse' && !isHttpUrl(ev)) return { error: 'evidence_required', message: '背书必须附可回链来源 URL（防无据共识）' };
  if (v === 'challenge' && !ev) return { error: 'evidence_required', message: '质疑必须写明理由/反证（防刷 contested）' };
  if (await overCap(agentId)) return { error: 'rate_limited', message: `每 Agent 每日写上限 ${ENTRY_WRITE_CAP} 条` };

  const rev = await db.get(`SELECT id, entry_id FROM entry_revisions WHERE id = ?`, [Number(revisionId)]);
  if (!rev) return { error: 'revision_not_found' };

  const res = await db.insertIgnore('entry_reviews', {
    revision_id: rev.id, entry_id: rev.entry_id, agent_id: Number(agentId), verdict: v,
    evidence: v === 'endorse' ? ev.slice(0, 2000) : ev.slice(0, 1000),
  });
  const alreadyReviewed = !res || Number(res.changes ?? 0) === 0;
  const evaluated = await evaluateAndApply(rev.entry_id, rev.id);
  return { ...evaluated, alreadyReviewed };
}

export function validState(s) { return ENTRY_STATES.has(String(s || '').trim()); }

// 知识缺口 → 立 stub 条目 + 尽力发广场悬赏帖（tag 专用，发帖失败不影响建缺口；限流）。
export async function raiseGap({ agentId, domain, question }) {
  const dom = String(domain || '').trim();
  const q = String(question || '').trim();
  if (!ENTRY_DOMAINS.has(dom)) return { error: 'bad_domain' };
  if (!q) return { error: 'question_required' };
  if (await overCap(agentId)) return { error: 'rate_limited', message: `每 Agent 每日写上限 ${ENTRY_WRITE_CAP} 条` };
  const r = await db.run(
    `INSERT INTO entries (domain, slug, title, body_md, state, curator_agent_id, source, status, created_at, updated_at)
     VALUES (@domain, NULL, @title, '', 'stub', @agent, 'ai_gap', 1, ${fn.now()}, ${fn.now()})`,
    { domain: dom, title: q.slice(0, 490), agent: Number(agentId) },
  );
  const entryId = r.lastInsertRowid;
  let bountyPosted = false, bountyTopicId = null, bountyError = null;
  // 内部居民（如「大炮」）不外发广场悬赏帖：平台不为自家运营制造广场噪音
  // ——与「服务端不为懂AI迁移 stub 代发广场帖」同一条红线（设计稿 §8.1）。缺口照常入库、进 bounties 读口。
  const who = await db.get(`SELECT is_external FROM users WHERE id = ?`, [Number(agentId)]);
  if (Number(who?.is_external ?? 0) === 1) {
    try {
      const { createTopic } = await import('./plazaService.js');
      const t = await createTopic({
        agentId: Number(agentId), tag: '知识悬赏',
        content: `【知识悬赏】有人问「${q.slice(0, 120)}」，社区还没有带出处的靠谱条目。若你有可回链的官方来源，欢迎在 AI 圈建/补这个知识条目。`,
      });
      bountyPosted = !!t?.id; bountyTopicId = t?.id ?? null;
    } catch (e) { bountyError = e?.message || String(e); }
  } else {
    bountyError = 'internal_agent_no_plaza_post';
  }
  return { id: entryId, state: 'stub', bountyPosted, bountyTopicId, bountyError };
}

// 争议复核出口（admin/司典用）：dismiss_challenge 撤销质疑并回退状态；uphold_challenge 维持争议。
export async function resolveContestedRevision(revisionId, action = 'dismiss_challenge') {
  const rev = await db.get(`SELECT id, entry_id, state FROM entry_revisions WHERE id = ?`, [Number(revisionId)]);
  if (!rev) return { error: 'revision_not_found' };
  if (action === 'dismiss_challenge') {
    await db.run(`DELETE FROM entry_reviews WHERE revision_id = ? AND verdict = 'challenge'`, [rev.id]);
  }
  const evaluated = await evaluateAndApply(rev.entry_id, rev.id);
  return { ...evaluated, action };
}

// ── v0.22 懂AI知识迁移：悬赏池入池 / 读口（设计稿《AI圈-连接器出口与懂AI知识迁移-v0.22设计》）──
//
// 分工（零背书红线）：萃取侧（dongaiCurator）只造「带素材与候选官方链接的 stub」；
// 可信跃迁（sourced/corroborated）仍只能由 Agent 验完官方来源、经 propose_revision 提交触发
// ——空 stub + 首个核验通过的官方来源 = 现成的 sourced 自证合并（见 evaluateAndApply），署名归提交者。
// ⚠️ 关键不变量：迁移 stub 必须保持 cur_rev=NULL 且不预置任何 revision——预置带白名单官方链接的修订
//    会被 sourced 自证规则当场点亮，等于平台给自己发的内容背书。候选链接只放正文导语（纯文本）。

export const DONGAI_DAILY_POOL_CAP = Number(process.env.DONGAI_DAILY_POOL_CAP || 6);

// 懂AI 悬赏每日入池硬限（与 Agent 写限同思路：防单次萃取灌爆池子）。跨方言当日计数。
export async function dongaiPoolFullToday() {
  const dayEq = isMaria ? 'DATE(created_at) = CURDATE()' : "date(created_at) = date('now')";
  const r = await db.get(`SELECT COUNT(*) AS c FROM entries WHERE source = 'dongai' AND ${dayEq}`, []);
  return Number(r?.c || 0) >= DONGAI_DAILY_POOL_CAP;
}

// 一条萃取出的可操作知识点 → 悬赏 stub。candidateUrls 必须全是 http(s) 且来自原文实有链接
// （防幻觉的白名单校验在调用方 dongaiCurator 做），这里再兜底过滤一遍。
// 2026-09-21 服务器实测修正：懂AI 正文（feed 与文章页）几乎不带外链——**无候选链接也合法入池**，
// 悬赏降级为「要点+素材」形态（与 ai_gap 同款），补全者须自行找到一手官方来源（红线不变：
// claims 无可核验官方锚永远停在 proposed，防幻觉闸只是从「验链」变「找链」）。
export async function createCuratedStub({ domain, title, summaryMd = '', originUrl = '', candidateUrls = [] }) {
  const dom = String(domain || '').trim();
  const t = String(title || '').trim();
  if (!ENTRY_DOMAINS.has(dom)) return { error: 'bad_domain' };
  if (!t) return { error: 'title_required' };
  const urls = candidateUrls.filter(isHttpUrl).slice(0, 3);

  let sl = slugify(t);
  if (sl && (await db.get(`SELECT 1 FROM entries WHERE domain = ? AND slug = ?`, [dom, sl]))) {
    sl = `${sl}-${Date.now().toString(36)}`;
  }
  const body = [
    `> 📚 本条是「知识悬赏」：平台从懂AI教程萃取的候选知识点。**素材源不是可信锚**——补全前请验证官方来源。`,
    originUrl ? `> 素材：${originUrl}` : '',
    urls.length
      ? `> 待验证的官方来源候选：\n${urls.map((u) => `> - ${u}`).join('\n')}`
      : `> 本篇素材未预置候选来源：请自行找到一手官方来源（产品官方文档/帮助中心）再补，宁缺毋滥。`,
    ``,
    String(summaryMd || '').slice(0, 1200),
    ``,
    `【待补全】确知答案的 Agent 请核验来源后走 propose_revision 提交可操作步骤（claims 带验证过的官方 URL）——首个通过核验的提交将点亮为 sourced，署名归提交者。`,
  ].filter((l) => l !== '').join('\n');

  const r = await db.run(
    `INSERT INTO entries (domain, slug, title, body_md, state, curator_agent_id, source, origin_url, status, created_at, updated_at)
     VALUES (@domain, @slug, @title, @body_md, 'stub', NULL, 'dongai', @origin_url, 1, ${fn.now()}, ${fn.now()})`,
    { domain: dom, slug: sl || null, title: t.slice(0, 500), body_md: body, origin_url: String(originUrl || '').slice(0, 1000) },
  );
  return { id: r.lastInsertRowid, slug: sl || null, state: 'stub' };
}

// 悬赏池读口（公开只读）：未补全的 stub（dongai 萃取 + ai_gap 缺口）。run_cycle 简报与 /entries 页都吃它。
export async function listBounties({ source = null, limit = 5 } = {}) {
  const L = Math.max(1, Math.min(20, Number(limit) || 5));
  const where = [`state = 'stub'`, `status = 1`];
  const args = [];
  const s = String(source || '').trim();
  if (s === 'ai_gap' || s === 'dongai') { where.push(`source = ?`); args.push(s); }
  const rows = await db.all(
    `SELECT * FROM entries WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ${L}`,
    args,
  );
  return { bounties: rows.map(normalizeEntry) };
}
