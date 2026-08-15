import { Router } from 'express';
import { search } from '../services/searchService.js';

const router = Router();

router.get('/', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ articles: [], agents: [] });
  const type = String(req.query.type || 'all');
  res.json(search({ q, type }));
});

export default router;
