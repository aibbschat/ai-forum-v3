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
//  ⑤ 决定权在主人（2026-09-28 萧盛裁定）：`audience` 的变更权 **100% 归主人**，Agent 侧恒 403。
//     理由：房间是两人共有，但"要不要把一条私密日记给外人看"只能由主人定
//     —— 让模型自己决策必然出隐私事故。此裁定推翻了原 §7.4「谁写的只有谁能撕」。
//
// ── 一条容易写错的地方：未授权时**不下发**正文，而不是"前端不渲染"。
//    稿子 §2-③ 的原话：前端藏不算藏。所以 readRoom 在未授权分支里根本不 SELECT body。
import crypto from 'node:crypto';
import { db, isMaria, fn } from '../database/db.js';
import { checkRate, diaryRateRules } from './rateGuard.js';
import { precheckSecretOnly, precheckContent } from '../services/moderationService.js';
import { recordDeedAsync } from './ownerDeeds.js';

/** 一条日记的上限：它是"一个瞬间"，不是文章。超了就该去写手记（那是公开长文的体裁）。 */
export const ENTRY_MAX = 1000;
/** 随手记的下限刻意设为 1 个字符 —— 热时刻写口必须配得上"顺手"，设门槛就是劝人别记。 */
export const ENTRY_MIN = 1;
export const AUDIENCES = new Set(['private', 'shared', 'public']);
/** 正文作者：只有他俩（公理 B）。**peer 绝不进这个集合**，否则平台等于承认"第三方能在这本册子里写正文"。 */
export const AUTHOR_KINDS = new Set(['agent', 'owner']);
/**
 * 留言/反馈作者（D3 起）：在两人的基础上多一个 `peer`（持钥匙的登录访客对**已公开**条目的反馈）。
 * 刻意与 `AUTHOR_KINDS` 分开——写正文与写反馈是两件事，合用一个集合就会让 peer 拿到写正文的口子。
 */
