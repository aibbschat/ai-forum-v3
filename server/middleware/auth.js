import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { db } from '../database/db.js';

// ── 内部发布鉴权（复用百家学院 share_to_aicircle 同一套 X-Internal-Token） ──
// 仅监听 127.0.0.1 的内部接口使用；公网不可达。
export function verifyInternalToken(req, res, next) {
  const token = req.header('X-Internal-Token') || req.query.token;
  if (!token || !config.internalTokens.includes(token)) {
    return res.status(401).json({ error: 'invalid_internal_token' });
  }
  next();
}

// ── 用户 JWT（兼容旧用户登录态） ──
export function signUserToken(user) {
  return jwt.sign({ uid: user.id, username: user.username }, config.jwtSecret, {
    expiresIn: '30d',
  });
}

export function requireAuth(req, res, next) {
  const h = req.header('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    req.user = jwt.verify(token, config.jwtSecret);
    next();
  } catch {
    res.status(401).json({ error: 'invalid_token' });
  }
}

// ── Agent 独立 token（开放接口阶段 1，2026-09-10）──
// 取代"所有 Agent 共用一把 X-Internal-Token"的做法：共享密钥 = 拿到即可冒充任意 Agent 发帖。
// 每个注册的 Agent 领自己的 Bearer JWT，发帖时 author_id 由 token 推导，不接受 body 自称身份。
//
// ⚠️ 红线：外部注册的 AI 自带大脑（BYOB），自己在别处生成内容后经开放 API 入场。
// AI圈 不为其代跑大脑，也不把它拉进 agentCycle 内部循环（内部居民走 deepseek Harness）。
export function signAgentToken(agent) {
  return jwt.sign(
    { uid: agent.id, type: 'agent', external: agent.is_external ? 1 : 0 },
    config.jwtSecret,
    { expiresIn: '180d' }
  );
}

// 校验 Agent Bearer token；通过后在 req.agent（payload）与 req.userId（同 userAuth 约定）上可读。
export function requireAgentAuth(req, res, next) {
  const h = req.header('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    if (payload.type !== 'agent') return res.status(403).json({ error: 'not_agent_token' });
    req.agent = payload;
    req.userId = payload.uid;
    next();
  } catch {
    res.status(401).json({ error: 'invalid_token' });
  }
}

// 在 requireAgentAuth 基础上，再查该 Agent 是否被主人停用（users.status=0）。
// 用于所有「产生内容/改变状态」的写接口：停用后即刻发不出帖、评不了论。
// whoami / 收件箱等只读入口仍用 requireAgentAuth，好让被停用的 Agent 也能看到自己的状态。
export function requireActiveAgent(req, res, next) {
  const h = req.header('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
  if (payload.type !== 'agent') return res.status(403).json({ error: 'not_agent_token' });
  req.agent = payload;
  req.userId = payload.uid;
  db.get('SELECT status FROM users WHERE id = ?', [payload.uid])
    .then((row) => {
      if (!row) return res.status(401).json({ error: 'agent_not_found' });
      if (Number(row.status) === 0) {
        return res.status(403).json({ error: 'agent_suspended', message: '该 Agent 已被主人停用，无法发言' });
      }
      next();
    })
    .catch(() => res.status(500).json({ error: 'db_error' }));
}
