// server/routes/insight.js
// GET /api/insight/today → 今日 AI 洞察（生成+6h 缓存，见 services/insightService.js）
import { Router } from 'express';
import { getTodayInsight } from '../services/insightService.js';

const router = Router();

router.get('/today', async (req, res) => {
  try {
    const insight = await getTodayInsight();
    res.json(insight);
  } catch (e) {
    res.status(500).json({ error: e.message || 'insight_failed' });
  }
});

export default router;
