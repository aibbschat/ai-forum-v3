// SEO 服务端渲染公共库（B2/B3）。
// 职责：
//  - 转义与轻量 Markdown→安全 HTML（正文暴露给搜索引擎，先转义再解析，杜绝注入）。
//  - 把「按页 meta」注入到 SPA 骨架 index.html 的 <head>（浏览器/微信内访问用）。
//  - 为纯爬虫渲染含正文的完整 SEO 落地页（文章 / 广场帖）。
// 关键原则：区分「社交分享卡」(og.js renderCard, 薄) 与「搜索引擎落地页」(本模块 buildSeoArticleDoc, 厚含正文)。
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 规范站点根：SITE_PUBLIC_URL 最高优先级（生产设 https://aibbs.chat），否则按请求 Host/协议兜底。
export function publicBase(req) {
  if (process.env.SITE_PUBLIC_URL) return process.env.SITE_PUBLIC_URL.replace(/\/$/, '');
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}`;
}

// dist/index.html 骨架（带 mtime 失效缓存）：cwd 可能是仓库根或 server/，两处都探。
let _html = '';
let _htmlKey = '';
function distIndexPath() {
  const cands = [
    resolve(process.cwd(), 'web', 'dist', 'index.html'),
    resolve(__dirname, '..', '..', 'web', 'dist', 'index.html'),
  ];
  for (const p of cands) if (existsSync(p)) return p;
  return null;
}
export function getIndexHtml() {
  const p = distIndexPath();
  if (!p) return _html || '';
  let mt = 0;
  try { mt = statSync(p).mtimeMs; } catch { /* ignore */ }
  const key = `${p}@${mt}`;
  if (key === _htmlKey) return _html;
  try {
    _html = readFileSync(p, 'utf8');
    _htmlKey = key;
  } catch { /* 读取失败保留上一次 */ }
  return _html;
}

// 轻量 Markdown → 安全 HTML。先按行累计到 maxChars 再解析（截断发生在行边界，不会切坏 token）。
export function mdToSafeHtml(md, { maxChars = 5000 } = {}) {
  const raw = String(md || '').replace(/\r\n/g, '\n');
  const srcLines = raw.split('\n');
  const budgeted = [];
  let count = 0;
  for (const ln of srcLines) {
    budgeted.push(ln);
    count += ln.replace(/[#>*_`~\-|]/g, '').length;
    if (count >= maxChars) break;
  }
  const src = budgeted.join('\n');

  const inline = (s) => {
    let t = esc(s);
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ''); // 去内联图片（相对/data URI 可能坏链）
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="nofollow noopener noreferrer">$1</a>');
    t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'); // 其余链接只留文本
    return t;
  };

  const out = [];
  let inCode = false;
  let codeBuf = [];
  let para = [];
  const flushPara = () => {
    if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
  };
  for (const line of src.split('\n')) {
    if (/^\s*```/.test(line)) {
      if (inCode) { out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`); codeBuf = []; inCode = false; }
      else { flushPara(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }
    if (!line.trim()) { flushPara(); continue; }
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
      flushPara();
      const lv = Math.min(m[1].length + 1, 6); // 正文 H1 由 <h1> 标题单独给，md 里的 # 降级为 h2 起
      out.push(`<h${lv}>${inline(m[2])}</h${lv}>`);
      continue;
    }
    if ((m = /^\s*>\s?(.*)$/.exec(line))) { flushPara(); out.push(`<blockquote><p>${inline(m[1])}</p></blockquote>`); continue; }
    if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) { flushPara(); out.push(`<ul><li>${inline(m[1])}</li></ul>`); continue; }
    if ((m = /^\s*\d+\.\s+(.*)$/.exec(line))) { flushPara(); out.push(`<ol><li>${inline(m[1])}</li></ol>`); continue; }
    if (/^\s*\|?\s*:?-{2,}/.test(line) && line.includes('|')) continue; // 表格分隔行
    if (line.trim().startsWith('|')) { para.push(line.replace(/\|/g, ' ').trim()); continue; }
    para.push(line.trim());
  }
  if (inCode && codeBuf.length) out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`);
  flushPara();
  return out.join('\n');
}

// 纯文本摘要（给 meta description / 卡片摘要）：剥 Markdown 标记，压空白，截断。
// 注意顺序：先删结构（代码块 → 图片 → 链接 → 标题/列表 → 表格竖线），再删行内标记，
// 否则 `-` `*` 会先被行内 sweep 吃掉、导致列表标记的 `\s+` 匹配不上而留下多余空格。
export function stripMd(md, n = 150) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s{0,3}(?:[-*+]|\d{1,9}\.)\s+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/[*_`~>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n);
}

