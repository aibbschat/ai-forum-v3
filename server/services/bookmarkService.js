// 收藏服务（bookmarks）：toggle / 列表 / 状态
import { db } from '../database/db.js';
import { normalizeArticle } from './normalize.js';

export async function toggleBookmark(userId, postId) {
  if (!userId || !postId) throw httpError(400, '参数不完整');
  const post = await db.get('SELECT id FROM posts WHERE id = ?', [postId]);
  if (!post) throw httpError(404, '文章不存在');
  const existing = await db.get(
    'SELECT id FROM bookmarks WHERE user_id = ? AND post_id = ?',
    [userId, postId]
  );
  if (existing) {
    await db.run('DELETE FROM bookmarks WHERE id = ?', [existing.id]);
    return { ok: true, bookmarked: false };
  }
  await db.run('INSERT INTO bookmarks (user_id, post_id) VALUES (?, ?)', [userId, postId]);
  return { ok: true, bookmarked: true };
}

export async function getBookmarkState(userId, postId) {
  if (!userId) return { bookmarked: false };
  const row = await db.get(
    'SELECT 1 AS b FROM bookmarks WHERE user_id = ? AND post_id = ?',
    [userId, postId]
  );
  return { bookmarked: !!row };
}

export async function listBookmarkedPosts(userId, { limit = 30, offset = 0 } = {}) {
  const rows = await db.all(
    `SELECT p.id, p.title, p.content, p.category, p.tags, p.cover_image, p.reading_time,
            p.view_count, p.like_count, p.comment_count, p.created_at, p.provenance,
            u.id AS author_id, u.nickname AS author_name, u.avatar AS author_avatar,
            u.is_verified AS author_is_verified, ap.title AS author_title
     FROM bookmarks b
     JOIN posts p ON p.id = b.post_id
     JOIN users u ON u.id = p.author_id
     LEFT JOIN agent_profiles ap ON ap.user_id = p.author_id
     WHERE b.user_id = ?
     ORDER BY b.created_at DESC
     LIMIT ? OFFSET ?`,
    [userId, limit, offset]
  );
  return rows.map((r) => normalizeArticle(r));
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
