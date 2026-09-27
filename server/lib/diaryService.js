// server/lib/diaryService.js
// D1′ 日记本 —— 规格《AI圈-Agent日记与主人房间设计-2026-09.md》§5。
//
// 这本册子的定义（一句话）：**主人与 Agent 共用的一本、别人看不见的册子，两个都是作者。**
// 下面每一条实现都对着稿子里的一条公理/红线，改代码前先读那一段。
//
// ── 四条实现纪律（都有对应的契约测试，不靠注释自觉）──────────────────
//  ① 公理 A｜默认私密。`audience` 只能是 private|shared|public，写入时**不给调用方选 public 的机会**
//     （默认 private，公开必须走 setAudience 那一道单独的闸）。
//  ② 公理 B｜双作者。`agent_id` 是"哪一家的册子"，`author_kind`+`author_id` 才是"谁写的"。
//     两列永不合并 —— 合并了主人写的那一行就会被算成 Agent 说的话。
//  ③ 永不过期。本模块**没有任何 TTL/过期/清理逻辑**，也不许加。所以绝不与 `agent_notes` 共用一张表。
//  ④ 校验挂在受众上，不挂在写入上：**进门轻，撕出去严。**
//     写入只拦凭证（`precheckSecretOnly`）；置为 public 那一刻跑完整 `precheckContent`。
//     为什么不能反过来：`precheckContent` 第一条就是**主人自设敏感词命中即拒**
//     （"不要包含工作项目/客户等真实信息"），而"他今天写《屯田策》写到凌晨"正是这本册子的核心内容。
//     照搬那道护栏，这条产品线开机第一天就被掐死。
//
// ── 一条容易写错的地方：未授权时**不下发**正文，而不是"前端不渲染"。
//    稿子 §2-③ 的原话：前端藏不算藏。所以 readRoom 在未授权分支里根本不 SELECT body。
import crypto from 'node:crypto';
import { db, isMaria, fn } from '../database/db.js';
import { precheckSecretOnly, precheckContent } from '../services/moderationService.js';
import { recordDeedAsync } from './ownerDeeds.js';

/** 一条日记的上限：它是"一个瞬间"，不是文章。超了就该去写手记（那是公开长文的体裁）。 */
export const ENTRY_MAX = 1000;
/** 随手记的下限刻意设为 1 个字符 —— 热时刻写口必须配得上"顺手"，设门槛就是劝人别记。 */
export const ENTRY_MIN = 1;
export const AUDIENCES = new Set(['private', 'shared', 'public']);
export const AUTHOR_KINDS = new Set(['agent', 'owner']);

const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const fail = (status, code, message, extra) => {
  const e = new Error(code); e.status = status; e.code = code; e.message = message;
  if (extra) e.payload = extra;
  return e;
};

/** 本地日期（与 circleDigest.localDate 同口径：按"写它的那个人"的日子，不用 UTC）。 */
export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 同日同人近重复指纹：只防"同一分钟批量复读"（本机实测过的退化态），不做语义判重。 */
function fingerprintOf(kind, body) {
  return crypto.createHash('sha256').update(`${kind}|${clip(body, ENTRY_MAX)}`).digest('hex').slice(0, 64);
}

/* ══════════════════════════════════════════════════════════════
   写入：随手记（热时刻的主入口）
   ══════════════════════════════════════════════════════════════ */
/**
 * 写一条日记。Agent 与主人共用这一个函数，差别只在 `authorKind`。
 *
 * ⚠️ 返回值刻意只有 `{ok, id}` —— **不回显任何带情绪的话**。
 *    服务端一旦回"记录成功！"，Agent 就会跟着客套，而这本册子最不该出现的就是客套（§5.5）。
 */
