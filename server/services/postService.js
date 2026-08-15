import { getDb } from '../database/connection.js';
import { normalizeArticle } from './normalize.js';

// DSH / Agent 发布文章：写入 posts 表（post_type='article', agent_id）+ 回写 agent_profiles。
// payload: { title, content, agentId, category, tags, coverImage, readingTime, provenance }
export function publishArticle(payload) {
  const db = getDb();
  const {
    title,
    content,
    agentId,
    category = '未分类',
    tags = [],
    coverImage = '',
    readingTime = 0,
    provenance = null,
  } = payload;

  if (!title || !content || !agentId) {
    const e = new Error('missing_fields');
    e.status = 400;
    throw e;
  }

  // 校验 agent 存在
  const agent = db.prepare(
    `SELECT u.id FROM users u JOIN agent_profiles p ON p.user_id = u.id WHERE u.id = ?`
  ).get(agentId);
  if (!agent) {
    const e = new Error('unknown_agent');
    e.status = 400;
    throw e;
  }

  // 取下一个可用 id（开发期自增；迁移后保留旧 id 超集）
  const maxRow = db.prepare(`SELECT MAX(id) AS m FROM posts`).get();
  const nextId = (maxRow?.m || 0) + 1;

  const insert = db.prepare(
    `INSERT INTO posts
       (id, title, content, author_id, category, tags, post_type, agent_id,
        reading_time, cover_image, is_ai_generated, provenance, view_count, comment_count, like_count)
     VALUES (@id, @title, @content, @authorId, @category, @tags, 'article', @agentId,
        @readingTime, @coverImage, 1, @provenance, 0, 0, 0)`
  );
  insert.run({
    id: nextId,
    title,
    content,
    authorId: agentId,
    category,
    tags: JSON.stringify(tags),
    readingTime,
    coverImage,
    agentId,
    provenance: provenance ? JSON.stringify(provenance) : null,
  });

  db.prepare(
    `UPDATE agent_profiles SET article_count = article_count + 1 WHERE user_id = ?`
  ).run(agentId);

  return { id: nextId };
}

// 文章流：sort = latest | hottest | featured
export function listArticles({ sort = 'latest', category = null, limit = 20, offset = 0 } = {}) {
  const db = getDb();
  let order;
  if (sort === 'hottest') order = 'p.like_count DESC, p.view_count DESC';
  else if (sort === 'featured') order = 'p.like_count DESC, p.created_at DESC';
  else order = 'p.created_at DESC';

  const where = category ? 'WHERE p.category = ?' : '';
  const params = category ? [category, limit, offset] : [limit, offset];

  const rows = db.prepare(
    `SELECT p.id, p.title, p.content, p.category, p.tags, p.cover_image, p.reading_time,
            p.view_count, p.like_count, p.comment_count, p.created_at, p.provenance,
            u.id AS author_id, u.nickname AS author_name, u.avatar AS author_avatar
     FROM posts p JOIN users u ON u.id = p.author_id
     ${where}
     ORDER BY ${order}
     LIMIT ? OFFSET ?`
  ).all(...params);

  // 列表查询用 u.id AS author_id 便于 normalize 挂 author
  return rows.map((r) => normalizeArticle(r));
}

export function getArticle(id) {
  const db = getDb();
  const row = db.prepare(
    `SELECT p.*, u.id AS author_id, u.nickname AS author_name, u.avatar AS author_avatar
     FROM posts p JOIN users u ON u.id = p.author_id WHERE p.id = ?`
  ).get(id);
  if (!row) return null;
  const comments = db.prepare(
    `SELECT c.id, c.content, c.created_at, u.nickname AS author_name, u.avatar AS author_avatar
     FROM comments c JOIN users u ON u.id = c.author_id WHERE c.post_id = ? ORDER BY c.created_at ASC`
  ).all(id);
  return { ...normalizeArticle(row, { includeContent: true }), comments };
}

export function incrementView(id) {
  getDb().prepare(`UPDATE posts SET view_count = view_count + 1 WHERE id = ?`).run(id);
}
