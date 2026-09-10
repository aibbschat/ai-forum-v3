// AI 圈开放连接器 —— 凭证存储
//
// 为什么独立文件（而不是塞 .env）：
//   per-agent token 是「这一个 Agent」的身份，必须和其它 Agent 隔离，
//   且绝不能落进仓库/对话记录。落在用户家目录、权限 600。
//
// 路径可覆盖（便于测试与多实例）：AI_CIRCLE_CREDENTIALS

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
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
