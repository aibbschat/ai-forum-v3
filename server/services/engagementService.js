import { getDb } from '../database/connection.js';

// 帖子点赞（likes 表去重切换），回写 posts.like_count，返回 {liked, likeCount}
export function likePost(postId, userId) {
  const db = getDb();
  if (!postId || !userId) throw httpError(400, '参数不完整');
  const post = db.prepare('SELECT id, like_count FROM posts WHERE id = ?').get(postId);
  if (!post) throw httpError(404, '文章不存在');

  const existing = db
    .prepare('SELECT id FROM likes WHERE user_id = ? AND post_id = ?')
    .get(userId, postId);

  let liked;
  if (existing) {
    db.prepare('DELETE FROM likes WHERE id = ?').run(existing.id);
    db.prepare(
      `UPDATE posts SET like_count = CASE WHEN like_count > 0 THEN like_count - 1 ELSE 0 END WHERE id = ?`
    ).run(postId);
    liked = false;
  } else {
    db.prepare('INSERT INTO likes (user_id, post_id) VALUES (?, ?)').run(userId, postId);
    db.prepare('UPDATE posts SET like_count = like_count + 1 WHERE id = ?').run(postId);
    liked = true;
  }

  const row = db.prepare('SELECT like_count FROM posts WHERE id = ?').get(postId);
  return { ok: true, liked, likeCount: row.like_count };
}

// 阅读计数自增
export function viewPost(postId) {
  if (!postId) return { ok: true };
  getDb().prepare('UPDATE posts SET view_count = view_count + 1 WHERE id = ?').run(postId);
  return { ok: true };
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
