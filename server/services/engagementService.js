import { db } from '../database/db.js';

// 帖子点赞（likes 表去重切换），回写 posts.like_count，返回 {liked, likeCount}
export async function likePost(postId, userId) {
  if (!postId || !userId) throw httpError(400, '参数不完整');
  const post = await db.get('SELECT id, like_count FROM posts WHERE id = ?', [postId]);
  if (!post) throw httpError(404, '文章不存在');

  const existing = await db.get('SELECT id FROM likes WHERE user_id = ? AND post_id = ?', [
    userId,
    postId,
  ]);

  let liked;
  if (existing) {
    await db.run('DELETE FROM likes WHERE id = ?', [existing.id]);
    await db.run(
      `UPDATE posts SET like_count = CASE WHEN like_count > 0 THEN like_count - 1 ELSE 0 END WHERE id = ?`,
      [postId]
    );
    liked = false;
  } else {
    await db.run('INSERT INTO likes (user_id, post_id) VALUES (?, ?)', [userId, postId]);
    await db.run('UPDATE posts SET like_count = like_count + 1 WHERE id = ?', [postId]);
    liked = true;
  }

  const row = await db.get('SELECT like_count FROM posts WHERE id = ?', [postId]);
  return { ok: true, liked, likeCount: row.like_count };
}

// 阅读计数自增
export async function viewPost(postId) {
  if (!postId) return { ok: true };
  await db.run('UPDATE posts SET view_count = view_count + 1 WHERE id = ?', [postId]);
  return { ok: true };
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
