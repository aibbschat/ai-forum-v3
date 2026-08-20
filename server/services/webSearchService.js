// server/services/webSearchService.js
// 豆包联网搜索（火山引擎 Search Infinity）直连服务。
//
// 端点（从火山官方 MCP server 反查得到）：
//   POST https://open.feedcoopapi.com/search_api/web_search
//   Authorization: Bearer <ASK_ECHO_SEARCH_INFINITY_API_KEY | 同一把 Ark/Agent Plan key>
//   Content-Type: application/json
//   body: { Query, SearchType:"web", Count, NeedSummary:true }
//
// 成本：个人用户每月 500 次免费，超出按官方定价；比走"让 LLM 自己联网"靠谱得多
// （后者在 ark-code-latest 这类代码模型上根本不会真联网，导致 chat 一直回【无资料】）。
//
// 失败安全：任何异常都返回 { sources: [] }，由上层决定是否降级到无网回答；
// 绝不抛错中断问答流程。

const DEFAULT_BASE_URL = 'https://open.feedcoopapi.com';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_COUNT = 6;

const KEY_ENVS = [
  'ASK_ECHO_SEARCH_INFINITY_API_KEY', // 官方 MCP 约定
  'WEB_SEARCH_API_KEY',               // 通用 web search 约定
  'LLM_VOLCENGINE_API_KEY',           // 本项目火山主 key（实测与 Search Infinity 通用）
  'DEEPSEEK_API_KEY',                 // 历史变量名（生产实际装的是火山 key）
  'VOLCES_API_KEY',
];

function resolveApiKey() {
  for (const k of KEY_ENVS) {
    const v = process.env[k];
    if (v && v.trim()) return v.trim();
  }
  return '';
}

/**
 * 搜索网页，返回标准化结果。
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.count=6]
 * @param {number} [opts.timeoutMs=15000]
 * @returns {Promise<{sources: Array<{url:string,title:string,snippet:string,publishedAt?:string}>, raw?:any}>}
 */
export async function searchWeb(query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return { sources: [] };
  if (q.length > 100) {
    // 接口硬限 100 字，超长直接截断（比抛错体验好）
    return searchWeb(q.slice(0, 100), opts);
  }

  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.warn('[webSearch] 未配置任何搜索 API key（检查 ASK_ECHO_SEARCH_INFINITY_API_KEY / LLM_VOLCENGINE_API_KEY）');
    return { sources: [] };
  }

  const count = Math.min(20, Math.max(1, Number(opts.count) || DEFAULT_COUNT));
  const timeoutMs = Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const baseURL = (process.env.WEB_SEARCH_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('web search timeout')), timeoutMs);

  let resp;
  try {
    resp = await fetch(`${baseURL}/search_api/web_search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'X-Traffic-Tag': 'ai_forum_chat',
      },
      body: JSON.stringify({
        Query: q,
        SearchType: 'web',
        Count: count,
        NeedSummary: true,
      }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    console.warn('[webSearch] 请求失败:', e?.message || e);
    return { sources: [] };
  }
  clearTimeout(timer);

  const text = await resp.text().catch(() => '');
  if (!resp.ok) {
    console.warn(`[webSearch] HTTP ${resp.status}: ${text.slice(0, 200)}`);
    return { sources: [] };
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.warn('[webSearch] 返回非 JSON:', text.slice(0, 200));
    return { sources: [] };
  }

  const result = data.Result || data.result || {};
  const items = Array.isArray(result.WebResults)
    ? result.WebResults
    : Array.isArray(result.ResultItems)
    ? result.ResultItems
    : Array.isArray(result.Items)
    ? result.Items
    : Array.isArray(data.ResultItems)
    ? data.ResultItems
    : Array.isArray(data.results)
    ? data.results
    : [];

  const sources = [];
  const seen = new Set();
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const url = String(it.Url || it.URL || it.url || '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push({
      url,
      title: String(it.Title || it.title || '').trim(),
      snippet: String(it.Snippet || it.snippet || it.Summary || it.summary || it.content || '').slice(0, 800),
      ...(it.PublishTime || it.publishTime ? { publishedAt: String(it.PublishTime || it.publishTime) } : {}),
    });
  }

  return { sources: sources.slice(0, count) };
}

/**
 * 把搜索结果拼成给 LLM 用的"站外资料"上下文文本。
 * @param {Array} sources
 * @returns {string}
 */
export function formatWebContext(sources) {
  if (!Array.isArray(sources) || !sources.length) return '';
  return sources
    .map((s, i) => {
      const bits = [`【网页${i + 1}】${s.title || '(无标题)'}`];
      if (s.siteName) bits.push(`来源：${s.siteName}`);
      if (s.snippet) bits.push(s.snippet);
      bits.push(`链接：${s.url}`);
      return bits.join('\n');
    })
    .join('\n\n---\n\n');
}
