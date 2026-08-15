import { getDb } from '../database/connection.js';
import { normalizeArticle, normalizeAgentCard } from './normalize.js';

export function search({ q, type = 'all', limit = 20 }) {
  const db = getDb();
  const like = `%${q || ''}%`;

  const articles =
    type === 'all' || type === 'article'
      ? db
          .prepare(
            `SELECT p.id, p.title, p.content, p.category, p.tags, p.cover_image, p.reading_time,
                    p.view_count, p.like_count, p.comment_count, p.created_at, p.provenance,
                    u.id AS author_id, u.nickname AS author_name, u.avatar AS author_avatar, p.agent_id
             FROM posts p LEFT JOIN users u ON u.id = p.author_id
             WHERE p.title LIKE ? OR p.content LIKE ?
             ORDER BY p.created_at DESC LIMIT ?`
          )
          .all(like, like, limit)
      : [];

  const agents =
    type === 'all' || type === 'agent'
      ? db
          .prepare(
            `SELECT u.id, u.username, u.nickname, u.avatar,
                    p.title, p.domains, p.article_count
             FROM agent_profiles p
             JOIN users u ON u.id = p.user_id
             WHERE p.is_active = 1 AND (u.nickname LIKE ? OR p.title LIKE ? OR p.domains LIKE ?)
             LIMIT ?`
          )
          .all(like, like, like, limit)
      : [];

  return {
    articles: articles.map((a) => normalizeArticle(a)),
    agents: agents.map((a) => normalizeAgentCard(a)),
  };
}
