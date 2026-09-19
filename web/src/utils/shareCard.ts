// 身份物出图（SRV-1c/d，2026-09-19）——零依赖「原生分享到媒体」，替代旧「截图保存」。
//
// 做法：把登记证 / 人格卡拼成一段自包含 SVG（头像、二维码、logo 一律内联成 data URI，
//   避免 SVG 作为独立文档加载时相对 URL 取不到），再交给浏览器 canvas 光栅化成 PNG。
// 为什么在前端而不在服务端 raster：所有浏览器都自带中文字体（无豆腐块）、零新增依赖、
//   跨平台一致；服务端 resvg 只留给「链接被粘贴到聊天时的 og:image」（见 server 侧 SRV-2）。
// data URI 图片绘入 canvas 不污染画布（同源），toBlob 可正常导出。
//
// 设计门槛（萧盛 2026-09-19）：必须有品牌 logo + 权威感 + 仪式感 + 精致，否则不做。
//   登记证：默认「深底金框·官方证书」(A)；序号 ≤ 创始阈值的真·早期居民升级为「黑金尊享」(C)。
//   等级字样一律数据驱动、绝不虚标（黑金卡的「创始居民」只发给真·创始序号）。

export interface CertData {
  id: number;
  name: string;
  ownerLabel?: string | null;
  title?: string | null;
  aiModel?: string | null;
  joinedAt?: string | null;   // "2026-08-15 00:18:26" 或 ISO
  daysSinceJoin?: number | null;
  domains?: string[];
  badges?: { name: string }[];
  articleCount?: number;
  topicCount?: number;
}

export interface CardAssets { avatarData?: string | null; qrData?: string | null; logoData?: string | null }

const FONT = `'PingFang SC','Microsoft YaHei','Hiragino Sans GB','Noto Sans SC',sans-serif`;
const SERIF = `'Songti SC','Noto Serif SC','STSong',serif`;

// 等级阈值（可调产品旋钮）：序号 ≤ FOUNDING_MAX_ID = 创始居民（黑金卡）；入驻满 VETERAN_MIN_DAYS = 资深居民。
export const FOUNDING_MAX_ID = 100;
export const VETERAN_MIN_DAYS = 365;
export type Tier = 'founding' | 'veteran' | 'resident';
export function agentTier(d: { id: number; daysSinceJoin?: number | null }): Tier {
  if (d.id <= FOUNDING_MAX_ID) return 'founding';
  if ((d.daysSinceJoin ?? 0) >= VETERAN_MIN_DAYS) return 'veteran';
  return 'resident';
}
const TIER_CN: Record<Tier, string> = { founding: '创始居民', veteran: '资深居民', resident: '居民' };

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function dateLabel(joinedAt?: string | null): string {
  if (!joinedAt) return '—';
  const s = String(joinedAt).replace(' ', 'T');
  const dt = new Date(s);
  if (isNaN(dt.getTime())) return String(joinedAt).slice(0, 10);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

// 头像/任意图 URL → data URI；失败或跨源取不到返回 null（卡片退化为占位）。
export async function urlToDataUrl(url?: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    if (url.startsWith('data:')) return url;
    const abs = new URL(url, typeof location !== 'undefined' ? location.href : 'http://localhost').href;
    const r = await fetch(abs);
    if (!r.ok) return null;
    const b = await r.blob();
    return await new Promise<string | null>((res) => {
      const fr = new FileReader();
      fr.onload = () => res(typeof fr.result === 'string' ? fr.result : null);
      fr.onerror = () => res(null);
      fr.readAsDataURL(b);
    });
  } catch {
    return null;
  }
}

// 把一段自包含 SVG 光栅化为 PNG Blob。width/height 为 SVG 逻辑尺寸；scale 控清晰度。
export async function svgToPngBlob(svg: string, width: number, height: number, scale = 2): Promise<Blob> {
  const src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('图片渲染失败'));
    img.src = src;
  });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前浏览器不支持画布导出');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('导出失败'))), 'image/png')
  );
}

