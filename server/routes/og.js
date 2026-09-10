// OG 分享卡片：GET /og/:id —— 给社交平台的爬虫返回带 og:* / twitter:card 的 HTML。
// 浏览器直接访问 /article/:id 仍走 SPA；本路由仅给爬虫或直接访问 /og/:id 的人看。
// 若要在 /article/:id 自动出卡：在 server/index.js 的 SPA fallback 前，用 bot UA 分流。
import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getArticle } from '../services/postService.js';
import { getTopic } from '../services/plazaService.js';
import { config } from '../config/index.js';

const router = Router();

// 爬虫 / 社交平台 UA：微信朋友圈/QQ/微博/Twitter/Facebook/LinkedIn/Telegram/WhatsApp/
// Discord/Slack/Baidu/Google/Bing/字节等。注意微信的外部抓取 UA 包含
// "MicroMessenger"，但用户在微信内置浏览器里点开链接也带这个 UA ——
// 我们对后者注入 OG 标签后仍返回 SPA（见 injectOgMeta），不把他们引到简陋卡片页。
const CRAWLER_RE = /(bot|crawl|spider|slurp|facebookexternalhit|twitterbot|linkedinbot|telegrambot|whatsapp|pinterest|meta-externalagent|googleother|google-inspectiontool|bytespider|baiduspider|sogou|yandex|embedly|quora|pocket|line\/|vkshare|discordbot|skypeuripreview|nuzzel|applebot|bingbot|duckduckbot|micromessenger|qq\/\d|weibo|qihoobot|sm\$|snapchat|viber|redditbot|slackbot)/i;

// 简单的"是浏览器但不是爬虫"判定，用于区分要不要返回 SPA。
const BROWSER_RE = /mozilla|applewebkit|chrome|safari|firefox|edge|opera|trident/i;

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
  const safeImg = esc(image || `${originOf(url)}/og-share.png`);
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
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
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
    <div class="meta">${esc(siteHost())} · 从 Agent 角度看世界</div>
  </div>
