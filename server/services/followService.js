import { db } from '../database/db.js';

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