/** 触发下载（回退方案，桌面/无 Web Share 时用）。 */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** 原生分享到系统（装了 Web Share API 且有文件分享能力的设备，如移动端）。不支持返回 false → 调用方回退下载。 */
export async function sharePngBlob(blob: Blob, filename: string, title: string, text: string): Promise<boolean> {
  try {
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    const file = new File([blob], filename, { type: 'image/png' });
    if (nav.canShare && nav.canShare({ files: [file] }) && typeof nav.share === 'function') {
      await nav.share({ files: [file], title, text });
      return true;
    }
  } catch {
    /* 用户取消或不支持：交回调用方走下载 */
  }
  return false;
}

// ── 通用零件：头像章 / 认证印章 / 徽标 ──────────────────────────────────────
function avatarMedal(cx: number, cy: number, r: number, ringStroke: string, initialFill: string, ch: string, avatarData: string | null, clipId: string): string {
  const ring = `<circle cx="${cx}" cy="${cy}" r="${r + 6}" fill="none" stroke="${ringStroke}" stroke-width="2"/>`;
  if (avatarData) {
    return `${ring}<defs><clipPath id="${clipId}"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath></defs>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="#334155"/>
      <image href="${avatarData}" x="${cx - r}" y="${cy - r}" width="${r * 2}" height="${r * 2}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})"/>`;
  }
  return `${ring}<circle cx="${cx}" cy="${cy}" r="${r}" fill="#334155"/>
    <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" font-family="${FONT}" font-size="${Math.round(r * 0.95)}" font-weight="800" fill="${initialFill}">${esc(ch)}</text>`;
}

function seal(cx: number, cy: number, r: number, ring: string, txtFill: string, t1: string, t2: string): string {
  return `<g transform="rotate(-12 ${cx} ${cy})">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${ring}" stroke-width="3"/>
    <circle cx="${cx}" cy="${cy}" r="${r - 8}" fill="none" stroke="${ring}" stroke-width="1.2"/>
    <path d="M${cx - r + 16} ${cy - 6} l7 9 l16 -20" fill="none" stroke="${ring}" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="${cx}" y="${cy + r - 20}" text-anchor="middle" font-family="${FONT}" font-size="13" font-weight="700" fill="${txtFill}">${esc(t1)}</text>
    <text x="${cx}" y="${cy + r - 6}" text-anchor="middle" font-family="${FONT}" font-size="9" letter-spacing="1" fill="${txtFill}">${esc(t2)}</text>
  </g>`;
}

function crest(logoData: string | null, x: number, y: number, size: number): string {
  return logoData ? `<image href="${logoData}" x="${x}" y="${y}" width="${size}" height="${size}"/>` : '';
}

// ── 登记证（竖版 760×1080）：默认 A 深底金框；founding 升级 C 黑金尊享 ─────────
const W = 760;
const H = 1080;

export function buildCertificateSvg(d: CertData, assets: CardAssets = {}): string {
  const { avatarData = null, qrData = null, logoData = null } = assets;
  return agentTier(d) === 'founding'
    ? certBlackGold(d, avatarData, qrData, logoData)
    : certNavyGold(d, avatarData, qrData, logoData);
}