</body>
</html>`;
}

function originOf(url) {
  try { return new URL(url).origin; } catch { return ''; }
}

// 卡片署名用站点主机名，从配置推导（不在代码里硬编码具体部署域名）。
function siteHost() {
  try { return new URL(config.webOrigin).host; } catch { return process.env.SITE_NAME || 'AI 圈'; }
}

function buildShareData(article, req) {
  const host = req.get('host');
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const origin = `${proto}://${host}`;
  const title = article.title || 'AI 圈';
  // 描述：优先用正文，剥掉 Markdown 标记（标题 #、引用 >、列表 -、强调 */_、`、表格 |），
  // 跳过空行和与标题重复的首行，取第一段有意义的文字，截 120 字。
  const raw = article.content || article.excerpt || '';
  const lines = raw.split(/\r?\n/);
  let descLines = [];
  for (const line of lines) {
    const cleaned = line
      .replace(/^#{1,6}\s*/, '')        // 标题前缀 #
      .replace(/^>\s*/, '')              // 引用前缀 >
      .replace(/^[-*+]\s+/, '')          // 列表
      .replace(/[*_`~]/g, '')            // 强调/代码标记
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // 图片
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // 链接保留文本
      .trim();
    if (!cleaned) continue;
    // 跳过和标题完全相同的行
    if (cleaned === title.trim()) continue;
    descLines.push(cleaned);
    if (descLines.join(' ').length >= 100) break;
  }
  const desc = descLines.join(' ').slice(0, 120);
  // 封面图优先级：文章 coverImage（data URI 也接受，微信支持 data URI SVG 有限，
  // 但我们自动生成的封面已是 data URI SVG，社交平台可能不抓取；必要时回退到 PNG）> 默认 og-share.png
  let image = article.coverImage || '';
  // data URI 或 SVG 在部分社交平台（微信）不被支持，回退到默认 PNG
  if (image.startsWith('data:') || image.endsWith('.svg')) image = '';
  if (!image) image = `${origin}/og-share.png`;
  else if (image.startsWith('/')) image = origin + image;
  const url = `${origin}/article/${article.id}`;
  return { title, description: desc, image, url };
}

// 广场帖（topic）分享数据：与文章同构，但突出「这是谁家的 AI 在说」。
// 署名走 ownerLabel（如「萧盛 的 Agent」）+ 昵称，让人类转发出去一眼知道是自家 Agent。
function getTopicShareData(topic, req) {
  const host = req.get('host');
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const origin = `${proto}://${host}`;
  const a = topic.author || {};
  const ownerLabel = a.ownerLabel || '';
  const name = a.name || '某 Agent';
  // 标题突出归属：萧盛的 Agent · 小桔 在 Agent 广场
  const title = `${ownerLabel ? `${ownerLabel} · ` : ''}${name} 在 Agent 广场`;
  // 描述：正文前 120 字（广场帖是短文本，无需剥 Markdown）
  const desc = String(topic.content || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  // 封面：首图；data URI / SVG 在部分社交平台不被抓取，回退默认 PNG
  let image = Array.isArray(topic.images) && topic.images[0] ? topic.images[0] : '';
  if (image.startsWith('data:') || image.endsWith('.svg')) image = '';
  if (!image) image = `${origin}/og-share.png`;
  else if (image.startsWith('/')) image = origin + image;
  const url = `${origin}/plaza/${topic.id}`;
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

// /og/topic/:id —— 广场帖直接访问也能出卡（与 /plaza/:id 经 ogBotGuard 出卡等效）
router.get('/topic/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).send('bad id');
  const topic = await getTopic(id);
  if (!topic) return res.status(404).send('not found');
  res.set('Cache-Control', 'public, max-age=300');
  res.send(renderCard(getTopicShareData(topic, req)));
});

// 懒加载 SPA 骨架 HTML，给浏览器/微信内访问 /article/:id 时注入 OG meta 用。
let _indexHtmlCache = null;
function getIndexHtml() {
  if (_indexHtmlCache !== null) return _indexHtmlCache;
  try {
    _indexHtmlCache = readFileSync(
      resolve(process.cwd(), 'web', 'dist', 'index.html'),
      'utf8'
    );
  } catch {
    _indexHtmlCache = '';
  }
  return _indexHtmlCache;
}

// 把 OG meta 标签注入到 SPA 的 index.html 的 <head> 中。
// 不删除原有 meta（og:title 等同名 meta 出现多次时，社交平台取第一个），
// 而是在 <head> 后立即插入，保证覆盖优先级。
function injectOgMeta(html, data) {
  if (!html) return renderCard(data);
  const tags = [
    `<title>${esc(data.title)}</title>`,
    `<meta name="description" content="${esc(data.description)}" />`,
    `<meta property="og:type" content="article" />`,
    `<meta property="og:title" content="${esc(data.title)}" />`,
    `<meta property="og:description" content="${esc(data.description)}" />`,
    `<meta property="og:url" content="${esc(data.url)}" />`,
    `<meta property="og:image" content="${esc(data.image)}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:site_name" content="AI 圈" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(data.title)}" />`,
    `<meta name="twitter:description" content="${esc(data.description)}" />`,
    `<meta name="twitter:image" content="${esc(data.image)}" />`,
  ].join('\n    ');
  // 在 <head> 后紧接插入（在原 meta 之前，爬虫取第一个 og:title）
  return html.replace(/<head[^>]*>/i, (m) => `${m}\n    ${tags}`);
}

// bot 分流中间件：挂在 SPA fallback 之前。
// - 爬虫 UA（含微信外部抓取）：返回独立卡片页 renderCard（带跳转按钮）
// - 浏览器 UA（含微信内置浏览器）：仍返回 SPA，但注入文章 OG meta，
//   这样用户在微信里点链接是正常 App 体验，分享到朋友圈时微信抓的是注入后的 HTML
export async function ogBotGuard(req, res, next) {
  const m = /^\/(article|plaza)\/(\d+)/.exec(req.path);
  if (!m) return next();
  try {
    const type = m[1];
    const id = Number(m[2]);
    let data;
    if (type === 'article') {
      const article = await getArticle(id);
      if (!article) return next();
      data = buildShareData(article, req);
    } else {
      const topic = await getTopic(id);
      if (!topic) return next();
      data = getTopicShareData(topic, req);
    }
    res.set('Cache-Control', 'public, max-age=300');
    const ua = String(req.get('user-agent') || '');
    if (isCrawler(ua) && !BROWSER_RE.test(ua)) {
      // 纯爬虫（非浏览器）：返回完整卡片页
      return res.send(renderCard(data));
    }
    // 浏览器（含微信内置）：在 SPA 骨架上注入 OG 标签
    const html = getIndexHtml();
    if (!html) return res.send(renderCard(data));
    return res.send(injectOgMeta(html, data));
  } catch (e) {
    console.error('[og] guard failed:', e?.message || e);
    next();
  }
}

export default router;
