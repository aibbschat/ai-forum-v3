import { db } from '../database/db.js';
import { maskSecrets } from './moderationService.js';

// 短消息 DM：会话列表 / 线程 / 发送 / 已读。纯 REST，前端轮询刷新。

function normalizeMessage(r) {
  return {
    id: r.id,
    senderId: r.sender_id,
    receiverId: r.receiver_id,
    content: r.content,
    isRead: !!r.is_read,
    createdAt: r.created_at,
  };
}

export async function sendMessage(senderId, receiverId, content) {
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
  content = maskSecrets(content).text;
  const r = await db.run(
    `INSERT INTO messages (sender_id, receiver_id, content, is_read) VALUES (?, ?, ?, 0)`,
    [senderId, receiverId, content]
  );
  const row = await db.get(`SELECT * FROM messages WHERE id = ?`, [r.lastInsertRowid]);
  return normalizeMessage(row);
}

// 与某用户的完整私信线程（按时间升序）。
export async function getThread(userId, otherId) {
  const rows = await db.all(
    `SELECT * FROM messages
     WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
     ORDER BY created_at ASC`,
    [userId, otherId, otherId, userId]
  );
  return rows.map(normalizeMessage);
}

// 会话列表：每个对方的最近一条消息 + 未读数（仅本用户参与的会话）。
export async function listConversations(userId) {
  const rows = await db.all(
    `SELECT m.id, m.sender_id, m.receiver_id, m.content, m.is_read, m.created_at,
            u.id AS ou_id, u.nickname AS ou_name, u.avatar AS ou_avatar
     FROM messages m
     LEFT JOIN users u ON u.id = CASE WHEN m.sender_id = ? THEN m.receiver_id ELSE m.sender_id END
     WHERE m.sender_id = ? OR m.receiver_id = ?
     ORDER BY m.created_at DESC`,
    [userId, userId, userId]
  );
  const convMap = new Map();
  for (const r of rows) {
    const otherId = r.sender_id === userId ? r.receiver_id : r.sender_id;
    if (!convMap.has(otherId)) {
      convMap.set(otherId, {
        user: { id: r.ou_id, name: r.ou_name, avatar: r.ou_avatar },
        lastMessage: r.content,
        lastAt: r.created_at,
        unread: 0,
      });
    }
    if (r.receiver_id === userId && !r.is_read) convMap.get(otherId).unread += 1;
  }
  return [...convMap.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
}

// 把与某用户的会话标记为已读（仅接收方视角）。
export async function markRead(userId, otherId) {
  await db.run(
    `UPDATE messages SET is_read = 1 WHERE receiver_id = ? AND sender_id = ? AND is_read = 0`,
    [userId, otherId]
  );
  return { ok: true };
}

// 当前用户未读私信总数（供导航栏红点轻量轮询）。
export async function getUnreadCount(userId) {
  const row = await db.get(
    `SELECT COUNT(*) AS c FROM messages WHERE receiver_id = ? AND is_read = 0`,
    [userId]
  );
  return row ? Number(row.c) : 0;
}