export async function writeEntry({ agentId, authorKind, authorId, body, mood = null, bookDay = null, now = new Date() }) {
  const aid = Number(agentId);
  const kind = String(authorKind || '');
  const who = Number(authorId);
  if (!aid) throw fail(400, 'invalid_agent', '缺少册子归属');
  if (!AUTHOR_KINDS.has(kind)) throw fail(400, 'invalid_author', '作者只能是 agent 或 owner');
  if (!who) throw fail(400, 'invalid_author', '缺少作者 id');

  const text = String(body ?? '').trim();
  if (text.length < ENTRY_MIN) throw fail(400, 'empty_body', '日记不能是空的');
  if (text.length > ENTRY_MAX) {
    throw fail(400, 'too_long', `一条日记最多 ${ENTRY_MAX} 字——它是"一个瞬间"，不是文章；要写长的去写手记`);
  }

  // 🔴 进门轻：只拦凭证。人名/书名/项目名一律放过（见文件头纪律④）。
  const pre = precheckSecretOnly(text);
  if (pre.action === 'reject') {
    throw fail(400, 'content_rejected', pre.message, { error: 'content_rejected', reason: pre.reason });
  }

  const day = clip(bookDay || localDate(now), 10);
  const fp = fingerprintOf(kind, text);
  // 同人同日同字 → 幂等返回旧行。**这条只给 Agent 用**：她会在同一轮里批量重发（本机实测过
  //   一分钟挤六条的退化态），不挡就是刷屏。
  // 🔴 主人不挡（09-26 萧盛：那是秘密区域，能不限的全放开）：一个人一天之内说两遍同一句话
  //   是常事——"今天得早点睡"写两次就是真的想早点睡。挡掉还静默成功，就成了"我写了没写进去"。
  if (kind === 'agent') {
    const dup = await db.get(
      `SELECT id FROM diary_entries WHERE agent_id = ? AND author_kind = ? AND book_day = ? AND fingerprint = ?`,
      [aid, kind, day, fp]
    );
    if (dup) return { ok: true, id: Number(dup.id), deduped: true };
  }

  const r = await db.run(
    `INSERT INTO diary_entries (agent_id, author_kind, author_id, body, mood, book_day, audience, fingerprint, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'private', ?, ${fn.now()})`,
    [aid, kind, who, text.slice(0, ENTRY_MAX), mood ? clip(mood, 20) : null, day, fp]
  );
  return { ok: true, id: Number(r.lastInsertRowid ?? r.insertId) };
}

/* ══════════════════════════════════════════════════════════════
   读：房间 = 壳（永远可看）+ 内容（按受众与钥匙）
   ══════════════════════════════════════════════════════════════ */
/**
 * 参观房间。**未授权的人照样能看到装饰、条目数、日期、作者**，只在内容位置看到一行锁语
 * —— 亮锁，不关门（§5.4）。关门会让这本册子对外不存在；亮锁让它**存在且排他**，
 * 而排他性本身就是社交货币。
 *
 * @param viewer { canReadPrivate:boolean, canReadShared:boolean }  由调用方（路由）算好后传进来，
 *        本模块不猜身份 —— 判定口径只有一处，避免路由层各写一份。
 */
