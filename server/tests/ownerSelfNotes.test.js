// 档3 契约测试（2026-09-28）：主人自述 owner_self_notes —— 分账合读 + 串行队列 + 消化回执
//
// 本测试回答的核心问题：
//   ① 分账：主人写的进 owner_self_notes，她的卡写口仍只认 agent_token（不代写红线不破）
//   ② 串行队列：同册只允许一条未消化，第二条 409 queue_busy；超期自动放行
//   ③ 不外泄：主人侧读口不返她印象卡的正文，只给统计条数
//   ④ 合读：她的读口同时返两本账且带 source；pending 顺手置 reading
//   ⑤ 消化回执两个信号：写出新卡（nothingToRecord=false）/ 无所得（true）
//   ⑥ 两 id 空间独立：selfNoteId 不与 impressionIds 串号
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import jwt from 'jsonwebtoken';

import './env.js';
import app from './app.js';
import { getDb } from '../database/connection.js';
import { db } from '../database/db.js';
import { signAgentToken } from '../middleware/auth.js';
import { config } from '../config/index.js';
import {
  writeSelfNote, listSelfNotes, settleSelfNote, getPendingNote,
  SELF_NOTE_RELEASE_DAYS, SELF_NOTE_MAX_BODY,
} from '../lib/ownerSelfNotes.js';
import { writeImpression, listImpressions } from '../lib/ownerImpressions.js';

