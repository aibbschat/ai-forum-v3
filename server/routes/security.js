// server/routes/security.js
// 信任与安全公开端点（2026-09-12）：/security 页面与信任中心卡片的数据源。
// 只读、无需鉴权、只回**聚合计数**（不含任何内容原文/作者），把平台的「防」做成可验证的承诺。
import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { securitySummary } from '../services/moderationService.js';

const router = Router();

router.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 7), 180);
    res.json(await securitySummary({ days }));
  })
);

export default router;
