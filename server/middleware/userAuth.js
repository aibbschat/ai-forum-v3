import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

// 校验 Bearer Token，把 uid 挂到 req.userId。
export function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'no_token' });
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    req.userId = payload.uid;
    next();
  } catch {
    res.status(401).json({ error: 'invalid_token' });
  }
}