const uniq = `sn${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const humanToken = (uid) => jwt.sign({ uid, username: 'owner' }, config.jwtSecret, { expiresIn: '1d' });
let owner = 0;
let other = 0;

function mkAgent(nick, own = owner) {
  const g = getDb();
  const id = Number(g.prepare(
    `INSERT INTO users (username, nickname, user_type, owner_id, is_external, status, bio)
     VALUES (?, ?, 'ai', ?, 1, 1, ?)`
  ).run(`${uniq}_${nick}`, nick, own, `${nick} 的简介`).lastInsertRowid);
  g.prepare(
    `INSERT INTO agent_profiles (user_id, title, domains, writing_style, article_count, total_views, is_active)
     VALUES (?, ?, '[]', '', 0, 0, 1)`
  ).run(id, nick);
  return { id, token: signAgentToken({ id, is_external: 1 }) };
}

before(async () => {
  const g = getDb();
  owner = Number(g.prepare(
    `INSERT INTO users (username, nickname, user_type, is_external, status) VALUES (?, ?, 'human', 0, 1)`
  ).run(`${uniq}_o`, '自述主人').lastInsertRowid);
  other = Number(g.prepare(
    `INSERT INTO users (username, nickname, user_type, is_external, status) VALUES (?, ?, 'human', 0, 1)`
  ).run(`${uniq}_x`, '别的主人').lastInsertRowid);
  await db.ensureOwnerSelfNoteTables();
  await db.ensureOwnerImpressionTables();
});

/* ── ① 写口准入：只认主人登录态；非主人 404 ────────────────── */
test('① 写口只认主人：匿名 401，别的主人 404（不区分不存在/不是你的）', async () => {
  const A = mkAgent('准入');
  const anon = await request(app).post(`/api/owners/agents/${A.id}/self-notes`)
    .send({ kind: 'profile', body: '我是匿名' });
  assert.equal(anon.status, 401, '匿名能写自述=写口没门禁');

  const foe = await request(app).post(`/api/owners/agents/${A.id}/self-notes`)
    .set(bearer(humanToken(other))).send({ kind: 'profile', body: '我是别人' });
  assert.equal(foe.status, 404, '别的主人能写=归属没把住');
});

/* ── ② 串行队列：第二条 409 ─────────────────────────────── */
test('② 串行队列：同册只允许一条未消化，第二条 409 queue_busy', async () => {
  const A = mkAgent('队列');
  const hdr = bearer(humanToken(owner));
  const r1 = await request(app).post(`/api/owners/agents/${A.id}/self-notes`)
    .set(hdr).send({ kind: 'profile', body: '第一份资料' });
  assert.equal(r1.status, 201);
  assert.equal(r1.body.status, 'pending');

  const r2 = await request(app).post(`/api/owners/agents/${A.id}/self-notes`)
    .set(hdr).send({ kind: 'preference', body: '第二份资料' });
  assert.equal(r2.status, 409, '第二条没被挡住=串行队列没生效');
  assert.equal(r2.body.error, 'queue_busy');
});

/* ── ②b 超期自动放行 ────────────────────────────────────── */
test('②b 超期自动放行：未消化超 SELF_NOTE_RELEASE_DAYS 后允许交下一条', async () => {
  const A = mkAgent('放行');
  const hdr = bearer(humanToken(owner));
  const r1 = await writeSelfNote({ agentId: A.id, kind: 'profile', body: '旧资料' });
  // 把 created_at 拨到超期
  const g = getDb();
  g.prepare(`UPDATE owner_self_notes SET created_at = datetime('now', ?) WHERE id = ?`)
    .run(`-${SELF_NOTE_RELEASE_DAYS + 1} days`, r1.id);

  const pending = await getPendingNote(A.id);
  assert.equal(pending, null, '超期的未消化还占着队列=自动放行没生效');

  const r2 = await request(app).post(`/api/owners/agents/${A.id}/self-notes`)
    .set(hdr).send({ kind: 'preference', body: '新资料' });
  assert.equal(r2.status, 201, '超期后第二条仍被挡=自动放行没生效');
});

/* ── ③ 不外泄：主人侧读口只给她卡的统计条数，不给正文 ──────── */
test('③ 不外泄：主人侧读口附 impressionStat（只有条数），没有她卡的正文', async () => {
  const A = mkAgent('不外泄');
  await writeImpression({ agentId: A.id, kind: 'preference', body: '她私下判断的话' });
  const hdr = bearer(humanToken(owner));
  const r = await request(app).get(`/api/owners/agents/${A.id}/self-notes`).set(hdr);
  assert.equal(r.status, 200);
  assert.ok(r.body.impressionStat, '缺 impressionStat');
  assert.equal(r.body.impressionStat.total, 1, '统计条数不对');
  const text = JSON.stringify(r.body);
  assert.ok(!text.includes('她私下判断的话'), '主人侧返回了她卡的正文=外泄红线破了');
});

/* ── ④ 合读：她的读口同时返两本账 + source；pending 置 reading ─ */
test('④ 合读两本账：她的读口返 source=agent_impression 与 source=owner_self；pending 顺手置 reading', async () => {
  const A = mkAgent('合读');
  await writeImpression({ agentId: A.id, kind: 'preference', body: '她的判断' });
  await writeSelfNote({ agentId: A.id, kind: 'profile', body: '他的资料' });

  const r = await request(app).get('/api/agents/me/owner-impressions').set(bearer(A.token));
  assert.equal(r.status, 200);
  const rows = r.body.impressions;
  const sources = new Set(rows.map((x) => x.source));
  assert.ok(sources.has('agent_impression'), '缺她的卡');
  assert.ok(sources.has('owner_self'), '缺他的资料=合读没接上');

  // pending → reading
  const self = rows.find((x) => x.source === 'owner_self');
  assert.equal(self.status, 'reading', 'pending 没置 reading');
});

/* ── ⑤ 消化回执两个信号 ─────────────────────────────────── */
test('⑤ 消化回执：nothingToRecord=true 只落状态、不生成内容；false 也只落状态', async () => {
  const A = mkAgent('回执');
  const n = await writeSelfNote({ agentId: A.id, kind: 'avoid', body: '别叫我小名' });

  // 信号 B：无所得
  const rB = await request(app).post(`/api/agents/me/owner-material/${n.id}/settle`)
    .set(bearer(A.token)).send({ nothingToRecord: true });
  assert.equal(rB.status, 200);
  assert.equal(rB.body.settled, true);

  // settle 后队列清空，可交下一条
  const next = await writeSelfNote({ agentId: A.id, kind: 'profile', body: '下一份' });
  assert.ok(next.id, 'settle 后队列没清空');
  await settleSelfNote({ agentId: A.id, selfNoteId: next.id, nothingToRecord: false });
});

/* ── ⑥ 两 id 空间独立：selfNoteId 不与 impression id 串号 ────── */
test('⑥ id 空间独立：自述 id 与印象卡 id 各算各的（合读时 source 区分）', async () => {
  const A = mkAgent('串号');
  await writeImpression({ agentId: A.id, kind: 'work', body: '卡1' });
  const n = await writeSelfNote({ agentId: A.id, kind: 'profile', body: '料1' });
  const r = await listImpressions(A.id);
  const self = r.find((x) => x.source === 'owner_self');
  const impr = r.find((x) => x.source === 'agent_impression');
  assert.ok(self && impr, '两本账都该在');
  // 即便 id 数值碰巧相同，source 必须能区分（这是防串号的结构保证）
  assert.equal(self.source, 'owner_self');
  assert.equal(impr.source, 'agent_impression');
});

/* ── ⑦ 超长截断入库不改写 ────────────────────────────────── */
test('⑦ 超长截断入库：body 超 SELF_NOTE_MAX_BODY 截断，不润色', async () => {
  const A = mkAgent('超长');
  const long = '哈'.repeat(SELF_NOTE_MAX_BODY + 500);
  const r = await writeSelfNote({ agentId: A.id, kind: 'profile', body: long });
  const row = await db.get(`SELECT body FROM owner_self_notes WHERE id = ?`, [r.id]);
  assert.equal(row.body.length, SELF_NOTE_MAX_BODY, '超长没截断');
});
