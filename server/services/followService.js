import { db } from '../database/db.js';
import { normalizeUser } from './normalize.js';

// 关注（幂等）：已关注则不重复插入。返回最新状态。
export async function follow(userId, agentId) {
  await ensureAgent(agentId);
  // 幂等插入走 db.insertIgnore（SQLite INSERT OR IGNORE / MariaDB INSERT IGNORE）
  await db.insertIgnore('follows', { user_id: userId, agent_id: agentId });
  return state(userId, agentId);
}

// 取关（幂等）。返回最新状态。
export async function unfollow(userId, agentId) {
  await ensureAgent(agentId);
  await db.run(`DELETE FROM follows WHERE user_id = ? AND agent_id = ?`, [userId, agentId]);
  return state(userId, agentId);
}

// 当前用户对某 Agent 的关注状态 + 该 Agent 粉丝总数。
export async function getFollowState(userId, agentId) {
  return state(userId, agentId);
}

// ── 真人↔真人互关 ───────────────────────────────────────────────
export async function followUser(followerId, followeeId) {
  if (followerId === followeeId) {
    const e = new Error('cannot_follow_self');
    e.status = 400;
    throw e;
  }
  await db.insertIgnore('user_follows', { follower_id: followerId, followee_id: followeeId });
  return userFollowState(followerId, followeeId);
}

export async function unfollowUser(followerId, followeeId) {
  await db.run(`DELETE FROM user_follows WHERE follower_id = ? AND followee_id = ?`, [
    followerId,
    followeeId,
  ]);
  return userFollowState(followerId, followeeId);
}

// 关注状态 + 粉丝/关注数 + 是否互关（对方也关注了我）。
export async function userFollowState(followerId, followeeId) {
  const following = !!(
    await db.get(`SELECT 1 FROM user_follows WHERE follower_id = ? AND followee_id = ?`, [
      followerId,
      followeeId,
    ])
  );
  const followerCount = (
    await db.get(`SELECT COUNT(*) AS n FROM user_follows WHERE followee_id = ?`, [followeeId])
  ).n;
  const followingCount = (
    await db.get(`SELECT COUNT(*) AS n FROM user_follows WHERE follower_id = ?`, [followerId])
  ).n;
  const isMutual = !!(
    await db.get(`SELECT 1 FROM user_follows WHERE follower_id = ? AND followee_id = ?`, [
      followeeId,
      followerId,
    ])
  );
  return { following, followerCount, followingCount, isMutual };
}

// 某用户的粉丝列表（用于个人中心"粉丝"）。
export async function getUserFollowers(userId, { limit = 50 } = {}) {
  const rows = await db.all(
    `SELECT u.id, u.username, u.nickname, u.avatar, u.bio
     FROM user_follows f JOIN users u ON u.id = f.follower_id
     WHERE f.followee_id = ? ORDER BY f.created_at DESC LIMIT ?`,
    [userId, limit]
  );
  return rows.map((r) => normalizeUser(r));
}

async function ensureAgent(agentId) {
  const a = await db.get(`SELECT user_id FROM agent_profiles WHERE user_id = ?`, [agentId]);
  if (!a) {
    const e = new Error('unknown_agent');
    e.status = 404;
    throw e;
  }
}

async function state(userId, agentId) {
  const following = userId
    ? !!(await db.get(`SELECT 1 FROM follows WHERE user_id = ? AND agent_id = ?`, [
        userId,
        agentId,
      ]))
    : false;
  const followerCount = (await db.get(`SELECT COUNT(*) AS n FROM follows WHERE agent_id = ?`, [
    agentId,
  ])).n;
  return { following, followerCount };
}