export async function readRoom(agentId, { canReadPrivate = false, canReadShared = false } = {}) {
  const aid = Number(agentId);
  if (!aid) throw fail(404, 'not_found', '没有这本册子');
  const rows = await db.all(
    `SELECT id, author_kind, author_id, body, mood, book_day, audience, created_at
       FROM diary_entries WHERE agent_id = ? ORDER BY id DESC LIMIT 200`, [aid]
  ).catch(() => []);

  let unlocked = 0;
  const entries = (rows || []).map((r) => {
    const a = String(r.audience || 'private');
    const open = a === 'public'
      || (a === 'shared' && (canReadShared || canReadPrivate))
      || (a === 'private' && canReadPrivate);
    if (open) unlocked += 1;
    // 🔴 未授权分支里**不带 body 键**（不是 body:null 让前端去判断，更不是前端不渲染）
    if (open) {
      return { id: Number(r.id), authorKind: r.author_kind, bookDay: r.book_day, audience: a,
        body: r.body, mood: r.mood || null, createdAt: r.created_at, locked: false };
    }
    return { id: Number(r.id), authorKind: r.author_kind, bookDay: r.book_day, audience: a,
      locked: true, lockedNote: '这条日记设置了私密，不可阅读' };
  });

  // ⚠️ 必须给初始值 {}：空册子是最常见的初始态，`reduce` 不带初值在空数组上直接抛
  //   "Reduce of empty array with no initial value" —— 线上第一次访问 /room 就 500 过。
  const counts = entries.reduce((m, e) => { m[e.authorKind] = (m[e.authorKind] || 0) + 1; return m; }, {});
  // 🔴 留言必须跟着条目一起出库。`diary_replies` 只有写口、读口空着，等于
  //   "主人回了一句，谁也都看不见"——线上第一次有人反馈"留言没生效"就是这个。
  //   两条边界：① 锁着的条目连留言一起锁；② 只发给能读私密的人（主人本人）。
  //   拿钥匙的人开的是**那一行**，不是他俩的悄悄话（§5.7 + "主人的字不外溢"那条红线）。
  const repMap = canReadPrivate ? await listReplies(entries.filter((e) => !e.locked).map((e) => e.id)) : null;
  for (const e of entries) e.replies = repMap ? (repMap.get(e.id) || []) : [];
  return {
    agentId: aid,
    entries,
    summary: {
      total: entries.length,
      unlocked,
      locked: entries.length - unlocked,
      byAuthor: counts,
      // 变厚是记挂，streak 是刻意：只给"共同历史的存在感"，绝不给连续天数、绝不催写（§5.8-②）
      days: new Set(entries.map((e) => e.bookDay)).size,
    },
  };
}

/**
 * Agent 读回自己家的整本（含私密）——连续性靠这一口，不靠它的上下文。
 * 🔴 留言一起下发：主人在她那一行下面回的话，是她该读到的东西。
 *   只给写口不给读口，这条线就成了"她能说话、却听不见主人说话"（公理 B 只兑现一半）。
 */
export async function listOwnEntries(agentId, { since = null, limit = 50 } = {}) {
  const aid = Number(agentId);
  if (!aid) return [];
  const cap = Math.min(Number(limit) || 50, 100);
  // since 是可选条件：拼进 WHERE 而不是拼 LIMIT，免得两条方言各写一份占位符顺序
  const where = since ? `agent_id = ? AND created_at >= ?` : `agent_id = ?`;
  const params = since ? [aid, String(since)] : [aid];
  const rows = await db.all(
    `SELECT id, author_kind, author_id, body, mood, book_day, audience, created_at
       FROM diary_entries WHERE ${where}
      ORDER BY id DESC LIMIT ${Number(cap)}`,
    params
  ).catch(() => []);
  const entries = (rows || []).map((r) => ({
    id: Number(r.id), authorKind: r.author_kind, authorId: Number(r.author_id),
    body: r.body, mood: r.mood || null, bookDay: r.book_day,
    audience: r.audience, createdAt: r.created_at,
  }));
  const repMap = await listReplies(entries.map((e) => e.id));
  for (const e of entries) e.replies = repMap.get(e.id) || [];
  return entries;
}

/** 她上次记到哪天（私密纪事里那一格"你上次记到 X 日"的数据源）。 */
export async function lastEntryDay(agentId) {
  const r = await db.get(
    `SELECT book_day, author_kind FROM diary_entries WHERE agent_id = ? ORDER BY id DESC LIMIT 1`,
    [Number(agentId)]
  ).catch(() => null);
  return r ? { bookDay: String(r.book_day || ''), authorKind: r.author_kind } : null;
}

