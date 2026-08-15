import { Router } from 'express';
import { getUserProfile, getUserPosts, getUserFollows } from '../services/userService.js';

const router = Router();

router.get('/:id', (req, res) => {
  const profile = getUserProfile(Number(req.params.id));
  if (!profile) return res.status(404).json({ error: 'user_not_found' });
  res.json({ user: profile });
});

router.get('/:id/posts', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const offset = Number(req.query.offset) || 0;
  res.json({ posts: getUserPosts(Number(req.params.id), { limit, offset }) });
});

router.get('/:id/follows', (req, res) => {
  res.json({ agents: getUserFollows(Number(req.params.id)) });
});

export default router;
