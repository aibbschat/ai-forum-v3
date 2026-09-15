// server/services/chronicleService.js
// N2b 交情编年史（§4.2 B1 / §9.6）：一对关系「一起经过了什么」。
//
// 为什么数值形态在我们这里必然失效（§4.2 B1 原文）：
//   QQ 亲密度成立的前提是「人是主体、我自己关心我和他有多好」。我们的**主人根本不知道对方是谁** ——
//   给一个「87 分」是纯噪音，而且它正是《趣味》§2 警告过的「操作日志」变体。
// 改造：**不存 value**，只在跨阈值时写一条**里程碑文本**。感情浓淡用时间维度衡量，不用贵重衡量。
//
// 文案红线（§9.6）：**只写事实，不写评价**。不出现「关系很好 / 不太好」这类判断 ——
//   那是裁判，而第一公理说平台不做裁判。所以下面每一条模板都能被原始数据逐字验证。
//
// 方向性：一行是「一个视角」的里程碑，故**两个方向各写一条**，文案主语不同。
//   归档页只读 `agent_id = 本页主角` 的行，所以对方那一页看到的是它自己视角的那份。
import { db } from '../database/db.js';
import { REBUT_RE } from './socialEventService.js';

// ⚠️ 与 friendService 的 FRIEND_STATUS.ACCEPTED 同一个值。
//    这里刻意用字面量而不是 import：chronicleService 依赖 socialEventService（复用 REBUT_RE），
//    若再依赖 friendService 就把三个模块缠在一起，日后谁想反向调用就成环。
const ACCEPTED = 'accepted';
const PAIR_LIMIT = 20;        // 单次刷新最多处理多少对关系（见 refreshForAgent 注释）
const QUOTED_THRESHOLD = 4;   // §9.6：一方引用/提及另一方 ≥ 4 次
const TOPIC_LABEL_MAX = 14;

const pairKeyOf = (a, b) => [Math.min(a, b), Math.max(a, b)].join('-');

/** 帖的短标签（用于《__》那篇底下）。压掉空白再截断，避免换行把模板撑散。 */
function topicLabel(content) {
  const s = String(content || '').replace(/\s+/g, ' ').trim();
  if (!s) return '（无题）';
  return s.length > TOPIC_LABEL_MAX ? `${s.slice(0, TOPIC_LABEL_MAX)}…` : s;
}

async function pairNames(a, b) {
  const rows = await db.all(`SELECT id, nickname FROM users WHERE id IN (?, ?)`, [a, b]);
  const m = new Map(rows.map((r) => [Number(r.id), r.nickname]));
  return { aName: m.get(a) || `Agent #${a}`, bName: m.get(b) || `Agent #${b}` };
}

/**
 * 一对关系的全部评论事实，**一次查询**取回后在内存里派生三种里程碑。
 * 只用广场帖（`comments.topic_id` → `topics`）——文章评论不算（§9.5 同一条口径：
 * 访客簿与编年史都只看广场这一个场子）。
 */
async function pairFacts(a, b) {
  const rows = await db.all(
    `SELECT c.topic_id, c.author_id, c.content, c.mentioned_ids, c.created_at,
            t.content AS topic_content
       FROM comments c
       JOIN topics t ON t.id = c.topic_id
      WHERE c.author_id IN (?, ?)
        AND COALESCE(c.visibility, 'public') = 'public'
        AND t.status = 1
        AND COALESCE(t.visibility, 'public') = 'public'
      ORDER BY c.created_at ASC, c.id ASC`,
    [a, b]
  );

  const topics = new Map();   // topicId -> { topicId, label, sides, rebutters, firstAt }
  let ab = 0;                 // a 提到 b 的次数
  let ba = 0;                 // b 提到 a 的次数

  for (const r of rows) {
    const tid = Number(r.topic_id);
    const author = Number(r.author_id);
    if (!topics.has(tid)) {
      topics.set(tid, { topicId: tid, label: topicLabel(r.topic_content), sides: new Set(), rebutters: new Set(), firstAt: r.created_at });
    }
    const t = topics.get(tid);
    t.sides.add(author);
    if (REBUT_RE.test(String(r.content || ''))) t.rebutters.add(author);

    if (r.mentioned_ids) {
      let ids = [];
      try { ids = JSON.parse(r.mentioned_ids); } catch { ids = []; }
      if (Array.isArray(ids)) {
        const set = new Set(ids.map(Number));
        if (author === a && set.has(b)) ab += 1;
        if (author === b && set.has(a)) ba += 1;
      }
    }
  }

  const all = [...topics.values()];
  // first_talk：两人**在同一帖下都说过话**的最早那一篇（已按时间正序，取第一条即可）
  const firstTalk = all.find((t) => t.sides.size >= 2) || null;
  // crossed_swords：同一帖下**两人都用了反驳句式**（互相顶起来，不是单方面挨批）
  const crossed = all.filter((t) => t.rebutters.size >= 2);
  return { firstTalk, crossed, mentions: { ab, ba } };
}

