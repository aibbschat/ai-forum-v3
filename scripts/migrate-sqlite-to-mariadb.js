#!/usr/bin/env node
// scripts/migrate-sqlite-to-mariadb.js
// 一次性数据迁移：SQLite（开发库 data/aiforum.db）→ MariaDB（生产库）。
// 幂等：逐表 INSERT IGNORE（已存在的行跳过），可重复执行。迁移前请先备份两端。
//
// 用法：
//   node scripts/migrate-sqlite-to-mariadb.js [--from ./data/aiforum.db] [--dry-run]
// 目标库配置走环境变量（与 server/database/mariadb.js 共用）：
//   MYSQL_HOST MYSQL_PORT MYSQL_USER MYSQL_PASSWORD MYSQL_DATABASE
//
// 前置：目标 MariaDB 已建库，且已用 server/database/schema.mariadb.sql 建好表。

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import mysql from 'mysql2/promise';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SCHEMA_MARIADB = resolve(ROOT, 'server/database/schema.mariadb.sql');

// 表迁移顺序（外键依赖在后）
const TABLES = [
  'users',
  'agent_profiles',
  'posts',
  'comments',
  'follows',
  'tags',
  'likes',
  'comment_likes',
  'memory_episodic',
  'memory_semantic',
  'memory_procedural',
];

function parseArgs(argv) {
  const opts = { from: './data/aiforum.db', dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--from') opts.from = argv[++i];
    if (argv[i] === '--dry-run') opts.dryRun = true;
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  const srcPath = resolve(ROOT, opts.from);
  const src = new Database(srcPath, { readonly: true });

  if (!opts.dryRun) {
    console.log(`[migrate] 连接 MariaDB: ${process.env.MYSQL_HOST || '127.0.0.1'}:${process.env.MYSQL_PORT || 3306}/${process.env.MYSQL_DATABASE || 'aiforum'}`);
  }
  const tgt = opts.dryRun
    ? null
    : await mysql.createConnection({
        host: process.env.MYSQL_HOST || '127.0.0.1',
        port: Number(process.env.MYSQL_PORT || 3306),
        user: process.env.MYSQL_USER || 'root',
        password: process.env.MYSQL_PASSWORD || '',
        database: process.env.MYSQL_DATABASE || 'aiforum',
        multipleStatements: true,
        dateStrings: true,
      });

  // 1) 建表（幂等：IF NOT EXISTS）
  if (!opts.dryRun) {
    const schema = readFileSync(SCHEMA_MARIADB, 'utf8');
    await tgt.query(schema);
    console.log('[migrate] schema.mariadb.sql 已执行（IF NOT EXISTS，幂等）');
  }

  // 2) 逐表搬迁数据
  let total = 0;
  for (const table of TABLES) {
    const rows = src.prepare(`SELECT * FROM ${table}`).all();
    if (!rows.length) {
      console.log(`[migrate] ${table}: 0 行（跳过）`);
      continue;
    }
    if (opts.dryRun) {
      console.log(`[migrate] [dry-run] ${table}: 将迁移 ${rows.length} 行`);
      total += rows.length;
      continue;
    }
    const cols = Object.keys(rows[0]);
    const placeholders = cols.map(() => '?').join(', ');
    const insert = `INSERT IGNORE INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`;
    // INSERT IGNORE 遇主键/唯一键冲突整行跳过 → 幂等
    for (const r of rows) {
      await tgt.execute(insert, cols.map((c) => (typeof r[c] === 'object' && r[c] !== null ? JSON.stringify(r[c]) : r[c])));
    }
    console.log(`[migrate] ${table}: ${rows.length} 行 ✅`);
    total += rows.length;
  }

  src.close();
  if (tgt) await tgt.end();
  console.log(`[migrate] 完成，共迁移 ${total} 行${opts.dryRun ? '（dry-run，未写目标库）' : ''}`);
}

main().catch((e) => {
  console.error('[migrate] 失败:', e.message);
  process.exit(1);
});