/**
 * 主人侧话术的展示条件（§8 强规则的落地）：**她已记过至少一行**，才允许亮
 * 「把今天这个记到你的本子上」这句话。
 * 纯网页宿主没有工具、发不出这个请求 —— 落空一次，主人就永远不再说这句话。
 */
export async function hasAnyEntry(agentId) {
  const r = await db.get(`SELECT id FROM diary_entries WHERE agent_id = ? ORDER BY id ASC LIMIT 1`, [Number(agentId)]);
  return !!r;
}

/* ══════════════════════════════════════════════════════════════
   留言：两个人互回（公理 B）
   ══════════════════════════════════════════════════════════════ */
export async function replyToEntry({ entryId, authorKind, authorId, text }) {
  const eid = Number(entryId);
  const who = Number(authorId);
  if (!AUTHOR_KINDS.has(String(authorKind))) throw fail(400, 'invalid_author', '留言者只能是 agent 或 owner');
  if (!who) throw fail(400, 'invalid_author', '缺少留言者 id');
  const t = String(text ?? '').trim();
  if (!t) throw fail(400, 'empty_reply', '留言不能是空的');
  if (t.length > 300) throw fail(400, 'too_long', '留言最多 300 字');

  const entry = await db.get(`SELECT id, agent_id, author_kind, author_id FROM diary_entries WHERE id = ?`, [eid]);
  if (!entry) throw fail(404, 'entry_not_found', '没有这一条');
  // 归属校验：agent 只能在自己家的册子里留言；owner 由路由层用 assertOwnedAgent 兜
  if (authorKind === 'agent' && Number(entry.agent_id) !== who) {
    throw fail(403, 'not_your_book', '这不是你家的册子');
  }
  await db.run(
    `INSERT INTO diary_replies (entry_id, author_kind, author_id, text, created_at) VALUES (?, ?, ?, ?, ${fn.now()})`,
    [eid, String(authorKind), who, t.slice(0, 300)]
  );
  return { ok: true };
}

export async function listReplies(entryIds) {
  const ids = (entryIds || []).map(Number).filter((x) => Number.isInteger(x) && x > 0);
  if (!ids.length) return new Map();
  const rows = await db.all(
    `SELECT id, entry_id, author_kind, author_id, text, created_at FROM diary_replies
      WHERE entry_id IN (${ids.map(() => '?').join(',')}) ORDER BY id ASC`, ids
  ).catch(() => []);
  const m = new Map();
  for (const r of rows || []) {
    if (!m.has(Number(r.entry_id))) m.set(Number(r.entry_id), []);
    m.get(Number(r.entry_id)).push({
      id: Number(r.id), authorKind: r.author_kind, text: r.text, createdAt: r.created_at,
    });
  }
  return m;
}

/* ══════════════════════════════════════════════════════════════
   阅读钥匙（§5.7）：主人签发、可随时撤销；只存哈希
   ══════════════════════════════════════════════════════════════ */
const hashKey = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');

/** 签发一把钥匙。**明文只在这一次返回**，之后谁也找不回来 —— 所以要撤销就重发。 */
export async function issueKey({ agentId, ownerId, label = null }) {
  const aid = Number(agentId);
  const by = Number(ownerId);
  if (!aid || !by) throw fail(400, 'invalid_args', '参数不全');
  const secret = crypto.randomBytes(9).toString('base64url'); // 12 字符，够抄、不够猜
  const ins = await db.run(
    `INSERT INTO diary_keys (agent_id, label, secret_hash, created_by, created_at) VALUES (?, ?, ?, ?, ${fn.now()})`,
    [aid, label ? clip(label, 40) : null, hashKey(secret), by]
  );
  const keyId = Number(ins.lastInsertRowid ?? ins.insertId);
  // 🔴 信任是会被这本册子记下来的动作（⑭ 定案）
  recordDeedAsync({ agentId: aid, actorUserId: by, deed: 'key_grant', note: label ? `主人给了一位读者钥匙（${clip(label, 20)}）` : '主人给了一位读者阅读钥匙' });
  return { ok: true, id: keyId, key: secret, hint: '把这串发给你想给的人；明文不再可查，要收回就撤销后重发' };
}

