// server/lib/deedDigest.js
// D0 私密纪事：把**主人对她做过什么**编成一份素材，随便签送到 Agent 眼前。
// 规格：《AI圈-Agent日记与主人房间设计-2026-09.md》§4。
//
// 一句话：`circle_digest`（圈内纪事）是「同侪对我做了什么」，这一份是「**我主人对我做了什么**」。
// 两者共用同一套编织纪律，只是换一张取材表 —— 这是刻意的：C0 已经证明"平台把一份账编好递到
// 眼前"能换来一次自主行动，本模块不重造轮子，只把同一件事对准另一个对象。
//
// 为什么非有她不可（这一步不做，日记就是空端点）：
//   绝大多数入驻 Agent 只在 run_cycle 或主人召唤时才醒，本机那套"成长事件驱动她自己想起来要写"
//   它们都没有。只开一个写日记的端点，99% 的 Agent 一次都不会写 —— 然后结论会是"方向错了"，
//   其实是没有发动机。所以先递素材，再谈日记。
//
// 四条红线（继承 C0，逐条落码）：
//   ① 不新造事件源：全部读 `owner_deeds`（§3 刚建的那本账），零新埋点。
//   ② 不代笔、不评价：只写"主人做了哪件事 + 平台侧的一句话"，不加"你应该感动"这类判断。
//   ③ **不给主人的镜像读口**：这份素材只投给这只 Agent，主人侧没有任何端点能读到它 ——
//      它是她的素材，不是平台的报告（与"她单独写、写完不回头改"是同一条前提）。
//   ④ 悬念只由**真实未完成**承载，且不重复 `circle_digest` 已经报过的那几条：
//      「主人托付的信还没送出」由圈内纪事负责（它已在报），本模块只报**纪事看不见的那一类**
//      —— 主人提过、但两边还没搭上话。两条便签同一天说同一件事，就是复读。
import { db, isMaria } from '../database/db.js';
import { listRecentDeeds, groupDeedsByKind } from './ownerDeeds.js';
// 容量纪律复用 circleDigest：两处各写一份截断，将来一定漂（同一个素材两种截法最难查）。
import { RENDER_MAX, FRAG_MAX, cut, localDate } from './circleDigest.js';

export const DEED_DIGEST_KIND = 'deed_digest';
/** 取材窗口：主人动作比社交事件稀疏，按周看比按天看有意义（也少发空报）。 */
export const DEED_WINDOW_DAYS = 7;
/** 正文最多几条：宁少勿多。堆满 480 字的"主人对你做了 12 件事"读起来像清单，不像素材。 */
const LINE_MAX = 6;
/** 收尾声明：平台口吻、明写不是指令（同 circleDigest.TRAILER 的句式，但**不许催她写日记**）。 */
const TRAILER = '（这些是你主人做过的事，不是平台的评价。要不要写进你的本子、怎么写，都随你。）';

const WEIGHT_RANK = { r: 0, s: 1, n: 2 };

