// server/plugins/perceive-web-search/index.js
// 感知源①：DeepSeek 联网检索（TECH-SPEC §7.3 接缝①「web_search 或 RSS」）。
// default export 实现 perceive 契约：返回 3~maxTopics 条 Topic。
//
// ⚠️ 实现路径（2026-08-15 真 key 实测修正）：
//   DeepSeek 标准 /chat/completions 的 tools 只支持 type:"function"，
//   tools:[{type:"web_search"}] 会 400（unknown variant `web_search`, expected `function`）。
//   官方原生联网搜索走 **Anthropic 兼容路由**（Claude Code 官方集成同款）：
//   POST https://api.deepseek.com/anthropic/v1/messages
//   tools:[{type:"web_search_20250305", name:"web_search"}] → 返回
//   server_tool_use（检索动作）+ web_search_tool_result（结果块）+ text（模型总结）。
//
// 铁律：本源【绝不抛错中断编排器】。任何网络/解析失败都返回空 topics，
//       由 service/perception/index.js 的 try/catch 做单源隔离（§16.8）。

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
  const title = raw?.title ?? raw?.name ?? raw?.page_title;
  if (!title) return null;
  const relevance =
    Number.isFinite(Number(raw?.relevance)) && raw.relevance >= 0 && raw.relevance <= 1
      ? Number(raw.relevance)
      : fallbackRelevance;
  const summary = raw?.summary ?? raw?.snippet ?? raw?.text ?? raw?.content;
  return {
    title: String(title),
    source: SOURCE,
    url: raw?.url ?? raw?.link ? String(raw.url ?? raw.link) : undefined,
    relevance,
    summary: summary ? String(summary).slice(0, 280) : undefined,
  };
}

async function callDeepSeekSearch(agent, date, cfg) {
  const domains = Array.isArray(agent?.domains) ? agent.domains : [];
  const dateStr = date instanceof Date ? date.toISOString().slice(0, 10) : String(date);
  const prompt =
    `你是论坛感知层。请基于今天（${dateStr}）的实时网络信息，围绕以下领域：` +
    `${domains.length ? domains.join('、') : '科技与社会'}，` +
    `检索最值得撰写文章的热点主题。\n请只返回一个 JSON 数组，每条形如 ` +
    `{"title":"主题标题","url":"来源链接(可选)","relevance":0.0~1.0,"summary":"一句话摘要"}，` +
    `共 3~${cfg.maxTopics} 条，按相关性降序。不要输出任何额外文字或解释。`;

  const resp = await fetch(`${cfg.endpoint}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!resp.ok) {
    throw new Error(`DeepSeek HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`);
  }

  const data = await resp.json();
  const blocks = Array.isArray(data?.content) ? data.content : [];

  // 路径 A：模型在最终 text 里按指令直接吐 JSON 数组
  const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
  const parsed = extractJsonArray(text);
  if (parsed && parsed.length) {
    return parsed.map((t, i) => toTopic(t, 0.9 - i * 0.1)).filter(Boolean);
  }

  // 路径 B：从 web_search_tool_result 块抽取原始检索结果（去重、截取 maxTopics）
  const results = [];
  for (const b of blocks) {
    if (b?.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      for (const c of b.content) {
        const t = toTopic(c, 0.85);
        if (t && !results.some((r) => r.title === t.title)) results.push(t);
      }
    }
  }
  return results.slice(0, cfg.maxTopics);
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
      return await callDeepSeekSearch(agent, date, cfg);
    } catch (e) {
      // 单源故障：返回空，绝不向上抛（编排器另有隔离层）
      console.error('[perceive-web-search] 调用失败，返回空 topics:', e?.message || e);
      return [];
    }
  },
};

export default plugin;
