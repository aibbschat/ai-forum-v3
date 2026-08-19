// 站内通知服务：点赞 / 评论 / 回复 / 关注 / @提及
// 所有写入都是 fire-and-forget；调用方不应 await 阻塞主流程。
// 为防止自己给自己触发通知、重复触发，createNotification 内部去重 + 自身过滤。
import { db } from '../database/db.js';

const VALID_TYPES = new Set(['like', 'comment', 'reply', 'follow', 'mention']);

/**
 * 写一条通知（幂等、失败不抛、不阻塞业务）。
 * @param {object} p
 * @param {number} p.userId       收件人
 * @param {number} p.actorId      触发者
 * @param {'like'|'comment'|'reply'|'follow'|'mention'} p.type
 * @param {number} [p.postId]
 * @param {number} [p.commentId]
 * @param {object} [p.extra]      JSON 可序列化对象
 */
export async function createNotification({ userId, actorId, type, postId, commentId, extra }) {
  try {
    if (!userId || !actorId || userId === actorId) return; // 不通知自己
    if (!VALID_TYPES.has(type)) return;
    // 5 分钟内同 (user, actor, type, post) 去重，防抖动/刷赞
    const dup = await db.get(
      `SELECT id FROM notifications
       WHERE user_id = ? AND actor_id = ? AND type = ?
         AND (? IS NULL OR post_id = ?)
         AND created_at >= ${isMariaSafe()}`,
      [userId, actorId, type, postId ?? null, postId ?? null]
    );
    if (dup) return;
    await db.run(
      `INSERT INTO notifications (user_id, actor_id, type, post_id, comment_id, extra)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        userId,
        actorId,
        type,
        postId ?? null,
        commentId ?? null,
        extra ? JSON.stringify(extra) : null,
      ]
    );
  } catch (e) {
    console.warn('[notificationService] create failed (ignored):', e?.message || e);
  }
}

// 列表：返回带 actor 昵称/头像和文章标题的统一结构
export async function listNotifications(userId, { limit = 30, offset = 0, unreadOnly = false } = {}) {
  const where = ['n.user_id = ?'];
  const args = [userId];
  if (unreadOnly) {
    where.push('n.is_read = 0');
  }
  const rows = await db.all(
    `SELECT n.id, n.type, n.post_id, n.comment_id, n.is_read, n.extra, n.created_at,
            u.id AS actor_id, u.nickname AS actor_name, u.avatar AS actor_avatar,
            u.user_type AS actor_user_type,
            p.title AS post_title
     FROM notifications n
     JOIN users u ON u.id = n.actor_id
     LEFT JOIN posts p ON p.id = n.post_id
     WHERE ${where.join(' AND ')}
     ORDER BY n.created_at DESC
     LIMIT ? OFFSET ?`,
    [...args, limit, offset]
  );
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    isRead: !!r.is_read,
    postId: r.post_id ?? undefined,
    commentId: r.comment_id ?? undefined,
    postTitle: r.post_title || undefined,
    actor: {
      id: r.actor_id,
      name: r.actor_name,
      avatar: r.actor_avatar,
      userType: r.actor_user_type || 'human',
    },
    extra: safeJson(r.extra),
    createdAt: r.created_at,
  }));
}

export async function countUnread(userId) {
  const row = await db.get(
    `SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0`,
    [userId]
  );
  return row ? row.n : 0;
}

export async function markAllRead(userId) {
  await db.run(`UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0`, [userId]);
  return { ok: true };
}

export async function markOneRead(userId, notificationId) {
  await db.run(
    `UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?`,
    [notificationId, userId]
  );
  return { ok: true };
}

function safeJson(v) {
  if (v == null) return undefined;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return undefined; }
}

// 方言助手（避免在通知查询里引 isMaria 形成循环依赖：直接字符串化）
import { isMaria } from '../database/db.js';
function isMariaSafe() {
  return isMaria ? `DATE_SUB(NOW(), INTERVAL 5 MINUTE)` : `datetime('now', '-5 minutes')`;
}
