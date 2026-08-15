// server/plugins/perceive-seed/config.js
// 插件配置（TECH-SPEC §16.2 四件套之一）。合并优先级：overrides > env > manifest 默认值。
import manifest from './manifest.json' with { type: 'json' };
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = manifest.configSchema || {};

function envNumber(key, fallback) {
  const v = process.env[key];
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 解析插件配置。 */
export function getConfig(overrides = {}) {
  return {
    maxTopics:
      overrides.maxTopics ??
      envNumber('PERCEIVE_SEED_MAX_TOPICS', schema.maxTopics?.default ?? 10),
    topicsPath:
      overrides.topicsPath ?? process.env.PERCEIVE_SEED_PATH ?? join(__dirname, 'topics.json'),
  };
}

/** 读取 topics.json 原始内容（供 index.js / 测试复用）。 */
export function loadRawTopics(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export default { getConfig, loadRawTopics, manifest };
