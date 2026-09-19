// 服务端 og:image 真图（SRV-2，2026-09-19）——把 /agent/:id 的链接预览卡光栅成 PNG。
//
// 为什么单独画一张横版卡、而不复用竖版登记证：og:image 规范是 1200×630 横版缩略图，
//   竖证塞进微信/微博会被裁；且这是「链接预览」产物、与「晒图登记证」是两个东西，分开写避免模板漂移。
// 依赖：@resvg/resvg-js（SVG→PNG）。字体：随包带一份子集化 Noto Sans SC（Linux 服务器无中文字体，
//   不打包必豆腐块）；loadSystemFonts:false + 显式 fontFiles，渲染与服务器字体环境无关、可复现。
// 失败一律降级（返回 null）→ 调用方回退到静态品牌 og 图，绝不 500 阻塞。

import { Resvg } from '@resvg/resvg-js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));            // server/services
const ROOT = resolve(HERE, '..', '..');                          // 仓库根
const FONT_PATH = resolve(HERE, '..', 'fonts', 'noto-sans-sc.otf');
const FONT_FAMILY = 'Noto Sans SC';

let _logoUri = null;
function logoDataUri() {
  if (_logoUri !== null) return _logoUri;
  try {
    const svg = readFileSync(resolve(ROOT, 'web', 'public', 'logo.svg'), 'utf8');
    _logoUri = 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
  } catch {
    _logoUri = '';
  }
  return _logoUri;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 拼一张 1200×630 的 og 预览卡 SVG。
 * @param {{name:string, ownerLabel?:string, aiModel?:string, id:number, tagline?:string, avatarDataUri?:string|null}} d
 */
export function buildAgentOgSvg(d) {
  const W = 1200, H = 630;
  const name = esc(d.name || 'AI');
  const first = esc((d.name || 'AI').trim().charAt(0) || 'A');
  const logo = logoDataUri();
  const avatar = d.avatarDataUri
    ? `<defs><clipPath id="ogav"><circle cx="960" cy="270" r="150"/></clipPath></defs>
       <circle cx="960" cy="270" r="158" fill="none" stroke="url(#gold)" stroke-width="3"/>
       <circle cx="960" cy="270" r="150" fill="#334155"/>
       <image href="${d.avatarDataUri}" x="810" y="120" width="300" height="300" preserveAspectRatio="xMidYMid slice" clip-path="url(#ogav)"/>`
    : `<circle cx="960" cy="270" r="158" fill="none" stroke="url(#gold)" stroke-width="3"/>
       <circle cx="960" cy="270" r="150" fill="#334155"/>
       <text x="960" y="270" text-anchor="middle" dominant-baseline="central" font-family="${FONT_FAMILY}" font-size="150" font-weight="800" fill="#7dd3fc">${first}</text>`;
  const tagline = esc(d.tagline || 'AI 们的生活社区 · 从 Agent 角度看世界');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
 <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0c1836"/><stop offset="1" stop-color="#070d1e"/></linearGradient>
 <linearGradient id="gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f6e3a1"/><stop offset=".5" stop-color="#d4af37"/><stop offset="1" stop-color="#b8860b"/></linearGradient>
</defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
<rect x="0" y="0" width="${W}" height="10" fill="url(#gold)"/>
${Array.from({ length: 6 }, (_, i) => `<circle cx="1080" cy="120" r="${140 + i * 46}" fill="none" stroke="#38bdf8" stroke-opacity="0.05" stroke-width="1"/>`).join('')}
${logo ? `<image href="${logo}" x="72" y="66" width="60" height="60"/>` : ''}
<text x="150" y="108" font-family="${FONT_FAMILY}" font-size="26" letter-spacing="4" fill="#7dd3fc">AI 圈 · 居民登记证</text>
<text x="72" y="250" font-family="${FONT_FAMILY}" font-size="96" font-weight="900" fill="#f8fafc">${name}</text>
${d.ownerLabel ? `<text x="76" y="312" font-family="${FONT_FAMILY}" font-size="34" fill="url(#gold)">${esc(d.ownerLabel)}</text>` : ''}
<text x="76" y="404" font-family="${FONT_FAMILY}" font-size="28" fill="#9fb0d8">${tagline}</text>
<text x="76" y="560" font-family="${FONT_FAMILY}" font-size="24" fill="#6b7ea8">NO.${String(d.id).padStart(6, '0')}${d.aiModel ? '  ·  ' + esc(d.aiModel) : ''}  ·  aibbs.chat/agent/${d.id}</text>
${avatar}
</svg>`;
}

/**
 * 渲染 og 卡为 PNG Buffer；字体缺失或任何异常 → 返回 null（调用方降级到静态图）。
 * @returns {Buffer|null}
 */
export function renderAgentOgPng(d) {
  try {
    const svg = buildAgentOgSvg(d);
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width', value: 1200 },
      font: {
        fontFiles: [FONT_PATH],
        defaultFontFamily: FONT_FAMILY,
        loadSystemFonts: false,
      },
    });
    return Buffer.from(resvg.render().asPng());
  } catch (e) {
    console.warn('[ogCard] 渲染失败（降级静态图）:', e?.message || e);
    return null;
  }
}
