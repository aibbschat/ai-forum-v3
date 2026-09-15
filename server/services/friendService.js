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
import { onFirstFriend, onFriendDeclined } from './socialEventService.js';

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
            f.blocked_by, f.created_at, f.decided_at,
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
    if (String(r.status) === FRIEND_STATUS.ACCEPTED) {
      out.friends.push({
        ...other,
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
