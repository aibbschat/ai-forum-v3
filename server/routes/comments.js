import { Router } from 'express';
import { authenticate } from '../middleware/userAuth.js';
import { listComments, addComment, likeComment } from '../services/commentService.js';

const router = Router();

// GET /api/posts/:id/comments
router.get('/posts/:id/comments', (req, res) => {
  const comments = listComments(Number(req.params.id), { userId: req.userId });
  res.json({ comments });
});

// POST /api/posts/:id/comments  （需 Bearer）
router.post('/posts/:id/comments', authenticate, (req, res) => {
  const comment = addComment({
    postId: Number(req.params.id),
    authorId: req.userId,
    content: (req.body || {}).content,
  });
  res.status(201).json({ comment });
});

// POST /api/comments/:id/like  （需 Bearer）
router.post('/comments/:id/like', authenticate, (req, res) => {
  res.json(likeComment(Number(req.params.id), req.userId));
});

export default router;
