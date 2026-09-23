// 发布侧自动配图（P1-10/11 兜底，2026-08-15 萧哥拍板）
// ---------------------------------------------------------------------------
// 背景：preset 里"assets 产出指令"是弱约束（可选），Agent 实测从未产出 assets
// （服务器 8 篇 post 全空）。治本：不逼 Agent 产出，发布侧事后接住——
//   1. chart：LLM 从正文提取可量化对比 → 生成 chart assets（仿 extractViewpoint
//      哲学：注入式可测、失败静默降级、无 key 跳过不烧钱）
//   2. 封面：按分类+标题生成本地 SVG data URI（零依赖、可控美观、无 CDN）
// 铁律：任何失败一律静默降级（无图），绝不阻塞发布。

import { chat as llmChat } from '../llm/client.js';


/**
 * 剥掉 LLM 返回 JSON 外可能裹的 markdown 围栏（```json ... ```）。
 * 即使请求方要求 json_object，部分供应商/模型仍会带围栏，直接 JSON.parse 必炸。
 */
export function stripJsonFences(text) {
  let t = String(text || '').trim();
  // 去掉首尾围栏：```json / ``` 开头，``` 结尾
  t = t.replace(/^```(?:json|JSON)?\s*/, '').replace(/\s*```$/, '');
  // 兜底：截取第一个 { 到最后一个 }（围栏未闭合等畸形输出）
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i !== -1 && j > i) t = t.slice(i, j + 1);
  return t.trim();
}

// ---------------------------------------------------------------------------
// 1. chart 提取（LLM 驱动，可注入）
// ---------------------------------------------------------------------------

/**
 * 从文章正文提取可量化对比 → 归一化为 chart assets。
 * @param {{title?:string, content?:string}} article
 * @param {{llmExtractor?:(text:string)=>Promise<{charts?:Array}>}} [opts] 注入式（测试 mock）
 * @returns {Promise<Array>} 合规 chart assets（最多 3 张；失败/无数据返回 []）
 */
export async function extractChartsFromText(article, { llmExtractor } = {}) {
  const text = (article?.content || '').trim();
  if (!text) return [];
  const extractor = llmExtractor || defaultLlmExtractor;
  try {
    const result = await extractor(text.slice(0, 3000));
    return normalizeCharts(result);
  } catch (e) {
    console.warn(`[assetService] chart 提取失败（降级无图）: ${e?.message || e}`);
    return [];
  }
}

/** 默认 LLM 提取器：走统一路由层（json_object）。无可用供应商时返回空，由上层静默降级。 */
async function defaultLlmExtractor(text) {
  const prompt = `你是数据可视化助手。从下面的文章正文中提取可量化的对比数据，生成 1-3 个图表。
要求：
- 只提取正文明确给出的数字对比（如市占率变化、营收/利润增长、性能倍数、多主体/多年份对比）
- 每个图表：title（简短图表标题）、labels（x 轴标签，如年份/公司/指标名）、values（数值数组，与 labels 一一对应）
- 优先选最有说服力的 1-2 组；没有可量化的对比数据就返回空数组
- 只输出 JSON，格式：{"charts":[{"title":"...","labels":["..."],"values":[10,20]}]}`;

  const r = await llmChat({
    purpose: 'vision',
    json: true,
    maxTokens: 800,
    temperature: 0.2,
    messages: [
      { role: 'system', content: '你只输出合法 JSON，不输出任何其他内容。' },
      { role: 'user', content: `${prompt}\n\n正文：\n${text}` },
    ],
  });
  // 无供应商 / 空响应 → 返回空，由 extractChartsFromText 静默降级 []
  if (!r?.content) return { charts: [] };
  return JSON.parse(stripJsonFences(r.content));
}

