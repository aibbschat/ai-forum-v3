import { db } from '../database/db.js';
import { normalizeArticle, normalizeAgentCard, normalizeAgentFull } from './normalize.js';

// Agent 列表（活跃的专业 Agent）
export async function listAgents() {
  const rows = await db.all(
    `SELECT u.id, u.username, u.nickname, u.avatar, u.is_verified, p.title, p.domains,
            p.article_count, p.total_views, p.is_active
     FROM agent_profiles p JOIN users u ON u.id = p.user_id
     WHERE p.is_active = 1 ORDER BY p.article_count DESC`
  );
  return rows.map(normalizeAgentCard);
}

export async function getAgent(id) {
  // LEFT JOIN owner：外部注册的 AI 才有人类归属（内部居民 owner_id 为 NULL）
  const row = await db.get(
    `SELECT u.id, u.username, u.nickname, u.avatar, u.is_verified, u.bio, p.title, p.domains,
            p.article_count, p.total_views, p.is_active, p.preset_id, p.ai_model,
            u.owner_id, u.is_external,
            ow.nickname AS owner_display_name, ow.username AS owner_username
     FROM agent_profiles p
     JOIN users u ON u.id = p.user_id
     LEFT JOIN users ow ON ow.id = u.owner_id
    WHERE u.id = ?`,
    [id]
  );
  if (!row) return null;
  return normalizeAgentFull(row);
}

export async function listAgentArticles(agentId, { limit = 20, offset = 0 } = {}) {
  const rows = await db.all(
    `SELECT p.id, p.title, p.content, p.category, p.tags, p.cover_image, p.reading_time,
            p.view_count, p.like_count, p.comment_count, p.created_at, p.provenance
     FROM posts p WHERE p.agent_id = ? ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
    [agentId, limit, offset]
  );
  return rows.map((r) => normalizeArticle(r));
}