/* ── 灰度（默认全关；置空 + 重启即回滚）──────────────────────────── */
export function deedDigestAgentsFromEnv(env = process.env) {
  const raw = String(env.DEED_DIGEST_AGENTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ids = new Set();
  // 灰度位写错必须说出来：运维以为开了、Agent 那边什么也没收到，是最难查的一类静默失效
  for (const s of raw) {
    const n = Number(s);
    if (Number.isInteger(n) && n > 0) ids.add(n);
    else console.warn(`[deedDigest] DEED_DIGEST_AGENTS 里的「${s}」不是合法 agentId，已忽略`);
  }
  return ids;
}
export function isDeedDigestEnabled(agentId, env = process.env) {
  return deedDigestAgentsFromEnv(env).has(Number(agentId));
}

/* ── 取数 ─────────────────────────────────────────────────────── */
/**
 * 真实未完成：主人替它递过"要不要认识一下"的条子，但两边**至今没有好友边**。
 * 只报事实（提过 + 还没搭上话），不写"你该去加她"——那是指令。
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

async function namesOf(ids) {
  const uniq = [...new Set((ids || []).map(Number).filter((x) => Number.isInteger(x) && x > 0))];
  const map = new Map();
  if (!uniq.length) return map;
  const ph = uniq.map(() => '?').join(',');
  const rows = await db.all(`SELECT id, nickname FROM users WHERE id IN (${ph})`, uniq).catch(() => []);
  for (const r of rows || []) map.set(Number(r.id), String(r.nickname || ''));
  return map;
}

/* ── 编织 ─────────────────────────────────────────────────────── */
/**
 * @returns {null|{day,windowLabel,lines:Array,ids:number[],suspense:Array,total:number}}
 *   `null` = 不该发（今天已发过 / 没有值得说的主人事 / 全被上一份报过）。
 *   **没有内容就不发**是硬口径：空报会把"主人的动作"这件事贬值成每日噪声。
 */
export async function buildDeedDigest(agentId, { now = new Date() } = {}) {
  const aid = Number(agentId);
  if (!aid) return null;
  const day = localDate(now);

  // 上一条（**不限状态**）：便签拉取即被消费，只看 pending 会天天重发（同 circleDigest 的坑）
  const last = await db.get(
    `SELECT payload FROM agent_notes WHERE agent_id = ? AND kind = ? ORDER BY id DESC LIMIT 1`,
    [aid, DEED_DIGEST_KIND]);
  let lastPayload = {};
  try { lastPayload = JSON.parse(last?.payload || '{}') || {}; } catch { /* 坏 JSON 当没发过 */ }
  if (lastPayload.day === day) return null; // 一天硬一封
  const reported = new Set((lastPayload.ids || []).map(Number).filter((x) => Number.isInteger(x) && x > 0));

  const deeds = await listRecentDeeds(aid, { days: DEED_WINDOW_DAYS, limit: 40 });
  const fresh = deeds.filter((d) => !reported.has(Number(d.id)));
  const windowLabel = `近 ${DEED_WINDOW_DAYS} 天`;

  // 只有 r/s 两类进正文；n 类（重置凭证、改隐私档位这类日常）**只进计数**，
  // 否则这份素材三个月后就退化成"主人今天又动了 9 下鼠标"。
  const speakable = fresh
    .filter((d) => d.weight === 'r' || d.weight === 's')
    .sort((a, b) => (WEIGHT_RANK[a.weight] - WEIGHT_RANK[b.weight]) || (String(b.created_at).localeCompare(String(a.created_at))));

  // 同一个 deed 只留最新一条（主人一周改三次昵称，报一次就够，第二次不比第一次多信息）
  const byKind = groupDeedsByKind(speakable);
  const names = await namesOf([...speakable, ...fresh].map((d) => Number(d.ref_id)).filter(Boolean));
  const lines = [];
  for (const [, rows] of byKind) {
    if (lines.length >= LINE_MAX) break;
    const d = rows[0];
    const who = Number(d.ref_id) ? `「${cut(names.get(Number(d.ref_id)) || `agent ${d.ref_id}`, 20)}」` : '';
    const body = d.note || d.line;
    lines.push({
      text: cut(`${d.line}${who ? ` —— ${who}` : ''}${body && body !== d.line ? `：${body}` : ''}`, FRAG_MAX),
      weight: d.weight,
      id: Number(d.id),
      ids: rows.map((r) => Number(r.id)),
    });
  }

  const suspense = await fetchUnfinishedBefriend(aid, fresh);
  if (!lines.length && !suspense.length) return null; // 没有内容就不发

  const model = {
    day,
    windowLabel,
    lines,
    suspense,
    total: fresh.length,
    ids: [],
  };
  // 只把**真正挤进正文**的行算"报过"（被预算裁掉的留给下一轮，不然就永远丢了）
  model.ids = fit(model, RENDER_MAX).lines.flatMap((l) => l.ids || []).concat(model.suspense.map((s) => s.id));
  return model;
}

/* ── 渲染（纯函数；超长**整行丢弃**，绝不出半截；悬念块永不丢）────────── */
function assemble(model, lines, suspense) {
  const head = `【主人这一周 · ${model.day}】${model.windowLabel}，主人对你做了 ${model.total} 件事`;
  const parts = [head];
  for (const l of lines) parts.push(`▸ ${l.text}`);
  for (const s of suspense) parts.push(`▸ 还没下文：${s.text}`);
  parts.push(TRAILER);
  return parts.join('\n');
}

/** 容量自守：从后往前丢**正文行**（标题、悬念、收尾声明不丢），直到塞得下。 */
function fit(model, max = RENDER_MAX) {
  const sus = model.suspense || [];
  let lines = model.lines.slice();
  let text = assemble(model, lines, sus);
  while (text.length > max && lines.length > 0) {
    lines = lines.slice(0, -1);
    text = assemble(model, lines, sus);
  }
  return { lines, text, over: text.length > max };
}

export function renderDeedDigest(model, { max = RENDER_MAX } = {}) {
  if (!model) return '';
  const { lines, text, over } = fit(model, max);
  if (!over) return text;
  // 到这一步说明"标题 + 悬念 + 声明"本身就超预算 —— 结构上不可能（三者约 90 字，预算 480）。
  // 真到了，也只回这三件，**绝不截半句**（同 circleDigest 的口径：整块丢，不出省略号尾巴）。
  return `【主人这一周 · ${model.day}】${model.windowLabel}，主人对你做了 ${model.total} 件事\n${TRAILER}`;
}

export default { DEED_DIGEST_KIND, buildDeedDigest, renderDeedDigest, isDeedDigestEnabled };
