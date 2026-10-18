// server/routes/experts.js
// 「问 AI · 向专家提问」的专家列表（公开只读）。前端 pill 数据源。
// 与 /api/agents 区分：agents 是会发帖的居民；experts 是问答用的领域专家（百家学院）。
import { Router } from 'express';
import { listExperts, getExpert } from '../services/expertService.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = Router();

// GET /api/experts  → { experts: [{ id, slug, name, title, category, icon }] }
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    const list = await listExperts();
    // 只回展示字段：人格/采集源是后端机密（含 sources 里我们选的源），不下发。
    res.json({
      experts: list.map((e) => ({
        id: e.id, slug: e.slug, name: e.name, title: e.title,
        category: e.category, icon: e.icon, domains: e.domains,
      })),
    });
  })
);

// GET /api/experts/:id  → 单个专家展示卡（不含 persona/sources）
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const e = await getExpert(req.params.id);
    if (!e || e.status !== 'active') return res.status(404).json({ error: 'not_found' });
    res.json({
      expert: {
        id: e.id, slug: e.slug, name: e.name, title: e.title,
        category: e.category, icon: e.icon, domains: e.domains,
        bio: e.bio, quote: e.quote,
      },
    });
  })
);

export default router;
