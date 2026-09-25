// server/lib/trafficTrack.js
// 站点流量采集（2026-09-25）：HTML 首载 + SPA 路由 beacon，一行 = 一次浏览。
//
// 口径（拍板：服务端中间件 + 前端 beacon）：
//   浏览 PV  = traffic_hits 行数（is_bot=0）—— HTML 首载 + SPA 站内跳转 beacon；
//   访客 UV  = DISTINCT vid（服务端种的一枚匿名 cookie，一年有效；无 cookie 环境不计入）；
//   独立 IP  = DISTINCT ip_hash（X-Forwarded-For 首个 IP，SHA-256 加盐，不落原始 IP）。
//
// 红线：
//   - 绝不存原始 IP / UA，只存哈希与 is_bot 位（管理后台自用，最小化）；
//   - /admin* 页面浏览不记录（自访自看不污染流量）；
//   - 记录是 fire-and-forget：流量采集绝不允许拖垮页面响应主链路。
import { createHash, randomUUID } from 'node:crypto';
import { db } from '../database/db.js';

export const VID_COOKIE = 'aiv';

const BOT_RE = /bot|crawl|spider|slurp|curl|wget|python|java\/|okhttp|go-http-client|axios|node|headless|phantom|lighthouse|pingdom|uptime|monitor|preview|facebookexternalhit|embedly|scrapy|semrush|ahrefs|bytespider|petalbot|yandex/i;

/** 真实客户端 IP：生产走 Nginx，取 X-Forwarded-For 首个；没有再退回 req.ip。 */
export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = String(xff).split(',')[0].trim();
    if (first) return first;
  }
  return req.ip || 'na';
}

export function isBot(req) {
  return BOT_RE.test(String(req.headers['user-agent'] || ''));
}

/** 极简 cookie 读取（不引 cookie-parser，只用这一处）。 */
export function getCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim() || null;
  }
  return null;
}

/** 今天（Asia/Shanghai）的 YYYY-MM-DD —— 日切以站点的本地日历为准，与 DB 时区无关。 */
export function shanghaiDay(d = new Date()) {
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

/** IP 哈希：盐 = TRAFFIC_SALT（未配则退 JWT_SECRET，再退固定串）。 */
export function hashIp(ip) {
  const salt = process.env.TRAFFIC_SALT || process.env.JWT_SECRET || 'aiv-traffic-salt';
  return createHash('sha256').update(`${String(ip || '')}|${salt}`).digest('hex');
}

/** fire-and-forget 落一行。任何失败只 warn，绝不向上抛。 */
export function recordHit({ kind, path, vid, req, isBot: bot = false }) {
  db.run(
    `INSERT INTO traffic_hits (day, kind, path, vid, ip_hash, is_bot) VALUES (?, ?, ?, ?, ?, ?)`,
    [shanghaiDay(), kind, String(path || '/').slice(0, 300), vid || null, hashIp(clientIp(req)), bot ? 1 : 0]
  ).catch((e) => console.warn('[traffic] record failed:', e?.message || e));
}

/**
 * HTML 首载记账（挂在 SPA fallback 里）：没有 vid 就种一枚（一年，HttpOnly）。
 * 机器人 / 自访（/admin*）不记。机器人在 publicPageGuard 就被喂正文，到这里的少，
 * 但兜底统一在这里判。
 */
export function trackHtmlHit(req, res) {
  try {
    if (isBot(req)) return; // 机器人浏览不计入（口径拍板：按 UA 过滤）
    const p = String(req.path || '/');
    if (p === '/admin' || p.startsWith('/admin/')) return; // 自访不污染
    let vid = getCookie(req, VID_COOKIE);
    if (!vid) {
      vid = randomUUID();
      res.cookie(VID_COOKIE, vid, { maxAge: 365 * 24 * 3600 * 1000, httpOnly: true, sameSite: 'lax', path: '/' });
    }
    recordHit({ kind: 'html', path: p, vid, req });
  } catch { /* 采集永不影响主链路 */ }
}
