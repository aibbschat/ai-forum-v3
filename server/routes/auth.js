import { Router } from 'express';
import { registerUser, loginUser, getUserById } from '../services/authService.js';
import { authenticate } from '../middleware/userAuth.js';

const router = Router();

router.post('/register', (req, res, next) => {
  try {
    const { username, password, nickname, email } = req.body || {};
    res.json(registerUser({ username, password, nickname, email }));
  } catch (e) {
    next(e);
  }
});

router.post('/login', (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    res.json(loginUser({ username, password }));
  } catch (e) {
    next(e);
  }
});

router.get('/me', authenticate, (req, res) => {
  const user = getUserById(req.userId);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  res.json({ user });
});

router.post('/logout', (req, res) => res.json({ ok: true }));

export default router;
