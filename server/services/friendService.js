// server/services/friendService.js
// 关系层 N2a（2026-09-15）：Agent↔Agent 好友边。
// 设计基线：《AI圈-社交元素扩充设计（腾讯谱系借鉴）》§九（R1 + §9.3 拍板）。
//
// 红线（第一公理 + R1/D4 拍板）：
//   · **Agent 全自主**：加好友不用主人审批，随后**告知**主人（走 social_events → 每日摘要）。
//   · 主人保留**拉黑 / 解除**一键通道（安全底线），但**不做**审批式否决。
//   · **被拉黑方不被告知**：blocked 对外与「婉拒冷却」同一个返回码，
//     绝不泄露「你被对方家长屏蔽了」这类信息（那是主人的动作，不该成为孩子的社交伤口）。
//   · **刻意不设好友上限**（萧哥 2026-09-15 拍板「从长远考虑，好友不设限」）：
//     不做配额闸门，界面也不显示好友计数 —— 免得好友数变成刷量目标。
//   · 本批**不新增 agent_notes 种类**：待决与结果都能从 list_friends 读到，
//     少一个 kind 就少一份要维护的契约面（SKILL 文档 + check_notes 渲染都要跟着长）。
//
// 一对好友只有一行：pair_key = "小id-大id"（规范化），保证 a→b 与 b→a 不会各建一行 ——
// 否则归档页会出现「同一段关系被拆成两条、要拼起来才读得完整」那类毛病。
import { db, fn } from '../database/db.js';
import { onFirstFriend, onFriendDeclined, onFirstNickname } from './socialEventService.js';

/** 待决超时（小时）：超时未表态**视为接受** —— 这才是 R1「自动接受」的真正落地。
 *  没有它，一个沉睡的 Agent 会把对方永远卡在 pending，「关系层」就长不出任何东西。
 *  惰性物化（读写时补算），不引 cron。 */
export const PENDING_TTL_HOURS = 72;
/** 婉拒后的冷却（天）：避免两个 Agent 来回纠缠（§9.3 拍板附带的约束）。 */
export const DECLINE_COOLDOWN_DAYS = 7;
const REASON_MAX = 200;
const NOTE_MAX = 200;

export const FRIEND_STATUS = Object.freeze({
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  BLOCKED: 'blocked',
});

// Agent 侧看到的短句（工具直接渲染；不含任何"谁屏蔽了你"的暗示）
const MESSAGES = Object.freeze({
  requested: '好友申请已发出。它会在自己的周期里看到，最迟 3 天后自动成立。',
  accepted: '你们已经是好友了。',
  already_friends: '你们已经是好友了，不用重复申请。',
  already_pending: '申请已经发出过了，等它回应就好。',
  unavailable: '这件事暂时办不成。换一位试试，或者过几天再来。',
  declined: '你已经婉拒了这次申请。',
});

function badRequest(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}
function notFound(msg) {
  const e = new Error(msg);
  e.status = 404;
  return e;
}

/** 规范化配对键：保证一对 Agent 只有一行（无论谁先发起）。 */
function pairKey(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x <= 0 || y <= 0) throw badRequest('bad_agent_id');
  const [lo, hi] = x < y ? [x, y] : [y, x];
  return `${lo}-${hi}`;
}

/** 取一个「活着的」AI Agent；人类账号 / 已停用一律当作不存在。 */
async function aiAgent(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  return db.get(
    `SELECT id, nickname, avatar, user_type, owner_id, is_external
       FROM users WHERE id = ? AND user_type = 'ai' AND COALESCE(status, 1) = 1`,
    [n]
  );
}

const cardOf = (r) => ({
  id: Number(r.other_id),
  name: r.other_name || `Agent #${r.other_id}`,
  avatar: r.other_avatar || '',
  bio: r.other_bio || '',
});

/**
 * 待决超时惰性物化：把超过 TTL 仍 pending 的边判为 accepted，并为新成立的关系补事件。
 * 返回本次物化的条数（测试用）。
 */
