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
 * HTML 浏览记账中间件（挂在 publicPageGuard / SPA fallback 之前）。
 *
 * 为什么按「响应 finish + content-type」记、而不是在 SPA fallback 里记：
 *   首页等公开路由由 publicPageGuard 直接出 HTML（到不了 fallback），在 fallback 记会漏掉
 *   最大的流量入口；而 finish 一生只触发一次，按响应是不是 text/html 判定，
 *   publicPageGuard 与 fallback 两条路全覆盖且天然不双记。
 *
 * 口径：
 *   - 只记 GET 的 text/html 响应（API JSON / og 图片 / 静态资源都不算浏览）；
 *   - 带扩展名的路径（如 /sw.js 兜底到 index.html）是资源请求，不是导航，跳过；
 *   - /admin* 自访不污染；机器人（UA 爬虫特征）不计入；
 *   - 没 vid 就种一枚（一年，HttpOnly）—— 种 cookie 在响应头发出前做，记录在 finish 后做。
 */
export function trafficHtmlGuard(req, res, next) {
  let newVid = null; // 首访新生成的 vid：Set-Cookie 不会改请求头，finish 时必须用闭包里这份
  try {
    const p = String(req.path || '/');
    const pageLike = req.method === 'GET'
      && p !== '/api' && !p.startsWith('/api/') && p !== '/og' && !p.startsWith('/og/')
      && p !== '/admin' && !p.startsWith('/admin/')
      && !/\.[A-Za-z0-9]+$/.test(p);
    if (pageLike && !getCookie(req, VID_COOKIE) && !isBot(req)) {
      newVid = randomUUID();
      res.cookie(VID_COOKIE, newVid, { maxAge: 365 * 24 * 3600 * 1000, httpOnly: true, sameSite: 'lax', path: '/' });
    }
  } catch { /* 采集永不影响主链路 */ }
  res.on('finish', () => {
    try {
      if (req.method !== 'GET') return; // HEAD 等不记
      const ct = String(res.getHeader('content-type') || '');
      if (!ct.includes('text/html')) return; // 只有真 HTML 响应才算一次浏览
      const p = String(req.path || '/');
      if (p.startsWith('/api/') || p.startsWith('/og/')) return;
      if (p === '/admin' || p.startsWith('/admin/')) return; // 自访不污染
      if (/\.[A-Za-z0-9]+$/.test(p)) return; // 资源路径兜底成 HTML（如 /sw.js）不算浏览
      if (isBot(req)) return; // 机器人浏览不计入（口径拍板：按 UA 过滤）
      recordHit({ kind: 'html', path: p, vid: getCookie(req, VID_COOKIE) || newVid, req });
    } catch { /* 采集永不影响主链路 */ }
  });
  next();
}
