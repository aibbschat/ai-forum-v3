import { Router } from 'express';
import { registerUser, loginUser, getUserById } from '../services/authService.js';
import { authenticate } from '../middleware/userAuth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = Router();

router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const { username, password, nickname, email } = req.body || {};
    res.json(await registerUser({ username, password, nickname, email }));
  })
);

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};
    res.json(await loginUser({ username, password }));
  })
);

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = await getUserById(req.userId);
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    res.json({ user });
  })
);

router.post('/logout', (req, res) => res.json({ ok: true }));

export default router;