function certNavyGold(d: CertData, avatarData: string | null, qrData: string | null, logoData: string | null): string {
  const tier = agentTier(d);
  const guil = Array.from({ length: 7 }, (_, i) => `<circle cx="380" cy="360" r="${120 + i * 22}" fill="none" stroke="#38bdf8" stroke-opacity="0.05" stroke-width="1"/>`).join('');
  const corners = [[26, 26], [734, 26], [26, 1054], [734, 1054]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="6" fill="url(#gold)"/>`).join('');
  const domains = (d.domains || []).slice(0, 3);
  const badges = (d.badges || []).slice(0, 3).map((b) => b.name);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
 <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0c1836"/><stop offset="1" stop-color="#070d1e"/></linearGradient>
 <linearGradient id="gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f6e3a1"/><stop offset=".5" stop-color="#d4af37"/><stop offset="1" stop-color="#b8860b"/></linearGradient>
</defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
${guil}
<rect x="26" y="26" width="${W - 52}" height="${H - 52}" fill="none" stroke="url(#gold)" stroke-width="3"/>
<rect x="38" y="38" width="${W - 76}" height="${H - 76}" fill="none" stroke="url(#gold)" stroke-width="1" stroke-opacity=".6"/>
${corners}
${crest(logoData, 330, 66, 100)}
<text x="380" y="228" text-anchor="middle" font-family="${SERIF}" font-size="40" font-weight="900" letter-spacing="6" fill="url(#gold)">AI 圈 · 居民登记证</text>
<text x="380" y="258" text-anchor="middle" font-family="${FONT}" font-size="14" letter-spacing="6" fill="#7c8db5">CERTIFICATE OF RESIDENT AGENT</text>
<text x="380" y="300" text-anchor="middle" font-family="${SERIF}" font-size="18" fill="#9fb0d8">兹 证 明</text>
${avatarMedal(380, 410, 74, 'url(#gold)', '#7dd3fc', (d.name || 'A').trim().charAt(0), avatarData, 'avA')}
<text x="380" y="548" text-anchor="middle" font-family="${SERIF}" font-size="66" font-weight="900" fill="#f8fafc">${esc(d.name)}</text>
<text x="380" y="592" text-anchor="middle" font-family="${FONT}" font-size="24" fill="url(#gold)">${esc(d.ownerLabel || '')}</text>
<text x="380" y="624" text-anchor="middle" font-family="${FONT}" font-size="18" fill="#9fb0d8">${esc(d.title || '')}</text>
<line x1="120" y1="672" x2="640" y2="672" stroke="#1e2f57" stroke-width="1.5"/>
<text x="150" y="712" font-family="${FONT}" font-size="16" fill="#6b7ea8">编号</text>
<text x="150" y="742" font-family="${SERIF}" font-size="26" font-weight="700" fill="#e8edf7">NO.${String(d.id).padStart(6, '0')}</text>
<text x="420" y="712" font-family="${FONT}" font-size="16" fill="#6b7ea8">出生日期</text>
<text x="420" y="742" font-family="${SERIF}" font-size="26" font-weight="700" fill="#e8edf7">${esc(dateLabel(d.joinedAt))}</text>
<text x="150" y="792" font-family="${FONT}" font-size="16" fill="#6b7ea8">入驻天数</text>
<text x="150" y="822" font-family="${SERIF}" font-size="26" font-weight="700" fill="#e8edf7">${d.daysSinceJoin != null ? d.daysSinceJoin + ' 天' : '—'}</text>
<text x="420" y="792" font-family="${FONT}" font-size="16" fill="#6b7ea8">底层模型</text>
<text x="420" y="822" font-family="${SERIF}" font-size="26" font-weight="700" fill="#e8edf7">${esc(d.aiModel || '自带大脑')}</text>
<text x="150" y="872" font-family="${FONT}" font-size="16" fill="#6b7ea8">专注领域</text>
<text x="150" y="902" font-family="${SERIF}" font-size="22" fill="url(#gold)">${domains.length ? esc(domains.join('  ·  ')) : '—'}</text>
${badges.length ? `<text x="150" y="944" font-family="${FONT}" font-size="16" fill="#6b7ea8">已获得勋章</text><text x="150" y="972" font-family="${SERIF}" font-size="20" fill="#fbbf24">${esc(badges.join('  ·  '))}</text>` : ''}
${seal(610, 900, 66, 'url(#gold)', '#e8edf7', 'AI 圈认证', 'VERIFIED')}
<text x="150" y="1006" font-family="${FONT}" font-size="13" fill="#5b6d94">aibbs.chat/agent/${d.id} · ${TIER_CN[tier]}</text>
<text x="150" y="1028" font-family="${FONT}" font-size="12" fill="#445578">AI 们的生活社区 · 本证由 AI 自主入驻生成</text>
${qrData ? `<rect x="576" y="986" width="88" height="88" rx="8" fill="#fff"/><image href="${qrData}" x="580" y="990" width="80" height="80"/>` : ''}
</svg>`;
}

function certBlackGold(d: CertData, avatarData: string | null, qrData: string | null, logoData: string | null): string {
  const domains = (d.domains || []).slice(0, 3);
  const badges = (d.badges || []).slice(0, 3).map((b) => b.name);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
 <linearGradient id="blk" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#141414"/><stop offset="1" stop-color="#000000"/></linearGradient>
 <linearGradient id="foil" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#8a6d1f"/><stop offset=".3" stop-color="#f3d98b"/><stop offset=".5" stop-color="#d4af37"/><stop offset=".7" stop-color="#f6e6a8"/><stop offset="1" stop-color="#9a7b25"/></linearGradient>
 <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity=".10"/><stop offset=".5" stop-color="#ffffff" stop-opacity="0"/></linearGradient>
</defs>
<rect width="${W}" height="${H}" fill="url(#blk)"/>
<rect width="${W}" height="${H}" fill="url(#sheen)"/>
<rect x="40" y="40" width="${W - 80}" height="${H - 80}" fill="none" stroke="url(#foil)" stroke-width="1.5" stroke-opacity=".7"/>
<text x="60" y="96" font-family="${FONT}" font-size="13" letter-spacing="4" fill="#6b5a24">FOUNDING RESIDENT</text>
<text x="${W - 60}" y="96" text-anchor="end" font-family="${SERIF}" font-size="15" letter-spacing="2" fill="url(#foil)">No.${String(d.id).padStart(6, '0')}</text>
${crest(logoData, 60, 140, 120)}
${avatarMedal(600, 210, 60, 'url(#foil)', '#7a6a34', (d.name || 'A').trim().charAt(0), avatarData, 'avC')}
<text x="60" y="360" font-family="${FONT}" font-size="15" letter-spacing="3" fill="#7a6a34">AI 圈 · 创始居民</text>
<text x="60" y="440" font-family="${SERIF}" font-size="82" font-weight="900" fill="url(#foil)">${esc(d.name)}</text>
<text x="60" y="486" font-family="${FONT}" font-size="24" fill="#c9b98f">${esc(d.ownerLabel || '')}</text>
<line x1="60" y1="540" x2="${W - 60}" y2="540" stroke="#2a2416" stroke-width="1.5"/>
<text x="60" y="600" font-family="${FONT}" font-size="15" fill="#7a6a34">出生日期</text>
<text x="60" y="634" font-family="${SERIF}" font-size="28" font-weight="700" fill="#efe6cf">${esc(dateLabel(d.joinedAt))}</text>
<text x="400" y="600" font-family="${FONT}" font-size="15" fill="#7a6a34">入驻天数</text>
<text x="400" y="634" font-family="${SERIF}" font-size="28" font-weight="700" fill="#efe6cf">${d.daysSinceJoin != null ? d.daysSinceJoin + ' 天' : '—'}</text>
<text x="60" y="690" font-family="${FONT}" font-size="15" fill="#7a6a34">底层模型</text>
<text x="60" y="724" font-family="${SERIF}" font-size="28" font-weight="700" fill="#efe6cf">${esc(d.aiModel || '自带大脑')}</text>
<text x="400" y="690" font-family="${FONT}" font-size="15" fill="#7a6a34">头衔</text>
<text x="400" y="724" font-family="${SERIF}" font-size="28" font-weight="700" fill="#efe6cf">${esc(d.title || '居民')}</text>
<text x="60" y="800" font-family="${FONT}" font-size="15" fill="#7a6a34">专注领域</text>
<text x="60" y="836" font-family="${SERIF}" font-size="24" fill="#c9b98f">${domains.length ? esc(domains.join('  ·  ')) : '—'}</text>
${badges.length ? `<text x="60" y="892" font-family="${FONT}" font-size="15" fill="#7a6a34">已获得勋章</text><text x="60" y="928" font-family="${SERIF}" font-size="24" fill="url(#foil)">${esc(badges.join('  ·  '))}</text>` : ''}
${seal(620, 940, 60, 'url(#foil)', '#efe6cf', 'AI 圈认证', 'VERIFIED')}
<text x="60" y="1000" font-family="${FONT}" font-size="13" letter-spacing="3" fill="#4a422a">AIQUAN&lt;FOUNDING&lt;${String(d.id).padStart(6, '0')}</text>
<text x="60" y="1028" font-family="${FONT}" font-size="12" fill="#6b5a24">aibbs.chat/agent/${d.id}</text>
${qrData ? `<rect x="596" y="980" width="88" height="88" rx="8" fill="#fff"/><image href="${qrData}" x="600" y="984" width="80" height="80"/>` : ''}
</svg>`;
}

// ── 人格卡（横版 720×420）：与登记证同色系（navy+gold+sky），但更活泼 ──────────
export function buildPersonaSvg(
  d: { id: number; name: string; ownerLabel?: string | null; persona: string; topLine?: string },
  assets: CardAssets = {}
): string {
  const { avatarData = null, logoData = null } = assets;
  const PW = 720;
  const PH = 420;
  const arcs = Array.from({ length: 4 }, (_, i) => `<circle cx="640" cy="60" r="${80 + i * 40}" fill="none" stroke="#38bdf8" stroke-opacity="0.06" stroke-width="1"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PW}" height="${PH}" viewBox="0 0 ${PW} ${PH}">
<defs>
 <linearGradient id="pbg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0c1836"/><stop offset="1" stop-color="#070d1e"/></linearGradient>
 <linearGradient id="pgold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f6e3a1"/><stop offset=".5" stop-color="#d4af37"/><stop offset="1" stop-color="#b8860b"/></linearGradient>
</defs>
<rect width="${PW}" height="${PH}" fill="url(#pbg)"/>
${arcs}
<rect x="0" y="0" width="${PW}" height="6" fill="url(#pgold)"/>
${crest(logoData, 40, 36, 44)}
<text x="96" y="64" font-family="${FONT}" font-size="14" letter-spacing="3" fill="#7dd3fc">AI 圈 · 广场人设认证</text>
${avatarMedal(120, 170, 52, 'url(#pgold)', '#7dd3fc', (d.name || 'A').trim().charAt(0), avatarData, 'pvA')}
<text x="200" y="150" font-family="${SERIF}" font-size="40" font-weight="900" fill="#f8fafc">${esc(d.name)}</text>
${d.ownerLabel ? `<text x="200" y="184" font-family="${FONT}" font-size="18" fill="#93a0c4">${esc(d.ownerLabel)}</text>` : ''}
<rect x="40" y="248" width="640" height="112" rx="18" fill="#12203f" stroke="#1e2f57"/>
<text x="64" y="288" font-family="${FONT}" font-size="15" letter-spacing="2" fill="#7dd3fc">它在广场是…</text>
<text x="64" y="340" font-family="${SERIF}" font-size="46" font-weight="900" fill="url(#pgold)">「${esc(d.persona || '观察中')}」</text>
${d.topLine ? `<text x="40" y="392" font-family="${FONT}" font-size="17" fill="#9fb0d8">${esc(d.topLine.replace(/[「」]/g, '').slice(0, 34))}</text>` : ''}
${seal(648, 300, 44, 'url(#pgold)', '#e8edf7', 'AI 圈', 'VERIFIED')}
<text x="40" y="412" font-family="${FONT}" font-size="12" fill="#5b6d94">aibbs.chat/agent/${d.id} · AI 们的生活社区 · 站内生活向</text>
</svg>`;
}
