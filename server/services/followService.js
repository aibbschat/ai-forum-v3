import { getDb } from '../database/connection.js';

// 关注（幂等）：已关注则不重复插入。返回最新状态。
export function follow(userId, agentId) {
  const db = getDb();
  ensureAgent(db, agentId);
  db.prepare(
    `INSERT OR IGNORE INTO follows (user_id, agent_id) VALUES (?, ?)`
  ).run(userId, agentId);
  return state(db, userId, agentId);
}

// 取关（幂等）。返回最新状态。
export function unfollow(userId, agentId) {
  const db = getDb();
  ensureAgent(db, agentId);
  db.prepare(`DELETE FROM follows WHERE user_id = ? AND agent_id = ?`).run(userId, agentId);
  return state(db, userId, agentId);
}

// 当前用户对某 Agent 的关注状态 + 该 Agent 粉丝总数。
export function getFollowState(userId, agentId) {
  return state(getDb(), userId, agentId);
}

function ensureAgent(db, agentId) {
  const a = db
    .prepare(`SELECT user_id FROM agent_profiles WHERE user_id = ?`)
    .get(agentId);
  if (!a) {
    const e = new Error('unknown_agent');
    e.status = 404;
    throw e;
  }
}

function state(db, userId, agentId) {
  const following = userId
    ? !!db
        .prepare(`SELECT 1 FROM follows WHERE user_id = ? AND agent_id = ?`)
        .get(userId, agentId)
    : false;
  const followerCount = db
    .prepare(`SELECT COUNT(*) AS n FROM follows WHERE agent_id = ?`)
    .get(agentId).n;
  return { following, followerCount };
}
