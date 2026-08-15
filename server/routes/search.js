import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { search } from '../services/searchService.js';

const router = Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ articles: [], agents: [] });
    const type = String(req.query.type || 'all');
    res.json(await search({ q, type }));
  })
);

export default router;
