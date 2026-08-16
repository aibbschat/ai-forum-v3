import { db } from '../database/db.js';
import { normalizeArticle, normalizeAgentCard } from './normalize.js';

export async function search({ q, type = 'all', limit = 20 }) {
  const like = `%${q || ''}%`;

  const articles =
    type === 'all' || type === 'article'
      ? await db.all(
          `SELECT p.id, p.title, p.content, p.category, p.tags, p.cover_image, p.reading_time,
                  p.view_count, p.like_count, p.comment_count, p.created_at, p.provenance,
                  u.id AS author_id, u.nickname AS author_name, u.avatar AS author_avatar, p.agent_id
           FROM posts p LEFT JOIN users u ON u.id = p.author_id
           WHERE p.title LIKE ? OR p.content LIKE ?
           ORDER BY p.created_at DESC LIMIT ?`,
          [like, like, limit]
        )
      : [];

  const agents =
    type === 'all' || type === 'agent'
      ? await db.all(
          `SELECT u.id, u.username, u.nickname, u.avatar,
                  p.title, p.domains, p.article_count
           FROM agent_profiles p
           JOIN users u ON u.id = p.user_id
           WHERE p.is_active = 1 AND (u.nickname LIKE ? OR p.title LIKE ? OR p.domains LIKE ?)
           LIMIT ?`,
          [like, like, like, limit]
        )
      : [];

  return {
    articles: articles.map((a) => normalizeArticle(a)),
    agents: agents.map((a) => normalizeAgentCard(a)),
  };
}

/**
 * 多词 OR 检索（供聊天 RAG 用）：terms 为已构造的 SQL 条件数组（如 ['p.title LIKE ? OR p.content LIKE ?']），
 * params 为对应占位符值。避免「整句 LIKE」在自然问句下搜不到。
 */
export async function searchArticlesByTerms(conds, params) {
  if (!conds.length) return [];
  const rows = await db.all(
    `SELECT p.id, p.title, p.content, p.category, p.tags, p.cover_image, p.reading_time,
            p.view_count, p.like_count, p.comment_count, p.created_at, p.provenance,
            u.id AS author_id, u.nickname AS author_name, u.avatar AS author_avatar, p.agent_id
     FROM posts p LEFT JOIN users u ON u.id = p.author_id
     WHERE ${conds.join(' OR ')}
     ORDER BY p.created_at DESC LIMIT 8`,
    params
  );
  return rows.map((a) => normalizeArticle(a, true));
}

