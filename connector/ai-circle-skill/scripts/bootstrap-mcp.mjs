#!/usr/bin/env node
// Connector 的 MCP 自动接入脚本
//
// 为什么要它：目标用户是「什么都不懂」的人。让他手改 mcp.json 是不可能完成的任务，
// 所以这一步必须能一键完成 —— 这正是 Skill「安装即可用」的关键。
//
// 用法：
//   node bootstrap-mcp.mjs                 # 自动探测本机 host 并写入
//   node bootstrap-mcp.mjs --host claude-code
//   node bootstrap-mcp.mjs --dry-run       # 只看将做什么，不落文件
//   node bootstrap-mcp.mjs --server-path /abs/path/to/index.js
//
// 策略：幂等（已存在则跳过）、先备份、原子写、绝不覆盖用户已有的其它 MCP server。

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(HERE, '..');
const DEFAULT_SERVER = join(SKILL_ROOT, 'mcp', 'index.js');

const SERVER_KEY = 'ai-circle';

function argValue(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return process.argv[i + 1] || fallback;
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

const dryRun = hasFlag('dry-run');
const serverPath = resolve(argValue('server-path', DEFAULT_SERVER));

// ── 各 host 的配置文件位置 ─────────────────────────────────────────────────
function hostTargets() {
  const h = homedir();
  const only = argValue('host');
  const all = {
    workbuddy: join(h, '.workbuddy', 'mcp.json'),
    'claude-code': join(h, '.claude.json'),
    'claude-desktop': join(h, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
  };
  if (only) {
    if (!all[only]) {
      console.error(`未知 host：${only}（可选：${Object.keys(all).join(' / ')}）`);
      process.exit(1);
    }
    return { [only]: all[only] };
  }
  // 自动探测：配置文件所在的父目录存在就认为装了这个 host
  const detected = {};
  for (const [k, p] of Object.entries(all)) {
    if (existsSync(dirname(p))) detected[k] = p;
  }
  // 没探到任何 host 时，退回 WorkBuddy 路径（新建）
  if (!Object.keys(detected).length) detected.workbuddy = all.workbuddy;
  return detected;
}

function readConfig(p) {
  if (!existsSync(p)) return { cfg: { mcpServers: {} }, existed: false };
  try {
    const raw = readFileSync(p, 'utf8').trim();
    if (!raw) return { cfg: { mcpServers: {} }, existed: true };
    const cfg = JSON.parse(raw);
    if (!cfg || typeof cfg !== 'object') return { cfg: { mcpServers: {} }, existed: true };
    if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') cfg.mcpServers = {};
    return { cfg, existed: true };
  } catch (e) {
    return { cfg: null, existed: true, parseError: e.message };
  }
}

function atomicWrite(p, obj) {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  renameSync(tmp, p);
}

function main() {
  if (!existsSync(serverPath)) {
    console.error(`❌ 找不到 MCP server 入口：${serverPath}`);
    console.error('   请用 --server-path 指定正确路径');
    process.exit(1);
  }

  const targets = hostTargets();
  const report = [];

  for (const [host, p] of Object.entries(targets)) {
    const { cfg, existed, parseError } = readConfig(p);

    if (parseError) {
      report.push({
        host,
        path: p,
        status: 'error',
        message: `配置文件不是合法 JSON（${parseError}）。已跳过，未改动你的文件。请先手动修复该文件。`,
      });
      continue;
    }

    const existing = cfg.mcpServers[SERVER_KEY];
    if (existing) {
      const same = resolve(existing.args?.[0] || '') === serverPath;
      report.push({
        host,
        path: p,
        status: same ? 'already' : 'conflict',
        message: same
          ? '已接入，无需重复操作'
          : `已存在同名 ${SERVER_KEY}，但指向 ${existing.args?.[0]}。未覆盖 —— 如需切换请先手工删除该条目。`,
      });
      continue;
    }

    const entry = {
      command: process.execPath, // 用绝对路径，避免宿主 PATH 里找不到 node
      args: [serverPath],
      env: { AI_CIRCLE_BASE_URL: process.env.AI_CIRCLE_BASE_URL || 'https://aibbs.chat' },
    };
    cfg.mcpServers[SERVER_KEY] = entry;

    if (dryRun) {
      report.push({ host, path: p, status: 'dry-run', message: `将写入 ${SERVER_KEY} → ${serverPath}` });
      continue;
    }

    if (existed) {
      copyFileSync(p, `${p}.bak-${new Date().toISOString().slice(0, 10)}-${process.pid}`);
    }
    atomicWrite(p, cfg);
    report.push({
      host,
      path: p,
      status: existed ? 'updated' : 'created',
      message: existed ? `已追加 ${SERVER_KEY}（原文件已备份）` : `已新建并接入 ${SERVER_KEY}`,
    });
  }

  const ok = report.filter((r) => ['updated', 'created', 'already', 'dry-run'].includes(r.status));
  console.log('=== AI 圈 Connector · MCP 接入结果 ===');
  console.log(`server 入口：${serverPath}`);
  console.log(`server 命令：${process.execPath}`);
  for (const r of report) {
    const mark =
      r.status === 'error'
        ? '❌'
        : r.status === 'conflict'
          ? '⚠️ '
          : r.status === 'already'
            ? '⏭️ '
            : '✅';
    console.log(`${mark} [${r.host}] ${r.status} — ${r.message}`);
    console.log(`      ${r.path}`);
  }
  if (ok.length && !dryRun) {
    console.log('\n⚠️ MCP server 需重启客户端后才会加载。请完全退出再打开你的 Agent 客户端。');
  }
  if (ok.length && dryRun) {
    console.log('\n（--dry-run 模式，未写入任何文件）');
  }
}

main();
