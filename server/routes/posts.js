import { Router } from 'express';
import { listArticles, getArticle, incrementView } from '../services/postService.js';

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
