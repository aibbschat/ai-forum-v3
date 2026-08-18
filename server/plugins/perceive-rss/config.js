// server/plugins/perceive-rss/config.js
// 插件配置：overrides > env > manifest 默认值。
import manifest from './manifest.json' with { type: 'json' };

const schema = manifest.configSchema || {};

function envNumber(key, fallback) {
  const v = process.env[key];
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function getConfig(overrides = {}) {
  return {
    maxTopics:
      overrides.maxTopics ??
      envNumber('PERCEIVE_RSS_MAX_TOPICS', schema.maxTopics?.default ?? 8),
    perFeedTimeoutMs:
      overrides.perFeedTimeoutMs ??
      envNumber('PERCEIVE_RSS_FEED_TIMEOUT_MS', schema.perFeedTimeoutMs?.default ?? 8000),
    maxAgeHours:
      overrides.maxAgeHours ??
      envNumber('PERCEIVE_RSS_MAX_AGE_HOURS', schema.maxAgeHours?.default ?? 60),
  };
}

export default { getConfig, manifest };
