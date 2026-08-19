/**
 * 豆包联网搜索 DSH Provider
 *
 * 直连火山引擎"联网搜索 API（Search Infinity）"官方 HTTP 端点，不依赖任何 Bot/Ark chat
 * completions，也不通过 Python MCP server 子进程（避免 uvx 冷启动 + Python 运行时）。
 *
 * 端点（从火山官方 MCP server 源码反查得到，见
 * https://github.com/volcengine/mcp-server/tree/main/server/mcp_server_askecho_search_infinity ）：
 *   POST https://open.feedcoopapi.com/search_api/web_search
 *   Authorization: Bearer <ASK_ECHO_SEARCH_INFINITY_API_KEY>
 *   Content-Type: application/json
 *   X-Traffic-Tag: dsh_web_search_doubao
 *   body: { Query, SearchType:"web", Count, Filter?:{...}, TimeRange?, ... }
 *
 * 成本：个人用户每月 500 次免费，超出后按官方定价（当前约 0.03 元/次量级，以控制台为准）；
 *       相比 dsh-web-search-deepseek 每次消耗一轮 Anthropic Messages model turn，成本约 1/20。
 *
 * 鉴权：
 *   - apiKey 配置项可写死（不推荐）
 *   - 否则按 apiKeyEnv（默认 ASK_ECHO_SEARCH_INFINITY_API_KEY，与火山官方 MCP 一致）
 *     到 DSH credentials / 环境变量取；官方 Skill 约定的 WEB_SEARCH_API_KEY、
 *     以及旧名 VOLCES_API_KEY 都作为 fallback（同一把 key 在多个产品名间通用）
 *
 * 配置字段（cordis.yml）：
 *   apiKey / apiKeyEnv / baseURL / maxResults / timeoutMs / authLevel / timeRange / queryRewrite
 *
 * 结果字段映射到 DSH web seam 的标准 Source 结构：
 *   { url, title, snippet, publishedAt }
 */

import { WebError } from '@deepseek-ai/dsh-web';

const PROVIDER_ID = 'doubao';
const DEFAULT_BASE_URL = 'https://open.feedcoopapi.com';
const DEFAULT_API_KEY_ENV = 'ASK_ECHO_SEARCH_INFINITY_API_KEY';
// 兼容：官方 Skill 约定的 WEB_SEARCH_API_KEY，以及历史部署用过的 VOLCES_API_KEY；
// 同一把 Ark/Agent Plan key 在这几个产品名之间通用。
const FALLBACK_API_KEY_ENVS = ['WEB_SEARCH_API_KEY', 'VOLCES_API_KEY'];
const DEFAULT_MAX_RESULTS = 8;
const DEFAULT_TIMEOUT_MS = 20000;

export class DoubaoSearchProvider {
  constructor(options = {}) {
    this.options = options;
  }

  get id() {
    return PROVIDER_ID;
  }

  async _resolveApiKey() {
    const o = this.options || {};
    if (typeof o.apiKey === 'string' && o.apiKey.length > 0) return o.apiKey;
    if (typeof o.resolveApiKey === 'function') {
      const k = await o.resolveApiKey();
      if (k) return k;
    }
    return undefined;
  }

  async available() {
    try {
      return Boolean(await this._resolveApiKey());
    } catch {
      return false;
    }
  }

  async search(request, signal) {
    const query = String(request?.query || '').trim();
    if (!query) throw new WebError('Doubao search: empty query', 'WEB_PROVIDER_ERROR');
    if (query.length > 100) {
      throw new WebError('Doubao search: query 超过 100 字符上限', 'WEB_PROVIDER_ERROR');
    }

    const apiKey = await this._resolveApiKey();
    if (!apiKey) {
      throw new WebError(
        `Doubao search has no API key for "${this.options?.apiKeyEnv || DEFAULT_API_KEY_ENV}"`,
        'WEB_PROVIDER_CREDENTIAL_MISSING'
      );
    }

    const o = this.options || {};
    const baseURL = (o.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const count = Math.min(50, Math.max(1, Number(o.maxResults) || DEFAULT_MAX_RESULTS));
    const timeoutMs = Number(o.timeoutMs) || DEFAULT_TIMEOUT_MS;

    const body = {
      Query: query,
      SearchType: 'web',
      Count: count,
      // 与火山官方 web_search.py 对齐：web 搜索默认请求摘要，丰富 Summary 字段
      NeedSummary: true,
    };
    // 可选过滤器
    const filter = {};
    if (o.authLevel === 1) filter.AuthInfoLevel = 1;
    if (o.needContent === true) filter.NeedContent = true;
    if (o.needUrl === false) filter.NeedUrl = false;
    if (o.sites) filter.Sites = String(o.sites);
    if (o.blockHosts) filter.BlockHosts = String(o.blockHosts);
    if (o.industry) filter.Industry = String(o.industry);
    if (Object.keys(filter).length) body.Filter = filter;
    if (o.timeRange) body.TimeRange = String(o.timeRange);
    if (o.queryRewrite !== undefined) body.QueryControl = { QueryRewrite: !!o.queryRewrite };
    if (o.contentFormats) body.ContentFormats = String(o.contentFormats);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Doubao search timeout')), timeoutMs);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        throw new WebError('Doubao search aborted', 'WEB_ABORTED');
      }
      signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }

