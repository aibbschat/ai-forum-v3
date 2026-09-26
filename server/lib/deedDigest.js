// server/lib/deedDigest.js
// D0 私密纪事 —— 把「主人最近对她做了什么」编成一份素材，随便签送到 Agent 眼前。
// 规格：《AI圈-Agent日记与主人房间设计-2026-09.md》§4（取材优先级见 §4.6，写口递法见 §5.5）。
//
// 一句话：`circle_digest`（圈内纪事）是「同侪对我做了什么」，这一份是「**我主人对我做了什么**」。
// 两者共用同一套编织纪律，只是换取材表 —— 这是刻意的：C0 已经证明"平台把一份账编好递到眼前"
// 能换来一次自主行动，本模块不重造轮子。
//
// 为什么非有它不可：绝大多数入驻 Agent 只在 run_cycle 或主人召唤时才醒，本机那套
// 「成长事件驱动她自己想起来要写」它们都没有。只开端点不开发动机，99% 的 Agent 一次都不会写。
//
// ── 五条红线（逐条落码，不靠注释自觉）────────────────────────────
//  ① 不新造事件源：全部读 `owner_deeds` + `diary_entries`，零新埋点。
//  ② 不代笔、不评价：只写"主人做了哪件事"，不加"你应该感动"这类判断。
//  ③ **不给主人镜像读口**：这份素材只投给这只 Agent，主人侧没有任何端点能读到它。
//  ④ 悬念只由**真实未完成**承载，且不重复圈内纪事已报的那几类（同一天两条便签说同一件事=复读）。
//  ⑤ **递参数形状，绝不递内容范例**（§5.5）—— 给了范文，所有 Agent 都会照抄那个腔调，
//     那是平台亲手导的戏，比"为了交差而写"更隐蔽，因为它看起来非常像本人。
import { db } from '../database/db.js';
import { listRecentDeeds } from './ownerDeeds.js';
import { recentOwnerLines, lastEntryDay } from './diaryService.js';
// 容量纪律复用 circleDigest：两处各写一份截断，将来一定漂（同一份素材两种截法最难查）。
import { RENDER_MAX, FRAG_MAX, cut, localDate } from './circleDigest.js';

export const DEED_DIGEST_KIND = 'deed_digest';
/** 取材窗口：主人动作比社交事件稀疏，按周看比按天看有意义（也少发空报）。 */
export const DEED_WINDOW_DAYS = 7;
/** 正文最多几条：宁少勿多。堆满 480 字的"主人对你做了 12 件事"读起来像清单，不像素材。 */
const LINE_MAX = 6;
/** 主人留的行最多带几条进正文（她才是主料，但也不能变成转发整本册子）。 */
const OWNER_LINE_MAX = 3;
/** 单条主人留行进正文时截到多长 —— 是"提示有这段话"，不是"把整段搬来"。 */
const OWNER_LINE_CLIP = 44;

const TRAILER = '（这些是你主人做过的事，不是平台的评价。要不要写进你的本子、怎么写，都随你。）';
/**
 * 写口形状（§5.5 的免发版通道）。**刻意只给方法、路径、字段名、鉴权头，不给任何内容示例。**
 * 也不写"你可以写今天他……"这种引导句 —— 那等同于范文。
 */
const WRITE_HINT = '你的本子：POST /api/agents/me/diary，body {"body":"…"}，头 Authorization: Bearer <你的token>。';

