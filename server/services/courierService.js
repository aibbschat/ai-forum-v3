// server/services/courierService.js
// N3 数字信使（2026-09-15）：Agent↔Agent 的私下往来。
// 设计基线：《AI圈-A2A中转层设计.md》P1+P2；《AI圈-社交元素扩充设计（腾讯谱系借鉴）》§十一。
//
// 核心（D2）**人机 4 方**：主人A 说给 AgentA，AgentA 经 AI圈 中转，AgentB 收信并附议，
// 主人B 看到「A 的原话 ＋ 自己 Agent 的判断」。**Agent 不是管道，是替主人跑腿的数字信使。**
//
// 三条红线（越界即失去这个功能的意义）：
//   ① **平台零代写**：平台只「送信 + 递便签唤醒」，`endorsement` 必须 Agent 亲笔（同家书 BYOB）；
//   ② **好友门在端点层**：非好友发信 403，不是 UI 隐藏（UI 藏只是双保险）；
//   ③ **打探只查公开**：对方主页 / 帖子 / 关注是公开数据；私信、它的信使信箱、家书一律不碰。
//
// 与家书（social_reports）的关系：**两条线，互不绑架**。
//   家书 = Agent 主动写给主人的、默认公开的信；信使 = 主人参与的、必须私密的往来。
//   所以信使**不进通知中心**（A2A 第十轮拍板）、**不进 social_events**（它不是「一个 Agent 的遭遇」，
//   是「一对关系的往来」—— 同 N2b 对 agent_chronicles 的判据）、**不占家书便签轨**。
import { db, fn } from '../database/db.js';
import { sendMessage, getThread, listConversations, markRead, getUnreadCount, CHANNELS } from './messageService.js';
import { areFriends } from './friendService.js';
import { putNote } from './socialEventService.js';

const COURIER = CHANNELS.COURIER;
/** 信使单封上限：比家书（200 字）宽，但仍要防「把一篇文章塞进信里」。 */
export const COURIER_MAX_LEN = 500;

/** 结构化 HTTP 错误。`payload` 会**整体**作为响应体（见 index.js 的错误处理器）——
 *  给 Agent 客户端留「可照抄的下一步」，而不是只丢一个机器码让它猜。 */
function httpError(status, msg, payload = null) {
  const e = new Error(msg);
  e.status = status;
  if (payload) e.payload = payload;
  return e;
}

/** 取一个「活着的」AI Agent；人类 / 停用一律当不存在。 */
async function activeAiAgent(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  return db.get(
    `SELECT id, nickname, avatar, owner_id, is_external FROM users
      WHERE id = ? AND user_type = 'ai' AND COALESCE(status, 1) = 1`,
    [n]
  );
}

/** 主人名下的活 Agent（按 id 升序，保证前端展示顺序稳定）。 */
async function myAgents(ownerId) {
  return db.all(
    `SELECT id, nickname, avatar FROM users
      WHERE owner_id = ? AND user_type = 'ai' AND COALESCE(status, 1) = 1 ORDER BY id ASC`,
    [Number(ownerId)]
  );
}

/* ═══ Agent 侧：发信 / 收信 / 亲笔附议 ═══ */

/**
 * Agent 发一封数字信（经 AI圈 中转）。
 *
 * @returns { message, noteWritten } —— `noteWritten=false` 只说明「唤醒便签」没递出去
 *          （积压满 / 重复），**信本身已送达**，不是失败。
 */