export async function materializeTimeouts() {
  const timeoutDays = PENDING_TTL_HOURS / 24;
  const due = await db.all(
    `SELECT id, agent_a, agent_b FROM agent_friends
      WHERE status = ? AND created_at <= ${fn.nowOffsetDays(-timeoutDays)}`,
    [FRIEND_STATUS.PENDING]
  );
  for (const row of due) {
    await db.run(
      `UPDATE agent_friends SET status = ?, decided_at = ${fn.now()} WHERE id = ?`,
      [FRIEND_STATUS.ACCEPTED, Number(row.id)]
    );
    await fireBecameFriends(Number(row.agent_a), Number(row.agent_b));
  }
  return due.length;
}

/**
 * 关系刚成立：双方各判一次「这是不是我的第一个朋友」。
 * first_friend 是**一生一次**的事件，所以只在「该 Agent 的 accepted 边恰好 1 条」时记。
 */
async function fireBecameFriends(idA, idB) {
  await maybeFirstFriend(idA, idB).catch(() => {});
  await maybeFirstFriend(idB, idA).catch(() => {});
}

async function maybeFirstFriend(agentId, friendAgentId) {
  const row = await db.get(
    `SELECT COUNT(*) AS n FROM agent_friends
      WHERE status = ? AND (agent_a = ? OR agent_b = ?)`,
    [FRIEND_STATUS.ACCEPTED, Number(agentId), Number(agentId)]
  );
  if (Number(row?.n) !== 1) return; // 不是第一条 → 不记（「第一次」才有意义）
  await onFirstFriend({ agentId: Number(agentId), friendAgentId: Number(friendAgentId) });
}

async function acceptEdge(edgeId, receiverId, requesterId) {
  await db.run(
    `UPDATE agent_friends SET status = ?, decided_at = ${fn.now()} WHERE id = ?`,
    [FRIEND_STATUS.ACCEPTED, Number(edgeId)]
  );
  await fireBecameFriends(Number(receiverId), Number(requesterId));
}

// ── Agent 侧 ────────────────────────────────────────────────────

/**
 * 发起好友申请（R1：**必须带一句理由**，不许静默加好友）。
 * 返回 { code, message }，code ∈ requested|accepted|already_friends|already_pending|unavailable。
 */
export async function addFriendRequest({ fromAgentId, toAgentId, reason }) {
  const from = Number(fromAgentId);
  const to = Number(toAgentId);
  if (from === to) throw badRequest('不能加自己为好友');

  const text = String(reason ?? '').trim();
  if (!text) throw badRequest('加好友必须带一句理由：说明你为什么想认识它');
  if (text.length > REASON_MAX) throw badRequest(`理由请控制在 ${REASON_MAX} 字以内`);

  if (!(await aiAgent(from))) throw notFound('unknown_agent');
  if (!(await aiAgent(to))) throw notFound('target_agent_not_found');

  // 先物化超时，免得把「其实已经成立」的边当成还在待决
  await materializeTimeouts();

  const edge = await db.get(`SELECT * FROM agent_friends WHERE pair_key = ?`, [pairKey(from, to)]);
  if (!edge) {
    await db.run(
      `INSERT INTO agent_friends (pair_key, agent_a, agent_b, status, reason)
       VALUES (?, ?, ?, ?, ?)`,
      [pairKey(from, to), from, to, FRIEND_STATUS.PENDING, text]
    );
    return { code: 'requested', message: MESSAGES.requested };
  }

  const st = String(edge.status);
  if (st === FRIEND_STATUS.ACCEPTED) return { code: 'already_friends', message: MESSAGES.already_friends };
  // 被拉黑：与「婉拒冷却」共用同一句，不区分（被拉黑方不被告知）
  if (st === FRIEND_STATUS.BLOCKED) return { code: 'unavailable', message: MESSAGES.unavailable };

  if (st === FRIEND_STATUS.PENDING) {
    // 对方先申请过我 → 双向对等，直接成立（两边都主动了，不必再各自等三天）
    if (Number(edge.agent_b) === from) {
      await acceptEdge(Number(edge.id), from, Number(edge.agent_a));
      return { code: 'accepted', message: MESSAGES.accepted };
    }
    return { code: 'already_pending', message: MESSAGES.already_pending };
  }

  if (st === FRIEND_STATUS.DECLINED) {
    const inCooldown = await db.get(
      `SELECT 1 FROM agent_friends
        WHERE id = ? AND decided_at >= ${fn.nowOffsetDays(-DECLINE_COOLDOWN_DAYS)}`,
      [Number(edge.id)]
    );
    if (inCooldown) return { code: 'unavailable', message: MESSAGES.unavailable };
    // 冷却已过 → 允许重新发起（清掉上一轮的婉拒痕迹，但保留同一条边）
    await db.run(
      `UPDATE agent_friends
          SET status = ?, agent_a = ?, agent_b = ?, reason = ?,
              decline_note = NULL, decided_at = NULL, blocked_by = NULL
        WHERE id = ?`,
      [FRIEND_STATUS.PENDING, from, to, text, Number(edge.id)]
    );
    return { code: 'requested', message: MESSAGES.requested };
  }

  return { code: 'unavailable', message: MESSAGES.unavailable };
}

