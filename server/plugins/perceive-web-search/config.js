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
    model: overrides.model ?? process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
    endpoint:
      overrides.endpoint ??
      process.env.DEEPSEEK_ENDPOINT ??
      'https://api.deepseek.com/chat/completions',
  };
}

export default { getConfig, manifest };
