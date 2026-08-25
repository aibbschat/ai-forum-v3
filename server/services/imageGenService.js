// 生图服务（2026-08-15）：让 AI Agent 文章自动配图。
// 支持两种后端：
//   - dashscope：阿里云百炼「通义万相 Wanx」原生异步接口（本部署默认）。
//     注意：DashScope 的 OpenAI 兼容模式（/compatible-mode/v1）并不暴露 images 接口，
//     直连会 404；必须走原生 /api/v1/services/aigc/text2image/image-synthesis
//     + X-DashScope-Async 任务轮询。
//   - openai：标准 OpenAI 兼容 images/generations（OpenAI / 智谱 CogView 等）。
// 设计铁律（与 assetService 一致）：任何失败一律静默降级（返回 null），绝不阻塞发布。
// 无 API Key 时不调用、不报错，由 postService 的 autoAssets 回落到本地 SVG 封面。

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// ── 配置 ──
const API_KEY =
  process.env.IMAGE_GEN_API_KEY ||
  process.env.ZHIPU_IMAGE_GEN_API_KEY ||
  process.env.DASHEYE_GEN_API_KEY ||
  process.env.DASHEYE_API_KEY ||
  process.env.OPENAI_API_KEY ||
  '';

const FALLBACK_DASHSCOPE_KEY = process.env.DASHEYE_GEN_API_KEY || process.env.DASHEYE_API_KEY || '';
// generateVia* 内部经 activeKey() 取 key；主用失败降级万相时临时切换
let ACTIVE_KEY = null;
function activeKey() { return ACTIVE_KEY ?? API_KEY; }
function setActiveKey(k) { ACTIVE_KEY = k; }
const TIMEOUT_MS = Number(process.env.IMAGE_GEN_TIMEOUT_MS || 60000);

const COVERS_DIR = process.env.COVERS_DIR || './covers';
const COVERS_URL_PREFIX = process.env.COVERS_URL_PREFIX || '/covers';

// OpenAI 兼容端点（仅 openai provider 使用）
const OPENAI_BASE_URL =
  process.env.IMAGE_GEN_BASE_URL ||
  process.env.DASHEYE_GEN_BASE_URL ||
  'https://dashscope.aliyuncs.com/compatible-mode/v1';

// DashScope 原生端点（仅 dashscope provider 使用）
const DASHSCOPE_BASE_URL =
  process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com';

// 后端选择：显式 IMAGE_GEN_PROVIDER 优先；否则按 BASE_URL 是否含 dashscope 自动判断。
const PROVIDER = (
  process.env.IMAGE_GEN_PROVIDER ||
  (OPENAI_BASE_URL.includes('dashscope') ? 'dashscope' : 'openai')
).toLowerCase();

// 模型 / 尺寸（dashscope 原生默认 wanx-v1；尺寸用 1024*1024 星号格式）
const MODEL = process.env.IMAGE_GEN_MODEL || process.env.DASHEYE_GEN_MODEL || 'wanx-v1';
const SIZE = process.env.IMAGE_GEN_SIZE || process.env.DASHEYE_GEN_SIZE || '1024*1024';

// 按领域给封面定"情绪基调"，避免千篇一律
const MOOD = {
  科技: '冷蓝未来感、光网/电路意象、克制留白',
  财经: '金橙暖调、数据流动、城市天际线',
  历史: '暖褐怀旧、卷轴/器物/光阴质感、沉静',
  心理: '紫调、脑神经光影、内心世界意象',
  社会: '青绿、城乡剪影、人与人之间距离感',
  文化: '朱红、笔墨/舞台/光影、东方写意',
  教育: '蓝绿、书本/成长光影、明亮通透',
  默认: '高级中性灰、抽象光影、现代克制',
};

/** 是否已配置生图后端（有 Key 才真正生成）。 */
export function isConfigured() {
  return Boolean(API_KEY);
}

/** 当前生效的后端 provider（调试/日志用）。 */
export function providerName() {
  return PROVIDER;
}

function buildPrompt(article) {
  const cat = article?.category || '默认';
  const mood = MOOD[cat] || MOOD['默认'];
  const title = (article?.title || '').slice(0, 60);
  const viewpoint = (article?.viewpoint || '').slice(0, 80);
  const tags = Array.isArray(article?.tags) ? article.tags.slice(0, 4).join('、') : '';
  const base =
    `为一篇题为《${title}》的${cat}领域深度文章生成一张杂志级封面配图。` +
    `要求：抽象、意象化、有氛围感，与主题精神契合；${mood}；` +
    `纯视觉构图，画面中不要出现任何文字、字母、数字、Logo 或水印；` +
    `电影感打光，高质感，避免人物脸部特写。`;
  const extra = viewpoint ? `文章核心观点：${viewpoint}。` : '';
  const tagLine = tags ? `可参考意象：${tags}。` : '';
  return base + extra + tagLine + '风格：现代、克制、留白。';
}

function sniffExt(mediaType) {
  if (mediaType === 'image/png') return 'png';
  if (mediaType === 'image/jpeg') return 'jpg';
  if (mediaType === 'image/webp') return 'webp';
  if (mediaType === 'image/gif') return 'gif';
  return 'png';
}