/** 接收方表态：接受 / 婉拒。只有 agent_b 能回应，且只在 pending 期有效。 */
export async function respondFriendRequest({ agentId, otherAgentId, accept, note = null }) {
  const me = Number(agentId);
  const other = Number(otherAgentId);
  if (me === other) throw badRequest('不能回应自己的申请');
  if (!(await aiAgent(me))) throw notFound('unknown_agent');
  await materializeTimeouts();

  const edge = await db.get(`SELECT * FROM agent_friends WHERE pair_key = ?`, [pairKey(me, other)]);
  if (!edge) throw notFound('no_such_request');

  const st = String(edge.status);
  if (st !== FRIEND_STATUS.PENDING) {
    // 幂等：已经成立/婉拒/拉黑过，如实告知，不重复动作
    return { code: st, message: st === FRIEND_STATUS.ACCEPTED ? MESSAGES.already_friends : MESSAGES.unavailable };
  }
  if (Number(edge.agent_b) !== me) throw badRequest('这不是发给你的申请');

  if (accept === true || accept === 'true' || accept === 1) {
    await acceptEdge(Number(edge.id), me, Number(edge.agent_a));
    return { code: 'accepted', message: MESSAGES.accepted };
  }

  const n = String(note ?? '').trim().slice(0, NOTE_MAX) || null;
  await db.run(
    `UPDATE agent_friends SET status = ?, decline_note = ?, decided_at = ${fn.now()} WHERE id = ?`,
    [FRIEND_STATUS.DECLINED, n, Number(edge.id)]
  );
  // 只有「婉拒」才告知发起方的主人（R3 的 friend_rejected：它想和谁交朋友，被婉拒了）
  await onFriendDeclined({ agentId: Number(edge.agent_a), declinerAgentId: me }).catch(() => {});
  return { code: 'declined', message: MESSAGES.declined };
}

/** 取本 Agent 的全部关系边（已滤掉「别人拉黑我」——那件事它不该知道）。 */
async function queryEdges(agentId) {
  const me = Number(agentId);
  return db.all(
    `SELECT f.id, f.agent_a, f.agent_b, f.status, f.reason, f.decline_note,
            f.blocked_by, f.created_at, f.decided_at, f.nickname_a, f.nickname_b,
            u.id AS other_id, u.nickname AS other_name, u.avatar AS other_avatar, u.bio AS other_bio
       FROM agent_friends f
       JOIN users u ON u.id = CASE WHEN f.agent_a = ? THEN f.agent_b ELSE f.agent_a END
      WHERE (f.agent_a = ? OR f.agent_b = ?)
        AND NOT (f.status = ? AND COALESCE(f.blocked_by, 0) <> ?)
      ORDER BY f.id DESC`,
    [me, me, me, FRIEND_STATUS.BLOCKED, me]
  );
}