function jsonLdScript(obj) {
  // <script> 内不转义 HTML 实体，但必须把 < 转成 \u003c 防止 </script> 逃逸。
  const json = JSON.stringify(obj).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, (c) =>
    c === '\u2028' ? '\\u2028' : '\\u2029');
  return `<script type="application/ld+json">${json}</script>`;
}

// meta 对象 → <head> 标签串。字段缺省即不输出，og:url 与 canonical 都用 m.canonical。
export function metaTags(m) {
  const t = [];
  t.push(`<title>${esc(m.title)}</title>`);
  if (m.description) t.push(`<meta name="description" content="${esc(m.description)}" />`);
  if (m.robots) t.push(`<meta name="robots" content="${esc(m.robots)}" />`);
  t.push(`<meta property="og:type" content="${esc(m.ogType || 'website')}" />`);
  t.push(`<meta property="og:site_name" content="AI 圈" />`);
  t.push(`<meta property="og:title" content="${esc(m.title)}" />`);
  if (m.description) t.push(`<meta property="og:description" content="${esc(m.description)}" />`);
  if (m.canonical) t.push(`<meta property="og:url" content="${esc(m.canonical)}" />`);
  if (m.ogImage) {
    t.push(`<meta property="og:image" content="${esc(m.ogImage)}" />`);
    t.push(`<meta property="og:image:width" content="1200" />`);
    t.push(`<meta property="og:image:height" content="630" />`);
  }
  t.push(`<meta name="twitter:card" content="${esc(m.twitterCard || 'summary')}" />`);
  t.push(`<meta name="twitter:title" content="${esc(m.title)}" />`);
  if (m.description) t.push(`<meta name="twitter:description" content="${esc(m.description)}" />`);
  if (m.ogImage) t.push(`<meta name="twitter:image" content="${esc(m.ogImage)}" />`);
  if (m.canonical) t.push(`<link rel="canonical" href="${esc(m.canonical)}" />`);
  if (Array.isArray(m.jsonLd)) for (const o of m.jsonLd) if (o) t.push(jsonLdScript(o));
  return t.join('\n    ');
}

// 把 meta 注入 SPA 骨架：先删除模板里同族的旧标签（title/description/canonical/og:*/twitter:*/robots/ld+json），
// 再在 <head> 后插入唯一一组，杜绝重复 canonical。
export function applyHeadMeta(html, m) {
  if (!html) return '';
  let out = html
    .replace(/<title>[\s\S]*?<\/title>/i, '')
    .replace(/<meta\s+name="description"[^>]*>/gi, '')
    .replace(/<meta\s+name="robots"[^>]*>/gi, '')
    .replace(/<link\s+rel="canonical"[^>]*>/gi, '')
    .replace(/<meta\s+property="og:[^"]+"[^>]*>/gi, '')
    .replace(/<meta\s+name="twitter:[^"]+"[^>]*>/gi, '')
    .replace(/<script\s+type="application\/ld\+json">[\s\S]*?<\/script>/gi, '');
  const block = metaTags(m);
  return out.replace(/(<head[^>]*>)/i, (mm) => `${mm}\n    ${block}\n    `);
}

const DOC_STYLE = `body{margin:0;font-family:-apple-system,"PingFang SC","Noto Serif SC",serif;background:#fff;color:#111;}
.wrap{max-width:720px;margin:0 auto;padding:40px 20px;}
h1{font-size:28px;line-height:1.4;margin:0 0 8px;}
.byline{color:#888;font-size:13px;margin:0 0 24px;}
article h2{font-size:22px;margin:28px 0 10px;}article h3{font-size:18px;margin:22px 0 8px;}
article p{font-size:16px;line-height:1.9;margin:0 0 16px;}article ul,article ol{padding-left:22px;line-height:1.9;}
article blockquote{border-left:3px solid #ddd;margin:0 0 16px;padding:2px 16px;color:#555;}
article pre{background:#f5f5f5;padding:12px;border-radius:8px;overflow:auto;}article code{background:#f2f2f2;padding:1px 5px;border-radius:4px;}
a{color:#1d4ed8;}`;

// 爬虫专用：含正文的完整落地页（文章）。
export function buildSeoArticleDoc(m) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
    ${metaTags(m)}
<style>${DOC_STYLE}</style>
</head>
<body>
  <article class="wrap">
    <h1>${esc(m.title)}</h1>
    <p class="byline">${esc(m.authorName || 'AI 圈')}${m.publishedAt ? ` · ${esc(String(m.publishedAt).slice(0, 10))}` : ''}</p>
    ${m.bodyHtml || `<p>${esc(m.description || '')}</p>`}
    <p><a href="${esc(m.canonical)}">在 AI 圈阅读全文并参与评论</a></p>
  </article>
</body>
</html>`;
}
