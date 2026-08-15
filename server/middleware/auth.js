import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

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
