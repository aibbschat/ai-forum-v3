import { getDb } from '../database/connection.js';

// 评论列表（含作者昵称/头像 + like 计数；可选传 userId 计算"我是否点过赞"）
export function listComments(postId, { userId = null } = {}) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT c.id, c.post_id, c.author_id, c.content, c.is_ai_generated, c.created_at,
              u.nickname AS author, u.avatar AS author_avatar,
              (SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id = c.id) AS like_count
       FROM comments c
       JOIN users u ON u.id = c.author_id
       WHERE c.post_id = ?
       ORDER BY c.created_at ASC`
    )
    .all(postId);

  return rows.map((r) => {
    let liked = false;
    if (userId) {
      liked = !!db
        .prepare('SELECT id FROM comment_likes WHERE comment_id = ? AND user_id = ?')
        .get(r.id, userId);
    }
    return {
      id: r.id,
      postId: r.post_id,
      authorId: r.author_id,
      author: r.author,
      authorAvatar: r.author_avatar,
      content: r.content,
      isAiGenerated: !!r.is_ai_generated,
      likeCount: r.like_count,
      liked,
      createdAt: r.created_at,
    };
  });
}

// 新增评论（作者 = 当前登录用户），并回写 posts.comment_count
export function addComment({ postId, authorId, content }) {
  const db = getDb();
  if (!postId || !authorId || !content || !String(content).trim()) {
    throw httpError(400, '评论内容不能为空');
  }
  const post = db.prepare('SELECT id FROM posts WHERE id = ?').get(postId);
  if (!post) throw httpError(404, '文章不存在');

  const info = db
    .prepare(
      `INSERT INTO comments (post_id, author_id, content, is_ai_generated)
       VALUES (?, ?, ?, 0)`
    )
    .run(postId, authorId, String(content).trim());
  db.prepare('UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?').run(postId);

  const row = db
    .prepare(
      `SELECT c.id, c.post_id, c.author_id, c.content, c.is_ai_generated, c.created_at,
              u.nickname AS author, u.avatar AS author_avatar
       FROM comments c JOIN users u ON u.id = c.author_id WHERE c.id = ?`
    )
    .get(info.lastInsertRowid);

  return {
    id: row.id,
    postId: row.post_id,
    authorId: row.author_id,
    author: row.author,
    authorAvatar: row.author_avatar,
    content: row.content,
    isAiGenerated: !!row.is_ai_generated,
    likeCount: 0,
    liked: false,
    createdAt: row.created_at,
  };
}

// 评论点赞（comment_likes 表去重切换，返回新计数）
export function likeComment(commentId, userId) {
  const db = getDb();
  if (!commentId || !userId) throw httpError(400, '参数不完整');
  const comment = db.prepare('SELECT id FROM comments WHERE id = ?').get(commentId);
  if (!comment) throw httpError(404, '评论不存在');

  const existing = db
    .prepare('SELECT id FROM comment_likes WHERE comment_id = ? AND user_id = ?')
    .get(commentId, userId);
  let liked;
  if (existing) {
    db.prepare('DELETE FROM comment_likes WHERE id = ?').run(existing.id);
    liked = false;
  } else {
    db.prepare('INSERT INTO comment_likes (user_id, comment_id) VALUES (?, ?)').run(
      userId,
      commentId
    );
    liked = true;
  }

  const { n: likeCount } = db
    .prepare('SELECT COUNT(*) AS n FROM comment_likes WHERE comment_id = ?')
    .get(commentId);
  return { ok: true, liked, likeCount };
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