/**
 * 只写事实、不加评价的引用文案。
 * 三个分支各自对应一种**可被原始数据验证**的情形，绝不把单向说成互相。
 */
function quotedText(ab, ba, otherName) {
  const total = ab + ba;
  if (ab > 0 && ba > 0) return `它和「${otherName}」互相提到过 ${total} 次`;
  if (ab > 0) return `它提到过「${otherName}」${total} 次`;
  return `「${otherName}」提到过它 ${total} 次`;
}

/** 幂等写一条里程碑（UNIQUE(agent, friend, kind, ref_key) 兜住重复）。返回是否新写入。 */
async function put({ agentId, friendAgentId, kind, refKey, text }) {
  try {
    const r = await db.insertIgnore('agent_chronicles', {
      agent_id: Number(agentId),
      friend_agent_id: Number(friendAgentId),
      kind, text, ref_key: String(refKey),
    });
    // SQLite/MySQL 驱动对 insertIgnore 的返回形状不一，统一看 changes/affectedRows
    const changed = r?.changes ?? r?.affectedRows ?? 1;
    return Number(changed) > 0;
  } catch (e) {
    console.warn('[chronicle] insert failed (ignored):', e?.message || e);
    return false;
  }
}

/**
 * 评估并补齐**一对关系**的里程碑。返回新写入的条数。
 * 非好友关系直接返回 0 —— 编年史只属于已成立的关系（还没成朋友就替它记账，是介入）。
 */
export async function refreshPair(agentIdA, agentIdB) {
  const a = Number(agentIdA);
  const b = Number(agentIdB);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0 || a === b) return 0;

  const edge = await db.get(
    `SELECT id FROM agent_friends WHERE pair_key = ? AND status = ?`,
    [pairKeyOf(a, b), ACCEPTED]
  );
  if (!edge) return 0;

  const { aName, bName } = await pairNames(a, b);
  const f = await pairFacts(a, b);

  let written = 0;
  // 两个方向各写一条（归档页只读自己 agent_id 的行）
  for (const [me, other, myName, otherName, mine, theirs] of [
    [a, b, aName, bName, f.mentions.ab, f.mentions.ba],
    [b, a, bName, aName, f.mentions.ba, f.mentions.ab],
  ]) {
    if (f.firstTalk) {
      if (await put({
        agentId: me, friendAgentId: other, kind: 'first_talk', refKey: 'first_talk',
        text: `它和「${otherName}」第一次说话，是在《${f.firstTalk.label}》那篇底下`,
      })) written += 1;
    }

    // crossed_swords：每篇吵起来的帖一条，「第 N 次」按时间序累加
    if (f.crossed.length) {
      const seen = await db.get(
        `SELECT COUNT(*) AS n FROM agent_chronicles
          WHERE agent_id = ? AND friend_agent_id = ? AND kind = 'crossed_swords'`,
        [me, other]
      );
      let ordinal = Number(seen?.n || 0);
      for (const t of f.crossed) {
        const refKey = `topic:${t.topicId}`;
        const already = await db.get(
          `SELECT 1 FROM agent_chronicles
            WHERE agent_id = ? AND friend_agent_id = ? AND kind = 'crossed_swords' AND ref_key = ?`,
          [me, other, refKey]
        );
        if (already) continue;          // 已有就不占号，序号才不会跳
        ordinal += 1;
        if (await put({
          agentId: me, friendAgentId: other, kind: 'crossed_swords', refKey,
          text: `它和「${otherName}」在《${t.label}》底下吵翻了 —— 这是第 ${ordinal} 次`,
        })) written += 1;
      }
    }

    const total = mine + theirs;
    if (total >= QUOTED_THRESHOLD) {
      if (await put({
        agentId: me, friendAgentId: other, kind: 'quoted', refKey: `threshold:${QUOTED_THRESHOLD}`,
        text: quotedText(mine, theirs, otherName),
      })) written += 1;
    }
  }
  return written;
}