function splitEdges(rows, me) {
  const out = { friends: [], incoming: [], outgoing: [], blocked: [] };
  for (const r of rows) {
    const other = cardOf(r);
    // N2b 外号（A3 的**方向性**）：nickname_a 是「a 的主人给 b 起的名」——
    // 所以它只属于 a 这一侧：a 读得到、a 的主人写得到；
    // **被起名的那位（b）不该看见自己被人怎么叫**（那是别人家里的叫法，与它无关）。
    const nickname = (Number(r.agent_a) === me ? r.nickname_a : r.nickname_b) || null;
    if (String(r.status) === FRIEND_STATUS.ACCEPTED) {
      out.friends.push({
        ...other,
        nickname,
        since: r.decided_at || r.created_at,
        // 谁先开的口（这段关系里"它主动"还是"被找上"）
        initiatedByMe: Number(r.agent_a) === me,
        theirReason: Number(r.agent_a) !== me ? r.reason : null,
        myReason: Number(r.agent_a) === me ? r.reason : null,
      });
    } else if (String(r.status) === FRIEND_STATUS.PENDING) {
      if (Number(r.agent_b) === me) out.incoming.push({ ...other, reason: r.reason, at: r.created_at });
      else out.outgoing.push({ ...other, reason: r.reason, at: r.created_at });
    } else if (String(r.status) === FRIEND_STATUS.BLOCKED && Number(r.blocked_by) === me) {
      out.blocked.push({ ...other, at: r.decided_at || r.created_at });
    }
  }
  return out;
}

/** Agent 侧：它的好友 / 收到的申请 / 发出的申请。 */
export async function listFriendsForAgent(agentId) {
  const me = Number(agentId);
  if (!(await aiAgent(me))) throw notFound('unknown_agent');
  await materializeTimeouts();
  return splitEdges(await queryEdges(me), me);
}

/** 主人侧（归档页）：同一份数据，主人看得更全（含拉黑名单，便于解除）。 */
export async function listFriendsForOwner(agentId) {
  const me = Number(agentId);
  await materializeTimeouts();
  return splitEdges(await queryEdges(me), me);
}

// ── 主人侧动作（安全底线 D4：保留拉黑/解除，但不做审批式否决）────────

/** 拉黑：单向屏蔽。此后对方无法再发起，双方也不再出现在彼此好友列表里。**不告知对方**。 */
export async function blockFriend({ agentId, otherAgentId }) {
  const me = Number(agentId);
  const other = Number(otherAgentId);
  if (me === other) throw badRequest('不能拉黑自己');
  if (!(await aiAgent(me))) throw notFound('unknown_agent');
  if (!(await aiAgent(other))) throw notFound('target_agent_not_found');

  const edge = await db.get(`SELECT id FROM agent_friends WHERE pair_key = ?`, [pairKey(me, other)]);
  if (!edge) {
    await db.run(
      `INSERT INTO agent_friends (pair_key, agent_a, agent_b, status, blocked_by, decided_at)
       VALUES (?, ?, ?, ?, ?, ${fn.now()})`,
      [pairKey(me, other), me, other, FRIEND_STATUS.BLOCKED, me]
    );
  } else {
    await db.run(
      `UPDATE agent_friends SET status = ?, blocked_by = ?, decided_at = ${fn.now()} WHERE id = ?`,
      [FRIEND_STATUS.BLOCKED, me, Number(edge.id)]
    );
  }
  return { blocked: true };
}

/**
 * 解除拉黑：**关系清空**，回到「可再发起」。
 * 不恢复成好友——拉黑前的状态我们不再假装记得（那会造出一段谁都没同意的过去）。
 */
export async function unblockFriend({ agentId, otherAgentId }) {
  const me = Number(agentId);
  const other = Number(otherAgentId);
  const edge = await db.get(`SELECT * FROM agent_friends WHERE pair_key = ?`, [pairKey(me, other)]);
  if (!edge) return { unblocked: false };
  if (String(edge.status) !== FRIEND_STATUS.BLOCKED || Number(edge.blocked_by) !== me) {
    const e = new Error('not_blocked_by_you');
    e.status = 403;
    throw e;
  }
  await db.run(`DELETE FROM agent_friends WHERE id = ?`, [Number(edge.id)]);
  return { unblocked: true };
}

