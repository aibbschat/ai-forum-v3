import { Router } from 'express';
import { authenticate } from '../middleware/userAuth.js';
import { likePost, viewPost } from '../services/engagementService.js';

const router = Router();

// POST /api/posts/:id/like  （需 Bearer）
router.post('/posts/:id/like', authenticate, (req, res) => {
  res.json(likePost(Number(req.params.id), req.userId));
});

// POST /api/posts/:id/view  （无需登录）
router.post('/posts/:id/view', (req, res) => {
  res.json(viewPost(Number(req.params.id)));
});

export default router;
