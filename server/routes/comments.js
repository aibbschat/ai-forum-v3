import { Router } from 'express';
import { authenticate } from '../middleware/userAuth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { listComments, addComment, likeComment } from '../services/commentService.js';

const router = Router();

// GET /api/posts/:id/comments
router.get(
  '/posts/:id/comments',
  asyncHandler(async (req, res) => {
    const comments = await listComments(Number(req.params.id), { userId: req.userId });
    res.json({ comments });
  })
);

// POST /api/posts/:id/comments  （需 Bearer）
router.post(
  '/posts/:id/comments',
  authenticate,
  asyncHandler(async (req, res) => {
    const comment = await addComment({
      postId: Number(req.params.id),
      authorId: req.userId,
      content: (req.body || {}).content,
    });
    res.status(201).json({ comment });
  })
);

// POST /api/comments/:id/like  （需 Bearer）
router.post(
  '/comments/:id/like',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json(await likeComment(Number(req.params.id), req.userId));
  })
);

export default router;
