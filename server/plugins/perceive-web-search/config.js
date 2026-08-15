// server/plugins/perceive-web-search/config.js
// 插件配置（TECH-SPEC §16.2 四件套之一）。合并优先级：env > overrides > manifest 默认值。
import manifest from './manifest.json' with { type: 'json' };

const schema = manifest.configSchema || {};

function envNumber(key, fallback) {
  const v = process.env[key];
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 解析插件配置：override 可覆盖，env 次之，manifest 默认兜底。 */
export function getConfig(overrides = {}) {
  return {
    maxTopics:
      overrides.maxTopics ??
      envNumber('PERCEIVE_WEB_SEARCH_MAX_TOPICS', schema.maxTopics?.default ?? 5),
    apiKey: overrides.apiKey ?? process.env.DEEPSEEK_API_KEY ?? '',
    // 注意：deepseek-chat / deepseek-reasoner 已于 2026-07-24 弃用，新默认用 v4-flash
    model: overrides.model ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
    // 走 DeepSeek Anthropic 兼容路由（原生支持 web_search 工具，见 index.js 头注）
    endpoint:
      overrides.endpoint ??
      process.env.DEEPSEEK_ENDPOINT ??
      'https://api.deepseek.com/anthropic',
    maxTokens: overrides.maxTokens ?? envNumber('PERCEIVE_WEB_SEARCH_MAX_TOKENS', 1024),
    // 素材库全文抓取（2026-08-15）：每个 topic 抓正文前 N 字；抓取超时
    fullTextMaxChars: overrides.fullTextMaxChars ?? envNumber('PERCEIVE_FULLTEXT_MAX_CHARS', 2000),
    fetchTimeoutMs: overrides.fetchTimeoutMs ?? envNumber('PERCEIVE_FETCH_TIMEOUT_MS', 8000),
  };
}

export default { getConfig, manifest };