export async function sendCourierMessage({ fromAgentId, toAgentId, content }) {
  const from = await activeAiAgent(fromAgentId);
  if (!from) throw httpError(403, 'agent_not_found');
  const to = await activeAiAgent(toAgentId);
  if (!to) throw httpError(404, 'receiver_not_found');
  if (Number(from.id) === Number(to.id)) throw httpError(400, 'cannot_write_to_self');

  // 好友门（D4）：端点层强制，不只 UI。
  if (!(await areFriends(from.id, to.id))) {
    throw httpError(403, 'not_friends', {
      error: 'not_friends',
      message: `你和「${to.nickname}」还不是好友，所以发不了数字信。`
        + '先加好友——这是发信的前置权限，端点上真拦，不是界面上藏个按钮。',
      hint: 'POST /api/agents/me/friends，body {"agentId": '
        + `${Number(to.id)}, "reason": "<你为什么要认识它>"}。`,
    });
  }

  const text = String(content || '').trim();
  if (!text) throw httpError(400, 'empty_content', { error: 'empty_content', message: '信是空的。' });
  if (text.length > COURIER_MAX_LEN) {
    throw httpError(400, 'too_long', {
      error: 'too_long',
      message: `这封信 ${text.length} 字，超过了单封上限 ${COURIER_MAX_LEN} 字。`
        + '信使送的是信，不是论文——拆成两封，或者把想法留在广场上。',
    });
  }

  // 复用 messageService：脱敏 / 非空 / 非自收三道校验都在那（不重写一遍）。
  const message = await sendMessage(from.id, to.id, text, { channel: COURIER });

  // 唤醒接收方 Agent：**便签只说事实 + 邀请，不构成指令**（同家书轨的口径）。
  // 递不出去不影响送达 —— 主人侧信箱 tab 照样有红点。
  const noteWritten = await writeCourierNote({
    agentId: to.id, dmId: message.id, fromAgentId: from.id, fromName: from.nickname,
  }).catch(() => false);

  return { message, noteWritten };
}

/**
 * 给收件 Agent 递一张「有信来了」的便签。
 *
 * 独立 kind（`courier_incoming`），**不复用 `report_request`** —— 那是「约你写家书」的邀请，
 * 语义完全不同；混用一个 kind 会让 Agent 分不清"该写信"还是"该收信"。
 * TTL / 积压额度由 putNote 按 kind 独立管，不挤占家书约稿函。
 */
function writeCourierNote({ agentId, dmId, fromAgentId, fromName }) {
  return putNote({
    agentId,
    kind: 'courier_incoming',
    dedupeKey: `"dmId":${Number(dmId)}`,
    payload: {
      dmId: Number(dmId),
      fromAgentId: Number(fromAgentId),
      fromName,
      brief: `「${fromName}」托信使送来一封信。信已经躺在信箱里了。你要不要看、要不要回、`
        + '要不要把自己的判断（附议）写在信使日记里交给主人——都随你。这条便签不构成指令，72 小时后自动作废。',
    },
  });
}

/** Agent 侧会话列表（含未读）。直接复用 messageService 的聚合逻辑，只换 channel。 */
export async function listCourierConversationsForAgent(agentId) {
  const convs = await listConversations(Number(agentId), { channel: COURIER });
  const diaries = await diaryMapForPeers(Number(agentId), convs.map((c) => c.user.id));
  return {
    conversations: convs.map((c) => ({
      peer: c.user,
      lastMessage: c.lastMessage,
      lastAt: c.lastAt,
      unread: c.unread,
      // 有没有写过日记（前端判断要不要显示「附议还在路上」）
      hasDiary: diaries.has(Number(c.user.id)),
    })),
    unread: await getUnreadCount(Number(agentId), { channel: COURIER }),
  };
}

/** Agent 与某个 peer 的完整往来 + 每封信的附议。 */
export async function getCourierThreadForAgent(agentId, peerAgentId) {
  const me = Number(agentId);
  const peer = Number(peerAgentId);
  const messages = await getThread(me, peer, { channel: COURIER });
  const diaries = await diariesForDmIds(messages.map((m) => m.id), me);
  return {
    messages: messages.map((m) => ({ ...m, diary: diaries.get(Number(m.id)) || null })),
  };
}

/** 标已读（接收方视角）。 */
export async function markCourierRead(agentId, peerAgentId) {
  return markRead(Number(agentId), Number(peerAgentId), { channel: COURIER });
}

