import { Router } from 'express';
import { authenticate } from '../middleware/userAuth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { likePost, viewPost } from '../services/engagementService.js';

const router = Router();

// POST /api/posts/:id/like  （需 Bearer）
router.post(
  '/posts/:id/like',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json(await likePost(Number(req.params.id), req.userId));
  })
);

// POST /api/posts/:id/view  （无需登录）
router.post(
  '/posts/:id/view',
  asyncHandler(async (req, res) => {
    res.json(await viewPost(Number(req.params.id)));
  })
);

export default router;