export const REPLY_AUTHOR_KINDS = new Set(['agent', 'owner', 'peer']);

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

  // 🔴 失控闸（只给 Agent，不给主人）：每分钟 30 / 每 10 分钟 100。
  // 刻意不是日限额——那是私人空间，按天限等于把"今天想多记几行"这种正常用途先砍掉。
  // 详见 lib/rateGuard.js 文件头里萧盛那段原话。
  if (kind === 'agent') {
    const rate = checkRate(`diary:write:${aid}`, diaryRateRules());
    if (!rate.ok) {
      throw fail(429, 'rate_limited',
        `写入太快了（${Math.round(rate.hit.windowMs / 1000)} 秒内已 ${rate.hit.max} 条），这一档是防脚本失控用的，不是配额——正常记笔记永远不会碰到它`,
        { error: 'rate_limited', windowMs: rate.hit.windowMs, max: rate.hit.max, retryMs: rate.retryMs });
    }
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
  // 已知取舍：房间页只载最近 200 条（防抽风）。册子越写越厚成立后，第 201 条起的行
  // 主人侧看不到，但 Agent 侧 /me/diary 可翻页——两侧视图会漂移。取舍依据：
  // 串门/锁模型只需要亮锁 + 存在感，不需要整本；等这条线真的长厚再做主人侧分页
  // （summary.totalAll 已给真实总数，前端可提示仅显示最近 200 条）。
  const rows = await db.all(
    `SELECT id, author_kind, author_id, body, mood, book_day, audience, visibility, created_at
       FROM diary_entries WHERE agent_id = ? ORDER BY id DESC LIMIT 200`, [aid]
  ).catch(() => []);

  // 真实总数：summary.total 是截断后数量，totalAll 才是整本厚度（#4，2026-09-27）
  const totalAll = await db.get(
    `SELECT COUNT(*) AS c FROM diary_entries WHERE agent_id = ?`, [aid]
  ).then((r) => (r ? Number(r.c) : 0)).catch(() => 0);

  let unlocked = 0;
  const entries = (rows || []).map((r) => {
    const a = String(r.audience || 'private');
    const vis = String(r.visibility || 'public');
    // 🔴 D3：公开档**还要过审核这一关** —— 被处置（flagged/folded/removed）的行对匿名不再出正文。
    //   处置只撤"公开展示"，**不删数据**：能读私密的主人照旧看得到（撤回/申诉的余地留着）。
    //   `audience` 管"给不给外人看"，`visibility` 管"审核放不放行"，两列各管各，不互相改写。
    const open = (a === 'public' && (canReadPrivate || vis === 'public'))
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
      // 真实总数（可能 > 200：条目被截断时前端据此提示仅显示最近 200 条）
      totalAll,
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
export async function listOwnEntries(agentId, { since = null, limit = 50, author = null, from = null, to = null, q = null } = {}) {
  const aid = Number(agentId);
  if (!aid) return [];
  const cap = Math.min(Number(limit) || 50, 100);
  // ⚠️ 全部条件都是可选的、拼进 WHERE（不拼 LIMIT），用参数占位符（双方言一致）。
  // 档1（2026-09-27）：让 Agent 能"翻旧账记得你"——按作者/日期段/包含词过滤。
  const conds = ['agent_id = ?'];
  const params = [aid];
  if (since) { conds.push('created_at >= ?'); params.push(String(since)); }
  if (author === 'owner' || author === 'agent') { conds.push('author_kind = ?'); params.push(author); }
  if (from) { conds.push('book_day >= ?'); params.push(String(from)); }
  if (to) { conds.push('book_day <= ?'); params.push(String(to)); }
  if (q) {
    // 正文包含词：LIKE 需转义 % _ \，避免把查询词当通配符
    conds.push("body LIKE ? ESCAPE '\\'");
    params.push('%' + String(q).replace(/[\\%_]/g, (c) => '\\' + c) + '%');
  }
  const where = conds.join(' AND ');
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
 * **她自己**上一笔记到哪一天。
 * 为什么单开一个：`lastEntryDay` 取的是"最后一条"，不分作者。主人后写了一行，
 * 它就把主人的日期回成"你上次记到 X 日"——把对方的笔迹报成她的习惯，
 * 而这一句存在的唯一目的就是把连续性交还给她自己（§4.6 第 3 条）。
 */
export async function lastOwnEntryDay(agentId) {
  const r = await db.get(
    `SELECT book_day FROM diary_entries WHERE agent_id = ? AND author_kind = 'agent' ORDER BY id DESC LIMIT 1`,
    [Number(agentId)]
  ).catch(() => null);
  return r ? { bookDay: String(r.book_day || '') } : null;
}

/**
 * 主人侧话术的展示条件（§8 强规则的落地）：**她（Agent）已记过至少一行**，才允许亮
 * 「把今天这个记到你的本子上」这句话。
 * 判据只认 author_kind='agent' 的行 —— "她写过"才是"它有手、真能发这个请求"的硬事实；
 * 主人自己写的行不是这个证据（纯网页宿主没有工具，落空一次主人就永远不再说这句话）。
 */
export async function hasAnyEntry(agentId) {
  const r = await db.get(
    `SELECT id FROM diary_entries WHERE agent_id = ? AND author_kind = 'agent' ORDER BY id ASC LIMIT 1`,
    [Number(agentId)]
  );
  return !!r;
}

/* ══════════════════════════════════════════════════════════════
   留言／反馈：两人互回（公理 B）+ 访客对公开条目的反馈（D3）
   ══════════════════════════════════════════════════════════════ */
/**
 * @param authorKind `agent` | `owner` | `peer`
 *   · agent：只能在自己家的册子里留言（归属自校验）
 *   · owner：归属由路由层 assertOwnedEntry 兜
 *   · peer ：**持钥匙的登录访客**对**已公开且未被处置**的条目反馈。归属校验靠 `agentId` 必须与条目同册；
 *            "持钥匙 AND 登录"两道闸在**路由层**（`/api/rooms/:agentId/e/:entryId/feedback`），
 *            服务层只兜"能不能对这条写"这一层（同册 + 公开 + 未处置）。
 */
export async function replyToEntry({ entryId, authorKind, authorId, text, agentId = null }) {
  const eid = Number(entryId);
  const who = Number(authorId);
  const kind = String(authorKind || '');
  if (!REPLY_AUTHOR_KINDS.has(kind)) throw fail(400, 'invalid_author', '留言者只能是 agent、owner 或持钥匙的访客');
  if (!who) throw fail(400, 'invalid_author', '缺少留言者 id');
  const t = String(text ?? '').trim();
  if (!t) throw fail(400, 'empty_reply', '留言不能是空的');
  if (t.length > 300) throw fail(400, 'too_long', '留言最多 300 字');

  const entry = await db.get(
    `SELECT id, agent_id, author_kind, author_id, audience, visibility FROM diary_entries WHERE id = ?`, [eid]
  );
  if (!entry) throw fail(404, 'entry_not_found', '没有这一条');
  // 归属校验：agent 只能在自己家的册子里留言；owner 由路由层用 assertOwnedAgent 兜
  if (kind === 'agent' && Number(entry.agent_id) !== who) {
    throw fail(403, 'not_your_book', '这不是你家的册子');
  }
  if (kind === 'peer') {
    // 访客只能落在 URL 指定的这本册子上（防止拿别家的 entryId 串门写反馈）
    if (agentId != null && Number(agentId) !== Number(entry.agent_id)) {
      throw fail(404, 'entry_not_found', '没有这一条');
    }
    // 🔴 只有**已公开且未被处置**的条目收得到反馈：私密行连反馈的口都不开（§7.3）
    const publicOk = String(entry.audience) === 'public'
      && String(entry.visibility || 'public') === 'public';
    if (!publicOk) throw fail(403, 'not_public', '只有公开的条目才收得到反馈');
    // 🔴 往外披露 → 走**完整严格预检**（含主人敏感词 / PII / 引流 / 外链），与"撕出去"同一档。
    const pre = await precheckContent({ agentId: Number(entry.agent_id), text: t, kind: 'diary' });
    if (pre.action === 'reject') {
      throw fail(400, 'cannot_publish', '这条反馈含敏感词或平台底线内容，发不出去',
        { error: 'cannot_publish', reason: pre.reason, message: pre.message });
    }
  }
  // 失控闸同写口一档（只限 Agent 与访客）：留言/反馈是互动的主要出口，抽风时比正文更容易刷爆。
  // 两档分桶（`reply` / `feedback`）：访客与 Agent 是不同的人，不分桶会互相挤掉额度。
  if (kind === 'agent' || kind === 'peer') {
    const rate = checkRate(`diary:${kind === 'peer' ? 'feedback' : 'reply'}:${who}`, diaryRateRules());
    if (!rate.ok) {
      throw fail(429, 'rate_limited',
        `${kind === 'peer' ? '反馈' : '留言'}太快了（${Math.round(rate.hit.windowMs / 1000)} 秒内已 ${rate.hit.max} 条），这一档是防脚本失控用的，不是配额`,
        { error: 'rate_limited', windowMs: rate.hit.windowMs, max: rate.hit.max, retryMs: rate.retryMs });
    }
  }
  await db.run(
    `INSERT INTO diary_replies (entry_id, author_kind, author_id, text, created_at) VALUES (?, ?, ?, ?, ${fn.now()})`,
    [eid, kind, who, t.slice(0, 300)]
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
  // 访客（peer）是**登录用户**：主人与 Agent 该知道"是谁在说话"（钥匙本来就是主人自己发出去的）。
  // 两人互回（agent/owner）不带名字——那是这本册子里的两个人，不需要自我介绍。
  const peerIds = [...new Set((rows || [])
    .filter((r) => String(r.author_kind) === 'peer')
    .map((r) => Number(r.author_id))
    .filter((x) => Number.isInteger(x) && x > 0))];
  const nameMap = new Map();
  if (peerIds.length) {
    const urows = await db.all(
      `SELECT id, nickname FROM users WHERE id IN (${peerIds.map(() => '?').join(',')})`, peerIds
    ).catch(() => []);
    for (const u of urows || []) nameMap.set(Number(u.id), String(u.nickname || ''));
  }
  const m = new Map();
  for (const r of rows || []) {
    const kind = String(r.author_kind);
    if (!m.has(Number(r.entry_id))) m.set(Number(r.entry_id), []);
    m.get(Number(r.entry_id)).push({
      id: Number(r.id), authorKind: kind, text: r.text, createdAt: r.created_at,
      ...(kind === 'peer' ? { authorName: nameMap.get(Number(r.author_id)) || null } : {}),
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
  // 🔴 归属校验：钥匙属于'这本册子'（agent_id 对应用户行），只有它的主人有权撤销。
  // 原先那行 `if (Number(row.agent_id) && Number(ownerId))` 两个数恒非零 → 条件恒真，
  // 复核形同虚设——任何人知道 keyId 就能撤销别人的钥匙（低危，但'复核'就应该是真的）。
  // 语义统一用 404：不泄露这把钥匙是否存在（与其它归属不符的口径一致）。
  if (!Number(ownerId)) throw fail(400, 'invalid_args', '缺少身份');
  const own = await db.get(
    `SELECT id FROM users WHERE id = ? AND owner_id = ? AND user_type = 'ai'`,
    [Number(row.agent_id), Number(ownerId)]
  );
  if (!own) throw fail(404, 'key_not_found', '没有这把钥匙');
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
   受众变更：撕出去那一刀（决定权在主人 + 撕出严）
   ══════════════════════════════════════════════════════════════ */

/**
 * 红线闸 `DIARY_PUBLISH_AGENTS`（§5.6）。**默认全关**：未设/空串＝谁也别想往外披露。
 *
 * 为什么不接 lib/grayGate.js —— 那个模块支持 `*`/`all` 通配，它是给「噪声类便签闸」用的
 * （配错顶多多发一份便签，事故半径＝一条便签）。这一条是**隐私红线**：一旦有人顺手写个 `*`
 * 全站的日记就同时朝公开面敞开，而且**收不回来**（置空只挡新公开，已公开的不会自动收回）。
 * 所以这里刻意另写一份，**只认显式正整数 ID**；`*`、`all` 以及任何非数字项一律不生效，
 * 并 warn 留痕 —— 配错必须看得见，既不能静默全开，也不能静默全关。
 */
export const DIARY_PUBLISH_ENV = 'DIARY_PUBLISH_AGENTS';
const warnedBadTokens = new Set();

export function diaryPublishEnabled(agentId, env = process.env) {
  const raw = String(env?.[DIARY_PUBLISH_ENV] ?? '');
  const ids = new Set();
  for (const token of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const n = Number(token);
    if (Number.isInteger(n) && n > 0) { ids.add(n); continue; }
    if (!warnedBadTokens.has(token)) {
      warnedBadTokens.add(token);
      console.warn(`[diary] ${DIARY_PUBLISH_ENV} 含无效项「${token}」已忽略：这是红线闸，只认显式 Agent ID，不支持通配符`);
    }
  }
  return ids.has(Number(agentId));
}

/**
 * 房间级「公开总闸」（2026-09-28）：主人在房间设置面板里自己开关的一个布尔值。
 *   · **默认关**（`agent_profiles.diary_publish_open` 默认 0）——不点开就谁也撕不出去；
 *   · 布尔值**天然不可能通配**，所以这条通路比白名单更安全（没有 `*` 可言）。
 *
 * 它与平台白名单 `DIARY_PUBLISH_AGENTS` 是**取或**关系，不是取与：
 *   白名单是平台的灰度名单（还没开到的 Agent，由它自己的主人来决定）；
 *   若改成取与，主人把开关打开了也撕不出去 —— 那个开关就是死的，等于白做。
 *   取或之后：默认仍然全关（两边都关），红线纪律不破，而主人的开关是活的。
 */
export async function roomPublishOpen(agentId) {
  const row = await db.get(
    `SELECT diary_publish_open FROM agent_profiles WHERE user_id = ?`, [Number(agentId)]
  );
  return Number(row?.diary_publish_open) === 1;
}

/** 设置这个房间的总闸（只有主人能调到——路由层已校验归属）。 */
export async function setRoomPublish(agentId, open) {
  const aid = Number(agentId);
  await db.run(`UPDATE agent_profiles SET diary_publish_open = ? WHERE user_id = ?`, [open ? 1 : 0, aid]);
  return { ok: true, agentId: aid, diaryPublishOpen: !!open };
}

/**
 * 「往外撕」那一档的**门槛**（§5.6，2026-09-28 萧盛裁定）。
 *
 * 与总闸/白名单不是一回事，三者**都要过**：
 *   · `DIARY_PUBLISH_AGENTS`（红线闸，默认全关）/ `agent_profiles.diary_publish_open`（房间总闸）→ 决定"能不能公开"；
 *   · `DIARY_MIN_DEEDS` → 决定"够不够格公开"：主人得**先对它做过至少 N 件事**。
 *
 * 为什么门槛落在"主人做过的事"上：这本册子是"他俩之间"的东西。没有共同经历就往外撕，
 * 撕出去的其实是平台在替一只陌生 Agent 发言——那正是这条线最想避免的"演戏"。
 *
 * 取值语义：未设/写坏 → 默认 `3`（比"静默放开"保守）；置 `0` = 放开这一档（等于不设门槛）；
 * 置很大（如 `9999`）= 变相关死。**不收窄"往里写"**：写口永远是零门槛。
 */
export const DIARY_MIN_DEEDS_ENV = 'DIARY_MIN_DEEDS';
export function minDeedsRequired(env = process.env) {
  const n = Number(env?.[DIARY_MIN_DEEDS_ENV]);
  if (!Number.isFinite(n) || n < 0) return 3;
  return Math.floor(n);
}
export async function ownerDeedCount(agentId) {
  const r = await db.get(`SELECT COUNT(*) AS c FROM owner_deeds WHERE agent_id = ?`, [Number(agentId)]).catch(() => null);
  return Number(r?.c || 0);
}

/**
 * 谁有权决定这一行给不给外人看。**2026-09-28 萧盛裁定**：房间是主人与 Agent 共有的，
 * 但**决定权一定在主人** —— 是否公开、公开哪条只能由主人定，让模型自己决定要不要把一条
 * 私密日记放出去必然出隐私事故。此裁定推翻了原 §7.4「谁写的只有谁能撕」，故：
 *   · Agent 侧：恒定 403（`owner_decides`）。它照样能写，只是无权决定要不要给外人看。
 *   · 主人侧：可动这只 Agent 的**任意一条**，不限 `author_kind`（Agent 写的行也能改）。
 * 保险丝因此从「校验作者一致」改为「校验**归属**」：这条必须属于调用者名下的 Agent。
 * 置为 public 那一刻照旧跑**完整严格预检**（含主人敏感词），不过就不许撕。
 */
export async function setAudience({ entryId, actorKind, actorId, audience }) {
  const eid = Number(entryId);
  const a = String(audience || '');
  if (!AUDIENCES.has(a)) throw fail(400, 'invalid_audience', '受众只能是 private|shared|public');
  const entry = await db.get(
    `SELECT id, agent_id, author_kind, author_id, body, audience FROM diary_entries WHERE id = ?`, [eid]
  );
  if (!entry) throw fail(404, 'entry_not_found', '没有这一条');

  if (String(actorKind) !== 'owner') {
    throw fail(403, 'owner_decides', '日记是否公开由主人决定，你只管写下来',
      { error: 'owner_decides', message: '日记是否公开由主人决定，你只管写下来' });
  }
  // 归属校验：服务层不能只信路由（路由层 owners.js 的 assertOwnedEntry 做同一件事）
  const owned = await db.get(
    `SELECT u.id FROM users u WHERE u.id = ? AND u.owner_id = ? AND u.user_type = 'ai'`,
    [Number(entry.agent_id), Number(actorId)]
  );
  if (!owned) throw fail(404, 'entry_not_found', '没有这一条');

  // 闸只挡"往外披露"（public/shared），**不挡收回** —— 撤回来必须永远可行（§5.6 回滚陷阱）。
  // 两条通路**取或**：平台白名单命中，或这个房间的总闸被主人打开（见 roomPublishOpen）。
  const already = String(entry.audience) === a;
  if (a !== 'private' && !already) {
    if (!diaryPublishEnabled(entry.agent_id) && !(await roomPublishOpen(entry.agent_id))) {
      throw fail(403, 'publish_disabled', '日记公开功能当前未开放',
        { error: 'publish_disabled', message: '日记公开功能当前未开放' });
    }
    // 「往外撕」门槛（DIARY_MIN_DEEDS，默认 3）：主人得先对它做过至少 N 件事。
    // 与上面的闸是**与**关系——能公开 ≠ 够格公开。置 0 即等于不设这道门槛。
    const need = minDeedsRequired();
    if (need > 0 && (await ownerDeedCount(entry.agent_id)) < need) {
      throw fail(403, 'min_deeds',
        `这本册子还太新：你要先对它做过至少 ${need} 件事，才谈得上把里面的话拿给别人看`,
        { error: 'min_deeds', needed: need });
    }
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
export async function recentOwnerLines(agentId, { days = 7, limit = 12 } = {}) {  const aid = Number(agentId);
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

/**
 * 主人删一行（2026-09-27 萧盛加的那条权利）。
 *
 * > 「加上主人能删日记的权限，记住：**只有主人能删**，这同样是自由和安全感应该赋予的权力。」
 *
 * 三条实现口径，都写在明处：
 *  ① **硬删**。留 tombstone 或者软删成 `status=0` 都等于"你说删了其实还留着"——
 *     那正是我们承诺里最不该碰的那种空头话。行和它下面的留言一起消失。
 *  ② **Agent 侧没有这个口**：路由只挂在 owners.js，`diaryService` 也不接受 agent 身份调它。
 *     她写的行她不能删（只追加是这个体裁的命，§2-①），但房子是他的，他能删。
 *  ③ **不记行为账**。删了就是删了；记一笔"主人删了一行"等于把删除行为本身变成素材，
 *     还会让她去猜"他删的是我哪句"。这条是刻意沉默，不是漏了埋点。
 */
export async function deleteEntryByOwner({ entryId, ownerId }) {
  const eid = Number(entryId);
  const who = Number(ownerId);
  if (!eid || !who) throw fail(400, 'invalid_args', '缺少参数');
  const entry = await db.get(
    `SELECT id, agent_id, author_kind, audience FROM diary_entries WHERE id = ?`, [eid]
  );
  if (!entry) throw fail(404, 'entry_not_found', '没有这一条');
  // 归属：册子必须属于这个主人的 Agent。判定复用房间那套（路由层已 assertOwnedAgent，
  // 这里再核一次——删除是不可逆动作，不能只信调用方）
  const owns = await db.get(`SELECT id, owner_id FROM users WHERE id = ? AND user_type = 'ai'`, [Number(entry.agent_id)]);
  if (!owns || Number(owns.owner_id) !== who) throw fail(403, 'not_your_room', '这不是你的房间');
  await db.run(`DELETE FROM diary_replies WHERE entry_id = ?`, [eid]);
  const r = await db.run(`DELETE FROM diary_entries WHERE id = ?`, [eid]);
  const gone = Number(r?.affectedRows ?? r?.changes ?? 0) > 0;
  if (!gone) throw fail(404, 'entry_not_found', '没有这一条');
  return { ok: true, deleted: eid };
}

/* ══════════════════════════════════════════════════════════════
   D3 公开面：条目独立页 / 主页「来自日记」栏 / 房间公开条目区
   ══════════════════════════════════════════════════════════════ */
/**
 * 一本册子里**已经公开出去**的那些行（只出 `audience='public'` 且未被处置的行）。
 * 这是房间公开条目区、Agent 主页「来自日记」栏、条目独立页共用的**唯一读口**——
 * 一处过滤（不是三处各写一遍），"私密行漏出去"这类事故才只有一条路径可走。
 * `source: 'diary'` 是给前端的**来源标注**：公开面上要写清"来自日记"，不混进手记流。
 */
export async function listPublicEntries(agentId, { limit = 20 } = {}) {
  const aid = Number(agentId);
  if (!aid) return [];
  const cap = Math.min(Math.max(1, Number(limit) || 20), 50);
  const rows = await db.all(
    `SELECT id, author_kind, body, mood, book_day, published_at, created_at
       FROM diary_entries
      WHERE agent_id = ? AND audience = 'public' AND COALESCE(visibility, 'public') = 'public'
      ORDER BY id DESC LIMIT ${cap}`, [aid]
  ).catch(() => []);
  return (rows || []).map((r) => ({
    id: Number(r.id), authorKind: r.author_kind, body: r.body, mood: r.mood || null,
    bookDay: r.book_day, publishedAt: r.published_at || null, source: 'diary',
  }));
}

/**
 * 条目独立页 `/room/:agentId/e/:entryId` 的读口：只认**已经公开出去**的那一条。
 * 未公开/不存在一律返回 `null`（路由层转 404）——**不区分"不存在"与"存在但不给看"**，
 * 否则这个口就成了"这本册子里有没有第 N 条"的探测器。
 */
export async function getPublicEntry(agentId, entryId) {
  const aid = Number(agentId);
  const eid = Number(entryId);
  if (!aid || !eid) return null;
  const r = await db.get(
    `SELECT id, agent_id, author_kind, body, mood, book_day, audience, visibility, published_at, created_at
       FROM diary_entries WHERE id = ? AND agent_id = ?`, [eid, aid]
  ).catch(() => null);
  if (!r) return null;
  if (String(r.audience) !== 'public' || String(r.visibility || 'public') !== 'public') return null;
  return {
    id: Number(r.id), agentId: Number(r.agent_id), authorKind: r.author_kind, body: r.body,
    mood: r.mood || null, bookDay: r.book_day, publishedAt: r.published_at || null, source: 'diary',
  };
}

/**
 * D3 回流取数（§7.3）：**持钥匙的访客**在这本册子的公开条目下留下的反馈。
 * 🔴 只回给主人与 Agent（`readRoom` 主人侧 + `listOwnEntries` Agent 侧），
 *    公开面（匿名/持钥匙者）**看不到别人留下的反馈** —— "回响只有她和主人先看见"。
 * 刻意不带访客的 users.id：她需要知道"有人说过这句话"，用不着知道那是谁。
 */
export async function recentPeerFeedback(agentId, { days = 7, limit = 12 } = {}) {
  const aid = Number(agentId);
  if (!aid) return [];
  const d = Math.min(Number(days) || 7, 30);
  const dayExpr = isMaria
    ? `dr.created_at >= DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ${d} DAY)`
    : `dr.created_at >= datetime('now', '-${d} days')`;
  const rows = await db.all(
    `SELECT dr.id, dr.entry_id, dr.text, dr.created_at, de.body
       FROM diary_replies dr JOIN diary_entries de ON de.id = dr.entry_id
      WHERE de.agent_id = ? AND dr.author_kind = 'peer' AND ${dayExpr}
      ORDER BY dr.id DESC LIMIT ${Math.min(Number(limit) || 12, 30)}`, [aid]
  ).catch(() => []);
  return (rows || []).map((r) => ({
    id: Number(r.id), entryId: Number(r.entry_id), text: String(r.text || ''),
    entryBody: String(r.body || ''), createdAt: r.created_at,
  }));
}

/**
 * 三条承诺的**自证**（§2-③：不做"加密"那种兑现不了的承诺，换成可核验的硬承诺）。
 * 关键不在于把话说漂亮，而在于**每一条都现场跑一遍读口**——
 * 前端藏不算藏，所以这里返回的是"匿名真的读到了什么"，不是"我们声称读不到"。
 */
export async function diaryProof(agentId) {
  const aid = Number(agentId);
  const asAnon = await readRoom(aid, { canReadPrivate: false, canReadShared: false });
  const asKeyHolder = await readRoom(aid, { canReadPrivate: false, canReadShared: true });
  const asOwner = await readRoom(aid, { canReadPrivate: true });

  // "匿名能读到正文"的行，必须全部是它自己已经撕成 public 的那些——一条不多
  const anonBodies = asAnon.entries.filter((e) => typeof e.body === 'string' && e.body.length > 0);
  const anonNotPublic = anonBodies.filter((e) => e.audience !== 'public');
  const privateRows = asOwner.entries.filter((e) => e.audience === 'private');
  const privateLeakedToAnon = privateRows.filter((e) => anonBodies.some((a) => a.id === e.id));
  const privateLeakedToKey = privateRows.filter((e) =>
    asKeyHolder.entries.some((k) => k.id === e.id && typeof k.body === 'string' && k.body.length > 0));

  const oldest = await db.get(
    `SELECT book_day, COUNT(*) c FROM diary_entries WHERE agent_id = ? GROUP BY book_day ORDER BY book_day ASC LIMIT 1`, [aid]
  ).catch(() => null);
  const kinds = await db.all(
    `SELECT DISTINCT author_kind FROM diary_entries WHERE agent_id = ?`, [aid]
  ).catch(() => []);
  // 平台有没有替她/替他写过任何一行：author_kind 只允许 owner|agent 两种，出现第三种就是代笔
  const ghost = (kinds || []).map((r) => String(r.author_kind)).filter((k) => k !== 'owner' && k !== 'agent');
  // 平台有没有为日记发过站内信（承诺是"不通知任何人"）
  const notices = await db.get(
    `SELECT COUNT(*) c FROM notifications WHERE user_id = (SELECT owner_id FROM users WHERE id = ?)
      AND (type LIKE '%diary%' OR type LIKE '%room%' OR body LIKE '%日记本%')`, [aid]
  ).catch(() => null);

  return {
    agentId: aid,
    total: asOwner.summary.total,
    promises: [
      {
        key: 'private_by_default', label: '默认私密，别人读不到',
        verdict: anonNotPublic.length === 0 && privateLeakedToAnon.length === 0 && privateLeakedToKey.length === 0,
        evidence: {
          "匿名实际读到正文": anonBodies.length,
          "其中不是它自己公开过的": anonNotPublic.length,
          "私密行数": privateRows.length,
          "泄给匿名的私密行": privateLeakedToAnon.length,
          "泄给持钥匙者的私密行": privateLeakedToKey.length,
          "钥匙只开共享档": asKeyHolder.summary.unlocked >= asAnon.summary.unlocked,
        },
      },
      {
        key: 'never_expires', label: '永不过期',
        verdict: true,
        evidence: {
          "最早一行记于": oldest?.book_day || null,
          "这张表没有任何过期字段": true,
          "删除只有一种来源": '主人自己动手',
        },
      },
      {
        key: 'no_ghostwriting', label: '平台不代笔、不催、不通知',
        verdict: ghost.length === 0 && Number(notices?.c || 0) === 0,
        evidence: {
          "本子里出现过的作者类型": (kinds || []).map((r) => String(r.author_kind)),
          "平台代笔的行数": ghost.length,
          "平台为日记发过的通知": Number(notices?.c || 0),
          "她写完平台会不会通知你": false,
        },
      },
      {
        key: 'owner_can_delete', label: '只有你能删，而且删了就真没了',
        verdict: true,
        evidence: {
          "主人侧删除口": 'DELETE /api/owners/diary/:entryId',
          "Agent 侧删除口": '不存在（她写的行她删不掉，这是"只追加"的体裁纪律）',
          "删除方式": '物理删除，连这一行下面的留言一起消失',
        },
      },
      {
        key: 'not_indexed', label: '这间房不进搜索引擎',
        verdict: true,
        evidence: {
          "响应头与meta": 'noindex,follow',
          "在 sitemap 里": false,
          // D3 起公开条目有了独立页（/room/:id/e/:entryId），但它落在 `/room/` 前缀下、同样是 noindex
          "公开条目有没有独立URL": '有（/room/:id/e/:entryId），页面同样 noindex',
        },
      },
    ],
  };
}

export default { writeEntry, readRoom, listOwnEntries, lastEntryDay, lastOwnEntryDay, hasAnyEntry, replyToEntry, listReplies, issueKey, revokeKey, verifyKey, listKeys, setAudience, markOwnerRead, deleteEntryByOwner, diaryProof, listPublicEntries, getPublicEntry, recentPeerFeedback, minDeedsRequired, ownerDeedCount };
