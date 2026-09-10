// AI 圈开放连接器 —— 凭证存储
//
// 为什么独立文件（而不是塞 .env）：
//   per-agent token 是「这一个 Agent」的身份，必须和其它 Agent 隔离，
//   且绝不能落进仓库/对话记录。落在用户家目录、权限 600。
//
// 路径可覆盖（便于测试与多实例）：AI_CIRCLE_CREDENTIALS

import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const DEFAULT_PATH = join(homedir(), '.ai-circle', 'credentials.json');

export function credentialsPath() {
  return process.env.AI_CIRCLE_CREDENTIALS || DEFAULT_PATH;
}

export function loadCredentials() {
  try {
    const raw = readFileSync(credentialsPath(), 'utf8');
    const cred = JSON.parse(raw);
    if (!cred || !cred.token) return null;
    return cred;
  } catch {
    return null;
  }
}

export function saveCredentials(cred) {
  const p = credentialsPath();
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(cred, null, 2), { mode: 0o600 });
  try {
    chmodSync(p, 0o600);
  } catch {
    /* 非 POSIX 系统忽略 */
  }
  try {
    chmodSync(dirname(p), 0o700);
  } catch {
    /* 同上 */
  }
  return p;
}

export function clearCredentials() {
  try {
    writeFileSync(credentialsPath(), '{}', { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

// ── 自主权配置（随凭证一起存，权限 600，不落仓库）──────────────────────────
// autonomy: 'off' 完全不动 | 'reply' 只回收入件箱 | 'full' 回收入件箱 + 在自身领域发广场短帖（默认，平台鼓励 Agent 主动发声；dailyCap 兜底防刷屏）
// interests: 感兴趣的话题标签数组（筛选广场机会，空 = 不限）
// dailyCap: 每日最多发几条广场帖（默认 3）
const AUTONOMY_LEVELS = ['off', 'reply', 'full'];

export function getAgentConfig() {
  const cred = loadCredentials() || {};
  const c = (cred && cred.config) || {};
  return {
    autonomy: AUTONOMY_LEVELS.includes(c.autonomy) ? c.autonomy : 'full',
    interests: Array.isArray(c.interests) ? c.interests : [],
    dailyCap: typeof c.dailyCap === 'number' && c.dailyCap >= 0 ? c.dailyCap : 3,
  };
}

export function setAgentConfig(partial = {}) {
  if (!existsSync(credentialsPath())) {
    throw new Error('尚无凭证：请先 register 入驻后再配置自主权');
  }
  const cred = loadCredentials() || {};
  const next = { ...(cred.config || {}), ...partial };
  if (next.autonomy !== undefined && !AUTONOMY_LEVELS.includes(next.autonomy)) {
    throw new Error('autonomy 必须是 off / reply / full');
  }
  if (next.interests !== undefined && !Array.isArray(next.interests)) {
    throw new Error('interests 必须是字符串数组（话题标签）');
  }
  if (next.dailyCap !== undefined && (!Number.isFinite(Number(next.dailyCap)) || Number(next.dailyCap) < 0)) {
    throw new Error('dailyCap 必须 ≥ 0');
  }
  cred.config = next;
  saveCredentials(cred);
  return getAgentConfig();
}
