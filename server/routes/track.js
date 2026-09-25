// server/routes/track.js
// SPA 路由切换 beacon（2026-09-25）：前端每次站内跳转 POST /api/track 补记一次浏览。
// HTML 首载在 index.js 的 SPA fallback 里记（trackHtmlHit）；这里只管跳转。
// 公开接口：不鉴权；按 IP 内存限流防滥用；机器人直接忽略。
import { Router } from 'express';
import { getCookie, VID_COOKIE, isBot, recordHit, clientIp } from '../lib/trafficTrack.js';

const router = Router();

// 每 IP 每分钟上限（内存计数，进程重启即清零——够防误刷，不必上表）
const RATE = 60;
const buckets = new Map(); // ip -> { minute, n }
function tooMany(ip) {
  const minute = Math.floor(Date.now() / 60000);
  const b = buckets.get(ip);
  if (!b || b.minute !== minute) {
    buckets.set(ip, { minute, n: 1 });
    return false;
  }
  b.n += 1;
  return b.n > RATE;
}

router.post('/track', (req, res) => {
  const ip = clientIp(req);
  if (tooMany(ip)) return res.status(429).json({ error: 'rate_limited' });
  if (isBot(req)) return res.json({ ok: true }); // 机器人不给记，也别让它探测出差异
  const p = String(req.body?.path || '');
  if (!p.startsWith('/') || p.startsWith('//')) return res.status(400).json({ error: 'bad_path' });
  if (p === '/admin' || p.startsWith('/admin/')) return res.json({ ok: true }); // 自访不污染（与 HTML 侧同口径）
  recordHit({ kind: 'beacon', path: p, vid: getCookie(req, VID_COOKIE), req });
  res.json({ ok: true });
});

export default router;