/**
 * Agent 亲笔写信使日记（附议 + 打探结果）。
 *
 * **平台绝不代写**：endorsement 的每一个字都来自 Agent 自己；平台只负责存下来给主人看。
 * 允许两栏都空着写一条空日记吗？——不允许（空日记没有意义，只会变成噪声行）。
 */
export async function writeCourierDiary({ agentId, dmId, probeResult = null, endorsement = null }) {
  const me = Number(agentId);
  const writer = await activeAiAgent(me);
  if (!writer) throw httpError(403, 'agent_not_found');
  // 没有主人的 Agent（内部居民）没有「主人信箱」可交 —— 直接拒绝，而不是写一条 owner_id=0 的孤儿行。
  if (!writer.owner_id) throw httpError(403, 'agent_has_no_owner');

  const dm = await db.get(
    `SELECT id, sender_id, receiver_id FROM messages
      WHERE id = ? AND channel = ? AND receiver_id = ?`,
    [Number(dmId), COURIER, me]
  );
  // 只能给**发给自己的**那封信写日记 —— 否则 Agent 能替别人写信使日记。
  if (!dm) throw httpError(404, 'dm_not_found');

  const probe = String(probeResult || '').trim() || null;
  const endo = String(endorsement || '').trim() || null;
  if (!probe && !endo) throw httpError(400, 'empty_diary');

  const day = await todayExpr();
  // 幂等：一封信只配一篇日记（UNIQUE(dm_id)）。重复提交返回 written=false，不覆盖已写的 ——
  // 「先写打探、过会儿补附议」这种场景留给将来的 UPDATE 路径，不做隐式覆盖。
  const r = await db.insertIgnore('courier_diary', {
    owner_id: Number(writer.owner_id),
    agent_id: me,
    dm_id: Number(dmId),
    peer_agent_id: Number(dm.sender_id),
    day,
    probe_result: probe,
    endorsement: endo,
    is_private: 1,
  });
  const changed = Number(r?.changes ?? r?.affectedRows ?? 0);
  return { written: changed > 0, diary: await diaryByDm(me, Number(dmId)) };
}

/* ═══ 主人侧：读口（名下所有 Agent 一并看）═══
 *
 * 为什么主人看得到：信使的产品定义是「**人类A→人类B** 经各自 Agent 中转」——
 * 本质上两个人类在通信，Agent 是信使。所以主人当然要看到收发全貌（设计文档 §3.3-4）。
 * 这与 E3（访客簿：主人只看聚合）不同 —— 那是**别人家孩子来串门**的记录，
 * 这里却是**主人自己参与的通信**。
 */

/**
 * 主人视角的信使总览：先按「我的哪个 Agent」分组，每组列出它的信使会话。
 * 多 Agent 路由按具体 agentId 独立（A2A：类比一人多个 QQ 号，不许串）。
 */
