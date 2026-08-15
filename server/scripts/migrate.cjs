#!/usr/bin/env node
/**
 * migrate.js — 旧 AI圈(ai-forum-prod) → AI圈 v3(ai-forum-v3) 数据迁移
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 重要前提与设计取舍（2026-08 现场勘验）：
 *   1) 本机无旧库 .db 文件；旧 ai-forum-prod 的 schema（debate_rooms /
 *      ai_evolution_logs / inspirations / expert_chat_messages …）与 v3 论坛
 *      模型（users / posts / comments / agent_profiles / follows / likes）
 *      并不对应——旧站不是同构论坛，而是另一套产品。
 *   2) 旧站内容按长期记忆为「规则引擎批量生成、96% 低质闲聊」，全量搬运
 *      会污染 v3「活智能体、可溯源(provenance)」的新站哲学。
 * → 因此本脚本是【参数化、防御式、默认空跑】的迁移骨架：等服务器导出真实
 *   旧库后，用 --from 指向它，按需扩写 MAPPINGS 即可；绝不盲迁。
 * ───────────────────────────────────────────────────────────────────────────
 *
 * 用法：
 *   node migrate.js --from <old.db> --to <new.db> [--check] [--apply]
 *     --from   旧库路径（导出自服务器 /var/www/ai-forum/prod 的 sqlite）
 *     --to     新库路径（默认 data/aiforum.db）
 *     --check  只报告两库表清单与行数 + 可迁移列，不改写
 *     --apply  真正写入（缺省为 dry-run，只打印会做什么）
 *
 * 策略：对每张 (旧表→新表)，取两表【列名交集】做 INSERT OR IGNORE。
 *      这样无论旧 schema 怎么变，都只安全拷贝能对得上的字段，绝不强塞。
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// 旧表 → 新表 的候选映射（真实旧库到位后按需增删）
const MAPPINGS = [
  { old: 'users',        new: 'users' },
  { old: 'posts',        new: 'posts' },
  { old: 'articles',     new: 'posts' },
  { old: 'comments',     new: 'comments' },
  { old: 'user_follows', new: 'follows' },
  { old: 'likes',        new: 'likes' },
];

function cols(db, table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
  } catch {
    return [];
  }
}

function rowCount(db, table) {
  try {
    return db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const a = { from: null, to: null, check: false, apply: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--from') a.from = argv[++i];
    else if (k === '--to') a.to = argv[++i];
    else if (k === '--check') a.check = true;
    else if (k === '--apply') a.apply = true;
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.from || !args.to) {
    console.error('用法: node migrate.js --from <old.db> --to <new.db> [--check] [--apply]');
    process.exit(2);
  }
  if (!fs.existsSync(args.from)) {
    console.error(`旧库不存在: ${args.from}`);
    process.exit(3);
  }

  const oldDb = new Database(args.from, { readonly: true });
  const newDb = new Database(args.to, { readonly: !args.apply });

  console.log(`\n旧库: ${args.from}`);
  console.log(`新库: ${args.to}`);
  console.log(`模式: ${args.apply ? 'APPLY（真实写入）' : 'DRY-RUN（只报告）'}\n`);

  const oldTables = oldDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  const newTables = newDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  console.log('─ 旧库表（名 / 行数）─');
  for (const t of oldTables) console.log(`   ${t.padEnd(24)} ${rowCount(oldDb, t)}`);
  console.log('─ 新库表（名 / 行数）─');
  for (const t of newTables) console.log(`   ${t.padEnd(24)} ${rowCount(newDb, t)}`);
  console.log('');

  let totalCopied = 0;
  for (const m of MAPPINGS) {
    const old = m.old;
    const now = m.new;
    const oc = cols(oldDb, old);
    const nc = cols(newDb, now);
    if (!oc.length || !nc.length) {
      console.log(`⤬ 跳过 ${old} → ${now}：旧表或新表不存在`);
      continue;
    }
    const common = oc.filter((c) => nc.includes(c));
    if (!common.length) {
      console.log(`⤬ 跳过 ${old} → ${now}：无共同列`);
      continue;
    }
    const rows = oldDb.prepare(`SELECT * FROM ${old}`).all();
    if (!args.apply) {
      console.log(
        `[dry-run] 将拷贝 ${rows.length} 行 ${old} → ${now}（共同列: ${common.join(', ')}）`
      );
      continue;
    }
    const placeholders = common.map(() => '?').join(',');
    const stmt = newDb.prepare(
      `INSERT OR IGNORE INTO ${now} (${common.join(',')}) VALUES (${placeholders})`
    );
    const run = newDb.transaction(() => {
      for (const r of rows) stmt.run(common.map((c) => r[c]));
    });
    run();
    totalCopied += rows.length;
    console.log(`✔ 处理 ${old} → ${now}：${rows.length} 行（共同列 ${common.length} 个）`);
  }

  console.log(`\n完成。${args.apply ? `共处理 ${totalCopied} 行` : '（dry-run，未写入）'}`);
  oldDb.close();
  newDb.close();
}

main();