    let resp;
    try {
      resp = await fetch(`${baseURL}/search_api/web_search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'X-Traffic-Tag': 'dsh_web_search_doubao',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (controller.signal.aborted) {
        throw new WebError('Doubao search aborted', 'WEB_ABORTED');
      }
      throw new WebError(`Doubao search request failed: ${e.message}`, 'WEB_PROVIDER_ERROR', { cause: e });
    }
    clearTimeout(timer);

    const text = await resp.text().catch(() => '');
    if (!resp.ok) {
      // 401/10403 等鉴权错误给出明确诊断
      const code = text.length < 200 ? text : `${text.slice(0, 200)}…`;
      if (resp.status === 401 || resp.status === 403 || /10403|invalid_api_key/i.test(text)) {
        throw new WebError(
          `Doubao search auth failed (HTTP ${resp.status}): ${code}。请确认 API Key 来自火山引擎"联网搜索"控制台（与 Ark Coding Plan 的 key 可能不通用）。`,
          'WEB_PROVIDER_CREDENTIAL_MISSING'
        );
      }
      throw new WebError(`Doubao API error (HTTP ${resp.status}): ${code}`, 'WEB_PROVIDER_ERROR');
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new WebError(`Doubao returned non-JSON: ${text.slice(0, 200)}`, 'WEB_PROVIDER_ERROR');
    }

    // 火山返回结构（实测 2026-08）：
    //   { ResponseMetadata, Result: { ResultCount, WebResults: [ {Id, Title, Url, Snippet, Summary, SiteName, PublishTime} ] } }
    // 兼容其它潜在位置：ResultItems / results / data
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
      : Array.isArray(data.data)
      ? data.data
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
        snippet: String(
          it.Snippet || it.snippet || it.Summary || it.summary || it.content || ''
        ).slice(0, 600),
        ...(it.PublishTime || it.publishTime || it.publishedAt
          ? { publishedAt: String(it.PublishTime || it.publishTime || it.publishedAt) }
          : {}),
      });
    }

    if (sources.length === 0) {
      // 不静默返回空：让 Agent 知道搜索通路有问题，不要把"无结果"当作事实
      const code = data.Code || data.code || data.ResponseMetadata?.Error?.Code;
      const msg = data.Message || data.message || data.ResponseMetadata?.Error?.Message;
      if (code || msg) {
        throw new WebError(`Doubao search returned no items: ${code || ''} ${msg || ''}`.trim(), 'WEB_PROVIDER_ERROR');
      }
      throw new WebError('Doubao search returned 0 items (query may need simplification or time range adjust)', 'WEB_PROVIDER_ERROR');
    }

    return {
      sources: sources.slice(0, count),
      truncated: sources.length >= count,
    };
  }
}

// ── DSH Cordis 插件入口 ──

export const name = 'web-search-doubao';
export const inject = ['web'];

export function apply(ctx, config = {}) {
  const apiKeyEnv = config.apiKeyEnv || DEFAULT_API_KEY_ENV;

  const resolveApiKey = async () => {
    // 1) DSH credentials service
    try {
      const creds = ctx.get('credentials');
      if (creds) {
        const r = await creds.resolve(apiKeyEnv);
        if (r?.value) return r.value;
        // 兼容旧 key 名
        for (const fb of FALLBACK_API_KEY_ENVS) {
          const r2 = await creds.resolve(fb);
          if (r2?.value) return r2.value;
        }
      }
    } catch {}
    // 2) 启动环境变量
    if (typeof process !== 'undefined' && process.env) {
      if (process.env[apiKeyEnv]) return process.env[apiKeyEnv];
      for (const fb of FALLBACK_API_KEY_ENVS) {
        if (process.env[fb]) return process.env[fb];
      }
    }
    return undefined;
  };

  const provider = new DoubaoSearchProvider({
    apiKey: typeof config.apiKey === 'string' ? config.apiKey : undefined,
    apiKeyEnv,
    resolveApiKey,
    baseURL: config.baseURL,
    maxResults: config.maxResults,
    timeoutMs: config.timeoutMs,
    authLevel: config.authLevel,
    timeRange: config.timeRange,
    queryRewrite: config.queryRewrite,
    needContent: config.needContent,
    needUrl: config.needUrl,
    sites: config.sites,
    blockHosts: config.blockHosts,
    industry: config.industry,
    contentFormats: config.contentFormats,
  });

  ctx.web.registerSearchProvider(provider);
  ctx.logger?.info(`[web-search-doubao] provider registered (id=${PROVIDER_ID}, env=${apiKeyEnv})`);
}

export default { name, inject, apply };