/** 归一化 LLM 输出为合规 chart assets（契约白名单校验）。 */
function normalizeCharts(result) {
  if (!result || !Array.isArray(result.charts)) return [];
  const out = [];
  for (const c of result.charts) {
    if (!c || !Array.isArray(c.labels) || !Array.isArray(c.values)) continue;
    const labels = c.labels.map(String).slice(0, 12);
    const values = c.values.slice(0, 12).map(Number);
    if (labels.length < 2 || values.length !== labels.length) continue;
    if (values.some((v) => !Number.isFinite(v))) continue;
    out.push({
      type: 'chart',
      title: typeof c.title === 'string' && c.title.trim() ? c.title.trim().slice(0, 100) : undefined,
      position: 'inline',
      data: {
        type: c.type === 'line' ? 'line' : 'bar',
        labels,
        datasets: [{ name: typeof c.name === 'string' ? c.name.slice(0, 40) : '数值', values }],
      },
    });
  }
  return out.slice(0, 3);
}

// ---------------------------------------------------------------------------
// 2. 封面生成（本地 SVG data URI，零依赖）
// ---------------------------------------------------------------------------

const CATEGORY_COLORS = {
  科技: { accent: '#2563eb', bg: '#eef4ff' },
  财经: { accent: '#b45309', bg: '#fdf3e3' },
  历史: { accent: '#78350f', bg: '#f6f0e6' },
  心理: { accent: '#7c3aed', bg: '#f5efff' },
  社会: { accent: '#047857', bg: '#eafaf3' },
  默认: { accent: '#374151', bg: '#f3f4f6' },
};

function esc(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** 按字符宽分行（全角=2 单位，半角=1），每行 maxW 单位，最多 maxLines 行。 */
function wrapTitle(title, maxW = 34, maxLines = 3) {
  const chars = [...String(title)];
  const lines = [];
  let line = '';
  let w = 0;
  for (const ch of chars) {
    const cw = ch.charCodeAt(0) > 255 ? 2 : 1;
    if (w + cw > maxW && line) {
      lines.push(line);
      line = ch;
      w = cw;
      if (lines.length === maxLines) break;
    } else {
      line += ch;
      w += cw;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === 0) lines.push('未命名');
  return lines;
}

/**
 * 按分类+标题生成本地 SVG 封面（data URI）。
 * @param {{title?:string, category?:string}} article
 * @returns {object|null} { type:'image', url:dataURI, title, position:'cover' }；失败返回 null
 */
export function generateCover(article) {
  try {
    const pal = CATEGORY_COLORS[article?.category] || CATEGORY_COLORS['默认'];
    const title = (article?.title || '未命名').trim().slice(0, 80);
    const lines = wrapTitle(title);
    const W = 640;
    const H = 360;
    const titleText = lines
      .map((l, i) => {
        const y = 150 + i * 40;
        return `<text x="48" y="${y}" font-family="'Noto Serif SC','Songti SC',serif" font-size="27" font-weight="700" fill="#111827">${esc(l)}</text>`;
      })
      .join('\n  ');

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${pal.bg}"/>
  <circle cx="556" cy="56" r="150" fill="${pal.accent}" opacity="0.10"/>
  <circle cx="612" cy="310" r="110" fill="${pal.accent}" opacity="0.07"/>
  <rect x="0" y="0" width="10" height="${H}" fill="${pal.accent}"/>
  <text x="48" y="68" font-family="'Noto Sans SC',sans-serif" font-size="14" letter-spacing="3" fill="${pal.accent}">${esc(article?.category || '专业洞察')} · 专业洞察</text>
  ${titleText}
  <text x="48" y="${H - 44}" font-family="'Noto Sans SC',sans-serif" font-size="12" fill="#9ca3af">AI 圈 · 让 AI 越来越懂世界</text>
</svg>`;
    const uri = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
    return { type: 'image', url: uri, title, position: 'cover' };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 3. 组合入口
// ---------------------------------------------------------------------------

/**
 * 自动配图：chart（LLM 提取，可关）+ 封面（本地 SVG）。
 * @param {{title?:string, content?:string, category?:string}} article
 * @param {{withChart?:boolean, llmExtractor?}} [opts]
 * @returns {Promise<Array>} assets 数组（可能为空，绝不抛错）
 */
export async function autoAssets(article, { withChart = true, llmExtractor } = {}) {
  const out = [];
  if (withChart) {
    const charts = await extractChartsFromText(article, { llmExtractor });
    out.push(...charts);
  }
  const cover = generateCover(article);
  if (cover) out.push(cover);
  return out;
}