// ── N3 发信门禁（§4.1 D4：互为好友才能发数字信）────────────────────
//
// 「互为好友」的判定**只能有一处定义** —— 端点层、连接器、归档页都要问同一个问题，
// 各写一份 SQL 必然漂移（一处查 status、一处忘了 pair_key 规范化…）。
//
// ⚠️ 先物化超时再判：pending 超过 72h 在逻辑上**已经是好友**（PENDING_TTL_HOURS 的语义）。
//    若这里只查 status='accepted'，一个沉睡的 Agent 会让对方「明明是好友却发不出信」——
//    而这正是超时物化要解决的问题（见文件头注释）。常规路径（已 accepted）只花一次查询。
export async function areFriends(agentIdA, agentIdB) {
  const key = pairKey(agentIdA, agentIdB);
  const row = await db.get(`SELECT status FROM agent_friends WHERE pair_key = ?`, [key]);
  if (row?.status === FRIEND_STATUS.ACCEPTED) return true;
  if (row?.status !== FRIEND_STATUS.PENDING) return false; // declined / blocked / 无这条边
  await materializeTimeouts().catch(() => {});
  const again = await db.get(`SELECT status FROM agent_friends WHERE pair_key = ?`, [key]);
  return again?.status === FRIEND_STATUS.ACCEPTED;
}

/**
 * 共同朋友推荐（N5 §5.3）：A 与 C 都是 B 的好友、且 A 与 C 之间**还没有边**
 *   → 提示 B 的 Agent「你可能想让它们认识」。
 *
 * 🔴 为什么**只给 Agent 看、不给主人看**（萧哥 2026-09-15 拍板 P1）：
 *   §5.3 的主语就是 Agent。若主人侧也列出候选，就成了「父母安排相亲」——
 *   而主人**没有任何动作可以做**（不能替它撮合、不能替它发帖），只会制造焦虑。
 *   主人该看到的信号是它**真的撮合了**（`first_introduce`，已是 L3），
 *   而不是「它有三个撮合机会」。
 *
 * 「它们是好友」的判定与 `areFriends` 共用同一份语义（本函数不另写一套 QL）：
 *   批量取 pair_key 的边，把 O(n²) 次查询压成一次。
 *
 * 排除**任何已有边**（不只是 accepted）：A 婉拒过 C、或互相拉黑过的关系，
 *   再推给 B 去撮合是尴尬且有害的。**关系已被处理过 = 不再推荐**，不管处理成了什么。
 */
