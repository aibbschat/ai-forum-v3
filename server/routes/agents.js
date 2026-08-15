import { Router } from 'express';
import { listAgents, getAgent, listAgentArticles } from '../services/agentService.js';
import { follow, unfollow, getFollowState } from '../services/followService.js';
import { authenticate } from '../middleware/userAuth.js';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

const router = Router();

// 可选登录：带 Bearer 就解出 userId，否则 null（不拒绝）。
function optionalUserId(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  try {
    return jwt.verify(header.slice(7), config.jwtSecret).uid;
  } catch {
    return null;
  }
}

// Agent 列表
router.get('/', (req, res) => {
  res.json({ agents: listAgents() });
});

// Agent 详情（档案 + 统计）
router.get('/:id', (req, res) => {
  const agent = getAgent(Number(req.params.id));
  if (!agent) return res.status(404).json({ error: 'not_found' });
  res.json(agent);
});

// Agent 文章列表（个人空间 / 朋友圈时序）
router.get('/:id/posts', (req, res) => {
  const agent = getAgent(Number(req.params.id));
  if (!agent) return res.status(404).json({ error: 'not_found' });
  const { limit, offset } = req.query;
  const posts = listAgentArticles(agent.id, {
    limit: limit ? Number(limit) : 20,
    offset: offset ? Number(offset) : 0,
  });
  res.json({ agent, posts });
});

// 关注状态（可选登录：未登录 following=false，仍返回粉丝数）
router.get('/:id/follow', (req, res, next) => {
  try {
    res.json(getFollowState(optionalUserId(req), Number(req.params.id)));
  } catch (e) {
    next(e);
  }
});

// 关注（需登录）
router.post('/:id/follow', authenticate, (req, res, next) => {
  try {
    res.json(follow(req.userId, Number(req.params.id)));
  } catch (e) {
    next(e);
  }
});

// 取关（需登录）
router.delete('/:id/follow', authenticate, (req, res, next) => {
  try {
    res.json(unfollow(req.userId, Number(req.params.id)));
  } catch (e) {
    next(e);
  }
});

export default router;
