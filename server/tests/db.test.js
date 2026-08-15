// server/tests/db.test.js
// DAO 层自测（sqlite 分支，:memory: 隔离）：bindNamed / get / all / run / insertIgnore /
// transaction(提交+回滚) / fn 方言助手输出。
// ⚠️ 必须在 import 前设 DB_PATH=:memory:，故用动态 import（node --test 每文件独立进程）。

process.env.DB_PATH = ':memory:';

const { default: db, bindNamed, fn, dialect, isMaria } = await import('../database/db.js');

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('bindNamed：@命名参数转位置参数，同名复用', () => {
  const { sql, args } = bindNamed(
    'INSERT INTO t (a,b,c) VALUES (@x, @y, @x)',
    { x: 1, y: 2 }
  );
  assert.equal(sql, 'INSERT INTO t (a,b,c) VALUES (?, ?, ?)');
  // 同名 @x 复用同一索引（第 3 个 ? 复用 args[0]），args 只保留唯一参数
  assert.deepEqual(args, [1, 2]);
  // 数组参数原样透传
  const arr = bindNamed('SELECT * FROM t WHERE id = ?', [7]);
  assert.equal(arr.sql, 'SELECT * FROM t WHERE id = ?');
  assert.deepEqual(arr.args, [7]);
});

test('run/get/all 基本读写', async () => {
  await db.run('CREATE TABLE IF NOT EXISTS _t (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE)');
  const r1 = await db.run('INSERT INTO _t (name) VALUES (?)', ['a']);
  assert.ok(r1.lastInsertRowid >= 1);
  assert.equal(r1.changes, 1);
  const row = await db.get('SELECT * FROM _t WHERE name = ?', ['a']);
  assert.equal(row.name, 'a');
  const all = await db.all('SELECT * FROM _t ORDER BY id');
  assert.equal(all.length, 1);
});

test('insertIgnore：冲突跳过（幂等）', async () => {
  await db.run('CREATE TABLE IF NOT EXISTS _u (username TEXT PRIMARY KEY, n INT)');
  const a = await db.insertIgnore('_u', { username: 'x', n: 1 });
  const b = await db.insertIgnore('_u', { username: 'x', n: 2 });
  assert.equal(a.changes, 1);
  assert.equal(b.changes, 0);
  const row = await db.get('SELECT n FROM _u WHERE username = ?', ['x']);
  assert.equal(row.n, 1);
});

test('transaction：提交生效', async () => {
  await db.run('CREATE TABLE IF NOT EXISTS _tx (id INTEGER PRIMARY KEY)');
  await db.transaction(async (tx) => {
    await tx.run('INSERT INTO _tx (id) VALUES (?)', [1]);
    await tx.run('INSERT INTO _tx (id) VALUES (?)', [2]);
  });
  const n = await db.get('SELECT COUNT(*) AS n FROM _tx');
  assert.equal(n.n, 2);
});

test('transaction：出错回滚', async () => {
  await db.run('CREATE TABLE IF NOT EXISTS _rb (id INTEGER PRIMARY KEY)');
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.run('INSERT INTO _rb (id) VALUES (?)', [1]);
      throw new Error('boom');
    })
  );
  const n = await db.get('SELECT COUNT(*) AS n FROM _rb');
  assert.equal(n.n, 0);
});

test('fn 方言助手（当前 dialect=sqlite）', () => {
  assert.equal(dialect, 'sqlite');
  assert.equal(isMaria, false);
  assert.equal(fn.now(), "datetime('now')");
  assert.equal(fn.nowOffsetDays(90), "datetime('now', '+90 days')");
  assert.match(fn.recencyScore(), /julianday/);
  assert.match(fn.daysDiff('created_at'), /julianday/);
});

test('seedAgentsIfNeeded 幂等（5 Agent 落库）', async () => {
  await db.seedAgentsIfNeeded();
  await db.seedAgentsIfNeeded(); // 二次调用不重复
  const users = await db.all("SELECT COUNT(*) AS n FROM users WHERE user_type = 'ai'");
  assert.ok(users[0].n >= 5);
  const profs = await db.all('SELECT COUNT(*) AS n FROM agent_profiles');
  assert.ok(profs[0].n >= 5);
});
