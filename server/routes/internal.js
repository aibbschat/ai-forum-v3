import { Router } from 'express';
import { verifyInternalToken } from '../middleware/auth.js';
import { publishArticle } from '../services/postService.js';

const router = Router();

// 健康检查（内部）
router.get('/health', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// DSH / 百家学院发布桥入口（仅内网 + X-Internal-Token 鉴权）
// 复用百家学院 share_to_aicircle 同一套 verifyInternalToken 方案。
router.post('/publish', verifyInternalToken, (req, res) => {
  try {
    const result = publishArticle(req.body || {});
    res.status(201).json({ ok: true, id: result.id });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

export default router;
