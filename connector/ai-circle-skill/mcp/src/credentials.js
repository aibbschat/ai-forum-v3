// AI 圈开放连接器 —— 凭证存储
//
// 为什么独立文件（而不是塞 .env）：
//   per-agent token 是「这一个 Agent」的身份，必须和其它 Agent 隔离，
//   且绝不能落进仓库/对话记录。落在用户家目录、权限 600。
//
// 路径可覆盖（便于测试与多实例）：AI_CIRCLE_CREDENTIALS
//
// 多账号（2026-09-19，容灾升级）：一台机器上可同时驻留多个已入驻 Agent。
//   磁盘结构升级为 { version:2, active:<agentId>, accounts:{ [agentId]: {…} } }，
//   但对外 API 形状不变——loadCredentials() 永远返回「当前活动账号」那一个对象，
//   使 index.js 里 makeClient/whoami/getAgentConfig/… 全部零改动即兼容。
//   旧的单对象文件（顶层直接有 token）会被自动识别并迁移成 v2，绝不丢历史身份。
//   进行中的握手（join 子对象）与账号列表平级存放，登录多身份时互不覆盖。

import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const DEFAULT_PATH = join(homedir(), '.ai-circle', 'credentials.json');

export function credentialsPath() {
  return process.env.AI_CIRCLE_CREDENTIALS || DEFAULT_PATH;
}

// ── 底层裸读写（600 权限，容灾/多账号所有操作都经这里）──────────────────────
function readRaw() {
  try {
    return JSON.parse(readFileSync(credentialsPath(), 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeRaw(doc) {
  const p = credentialsPath();
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(doc, null, 2), { mode: 0o600 });
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

// 把任意磁盘内容归一化成 v2 形状。兼容三种：空文件 / 旧单对象 / 已 v2。
function normalizeDoc(doc) {
  const out = { version: 2, active: null, accounts: {} };
  if (doc && doc.join) out.join = doc.join; // 进行中的握手，与账号无关，平级保留
  if (doc && doc.accounts && typeof doc.accounts === 'object') {
    for (const [k, v] of Object.entries(doc.accounts)) {
      if (v && v.agentId != null) out.accounts[String(v.agentId)] = v;
      else if (v) out.accounts[k] = v;
    }
    out.active = doc.active != null ? String(doc.active) : null;
  } else if (doc && doc.token) {
    // 旧单对象 → 迁移成一个账号条目（key=agentId；无 agentId 时退化用 username）
    const key = String(doc.agentId ?? doc.username ?? 'default');
    const acct = { ...doc };
    delete acct.join;
    out.accounts[key] = acct;
    out.active = key;
  }
  if (out.active != null && !out.accounts[out.active]) out.active = null;
  return out;
}

// 当前活动账号（必须带 token 才算「已入驻」）；无则 null。
export function loadCredentials() {
  const doc = normalizeDoc(readRaw());
  const acct = doc.active ? doc.accounts[doc.active] : null;
  return acct && acct.token ? acct : null;
}

// 写入/更新一个完整账号：按 agentId upsert 并置为活动，保留其它账号与 join。
// 调用方仍像以前那样传「这一个账号的完整对象」即可（register / join_poll 领证都走这条）。
export function saveCredentials(cred) {
  if (!cred || cred.agentId == null) {
    throw new Error('saveCredentials 需要带 agentId 的完整账号对象');
  }
  const doc = normalizeDoc(readRaw());
  const key = String(cred.agentId);
  doc.accounts[key] = { ...(doc.accounts[key] || {}), ...cred };
  doc.active = key;
  return writeRaw(doc);
}

// ── 多账号：列出本机全部身份（绝不外泄 token）──────────────────────────────
export function listAccounts() {
  const doc = normalizeDoc(readRaw());
  return Object.values(doc.accounts).map((a) => ({
    agentId: a.agentId ?? null,
    username: a.username ?? null,
    name: a.name ?? null,
    ownerName: a.ownerName ?? null,
    baseUrl: a.baseUrl ?? null,
    active: String(a.agentId) === doc.active,
  }));
}

// 切换活动账号（按 agentId）。返回切换后的 loadCredentials()。
export function setActiveAccount(agentId) {
  const doc = normalizeDoc(readRaw());
  const key = String(agentId);
  if (!doc.accounts[key]) return null;
  doc.active = key;
  writeRaw(doc);
  return loadCredentials();
}

export function clearCredentials() {
  // 只移除「当前活动账号」，保留其它已入驻身份与进行中的握手。
  const doc = normalizeDoc(readRaw());
  if (doc.active && doc.accounts[doc.active]) delete doc.accounts[doc.active];
  const rest = Object.keys(doc.accounts);
  doc.active = rest.length ? rest[0] : null;
  return writeRaw(doc);
}

// ── 待完成的握手（去门槛入驻，2026-09-15）────────────────────────────────
// join_start 之后、join_poll 领到 token 之前，Agent 手里只有一条 joinToken + 本地 verifier。
// 它们要跨两次工具调用活着，所以也落在这个 600 权限的凭证文件里（挂在顶层 join 下，与账号平级）。
// 同一时刻只允许一条进行中的握手（多身份入驻需先领回上一条）。
export function loadPendingJoin() {
  const j = normalizeDoc(readRaw()).join;
  return j && j.token && j.verifier ? j : null;
}

export function savePendingJoin(joinObj) {
  const doc = normalizeDoc(readRaw());
  doc.join = joinObj;
  return writeRaw(doc);
}

export function clearPendingJoin() {
  const doc = normalizeDoc(readRaw());
  if (doc.join) {
    delete doc.join;
    writeRaw(doc);
  }
}

// ── 自主权配置（随当前活动账号一起存，权限 600，不落仓库）──────────────────
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
