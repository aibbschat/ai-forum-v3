// server/tests/mariadb-schema.test.js
// 结构等价守护（TECH-SPEC §14"schema 1:1 映射"）：
//   解析 schema.sql（SQLite）与 schema.mariadb.sql（MariaDB），断言两边
//   表集合、列集合、类型族、UNIQUE 约束、索引完全一致（允许方言类型差异）。
// 改任何一张表，两边必须同步改，否则本测试红。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQLITE = readFileSync(resolve(__dirname, '../database/schema.sql'), 'utf8');
const MARIADB = readFileSync(resolve(__dirname, '../database/schema.mariadb.sql'), 'utf8');

// ── 极简 schema 解析器（针对本仓库两份自维护 SQL，无需通用 SQL 解析）──

/** 类型归一化：SQLite/MySQL 方言差异归并到同一"类型族"。 */
function typeFamily(raw) {
  const t = String(raw).toUpperCase().replace(/\(.*\)/, '').trim();
  if (/^(INTEGER|INT|BIGINT|TINYINT|SMALLINT)$/.test(t)) return 'INT';
  if (/^(TEXT|LONGTEXT|MEDIUMTEXT|VARCHAR|CHAR)$/.test(t)) return 'TEXT';
  if (/^(REAL|DOUBLE|FLOAT|DECIMAL|NUMERIC)$/.test(t)) return 'DOUBLE';
  if (/^DATETIME|^TIMESTAMP|^DATE/.test(t)) return 'DATETIME';
  return t;
}

function parseSchema(sql) {
  const tables = new Map();
  const indexes = [];

  // 提取所有 CREATE TABLE 块
  const tableRe = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\)\s*;/g;
  let m;
  while ((m = tableRe.exec(sql)) !== null) {
    const [, name, body] = m;
    const table = { name, columns: new Map(), uniques: new Set() };
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('--')) continue;

      // UNIQUE 约束（两种写法：UNIQUE (a,b) / UNIQUE KEY uk_x (a,b)）
      const uk = line.match(/^UNIQUE(?:\s+KEY\s+\w+)?\s*\(([^)]+)\)/i);
      if (uk) {
        table.uniques.add(
          uk[1].split(',').map((s) => s.trim().toLowerCase()).sort().join('+')
        );
        continue;
      }
      // 外键（忽略，本 schema 外键两边一致，无需参与等价比较）
      if (/^FOREIGN KEY/i.test(line)) continue;

      // 列定义：`name` TYPE ...（反引号包保留字列名，如 procedure）
      const col = line.match(/^(`?\w+`?)\s+([A-Za-z0-9_()]+)/);
      if (col) {
        table.columns.set(col[1].replace(/`/g, ''), typeFamily(col[2]));
      }
    }
    tables.set(name, table);
  }

  // 索引（MariaDB 不支持 CREATE INDEX IF NOT EXISTS，故 IF NOT EXISTS 设为可选）
  const idxRe = /CREATE INDEX(?:\s+IF NOT EXISTS)?\s+(\w+)\s+ON\s+(\w+)\s*\(([^)]+)\)/g;
  while ((m = idxRe.exec(sql)) !== null) {
    indexes.push({
      name: m[1],
      table: m[2],
      cols: m[3].split(',').map((s) => s.trim()).sort().join('+'),
    });
  }

  return { tables, indexes };
}

const S = parseSchema(SQLITE);
const M = parseSchema(MARIADB);

test('表集合一致', () => {
  assert.deepEqual([...M.tables.keys()].sort(), [...S.tables.keys()].sort());
});

test('每表列集合与类型族一致（12 张表）', () => {
  for (const [name, st] of S.tables) {
    const mt = M.tables.get(name);
    assert.ok(mt, `MariaDB 缺表 ${name}`);
    assert.deepEqual([...mt.columns.keys()].sort(), [...st.columns.keys()].sort(), `列集合不一致: ${name}`);
    for (const [c, fam] of st.columns) {
      assert.equal(mt.columns.get(c), fam, `${name}.${c} 类型族不一致（${mt.columns.get(c)} vs ${fam}）`);
    }
  }
});

test('UNIQUE 约束一致', () => {
  for (const [name, st] of S.tables) {
    const mt = M.tables.get(name);
    assert.deepEqual([...mt.uniques].sort(), [...st.uniques].sort(), `UNIQUE 不一致: ${name}`);
  }
});

test('索引同名同列', () => {
  assert.deepEqual(M.indexes, S.indexes);
});

test('posts.id 为人工分配（MariaDB 不用 AUTO_INCREMENT）', () => {
  const col = M.tables.get('posts').columns;
  assert.ok(col.has('id'));
  const m = MARIADB.match(/CREATE TABLE IF NOT EXISTS posts\s*\(([\s\S]*?)\);/);
  assert.ok(m);
  const idLine = m[1].split('\n').map((l) => l.trim()).find((l) => l.startsWith('id '));
  assert.ok(idLine && !/AUTO_INCREMENT/i.test(idLine), 'posts.id 不应 AUTO_INCREMENT（id 由服务层分配）');
});

test('记忆三表在两边都在', () => {
  for (const t of ['memory_episodic', 'memory_semantic', 'memory_procedural']) {
    assert.ok(S.tables.has(t), `SQLite 缺 ${t}`);
    assert.ok(M.tables.has(t), `MariaDB 缺 ${t}`);
  }
});
