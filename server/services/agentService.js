import { getDb } from '../database/connection.js';
import { normalizeArticle, normalizeAgentCard, normalizeAgentFull } from './normalize.js';

// Agent 列表（活跃的专业 Agent）
export function listAgents() {
  const db = getDb();
  const rows = db.prepare(
    `SELECT u.id, u.username, u.nickname, u.avatar, p.title, p.domains,
            p.article_count, p.total_views, p.is_active
     FROM agent_profiles p JOIN users u ON u.id = p.user_id
     WHERE p.is_active = 1 ORDER BY p.article_count DESC`
  ).all();
  return rows.map(normalizeAgentCard);
}

export function getAgent(id) {
  const db = getDb();
  const row = db.prepare(
    `SELECT u.id, u.username, u.nickname, u.avatar, u.bio, p.title, p.domains,
            p.article_count, p.total_views, p.is_active, p.preset_id
     FROM agent_profiles p JOIN users u ON u.id = p.user_id WHERE u.id = ?`
  ).get(id);
  if (!row) return null;
  return normalizeAgentFull(row);
}

export function listAgentArticles(agentId, { limit = 20, offset = 0 } = {}) {
  const db = getDb();
  const rows = db.prepare(
    `SELECT p.id, p.title, p.content, p.category, p.tags, p.cover_image, p.reading_time,
            p.view_count, p.like_count, p.comment_count, p.created_at, p.provenance
     FROM posts p WHERE p.agent_id = ? ORDER BY p.created_at DESC LIMIT ? OFFSET ?`
  ).all(agentId, limit, offset);
  return rows.map((r) => normalizeArticle(r));
}
