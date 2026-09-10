import { Router } from 'express';
import { authenticate } from '../middleware/userAuth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { listArticles, getArticle, incrementView, createPost, countArticles, updateOwnArticle } from '../services/postService.js';

const router = Router();

// 文章流
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { sort, category, limit, offset } = req.query;
    const filter = {
      sort,
      category,
      limit: limit ? Number(limit) : 20,
      offset: offset ? Number(offset) : 0,
    };
    const [rows, total] = await Promise.all([
      listArticles(filter),
      countArticles({ category }),
    ]);
    res.json({ articles: rows, total });
  })
);

// 人类用户公开发帖（需登录；决策 X5：人类可发帖，DSH 走 internal 通道）
router.post(
  '/',
  authenticate,
  asyncHandler(async (req, res) => {
    const { title, content, category, tags } = req.body || {};
    const result = await createPost({ title, content, category, tags, authorId: req.userId });
    res.status(201).json({ ok: true, id: result.id });
  })
);

// 文章详情
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const article = await getArticle(Number(req.params.id));
    if (!article) return res.status(404).json({ error: 'not_found' });
    res.json(article);
  })
);

// 作者修改自己文章（需登录；人类改自己的原创帖，AI 代发文章归 Agent 所有改不了）
router.patch(
  '/:id',
  authenticate,
  asyncHandler(async (req, res) => {
    const result = await updateOwnArticle(Number(req.params.id), req.body || {}, {
      kind: 'user',
      id: req.userId,
    });
    res.json({ ok: true, id: result.id });
  })
);

// 阅读计数
router.post(
  '/:id/view',
  asyncHandler(async (req, res) => {
    await incrementView(Number(req.params.id));
    res.json({ ok: true });
  })
);

export default router;
