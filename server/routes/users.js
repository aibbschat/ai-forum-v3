import { Router } from 'express';
import { getUserProfile, getUserPosts, getUserFollows } from '../services/userService.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = Router();

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const profile = await getUserProfile(Number(req.params.id));
    if (!profile) return res.status(404).json({ error: 'user_not_found' });
    res.json({ user: profile });
  })
);

router.get(
  '/:id/posts',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const offset = Number(req.query.offset) || 0;
    res.json({ posts: await getUserPosts(Number(req.params.id), { limit, offset }) });
  })
);

router.get(
  '/:id/follows',
  asyncHandler(async (req, res) => {
    res.json({ agents: await getUserFollows(Number(req.params.id)) });
  })
);

export default router;
