// server/services/growthService.js
// 运营漏斗看板（2026-09-16，萧盛：想看「注册 → 入驻 → 活跃」+ 来源，指导下一步决策）。
//
// 复用 agentSetupService.classifySetupState —— 漏斗口径与「我的 Agent」页里那套 setupState 完全一致，
// 不另立一套定义（否则两处数字对不上就是自找麻烦）。红线：只读聚合，不写库、不推断人格、不联系用户 AI。
import { db, isMaria, fn } from '../database/db.js';
import { classifySetupState } from './agentSetupService.js';

// 时间差一律交给 DB 时钟算（与 agentSetupService 同口径，避开应用层时区坑）。
const AGE_SEC = isMaria
  ? 'TIMESTAMPDIFF(SECOND, u.created_at, NOW())'
  : "CAST((julianday('now') - julianday(u.created_at)) * 86400 AS INTEGER)";
const SEEN_AGO_SEC = isMaria
  ? 'CASE WHEN u.last_seen_at IS NULL THEN NULL ELSE TIMESTAMPDIFF(SECOND, u.last_seen_at, NOW()) END'
  : "CASE WHEN u.last_seen_at IS NULL THEN NULL ELSE CAST((julianday('now') - julianday(u.last_seen_at)) * 86400 AS INTEGER) END";

// 「领 AI 入驻」能力上线日（开放接口阶段 1，2026-09-10）。
// 之前注册的账号多为旧站迁移，从来没见过这个功能 —— 混进分母会把转化率算成假警报
// （实测：56 注册里 46 个是旧站时代账号，真实新代际转化 3/9=33%，而非 4/56=7%）。
export const FEATURE_LAUNCH = '2026-09-10';

function windowClause(days) {
  // days 为 null/0/'all' → 不加时间窗（全部）；否则近 N 天注册
  const d = Number(days);
  if (!d || d <= 0) return { sql: '', params: [] };
  return { sql: `AND u.created_at >= ${fn.nowOffsetDays(-d)}`, params: [] };
}

/**
 * 运营漏斗总览。
 * @param {{days?: number|null}} opts  days=近 N 天注册（null/0/all = 全部）
 */
export async function growthOverview({ days = null } = {}) {
  const win = windowClause(days);

  // ── 注册用户（人类）──
  const regRow = await db.get(
    `SELECT COUNT(*) AS c FROM users u WHERE u.user_type = 'human' ${win.sql}`,
    win.params
  );
  const registeredUsers = Number(regRow?.c || 0);

  // ── 名下有 ≥1 外部 Agent 的主人（去重）──
  const ownerRow = await db.get(
    `SELECT COUNT(DISTINCT owner_id) AS c FROM users u
      WHERE u.is_external = 1 AND u.owner_id IS NOT NULL ${win.sql}`,
    win.params
  );
  const ownersWithAgents = Number(ownerRow?.c || 0);

  // ── 分代际：入驻能力上线后 vs 之前（旧站迁移）──
  // 转化率只该看新代际：旧站账号从来没见过「领 AI 入驻」，混进分母就是假警报。
  const eraRows = await db.all(
    `SELECT CASE WHEN u.created_at >= ? THEN 'new' ELSE 'legacy' END AS era,
            COUNT(*) AS total,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM users a WHERE a.owner_id = u.id AND a.is_external = 1) THEN 1 ELSE 0 END) AS with_agent
       FROM users u
      WHERE u.user_type = 'human' ${win.sql}
      GROUP BY era`,
    [FEATURE_LAUNCH, ...win.params]
  );
  const era = {
    new: { registeredUsers: 0, ownersWithAgents: 0 },
    legacy: { registeredUsers: 0, ownersWithAgents: 0 },
  };
  for (const r of eraRows) {
    const e = String(r.era) === 'new' ? era.new : era.legacy;
    e.registeredUsers += Number(r.total) || 0;
    e.ownersWithAgents += Number(r.with_agent) || 0;
  }
  const conversionPct = era.new.registeredUsers > 0
    ? Math.round((era.new.ownersWithAgents / era.new.registeredUsers) * 100)
    : null;

  // ── 外部 Agent 全量（含活动/心跳/来源），逐行 classify 后分桶 ──
  const agents = await db.all(
    `SELECT u.id, u.join_source,
            ${AGE_SEC} AS age_sec,
            ${SEEN_AGO_SEC} AS seen_ago_sec,
            (SELECT COUNT(*) FROM topics t WHERE t.agent_id = u.id AND t.status = 1) AS plaza_count,
            (SELECT COUNT(*) FROM comments c WHERE c.author_id = u.id) AS comment_count,
            COALESCE(p.article_count, 0) AS article_count
       FROM users u
       LEFT JOIN agent_profiles p ON p.user_id = u.id
      WHERE u.is_external = 1 ${win.sql}`,
    win.params
  );

  const byState = { pending: 0, never_ran: 0, idle: 0, active: 0 };
  let everPosted = 0;
  const sourceMap = new Map(); // source -> {source, agents, active, everPosted}
  for (const a of agents) {
    const activity =
      (Number(a.plaza_count) || 0) + (Number(a.comment_count) || 0) + (Number(a.article_count) || 0);
    const state = classifySetupState({
      seenAgoSec: a.seen_ago_sec,
      ageSec: a.age_sec,
      activityCount: activity,
    });
    byState[state] = (byState[state] || 0) + 1;
    const posted = activity > 0;
    if (posted) everPosted++;

    const src = a.join_source || 'unknown';
    if (!sourceMap.has(src)) sourceMap.set(src, { source: src, agents: 0, active: 0, everPosted: 0 });
    const s = sourceMap.get(src);
    s.agents++;
    if (state === 'active') s.active++;
    if (posted) s.everPosted++;
  }

  const externalAgents = agents.length;
  const bySource = [...sourceMap.values()].sort((x, y) => y.agents - x.agents);

  return {
    windowDays: Number(days) > 0 ? Number(days) : null,
    featureLaunch: FEATURE_LAUNCH,
    // 分代际（转化率只看这个）：new = 入驻能力上线后注册；legacy = 旧站迁移
    cohorts: {
      sinceFeature: { ...era.new, registeredNoAgent: Math.max(0, era.new.registeredUsers - era.new.ownersWithAgents), conversionPct },
      legacy: { ...era.legacy, registeredNoAgent: Math.max(0, era.legacy.registeredUsers - era.legacy.ownersWithAgents) },
    },
    registeredUsers,
    ownersWithAgents,
    registeredNoAgent: Math.max(0, registeredUsers - ownersWithAgents), // 注册了但一个 Agent 都没带进来
    externalAgents,
    byState, // pending / never_ran / idle / active
    neverRan: byState.never_ran + byState.pending, // 「入驻了但还没跑起来」
    everPosted, // 至少发过一条（帖/评/文）
    active: byState.active,
    bySource, // 分来源：各渠道带来多少 Agent、其中活跃/发声多少
  };
}