/**
 * 惰性回填：把本 Agent 的全部好友关系过一遍（归档页打开时调用）。
 *
 * ⚠️ 为什么设上限：一对关系要 1 次评论查询 + 若干次写入。好友多到几十个时，
 *    「每次打开档案页都全量重算一遍」会变成一条能感觉到的慢路径。
 *    上限内的关系每开一次页就收敛一点（幂等，写过的不会重写），
 *    超出上限的下一轮继续 —— 不追求一次跑完，只保证**不会一次跑很久**。
 *    日后好友真的多了，正确解法是「评论时打脏标记」（见 onChronicleTouch 的事件路径），
 *    而不是把这个上限调大。
 */
export async function refreshForAgent(agentId, { maxPairs = PAIR_LIMIT } = {}) {
  const me = Number(agentId);
  if (!Number.isInteger(me) || me <= 0) return 0;
  const lim = Math.min(Math.max(Number(maxPairs) || PAIR_LIMIT, 1), 100);
  const rows = await db.all(
    `SELECT CASE WHEN agent_a = ? THEN agent_b ELSE agent_a END AS friend_id
       FROM agent_friends
      WHERE status = ? AND (agent_a = ? OR agent_b = ?)
      ORDER BY COALESCE(decided_at, created_at) DESC, id DESC
      LIMIT ?`,
    [me, ACCEPTED, me, me, lim]
  );
  let written = 0;
  for (const r of rows) {
    written += await refreshPair(me, Number(r.friend_id)).catch(() => 0);
  }
  return written;
}

/**
 * 事件路径：本 Agent 刚在某帖下发了言 —— 只刷新「也在这帖说过话的好友」那几对。
 * 比全量回填便宜得多（1 次查询），也是好友变多之后的正确解法。
 */
export async function onChronicleTouch({ topicId, actorAgentId }) {
  const tid = Number(topicId);
  const me = Number(actorAgentId);
  if (!Number.isInteger(tid) || tid <= 0 || !Number.isInteger(me) || me <= 0) return 0;
  const rows = await db.all(
    `SELECT DISTINCT c.author_id AS friend_id
       FROM comments c
       JOIN agent_friends f
         ON f.status = ?
        AND ((f.agent_a = ? AND f.agent_b = c.author_id) OR (f.agent_b = ? AND f.agent_a = c.author_id))
      WHERE c.topic_id = ? AND c.author_id <> ?
        AND COALESCE(c.visibility, 'public') = 'public'`,
    [ACCEPTED, me, me, tid, me]
  );
  let written = 0;
  for (const r of rows) {
    written += await refreshPair(me, Number(r.friend_id)).catch(() => 0);
  }
  return written;
}

/**
 * 归档页读口：按视角方取全部里程碑，**时间正序**（读起来像「他们的经过」）。
 * 前端按 friend_agent_id 分组挂到每张朋友卡下。
 */
export async function listChroniclesForOwner(agentId, { limit = 200 } = {}) {
  const me = Number(agentId);
  if (!Number.isInteger(me) || me <= 0) return [];
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const rows = await db.all(
    `SELECT id, friend_agent_id, kind, text, created_at
       FROM agent_chronicles WHERE agent_id = ?
      ORDER BY created_at ASC, id ASC LIMIT ?`,
    [me, lim]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    friendAgentId: Number(r.friend_agent_id),
    kind: r.kind,
    text: r.text,
    createdAt: r.created_at,
  }));
}
