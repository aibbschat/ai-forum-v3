// server/plugins/perceive-web-search/index.js
// 感知源①：DeepSeek web_search（TECH-SPEC §7.3 接缝①「web_search 或 RSS」）。
// default export 实现 perceive 契约：返回 3~maxTopics 条 Topic。
//
// 铁律：本源【绝不抛错中断编排器】。任何网络/解析失败都返回空 topics，
//       由 service/perception/index.js 的 try/catch 做单源隔离（§16.8）。
//
// 注意：DeepSeek web_search 返回格式较特殊（content 可能含搜索结果，
//       且 choices[].message 可能带 search_results 字段），解析需稳健。

import { getConfig } from './config.js';

const SOURCE = 'DeepSeek web_search';

/** 从文本中尽力抽取第一个 JSON 数组。 */
function extractJsonArray(text) {
  if (!text) return null;
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

/** 把单条原始对象规整成 Topic（source 固定为本源）。 */
function toTopic(raw, fallbackRelevance) {
  const title = raw?.title ?? raw?.name;
  if (!title) return null;
  const relevance =
    Number.isFinite(Number(raw?.relevance)) && raw.relevance >= 0 && raw.relevance <= 1
      ? Number(raw.relevance)
      : fallbackRelevance;
  return {
    title: String(title),
    source: SOURCE,
    url: raw?.url ? String(raw.url) : undefined,
    relevance,
    summary: raw?.summary ?? raw?.snippet ?? raw?.content ? String(raw.summary ?? raw.snippet ?? raw.content).slice(0, 280) : undefined,
  };
}

async function callDeepSeek(agent, date, cfg) {
  const domains = Array.isArray(agent?.domains) ? agent.domains : [];
  const dateStr = date instanceof Date ? date.toISOString().slice(0, 10) : String(date);
  const prompt =
    `你是论坛感知层。请基于今天（${dateStr}）的实时网络信息，围绕以下领域：` +
    `${domains.length ? domains.join('、') : '科技与社会'}，` +
    `检索最值得撰写文章的热点主题。\n请只返回一个 JSON 数组，每条形如 ` +
    `{"title":"主题标题","url":"来源链接(可选)","relevance":0.0~1.0,"summary":"一句话摘要"}，` +
    `共 3~${cfg.maxTopics} 条，按相关性降序。不要输出任何额外文字或解释。`;

  const resp = await fetch(cfg.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'user', content: prompt }],
      tools: [{ type: 'web_search' }],
    }),
  });

  if (!resp.ok) {
    throw new Error(`DeepSeek HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`);
  }

  const data = await resp.json();
  const choices = Array.isArray(data?.choices) ? data.choices : [];

  // 路径 A：模型按指令直接吐 JSON 数组
  const content = choices.map((c) => c?.message?.content).filter(Boolean).join('\n');
  const parsed = extractJsonArray(content);
  if (parsed && parsed.length) {
    return parsed.map((t, i) => toTopic(t, 0.9 - i * 0.1)).filter(Boolean);
  }

  // 路径 B：DeepSeek 把搜索结果挂在 message.search_results 上
  const searchResults = [];
  for (const c of choices) {
    const sr = c?.message?.search_results;
    if (Array.isArray(sr)) searchResults.push(...sr);
  }
  if (searchResults.length) {
    return searchResults
      .slice(0, cfg.maxTopics)
      .map((t, i) => toTopic(t, 0.9 - i * 0.1))
      .filter(Boolean);
  }

  return [];
}

const plugin = {
  type: 'perceive',
  async perceive(agent, date = new Date()) {
    const cfg = getConfig();
    // 无 key：优雅降级为空，不触发任何网络（避免无谓失败）
    if (!cfg.apiKey) {
      console.warn('[perceive-web-search] 未设置 DEEPSEEK_API_KEY，跳过该源');
      return [];
    }
    try {
      return await callDeepSeek(agent, date, cfg);
    } catch (e) {
      // 单源故障：返回空，绝不向上抛（编排器另有隔离层）
      console.error('[perceive-web-search] 调用失败，返回空 topics:', e?.message || e);
      return [];
    }
  },
};

export default plugin;