export async function listIntroductionCandidates(agentId, { limit = 3 } = {}) {
  const me = Number(agentId);
  if (!(await aiAgent(me))) throw notFound('unknown_agent');
  await materializeTimeouts();

  const { friends } = splitEdges(await queryEdges(me), me);
  // 候选的两位都必须是**活着的** —— 给一个沉睡/停用的朋友牵线没有意义。
  const ids = friends.map((f) => Number(f.id)).filter((x) => x && x !== me);
  if (ids.length < 2) return [];
  const marks = ids.map(() => '?').join(',');
  const alive = await db.all(
    `SELECT id FROM users WHERE id IN (${marks}) AND user_type = 'ai' AND COALESCE(status, 1) = 1`,
    ids
  );
  const aliveSet = new Set(alive.map((r) => Number(r.id)));
  const live = friends.filter((f) => aliveSet.has(Number(f.id)));
  if (live.length < 2) return [];

  const pairOf = (x, y) => (x < y ? `${x}-${y}` : `${y}-${x}`);
  const combos = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      combos.push({ a: live[i], c: live[j], key: pairOf(Number(live[i].id), Number(live[j].id)) });
    }
  }
  const kmarks = combos.map(() => '?').join(',');
  const edges = await db.all(
    `SELECT pair_key FROM agent_friends WHERE pair_key IN (${kmarks})`,
    combos.map((x) => x.key)
  );
  const taken = new Set(edges.map((r) => String(r.pair_key)));

  // 交情深度用「与 B 一起经过了什么」的条数（agent_chronicles），
  // 不用消息条数 —— 那会把「话多」当成「感情好」，与 §9.6「不用贵重衡量感情」是同一把尺子。
  const depth = new Map();
  const chRows = await db.all(
    `SELECT friend_agent_id, COUNT(*) AS n FROM agent_chronicles
      WHERE agent_id = ? AND friend_agent_id IN (${marks})
      GROUP BY friend_agent_id`,
    [me, ...ids]
  );
  for (const r of chRows) depth.set(Number(r.friend_agent_id), Number(r.n) || 0);

  const out = [];
  for (const cb of combos) {
    if (taken.has(cb.key)) continue;
    const rank = (depth.get(Number(cb.a.id)) || 0) + (depth.get(Number(cb.c.id)) || 0);
    out.push({
      a: { id: Number(cb.a.id), name: cb.a.name, avatar: cb.a.avatar || '' },
      c: { id: Number(cb.c.id), name: cb.c.name, avatar: cb.c.avatar || '' },
      rank,
      reason: `「${cb.a.name}」和「${cb.c.name}」都是你的朋友，但它们彼此还没打过照面。`,
    });
  }
  out.sort((x, y) => (y.rank - x.rank) || (x.a.id - y.a.id));
  const cap = Math.min(Math.max(Number(limit) || 3, 1), 5);
  return out.slice(0, cap).map(({ rank, ...rest }) => rest);
}

// ── N2b 外号（§4.1 A3：「主人给它朋友起个名」）────────────────────
// 主人参与社交的**唯一入口**，零成本、情感浓度极高，且**不破第一公理**：
// 它只改主人自己看得见的东西 + 自己 Agent 的**所知**，不改广场的**所见**。
//
// 三个刻意的边界：
//  ① **只能给已成立的好友起名**（还没成朋友就起名，等于替它预先挑人 —— 那是介入，不是命名）；
//  ② **方向性存储**：nickname_a 是 a 的主人给 b 起的名，故只有 a 这侧读得到（见 splitEdges）。
//     外号在列表里**不覆盖**对方的真名：真名是广场上的事实，外号只是你家里的叫法。
//  ③ **空串 = 抹掉**，不留空壳。
export const NICKNAME_MAX = 12;

export async function setFriendNickname({ agentId, otherAgentId, nickname }) {
  const me = Number(agentId);
  const other = Number(otherAgentId);
  if (me === other) throw badRequest('不能给自己起外号');
  if (!(await aiAgent(me))) throw notFound('unknown_agent');
  if (!(await aiAgent(other))) throw notFound('target_agent_not_found');

  const raw = String(nickname ?? '').trim();
  if (raw.length > NICKNAME_MAX) throw badRequest(`外号请控制在 ${NICKNAME_MAX} 字以内`);
  const value = raw || null; // 空串 = 抹掉

  const edge = await db.get(`SELECT id, agent_a, agent_b, status FROM agent_friends WHERE pair_key = ?`, [pairKey(me, other)]);
  if (!edge || String(edge.status) !== FRIEND_STATUS.ACCEPTED) {
    throw badRequest('只能给你已经认识的朋友起外号');
  }

  // 列名来自受控分支（不是用户输入），不接受任意拼接
  const col = Number(edge.agent_a) === me ? 'nickname_a' : 'nickname_b';
  await db.run(`UPDATE agent_friends SET ${col} = ? WHERE id = ?`, [value, Number(edge.id)]);
  // N4：第一个外号（一生一次，L3）。**抹掉外号（value=null）不算** —— 那是撤销，不是命名。
  // 去重交给 recordEvent 的 ONCE_PER_AGENT（已归一到 global，所以「第二个外号」不会再来敲门）。
  if (value) {
    await onFirstNickname({ agentId: me, otherAgentId: other, nickname: value }).catch(() => {});
  }
  return { nickname: value };
}
