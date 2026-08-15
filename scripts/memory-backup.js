// scripts/memory-backup.js —— 记忆三表导出（TECH-SPEC v2.3 §7.6.7 可备份可恢复）。
//
// 把指定（--agent <id>）或全部 AI Agent 的记忆三表（episodic / semantic / procedural）
// 导出为一个 JSON 文件，供每日备份与恢复演练（§7.6.8「记忆库可导出/恢复」）。
//
// 用法：
//   node scripts/memory-backup.js              # 导出全部 AI Agent 记忆
//   node scripts/memory-backup.js --agent 3    # 只导出指定 Agent（users.id）
//
// 输出：backups/memory-YYYYMMDD-HHMMSS.json（UTC 时间戳），含每 Agent 行数统计。
// 退出码：0=成功  1=数据错误（Agent 不存在 / 导出失败）  2=用法错误（--agent 非法）。
//
// 依赖：Node >= 20（顶层 await）。DB 路径取自 config（env DB_PATH，默认 data/aiforum.db），
// 仓库根 .env 可覆盖。只读导出，不改任何数据。

import dotenv from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
// 先加载根 .env 再动态导入 connection，确保 DB_PATH / 环境变量生效。
dotenv.config({ path: join(ROOT, '.env') });

const { getDb, closeDb } = await import('../server/database/connection.js');

// ── 参数解析 ────────────────────────────────────────────────────────
function parseArgs(argv) {
  const agentIndex = argv.indexOf('--agent');
  if (agentIndex < 0) return { agentId: null };
  const raw = argv[agentIndex + 1];
  if (!raw || !/^\d+$/.test(raw)) {
    console.error(`用法错误：--agent 需要正整数 Agent id（收到 "${raw ?? ''}"）`);
    process.exit(2);
  }
  return { agentId: Number(raw) };
}

const { agentId } = parseArgs(process.argv.slice(2));

// ── 时间戳：YYYYMMDD-HHMMSS（UTC） ──────────────────────────────────
function utcStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

const THREE_TABLES = ['memory_episodic', 'memory_semantic', 'memory_procedural'];

function dumpAgent(db, id, username) {
  const counts = {};
  const data = {};
  for (const table of THREE_TABLES) {
    const rows = db
      .prepare(`SELECT * FROM ${table} WHERE agent_id = ? ORDER BY id ASC`)
      .all(id);
    counts[table] = rows.length;
    data[table] = rows;
  }
  return { agentId: id, username, counts, ...data };
}

// ── 主体 ────────────────────────────────────────────────────────────
let db;
try {
  db = getDb();

  // 选取目标 Agent：--agent 指定单个，否则全部 AI 用户。
  let targets;
  if (agentId) {
    const row = db
      .prepare(`SELECT id, username, user_type FROM users WHERE id = ?`)
      .get(agentId);
    if (!row) {
      console.error(`数据错误：Agent id=${agentId} 不存在（users 表无此 id）`);
      process.exit(1);
    }
    if (row.user_type !== 'ai') {
      console.error(`数据错误：id=${agentId} 是 ${row.user_type} 用户，不是 AI Agent`);
      process.exit(1);
    }
    targets = [{ id: row.id, username: row.username }];
  } else {
    targets = db
      .prepare(`SELECT id, username FROM users WHERE user_type = 'ai' ORDER BY id ASC`)
      .all();
  }
  if (!targets.length) {
    console.error('数据错误：没有可导出的 AI Agent（users 表为空？）');
    process.exit(1);
  }

  const agents = targets.map((t) => dumpAgent(db, t.id, t.username));

  const backup = {
    app: 'ai-forum-v3',
    spec: 'TECH-SPEC v2.3 §7.6.7',
    exportedAt: new Date().toISOString(),
    agents,
  };

  const outDir = join(ROOT, 'backups');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `memory-${utcStamp(new Date())}.json`);
  writeFileSync(outFile, JSON.stringify(backup, null, 2), 'utf8');

  // 汇总输出
  const grand = { memory_episodic: 0, memory_semantic: 0, memory_procedural: 0 };
  for (const a of agents) {
    for (const t of THREE_TABLES) grand[t] += a.counts[t];
  }
  console.log(`记忆已导出：${outFile}`);
  console.log(`Agent 数：${agents.length}`);
  for (const a of agents) {
    console.log(
      `  agent=${a.agentId} (${a.username})  episodic=${a.counts.memory_episodic} ` +
        `semantic=${a.counts.memory_semantic} procedural=${a.counts.memory_procedural}`
    );
  }
  console.log(
    `合计：episodic=${grand.memory_episodic} semantic=${grand.memory_semantic} ` +
      `procedural=${grand.memory_procedural}`
  );
  process.exitCode = 0;
} catch (err) {
  console.error(`备份失败：${err.message}`);
  process.exitCode = 1;
} finally {
  try {
    closeDb();
  } catch {}
}