// 当 API 没返回 content-type 时，从 magic bytes 嗅探
function sniffFromBytes(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42)
    return 'image/webp';
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
    return 'image/gif';
  return 'image/png';
}

async function saveCover(bytes, mediaType) {
  const ext = sniffExt(mediaType);
  await mkdir(COVERS_DIR, { recursive: true });
  const file = `cover-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  await writeFile(join(COVERS_DIR, file), bytes);
  return `${COVERS_URL_PREFIX}/${file}`;
}

/**
 * 生成文章封面（真实 AI 生图），保存到持久目录并返回可访问 URL；失败返回 null。
 * @param {{title?:string, content?:string, category?:string, tags?:string[], viewpoint?:string}} article
 * @returns {Promise<string|null>} 形如 /covers/cover-<ts>-<rand>.png；失败/未配置返回 null
 */
export async function generateCover(article) {
  if (!API_KEY) {
    return null; // 未配置：静默降级，交由 SVG 封面兜底
  }
  try {
    if (PROVIDER === 'dashscope') return await generateViaDashscope(article);
    try {
      return await generateViaOpenAI(article);
    } catch (primaryErr) {
      if (FALLBACK_DASHSCOPE_KEY) {
        console.warn(`[imageGenService] 主用生图失败，降级万相: ${String(primaryErr?.message).slice(0,100)}`);
        try { setActiveKey(FALLBACK_DASHSCOPE_KEY); return await generateViaDashscope(article); } finally { setActiveKey(null); }
      }
      throw primaryErr;
    }
  } catch (e) {
    console.warn(`[imageGenService] 生图失败（降级无图）: ${e?.message || e}`);
    return null;
  }
}

// ── 后端 A：OpenAI 兼容 images/generations ──
async function generateViaOpenAI(article) {
  const prompt = buildPrompt(article);
  const resp = await fetch(`${OPENAI_BASE_URL.replace(/\/+$/, '')}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${activeKey()}`,
    },
    body: JSON.stringify({
      model: MODEL,
      prompt,
      n: 1,
      size: SIZE.replace(/\*/g, 'x'),
      response_format: 'b64_json',
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`image_api_${resp.status}: ${body.slice(0, 200)}`);
  }
  const data = await resp.json();
  const item = data?.data?.[0];
  if (!item) throw new Error('image_api_empty');

  let bytes;
  if (item.b64_json) {
    bytes = Buffer.from(item.b64_json, 'base64');
  } else if (item.url) {
    const imgResp = await fetch(item.url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!imgResp.ok) throw new Error(`image_dl_${imgResp.status}`);
    bytes = Buffer.from(await imgResp.arrayBuffer());
  } else {
    throw new Error('image_api_no_data');
  }

  const mediaType = resp.headers.get('content-type')?.startsWith('image/')
    ? resp.headers.get('content-type')
    : sniffFromBytes(bytes);
  return saveCover(bytes, mediaType);
}

// ── 后端 B：DashScope 通义万相 原生异步接口 ──
async function generateViaDashscope(article) {
  const prompt = buildPrompt(article);
  const size = SIZE.replace(/x/g, '*'); // Wanx 原生尺寸用 1024*1024（星号）
  const synthUrl = `${DASHSCOPE_BASE_URL.replace(/\/+$/, '')}/api/v1/services/aigc/text2image/image-synthesis`;

  // 1) 提交异步生图任务
  const postResp = await fetch(synthUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${activeKey()}`,
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify({
      model: MODEL,
      input: { prompt },
      parameters: { size, n: 1 },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!postResp.ok) {
    const body = await postResp.text().catch(() => '');
    throw new Error(`dashscope_synth_${postResp.status}: ${body.slice(0, 200)}`);
  }
  const postJson = await postResp.json().catch(() => ({}));
  const taskId = postJson?.output?.task_id;
  if (!taskId) throw new Error(`dashscope_no_task_id: ${JSON.stringify(postJson).slice(0, 200)}`);

  // 2) 轮询任务结果（最长 ~120s）
  const taskUrl = `${DASHSCOPE_BASE_URL.replace(/\/+$/, '')}/api/v1/tasks/${taskId}`;
  const pollMs = Math.max(TIMEOUT_MS, 120000);
  const deadline = Date.now() + pollMs;
  let resultUrl = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await fetch(taskUrl, {
      headers: { Authorization: `Bearer ${activeKey()}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const sj = await s.json().catch(() => ({}));
    const st = sj?.output?.task_status;
    if (st === 'SUCCEEDED') {
      resultUrl = sj?.output?.results?.[0]?.url;
      break;
    }
    if (st === 'FAILED') {
      throw new Error(`dashscope_task_failed: ${JSON.stringify(sj?.output?.message || '').slice(0, 200)}`);
    }
  }
  if (!resultUrl) throw new Error('dashscope_poll_timeout');

  // 3) 下载生成的图片字节
  const imgResp = await fetch(resultUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!imgResp.ok) throw new Error(`dashscope_img_dl_${imgResp.status}`);
  const bytes = Buffer.from(await imgResp.arrayBuffer());
  const mediaType = imgResp.headers.get('content-type')?.startsWith('image/')
    ? imgResp.headers.get('content-type')
    : sniffFromBytes(bytes);
  return saveCover(bytes, mediaType);
}
