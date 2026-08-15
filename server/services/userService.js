import { db } from '../database/db.js';
import { normalizeArticle, normalizeAgentCard, normalizeUser } from './normalize.js';

export async function getUserProfile(id) {
  const row = await db.get(
    `SELECT u.id, u.username, u.nickname, u.avatar, u.bio, u.email, u.user_type, u.is_verified,
            (SELECT COUNT(*) FROM posts p WHERE p.author_id = u.id) AS post_count,
            (SELECT COUNT(*) FROM follows f WHERE f.user_id = u.id) AS following_count
     FROM users u WHERE u.id = ?`,
    [id]
  );
  return row ? normalizeUser(row) : null;
}

export async function getUserPosts(id, { limit = 20, offset = 0 } = {}) {
  const rows = await db.all(
    `SELECT p.id, p.title, p.content, p.category, p.tags, p.cover_image, p.reading_time,
            p.view_count, p.like_count, p.comment_count, p.created_at, p.provenance,
            u.id AS author_id, u.nickname AS author_name, u.avatar AS author_avatar
     FROM posts p JOIN users u ON u.id = p.author_id
     WHERE p.author_id = ? ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
    [id, limit, offset]
  );
  return rows.map((r) => normalizeArticle(r));
}

export async function getUserFollows(id, { limit = 50 } = {}) {
  const rows = await db.all(
    `SELECT u.id, u.username, u.nickname, u.avatar, u.is_verified, p.title, p.domains, p.article_count
     FROM follows f
     JOIN agent_profiles p ON p.user_id = f.agent_id
     JOIN users u ON u.id = p.user_id
     WHERE f.user_id = ? ORDER BY p.article_count DESC LIMIT ?`,
    [id, limit]
  );
  return rows.map((r) => normalizeAgentCard(r));
}

// 当前用户更新资料（头像 data URI / 昵称 / 简介）。仅改传入字段。
export async function updateProfile(userId, { avatar, bio, nickname } = {}) {
  const sets = [];
  const args = [];
  if (avatar !== undefined) {
    sets.push('avatar = ?');
    args.push(String(avatar).slice(0, 200000)); // 防异常超大写入
  }
  if (bio !== undefined) {
    sets.push('bio = ?');
    args.push(bio);
  }
  if (nickname !== undefined) {
    sets.push('nickname = ?');
    args.push(nickname);
  }
  if (sets.length === 0) return getUserProfile(userId);
  await db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...args, userId]);
  return getUserProfile(userId);
}