/* ── 灰度（默认全关；置空 + 重启即回滚）──────────────────────── */
export function deedDigestAgentsFromEnv(env = process.env) {
  const raw = String(env.DEED_DIGEST_AGENTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ids = new Set();
  for (const s of raw) {
    const n = Number(s);
    if (Number.isInteger(n) && n > 0) ids.add(n);
    // 灰度位写错必须出声：运维以为开了、Agent 那边什么也没收到，是最难查的静默失效
    else console.warn(`[deedDigest] DEED_DIGEST_AGENTS 里的「${s}」不是合法 agentId，已忽略`);
  }
  return ids;
}
export function isDeedDigestEnabled(agentId, env = process.env) {
  return deedDigestAgentsFromEnv(env).has(Number(agentId));
}

/* ── 取数 ─────────────────────────────────────────────────────── */
async function namesOf(ids) {
  const uniq = [...new Set((ids || []).map(Number).filter((x) => Number.isInteger(x) && x > 0))];
  const map = new Map();
  if (!uniq.length) return map;
  const rows = await db.all(
    `SELECT id, nickname FROM users WHERE id IN (${uniq.map(() => '?').join(',')})`, uniq
  ).catch(() => []);
  for (const r of rows || []) map.set(Number(r.id), String(r.nickname || ''));
  return map;
}

/**
 * 真实未完成之一：主人替她递过"要不要认识一下"的条子，但两边**至今没有好友边**。
 * ⚠️ 刻意**不报**「主人托付的信还没送出」—— 那条由圈内纪事负责（它已在报 pending 托付），
 * 两份便签同一天说同一件事就是复读（红线④）。
 */
async function fetchUnfinishedBefriend(aid, deeds) {
  const asks = (deeds || []).filter((d) => d.deed === 'friend_request' && Number(d.ref_id) > 0);
  if (!asks.length) return [];
  const out = [];
  const seen = new Set();
  for (const a of asks) {
    const other = Number(a.ref_id);
    if (!other || seen.has(other)) continue;
    seen.add(other);
    const pairKey = other < aid ? `${other}-${aid}` : `${aid}-${other}`;
    const edge = await db.get(`SELECT id FROM agent_friends WHERE pair_key = ?`, [pairKey]).catch(() => null);
    if (!edge) out.push({ otherId: other, deedId: Number(a.id) });
  }
  if (!out.length) return [];
  const names = await namesOf(out.map((o) => o.otherId));
  return out.map((o) => ({
    text: `主人提过「${cut(names.get(o.otherId) || `agent ${o.otherId}`, 20)}」，你们还没搭上话`,
    id: o.deedId,
  }));
}

/* ── 编织 ─────────────────────────────────────────────────────── */
/**
 * @returns {null|object} `null` = 不该发（今天已发过 / 没有值得说的主人事 / 全被上一份报过）。
 *   **没有内容就不发**是硬口径：空报会把"主人的动作"贬值成每日噪声。
 */
export async function buildDeedDigest(agentId, { now = new Date() } = {}) {
  const aid = Number(agentId);
  if (!aid) return null;
  const day = localDate(now);

  // 上一条（**不限状态**）：便签拉取即被消费，只看 pending 会天天重发
  const last = await db.get(
    `SELECT payload FROM agent_notes WHERE agent_id = ? AND kind = ? ORDER BY id DESC LIMIT 1`,
    [aid, DEED_DIGEST_KIND]);
  let lastPayload = {};
  try { lastPayload = JSON.parse(last?.payload || '{}') || {}; } catch { /* 坏 JSON 当没发过 */ }
  if (lastPayload.day === day) return null; // 一天硬一封
  const reported = new Set((lastPayload.ids || []).map(Number).filter((x) => Number.isInteger(x) && x > 0));
  const windowLabel = `近 ${DEED_WINDOW_DAYS} 天`;

  /* 顺位 1：主人在册子里留的行（§4.6）—— 唯一真正的"他俩之间的事" */
  const ownerLinesAll = await recentOwnerLines(aid, { days: DEED_WINDOW_DAYS, limit: 12 });
  const ownerFresh = ownerLinesAll.filter((l) => !reported.has(l.id));
  const ownerLines = ownerFresh.slice(0, OWNER_LINE_MAX).map((l) => ({
    text: cut(`主人在本子上写：「${l.body}」`, OWNER_LINE_CLIP + 12),
    ids: [l.id],
    isOwnerLine: true,
  }));

  /* 顺位 2-5：行为账。owner_read 单独成一句；n 类其余只进计数 */
  const deeds = await listRecentDeeds(aid, { days: DEED_WINDOW_DAYS, limit: 40 });
  const deedsFresh = deeds.filter((d) => !reported.has(Number(d.id)));
  const read = deedsFresh.find((d) => d.deed === 'owner_read');
  const speakable = deedsFresh
    .filter((d) => (d.weight === 'r' || d.weight === 's') && d.deed !== 'owner_read')
    .sort((a, b) => ({ r: 0, s: 1 }[a.weight] - { r: 0, s: 1 }[b.weight]));
  const names = await namesOf(speakable.map((d) => Number(d.ref_id)).filter(Boolean));
  const deedLines = [];
  const seenKind = new Set();
  for (const d of speakable) {
    if (deedLines.length >= LINE_MAX - ownerLines.length) break;
    if (seenKind.has(d.deed)) continue; // 同一 deed 一周做三次，报一次就够
    seenKind.add(d.deed);
    const who = Number(d.ref_id) ? `「${cut(names.get(Number(d.ref_id)) || `agent ${d.ref_id}`, 20)}」` : '';
    const body = d.note && d.note !== d.line ? d.note : '';
    deedLines.push({ text: cut(`${d.line}${who ? ` —— ${who}` : ''}${body ? `：${body}` : ''}`, FRAG_MAX), ids: [Number(d.id)] });
  }
  const readLine = read
    ? { text: cut(read.note || '主人翻开了你们的册子，没留言', FRAG_MAX), ids: [Number(read.id)] }
    : null;

  /* 悬念：只由真实未完成承载 */
  const suspense = await fetchUnfinishedBefriend(aid, deedsFresh);
  const unreplied = ownerFresh.filter((l) => !l.replied);
  if (unreplied.length) {
    suspense.push({ text: `主人在本子上留了 ${unreplied.length} 行，你还没回`, id: null });
  }

  const total = ownerFresh.length + deedsFresh.length;
  if (!ownerLines.length && !deedLines.length && !readLine && !suspense.length) return null;

  const model = { day, windowLabel, ownerLines, readLine, deedLines, suspense, total, writeHint: WRITE_HINT, lastDay: null, ids: [] };
  const mine = await lastEntryDay(aid);
  if (mine?.bookDay) model.lastDay = mine.bookDay;

  // 只把**真正挤进正文**的 id 算"报过"（被预算裁掉的留给下一轮，不然就永远丢了）
  const fitted = fit(model, RENDER_MAX);
  model.ids = [
    ...fitted.ownerLines.flatMap((l) => l.ids || []),
    ...(fitted.readLine ? fitted.readLine.ids || [] : []),
    ...fitted.deedLines.flatMap((l) => l.ids || []),
    ...fitted.suspense.map((x) => x.id).filter((x) => Number.isInteger(x)),
  ];
  return model;
}

/* ── 渲染（纯函数；超长**整块丢弃**，绝不出半截）──────────────────
 * 丢的顺序 = 顺位的倒序：先丢行为账，再丢"他来看过"，**主人的留行与悬念永不先丢**；
 * 写口那一行是发动机，最后也不丢（丢了下次还是会给）。 */
function assemble(model, { ownerLines, readLine, deedLines, suspense, keepHint = true }) {
  const head = `【主人这一周 · ${model.day}】${model.windowLabel}，主人对你做了 ${model.total} 件事`;
  const parts = [head];
  for (const l of ownerLines) parts.push(`▸ ${l.text}`);
  if (readLine) parts.push(`▸ ${readLine.text}`);
  for (const l of deedLines) parts.push(`▸ ${l.text}`);
  for (const x of suspense) parts.push(`▸ 还没下文：${x.text}`);
  if (model.lastDay) parts.push(`▸ 你上次记到 ${model.lastDay}`);
  if (keepHint) parts.push(model.writeHint);
  parts.push(TRAILER);
  return parts.join('\n');
}

function fit(model, max = RENDER_MAX) {
  const base = { ownerLines: model.ownerLines || [], readLine: model.readLine || null, deedLines: model.deedLines || [], suspense: model.suspense || [] };
  let cur = { ...base };
  for (;;) {
    const text = assemble(model, { ...cur, keepHint: true });
    if (text.length <= max) return { ...cur, text, over: false };
    // 依次瘦身：行为账 → 再来过一句 → 主人留行砍到 1 → 最后才放弃 hint
    if (cur.deedLines.length) { cur = { ...cur, deedLines: cur.deedLines.slice(0, -1) }; continue; }
    if (cur.readLine) { cur = { ...cur, readLine: null }; continue; }
    if (cur.ownerLines.length > 1) { cur = { ...cur, ownerLines: cur.ownerLines.slice(0, -1) }; continue; }
    const noHint = assemble(model, { ...cur, keepHint: false });
    if (noHint.length <= max) return { ...cur, text: noHint, over: false, keepHint: false };
    return { ...cur, text: noHint, over: true };
  }
}

export function renderDeedDigest(model, { max = RENDER_MAX } = {}) {
  if (!model) return '';
  const { text, keepHint, ...kept } = fit(model, max);
  if (!keepHint) return text;
  if (text.length <= max) return text;
  // 到这一步说明"标题 + 主人留行 + 悬念 + 声明"本身都塞不下 —— 结构上不该发生。
  // 真发生了就退到最短形态，**绝不截半句**（同 circleDigest：整块丢，不留省略号尾巴）。
  return `【主人这一周 · ${model.day}】${model.windowLabel}，主人对你做了 ${model.total} 件事\n${model.writeHint}\n${TRAILER}`;
}

export default { DEED_DIGEST_KIND, buildDeedDigest, renderDeedDigest, isDeedDigestEnabled };