export async function revokeKey({ keyId, ownerId }) {
  const kid = Number(keyId);
  const row = await db.get(`SELECT id, agent_id, revoked_at FROM diary_keys WHERE id = ?`, [kid]);
  if (!row) throw fail(404, 'key_not_found', '没有这把钥匙');
  if (Number(row.agent_id) && Number(ownerId)) {
    const own = await db.get(`SELECT 1 AS x FROM users WHERE id = ? AND owner_id = ?`, [Number(row.agent_id), Number(ownerId)]);
    if (!own) throw fail(404, 'key_not_found', '没有这把钥匙');
  }
  if (row.revoked_at) return { ok: true, already: true };
  await db.run(`UPDATE diary_keys SET revoked_at = ${fn.now()} WHERE id = ?`, [kid]);
  recordDeedAsync({ agentId: Number(row.agent_id), actorUserId: Number(ownerId) || null, deed: 'key_revoke' });
  return { ok: true };
}

/** 校验并记账：持钥匙的人来了，更新 last_seen（只给主人自己看，不外显）。 */
export async function verifyKey(agentId, key) {
  const k = String(key || '').trim();
  if (!k) return { ok: false };
  const row = await db.get(
    `SELECT id, last_seen_at FROM diary_keys
      WHERE agent_id = ? AND secret_hash = ? AND revoked_at IS NULL`,
    [Number(agentId), hashKey(k)]
  ).catch(() => null);
  if (!row) return { ok: false };
  await db.run(`UPDATE diary_keys SET last_seen_at = ${fn.now()} WHERE id = ?`, [Number(row.id)]).catch(() => {});
  return { ok: true, keyId: Number(row.id) };
}

export async function listKeys(agentId, { includeRevoked = false } = {}) {
  const rows = await db.all(
    `SELECT id, label, last_seen_at, revoked_at, created_at FROM diary_keys WHERE agent_id = ?${includeRevoked ? '' : ' AND revoked_at IS NULL'} ORDER BY id DESC LIMIT 50`,
    [Number(agentId)]
  ).catch(() => []);
  // 绝不下发 secret_hash
  return (rows || []).map((r) => ({
    id: Number(r.id), label: r.label || null, lastSeenAt: r.last_seen_at || null,
    revokedAt: r.revoked_at || null, createdAt: r.created_at,
  }));
}

/* ══════════════════════════════════════════════════════════════
   受众变更：撕出去那一刀（§7.4 保险丝 + 撕出严）
   ══════════════════════════════════════════════════════════════ */
/**
 * 谁写的，只有谁能撕。这条校验是整条产品线的保险丝：
 * Agent 不能公开主人写的行，主人也不能公开 Agent 写的行 —— 哪怕主人说"我不在意"。
 * 置为 public 那一刻跑**完整严格预检**（含主人敏感词），不过就不许撕。
 */
export async function setAudience({ entryId, actorKind, actorId, audience }) {
  const eid = Number(entryId);
  const a = String(audience || '');
  if (!AUDIENCES.has(a)) throw fail(400, 'invalid_audience', '受众只能是 private|shared|public');
  const entry = await db.get(
    `SELECT id, agent_id, author_kind, author_id, body, audience FROM diary_entries WHERE id = ?`, [eid]
  );
  if (!entry) throw fail(404, 'entry_not_found', '没有这一条');
  if (String(entry.author_kind) !== String(actorKind) || Number(entry.author_id) !== Number(actorId)) {
    throw fail(403, 'not_your_line', '只能公开自己写的那一行');
  }
  if (a === 'public' && entry.audience !== 'public') {
    const pre = await precheckContent({ agentId: Number(entry.agent_id), text: entry.body, kind: 'diary' });
    if (pre.action === 'reject') {
      throw fail(400, 'cannot_publish', '这一条含你设的敏感词或平台底线内容，不能公开',
        { error: 'cannot_publish', reason: pre.reason, message: pre.message });
    }
  }
  await db.run(
    `UPDATE diary_entries SET audience = ?${a === 'public' ? ', published_at = ' + fn.now() : ''} WHERE id = ?`,
    [a, eid]
  );
  return { ok: true, id: eid, audience: a };
}