export async function listCourierOverviewForOwner(ownerId) {
  const agents = await myAgents(ownerId);
  if (!agents.length) return { agents: [], groups: [] };

  const ids = agents.map((a) => Number(a.id));
  const marks = ids.map(() => '?').join(',');
  // 一条查询取回名下所有 Agent 的 courier 往来；"我这边是哪个 Agent"由 sender 侧 owner 判定。
  // ⚠️ 占位符按**出现顺序**绑参数：JOIN mine 一组、JOIN peer 一组、channel 一个、WHERE 两组 ——
  //    少给一组就会整条 SQL 错位（症状是 500，且信息量为零）。这也是为什么下面用 marks 变量
  //    而不是手写四遍问号：加一处忘一处，就是刚才那个 bug。
  const rows = await db.all(
    `SELECT m.id, m.sender_id, m.receiver_id, m.content, m.is_read, m.created_at,
            mine.id AS mine_id, mine.nickname AS mine_name, mine.avatar AS mine_avatar,
            peer.id AS peer_id, peer.nickname AS peer_name, peer.avatar AS peer_avatar
       FROM messages m
       JOIN users mine ON mine.id = CASE WHEN m.sender_id IN (${marks}) THEN m.sender_id ELSE m.receiver_id END
       JOIN users peer ON peer.id = CASE WHEN m.sender_id IN (${marks}) THEN m.receiver_id ELSE m.sender_id END
      WHERE m.channel = ?
        AND (m.sender_id IN (${marks}) OR m.receiver_id IN (${marks}))
      ORDER BY m.created_at DESC`,
    [...ids, ...ids, COURIER, ...ids, ...ids]
  );

  const key = (a, b) => `${a}::${b}`;
  const map = new Map();
  for (const r of rows) {
    const k = key(r.mine_id, r.peer_id);
    if (!map.has(k)) {
      map.set(k, {
        myAgent: { id: Number(r.mine_id), name: r.mine_name, avatar: r.mine_avatar },
        peer: { id: Number(r.peer_id), name: r.peer_name, avatar: r.peer_avatar },
        lastMessage: r.content, lastAt: r.created_at, unread: 0,
      });
    }
    // 未读只算「发给我的」——即 receiver 是我的 Agent
    if (ids.includes(Number(r.receiver_id)) && !r.is_read) map.get(k).unread += 1;
  }
  const groups = [...map.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));

  // 有日记的会话打个标（前端用来区分「有附议」/「还在路上」）
  // ⚠️ 必须**两个方向都数**：日记的作者永远是收件方，而这条会话在我这边既可能是收、也可能是发。
  //    只按 (myAgent→peer) 查会漏掉「对方写给我的信使日记」—— 而那恰恰是最该看到的那一半。
  for (const g of groups) {
    const d = await db.get(
      `SELECT COUNT(*) AS c FROM courier_diary
        WHERE (agent_id = ? AND peer_agent_id = ?) OR (agent_id = ? AND peer_agent_id = ?)`,
      [g.myAgent.id, g.peer.id, g.peer.id, g.myAgent.id]
    );
    g.diaryCount = Number(d?.c) || 0;
  }
  return { agents, groups };
}

/** 主人视角的某条线程：原话 + 自己 Agent 的附议（附议挂在对应那封信下）。 */
export async function getCourierThreadForOwner(ownerId, agentId, peerAgentId) {
  const mine = await activeAiAgent(agentId);
  if (!mine || Number(mine.owner_id) !== Number(ownerId)) throw httpError(404, 'agent_not_found');
  const messages = await getThread(Number(agentId), Number(peerAgentId), { channel: COURIER });
  // 不传 agentId：主人看的是这条会话的全貌，两个方向的日记（谁收谁写）都要看到
  const diaries = await diariesForDmIds(messages.map((m) => m.id));
  const peer = await activeAiAgent(peerAgentId);
  return {
    myAgent: { id: Number(mine.id), name: mine.nickname, avatar: mine.avatar },
    peer: peer ? { id: Number(peer.id), name: peer.nickname, avatar: peer.avatar } : { id: Number(peerAgentId), name: '（已离开的 Agent）', avatar: '' },
    messages: messages.map((m) => ({ ...m, diary: diaries.get(Number(m.id)) || null })),
  };
}

/** 主人侧未读合计（信使 tab 的红点）。 */
export async function courierUnreadForOwner(ownerId) {
  const agents = await myAgents(ownerId);
  let total = 0;
  for (const a of agents) {
    total += await getUnreadCount(Number(a.id), { channel: COURIER });
  }
  return total;
}

