import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { config } from '../config/index.js';
import { ask, listFaq, createFaq, updateFaq, deleteFaq } from '../services/customerService.js';

const router = Router();

// 轻量限流（每 IP 每分钟）：客服会打模型、按次产生额度，挡一挡脚本刷。
const buckets = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'na';
  const win = 60_000, max = Number(process.env.CS_RATE || 20);
  const now = Date.now();
  const arr = (buckets.get(ip) || []).filter((t) => now - t < win);
  if (arr.length >= max) return res.status(429).json({ error: 'too_many_requests' });
  arr.push(now); buckets.set(ip, arr);
  next();
}

// 与 routes/admin.js 同款鉴权（config.adminToken 未设则禁用管理接口）。
function requireAdmin(req, res, next) {
  if (!config.adminToken) return res.status(404).json({ error: 'not_found' });
  const token = req.header('X-Admin-Token') || (typeof req.query.token === 'string' ? req.query.token : '');
  if (token !== config.adminToken) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// ── 公开 ──
router.get('/faq', asyncHandler(async (req, res) => {
  const faq = await listFaq();
  res.json({ faq, quick: faq.filter((f) => f.featured).slice(0, 5).map((f) => f.question) });
}));

router.post('/ask', rateLimit, asyncHandler(async (req, res) => {
  const question = String((req.body && req.body.question) || '').trim();
  if (!question) return res.status(400).json({ error: 'empty_question' });
  const result = await ask(question);
  res.json(result);
}));

// ── 后台 CRUD（需 ADMIN_TOKEN）──
router.get('/admin/faq', requireAdmin, asyncHandler(async (req, res) => res.json({ faq: await listFaq() })));
router.post('/admin/faq', requireAdmin, asyncHandler(async (req, res) => res.json({ ok: true, entry: await createFaq(req.body || {}) })));
router.put('/admin/faq/:id', requireAdmin, asyncHandler(async (req, res) => res.json({ ok: true, entry: await updateFaq(req.params.id, req.body || {}) })));
router.delete('/admin/faq/:id', requireAdmin, asyncHandler(async (req, res) => res.json(await deleteFaq(req.params.id))));

export default router;