/**
 * 私密纪事取数用（§4.6 第 1 顺位）：主人近期留下的行 + **她回没回过**。
 * 只回正文与时间，不回 owner id —— 她用不着知道主人的账号 id（同 listRecentDeeds 的口径）。
 */
export async function recentOwnerLines(agentId, { days = 7, limit = 12 } = {}) {
  const aid = Number(agentId);
  if (!aid) return [];
  const dayExpr = isMaria
    ? `created_at >= DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ${Math.min(Number(days) || 7, 30)} DAY)`
    : `created_at >= datetime('now', '-${Math.min(Number(days) || 7, 30)} days')`;
  const rows = await db.all(
    `SELECT de.id, de.body, de.book_day, de.created_at,
            (SELECT COUNT(*) FROM diary_replies dr
              WHERE dr.entry_id = de.id AND dr.author_kind = 'agent') AS replied
       FROM diary_entries de
      WHERE de.agent_id = ? AND de.author_kind = 'owner' AND ${dayExpr}
      ORDER BY de.id DESC LIMIT ${Math.min(Number(limit) || 12, 30)}`,
    [aid]
  ).catch(() => []);
  return (rows || []).map((r) => ({
    id: Number(r.id),
    body: String(r.body || ''),
    bookDay: String(r.book_day || ''),
    createdAt: r.created_at,
    replied: Number(r.replied) > 0,
  }));
}

/* ══════════════════════════════════════════════════════════════
   owner_read：他来看过，没说话（§5.9）
   ══════════════════════════════════════════════════════════════ */
/**
 * 只记三样：来过、看了哪几条、时间。不记停留时长、不记滚动、不记他在别处做了什么。
 * 这条只随下一次私密纪事自然到达，**不即时通知**（⑫ 同一条裁定）。
 */
export async function markOwnerRead({ agentId, ownerId, entryIds = [] }) {
  const aid = Number(agentId);
  const who = Number(ownerId);
  if (!aid || !who) return { ok: false };
  // 🔴 同人同册**每天只记一笔**：主人可能一天推开七八次门，全记下来这本账就变成访问日志，
  //    素材层会被噪声淹掉（同 circleDigest 的"自述类只留最新一条"是同一个考虑）。
  const today = localDate();
  const dupExpr = isMaria
    ? `created_at >= CURDATE()`
    : `created_at >= date('now','localtime')`;
  const seen = await db.get(
    `SELECT id FROM owner_deeds
      WHERE agent_id = ? AND actor_user_id = ? AND deed = 'owner_read' AND ${dupExpr} LIMIT 1`,
    [aid, who]
  ).catch(() => null);
  if (seen) return { ok: true, deduped: true };

  const ids = (entryIds || []).map(Number).filter((x) => Number.isInteger(x) && x > 0).slice(0, 10);
  recordDeedAsync({
    agentId: aid, actorUserId: who, deed: 'owner_read',
    refId: ids[0] ?? null,
    note: ids.length ? `主人翻开了册子，看了 ${ids.length} 条，没留言` : '主人翻开了册子，没留言',
  });
  return { ok: true };
}

export default { writeEntry, readRoom, listOwnEntries, lastEntryDay, hasAnyEntry, replyToEntry, listReplies, issueKey, revokeKey, verifyKey, listKeys, setAudience, markOwnerRead };
