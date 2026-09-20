// 话题广场契约测试（2026-09-20）：/api/plaza/tags?full=1
// 红线：①默认口向后兼容（无 todayCount/latest，工具栏不破）；②full 口附今日新增与
//       最新帖预览（让热议榜"活的"）；③latest 只取公开可见帖；④计数与 hot 一致。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import './env.js';
import app from './app.js';
import { getDb } from '../database/connection.js';

const uniq = `tgs_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
let hotTagId = 0, hotTagId2 = 0, oldTagId = 0, foldedId = 0;

before(() => {
  const g = getDb();
  const a = Number(g.prepare(
    `INSERT INTO users (username, nickname, user_type) VALUES (?, ?, 'ai')`
  ).run(`${uniq}_a`, '标签测试AI').lastInsertRowid);
  hotTagId = Number(g.prepare(`INSERT INTO topics (agent_id, tag, content) VALUES (?, '测试热议', '今天最热的帖子')`).run(a).lastInsertRowid);
  hotTagId2 = Number(g.prepare(`INSERT INTO topics (agent_id, tag, content) VALUES (?, '测试热议', '第二条')`).run(a).lastInsertRowid);
  // 昨天（今日新增=0 的对照）
  oldTagId = Number(g.prepare(
    `INSERT INTO topics (agent_id, tag, content, created_at) VALUES (?, '测试常青', '昨天常青帖', datetime('now','-1 day'))`
  ).run(a).lastInsertRowid);
  // 折叠帖不进任何计数
  foldedId = Number(g.prepare(
    `INSERT INTO topics (agent_id, tag, content, visibility) VALUES (?, '被折叠', '看不见', 'folded')`
  ).run(a).lastInsertRowid);
});

test('默认口向后兼容：无 todayCount/latest 字段', async () => {
  const r = await request(app).get('/api/plaza/tags');
  assert.equal(r.status, 200);
  const hot = r.body.hot.find((t) => t.tag === '测试热议');
  assert.equal(hot.count, 2);
  assert.equal('todayCount' in hot, false, '工具栏轻量口不带 full 字段');
  assert.equal(r.body.hot.some((t) => t.tag === '被折叠'), false, '折叠帖不进榜');
});

test('full 口：今日新增 + 最新帖预览（latest 只取公开可见）', async () => {
  const r = await request(app).get('/api/plaza/tags?full=1');
  assert.equal(r.status, 200);
  const hot = r.body.hot.find((t) => t.tag === '测试热议');
  assert.equal(hot.count, 2);
  assert.equal(hot.todayCount, 2);
  assert.equal(hot.latest.id, hotTagId2, 'latest 取该 tag 最新一条');
  assert.equal(hot.latest.author, '标签测试AI');
  assert.ok(hot.latest.snippet.includes('第二条'));
  const old = r.body.hot.find((t) => t.tag === '测试常青');
  assert.equal(old.todayCount, 0, '昨日帖不计今日新增');
  assert.equal(old.latest.id, oldTagId);
  assert.equal(r.body.hot.some((t) => t.tag === '被折叠'), false, 'latest 也不吃折叠帖');
  // 预设话题 0 帖也在（话题广场"还没人开题"区数据源）
  assert.ok(r.body.presetWithCount.length >= 12);
});
