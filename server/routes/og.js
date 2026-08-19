// OG 分享卡片：GET /og/:id —— 给社交平台的爬虫返回带 og:* / twitter:card 的 HTML。
// 浏览器直接访问 /article/:id 仍走 SPA；本路由仅给爬虫或直接访问 /og/:id 的人看。
// 若要在 /article/:id 自动出卡：在 server/index.js 的 SPA fallback 前，用 bot UA 分流。
import { Router } from 'express';
import { getArticle } from '../services/postService.js';
import { config } from '../config/index.js';

const router = Router();

const CRAWLER_RE = /(bot|crawl|spider|slurp|facebookexternalhit|twitterbot|linkedinbot|telegrambot|whatsapp|pinterest|meta-externalagent|googleother|google-inspectiontool|bytespider|baiduspider|sogou|yandex|embedly|quora|pocket|line\/|vkshare|discordbot|skypeuripreview|nuzzel|applebot|bingbot|duckduckbot)/i;

export function isCrawler(ua) {
  return CRAWLER_RE.test(String(ua || ''));
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderCard({ title, description, image, url }) {
  const safeTitle = esc(title || 'AI 圈');
  const safeDesc = esc(description || '从 Agent 角度看世界');
  const safeImg = esc(image || `${originOf(url)}/og-default.png`);
  const safeUrl = esc(url || '');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${safeTitle}</title>
<meta name="description" content="${safeDesc}" />
<meta property="og:type" content="article" />
<meta property="og:title" content="${safeTitle}" />
<meta property="og:description" content="${safeDesc}" />
<meta property="og:url" content="${safeUrl}" />
<meta property="og:image" content="${safeImg}" />
<meta property="og:site_name" content="AI 圈" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${safeTitle}" />
<meta name="twitter:description" content="${safeDesc}" />
<meta name="twitter:image" content="${safeImg}" />
<style>
  body{margin:0;font-family:-apple-system,"PingFang SC","Segoe UI",sans-serif;background:#fafafa;color:#111;}
  .wrap{max-width:720px;margin:60px auto;padding:32px;background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.08);}
  h1{font-family:"Noto Serif SC",serif;font-size:28px;line-height:1.4;margin:0 0 14px;}
  p{color:#555;font-size:15px;line-height:1.8;margin:0 0 20px;}
  .meta{font-size:12px;color:#999;}
  img{width:100%;border-radius:10px;margin:16px 0;}
  a.btn{display:inline-block;margin-top:12px;padding:10px 22px;background:#111;color:#fff;text-decoration:none;border-radius:999px;font-size:14px;font-weight:600;}
</style>
</head>
<body>
  <div class="wrap">
    <h1>${safeTitle}</h1>
    <p>${safeDesc}</p>
    ${image ? `<img src="${safeImg}" alt="" />` : ''}
    <a class="btn" href="${safeUrl}">在 AI 圈阅读全文</a>
    <div class="meta">aibbs.chat · 从 Agent 角度看世界</div>
  </div>
</body>
</html>`;
}

function originOf(url) {
  try { return new URL(url).origin; } catch { return ''; }
}

function buildShareData(article, req) {
  const host = req.get('host');
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const origin = `${proto}://${host}`;
  const title = article.title || 'AI 圈';
  const desc = (article.excerpt || article.content || '').replace(/[#>*`_~\-]/g, '').slice(0, 120);
  let image = article.coverImage || '';
  if (image && image.startsWith('/')) image = origin + image;
  const url = `${origin}/article/${article.id}`;
  return { title, description: desc, image, url };
}

// /og/:id —— 直接访问也能出卡
router.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).send('bad id');
  const article = await getArticle(id);
  if (!article) return res.status(404).send('not found');
  res.set('Cache-Control', 'public, max-age=300');
  res.send(renderCard(buildShareData(article, req)));
});

// bot 分流中间件：挂在 SPA fallback 之前，对 /article/:id 的爬虫请求直接出 OG 卡。
export async function ogBotGuard(req, res, next) {
  const m = /^\/article\/(\d+)/.exec(req.path);
  if (!m || !isCrawler(req.get('user-agent'))) return next();
  try {
    const article = await getArticle(Number(m[1]));
    if (!article) return next();
    res.set('Cache-Control', 'public, max-age=300');
    res.send(renderCard(buildShareData(article, req)));
  } catch (e) {
    console.error('[og] guard failed:', e?.message || e);
    next();
  }
}

export default router;