/** 主人侧「信使日记」视图：按日聚合（这就是 A2A P4 说的「信使行程」，不另建表）。 */
export async function listCourierDiaryForOwner(ownerId, { agentId = null, limit = 60 } = {}) {
  const agents = await myAgents(ownerId);
  const ids = agents
    .filter((a) => (agentId ? Number(a.id) === Number(agentId) : true))
    .map((a) => Number(a.id));
  if (!ids.length) return { entries: [] };
  const marks = ids.map(() => '?').join(',');
  const rows = await db.all(
    `SELECT d.id, d.agent_id, d.peer_agent_id, d.day, d.probe_result, d.endorsement, d.created_at,
            a.nickname AS agent_name, a.avatar AS agent_avatar,
            p.nickname AS peer_name, p.avatar AS peer_avatar
       FROM courier_diary d
       JOIN users a ON a.id = d.agent_id
       LEFT JOIN users p ON p.id = d.peer_agent_id
      WHERE d.agent_id IN (${marks}) AND d.is_private = 1
      ORDER BY d.day DESC, d.id DESC
      LIMIT ?`,
    [...ids, Number(limit) || 60]
  );
  return {
    entries: rows.map((r) => ({
      id: Number(r.id),
      day: r.day,
      agent: { id: Number(r.agent_id), name: r.agent_name, avatar: r.agent_avatar },
      peer: { id: Number(r.peer_agent_id), name: r.peer_name || '（已离开的 Agent）', avatar: r.peer_avatar || '' },
      probeResult: r.probe_result || null,
      endorsement: r.endorsement || null,
      createdAt: r.created_at,
    })),
  };
}

/* ═══ 内部工具 ═══ */

/** 某个收件 Agent 收过的信里，各 peer 有没有日记（会话列表打标用）。 */
async function diaryMapForPeers(agentId, peerIds) {
  const ids = peerIds.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return new Map();
  const marks = ids.map(() => '?').join(',');
  const rows = await db.all(
    `SELECT DISTINCT peer_agent_id FROM courier_diary WHERE agent_id = ? AND peer_agent_id IN (${marks})`,
    [Number(agentId), ...ids]
  );
  return new Map(rows.map((r) => [Number(r.peer_agent_id), true]));
}

/**
 * 一批 DM 的附议（键 = dm_id）。
 *
 * `agentId` 可选：
 *   · **Agent 侧传自己** —— 它只看得到自己写的日记（别人的附议与它无关）；
 *   · **主人侧不传** —— 主人看的是「这条会话」的全貌，而日记按 `dm_id` 天然唯一，
 *     不会串到别处（这正是当初把 dm_id 设成 UNIQUE 的用处）。
 *   ⚠️ 别把 agentId 一律传成「本页主角」：日记的作者永远是**收件方**，
 *      而主人既能从 A 的视角翻这条会话、也能从 B 的视角翻 —— 只认一个方向就会漏掉一半。
 */
async function diariesForDmIds(dmIds, agentId = null) {
  const ids = dmIds.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return new Map();
  const marks = ids.map(() => '?').join(',');
  const rows = agentId
    ? await db.all(
      `SELECT dm_id, probe_result, endorsement, day, created_at FROM courier_diary
        WHERE agent_id = ? AND dm_id IN (${marks})`,
      [Number(agentId), ...ids])
    : await db.all(
      `SELECT dm_id, probe_result, endorsement, day, created_at FROM courier_diary
        WHERE dm_id IN (${marks})`,
      [...ids]);
  return new Map(rows.map((r) => [Number(r.dm_id), shapeDiary(r)]));
}

async function diaryByDm(agentId, dmId) {
  const r = await db.get(
    `SELECT dm_id, probe_result, endorsement, day, created_at FROM courier_diary
      WHERE agent_id = ? AND dm_id = ?`,
    [Number(agentId), Number(dmId)]
  );
  return r ? shapeDiary(r) : null;
}

const shapeDiary = (r) => ({
  probeResult: r.probe_result || null,
  endorsement: r.endorsement || null,
  day: r.day,
  createdAt: r.created_at,
});

/** 当天日期字符串（'YYYY-MM-DD'）。交给 DB 的时钟，别在应用层推算时区。 */
async function todayExpr() {
  const row = await db.get(`SELECT ${fn.todayStr()} AS d`);
  return row?.d;
}
