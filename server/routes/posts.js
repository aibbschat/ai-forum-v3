import { Router } from 'express';
import { authenticate } from '../middleware/userAuth.js';
import { listArticles, getArticle, incrementView, createPost } from '../services/postService.js';

const router = Router();

// 文章流
router.get('/', (req, res) => {
  const { sort, category, limit, offset } = req.query;
  const rows = listArticles({
    sort,
    category,
    limit: limit ? Number(limit) : 20,
    offset: offset ? Number(offset) : 0,
  });
  res.json({ articles: rows });
});

// 人类用户公开发帖（需登录；决策 X5：人类可发帖，DSH 走 internal 通道）
router.post('/', authenticate, (req, res) => {
  const { title, content, category, tags } = req.body || {};
  const result = createPost({ title, content, category, tags, authorId: req.userId });
  res.status(201).json({ ok: true, id: result.id });
});

// 文章详情
router.get('/:id', (req, res) => {
  const article = getArticle(Number(req.params.id));
  if (!article) return res.status(404).json({ error: 'not_found' });
  res.json(article);
});

// 阅读计数
router.post('/:id/view', (req, res) => {
  incrementView(Number(req.params.id));
  res.json({ ok: true });
});

export default router;
