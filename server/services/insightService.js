// server/services/insightService.js
// 「今日 AI 洞察」：取站内最新文章 → DeepSeek 凝练一句导语 → 6 小时缓存。
// 设计要点：
// - 缓存落 site_insight 单行表（id=1），避免每次首页加载都打 LLM（成本/延迟）。
// - 无 DEEPSEEK_API_KEY 或生成失败 → 回退默认文案，绝不抛错中断首页。
// - 双方言 upsert（Maria ON DUPLICATE KEY / SQLite ON CONFLICT）。

import { db, isMaria } from '../database/db.js';
import { listArticles } from './postService.js';

const DEEPSEEK_ENDPOINT = process.env.DEEPSEEK_ENDPOINT ?? 'https://api.deepseek.com/chat/completions';
const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';
const CACHE_HOURS = 6;
const FALLBACK = 'AI 圈驻站专家持续产出跨领域专业洞察，欢迎探索。';

/** 解析 DB 时间串为时间戳（兼容 Maria 'YYYY-MM-DD HH:MM:SS' 与 SQLite 'YYYY-MM-DD HH:MM:SS'）。 */
function toTs(v) {
  if (!v) return NaN;
  const s = String(v).trim();
  const ts = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z').getTime();
  return Number.isFinite(ts) ? ts : NaN;
}

/**
 * 取今日洞察。命中 6h 内缓存直接返回；否则现生成并写回。
 * @returns {{text:string, generatedAt?:string|null, cached:boolean}}
 */
export async function getTodayInsight() {
  const cached = await db.get(`SELECT content, generated_at FROM site_insight WHERE id = 1`);
  if (cached?.content) {
    const ts = toTs(cached.generated_at);
    if (Number.isFinite(ts) && Date.now() - ts < CACHE_HOURS * 3600 * 1000) {
      return { text: cached.content, generatedAt: cached.generated_at, cached: true };
    }
  }

  const generated = await generateInsight().catch(() => null);
  const text = generated || FALLBACK;

  const nowSql = isMaria ? 'NOW()' : "datetime('now')";
  const upsert = isMaria
    ? `ON DUPLICATE KEY UPDATE content = VALUES(content), generated_at = NOW()`
    : `ON CONFLICT(id) DO UPDATE SET content = excluded.content, generated_at = datetime('now')`;
  await db.run(
    `INSERT INTO site_insight (id, content, generated_at) VALUES (1, ?, ${nowSql}) ${upsert}`,
    [text]
  );

  return { text, generatedAt: null, cached: false };
}

/** 调用 DeepSeek 基于最新文章生成一句导语；任何异常返回 null（由调用方回退）。 */
async function generateInsight() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;

  const { articles } = await listArticles({ sort: 'latest', limit: 8 });
  if (!articles?.length) return null;

  const bullets = articles
    .map((a) => `- ${a.title}：${(a.excerpt || '').replace(/\s+/g, ' ').slice(0, 60)}`)
    .join('\n');

  const prompt =
    '你是 AI 圈的「今日洞察」编辑。根据以下站内文章标题与摘要，写一句不超过 40 字的导语，' +
    '点出今天的专业看点。\n要求：客观平实、不标题党、不用问句、不要出现“今日”二字。\n文章：\n' +
    bullets;

  let resp;
  try {
    resp = await fetch(DEEPSEEK_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: '你是严谨的中文专业内容编辑，只输出一句导语，不要解释、不要引号。' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 80,
        temperature: 0.6,
      }),
    });
  } catch {
    return null;
  }
  if (!resp.ok) return null;

  const data = await resp.json().catch(() => null);
  const raw = data?.choices?.[0]?.message?.content?.trim();
  if (!raw) return null;
  return raw.replace(/^["'「『]|["'」』]$/g, '');
}
