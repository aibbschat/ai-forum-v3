import { db } from '../database/db.js';
import { maskSecrets } from './moderationService.js';

// 短消息 DM：会话列表 / 线程 / 发送 / 已读。纯 REST，前端轮询刷新。
//
// N3（2026-09-15）加 `channel` 分类：human=人对人私信 ｜ courier=Agent↔Agent 数字信使。
//
// ⚠️ 本文件的**头号回归风险**：`routes/messages.js` 有 5 处调这些函数、全都不传 channel。
//   所以每个函数的默认值必须是 `'human'` —— 一旦默认成 courier（或漏了过滤），
//   信使的信就会混进主人的「私信」tab，而这是最难在测试里发现的那类 bug。
//   反向同理：信使 tab 也绝不能看见人类私信。

/** 信箱分类白名单。channel 会进 SQL 的 WHERE —— **受控值，不放用户输入原样通过**。 */
export const CHANNELS = Object.freeze({ HUMAN: 'human', COURIER: 'courier' });

/** 收口：未知值一律落回 'human'（默认安全 —— 猜错时最多是"私信里多了一条"，不会泄密）。 */
function normChannel(v) {
  return v === CHANNELS.COURIER ? CHANNELS.COURIER : CHANNELS.HUMAN;
}

function normalizeMessage(r) {
  return {
    id: r.id,
    senderId: r.sender_id,
    receiverId: r.receiver_id,
    content: r.content,
    channel: r.channel || CHANNELS.HUMAN,
    isRead: !!r.is_read,
    createdAt: r.created_at,
  };
}

export async function sendMessage(senderId, receiverId, content, { channel = CHANNELS.HUMAN } = {}) {
  content = (content || '').trim();
  if (!content) {
    const e = new Error('empty_content');
    e.status = 400;
    throw e;
  }
  if (!receiverId || receiverId === senderId) {
    const e = new Error('invalid_receiver');
    e.status = 400;
    throw e;
  }
  // 信任与安全（2026-09-12）：私信落库前脱敏——API key / JWT / 绑定码 / 手机号 / 证件号
  // 一律替换为 [已隐去]（Moltbook 私信泄露明文 OpenAI key 事故的直接对策）。只脱敏，不拒发。
  // 信使（courier）复用同一条 —— 脱敏是"往外发"的属性，与分类无关。
  content = maskSecrets(content).text;
  const r = await db.run(
    `INSERT INTO messages (sender_id, receiver_id, content, is_read, channel) VALUES (?, ?, ?, 0, ?)`,
    [senderId, receiverId, content, normChannel(channel)]
  );
  const row = await db.get(`SELECT * FROM messages WHERE id = ?`, [r.lastInsertRowid]);
  return normalizeMessage(row);
}

// 与某用户的完整线程（按时间升序）。
export async function getThread(userId, otherId, { channel = CHANNELS.HUMAN } = {}) {
  const rows = await db.all(
    `SELECT * FROM messages
     WHERE channel = ?
       AND ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
     ORDER BY created_at ASC`,
    [normChannel(channel), userId, otherId, otherId, userId]
  );
  return rows.map(normalizeMessage);
}

// 会话列表：每个对方的最近一条消息 + 未读数（仅本用户参与的会话）。
export async function listConversations(userId, { channel = CHANNELS.HUMAN } = {}) {
  const rows = await db.all(
    `SELECT m.id, m.sender_id, m.receiver_id, m.content, m.is_read, m.channel, m.created_at,
            u.id AS ou_id, u.nickname AS ou_name, u.avatar AS ou_avatar
     FROM messages m
     LEFT JOIN users u ON u.id = CASE WHEN m.sender_id = ? THEN m.receiver_id ELSE m.sender_id END
     WHERE m.channel = ? AND (m.sender_id = ? OR m.receiver_id = ?)
     ORDER BY m.created_at DESC`,
    [userId, normChannel(channel), userId, userId]
  );
  const convMap = new Map();
  for (const r of rows) {
    const otherId = r.sender_id === userId ? r.receiver_id : r.sender_id;
    if (!convMap.has(otherId)) {
      convMap.set(otherId, {
        user: { id: r.ou_id, name: r.ou_name, avatar: r.ou_avatar },
        lastMessage: r.content,
        // 最后一句是谁说的 —— 信使（courier）读口靠它决定要不要给 `lastMessage`
        // 包 `<untrusted_agent_content>`：**只有对方写的才是「他人正文」**，
        // 自己发的那句包上数据标记反而是错的（第四红线，2026-09-15 巡检补）。
        lastFromMe: r.sender_id === userId,
        lastAt: r.created_at,
        unread: 0,
      });
    }
    if (r.receiver_id === userId && !r.is_read) convMap.get(otherId).unread += 1;
  }
  return [...convMap.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
}

// 把与某用户的会话标记为已读（仅接收方视角）。
export async function markRead(userId, otherId, { channel = CHANNELS.HUMAN } = {}) {
  await db.run(
    `UPDATE messages SET is_read = 1
      WHERE receiver_id = ? AND sender_id = ? AND channel = ? AND is_read = 0`,
    [userId, otherId, normChannel(channel)]
  );
  return { ok: true };
}

// 当前用户未读总数（供导航栏红点轻量轮询）。
export async function getUnreadCount(userId, { channel = CHANNELS.HUMAN } = {}) {
  const row = await db.get(
    `SELECT COUNT(*) AS c FROM messages WHERE receiver_id = ? AND is_read = 0 AND channel = ?`,
    [userId, normChannel(channel)]
  );
  return row ? Number(row.c) : 0;
}
