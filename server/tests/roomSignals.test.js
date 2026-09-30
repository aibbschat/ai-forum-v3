/*
 * 路B 房间信号（2026-09-28）契约测试 —— 主人写日记 / 交资料时递给 Agent 的那两封通知。
 *
 * 为什么必须单独有这一份：路B 首轮上线时**一条测试都没有**，而它的失败模式全是静默的——
 *   预览被截却不标明 → 她把半句当整句引用回去；
 *   主人连写十行 → 收件箱十封同类刷屏，她反而一封都不处理；
 *   通知里一个同步抛错 → 主人写一行日记变成 500（首轮实测就是这样撞出来的）。
 * 这三条都不是"看起来会坏"的样式，所以钉成名字。
 *
 * 纪律来源：《AI圈-主人资料页重设计-2026-09.md》§八。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import jwt from 'jsonwebtoken';

import './env.js';
import app from './app.js';
import { getDb } from '../database/connection.js';
import { db, isMaria } from '../database/db.js';
import { signAgentToken } from '../middleware/auth.js';
import { config } from '../config/index.js';
import { settleSelfNote } from '../lib/ownerSelfNotes.js';

const uniq = `rsig${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const humanToken = (uid) => jwt.sign({ uid, username: 'owner' }, config.jwtSecret, { expiresIn: '1d' });
let owner = 0;

function mkAgent(nick) {
  const g = getDb();
  const id = Number(g.prepare(
    `INSERT INTO users (username, nickname, user_type, owner_id, is_external, status, bio)
     VALUES (?, ?, 'ai', ?, 1, 1, ?)`
  ).run(`${uniq}_${nick}`, nick, owner, `${nick} 的简介`).lastInsertRowid);
  g.prepare(
    `INSERT INTO agent_profiles (user_id, title, domains, writing_style, article_count, total_views, is_active)
     VALUES (?, ?, '[]', '', 0, 0, 1)`
  ).run(id, nick);
  return { id, token: signAgentToken({ id, is_external: 1 }) };
}
/** 直接查库断言：合并/计数是"几封、第几封"的问题，走读口会被别的字段的富化逻辑干扰。 */
const signals = (aid, type) => db.all(
  `SELECT id, is_read, extra FROM notifications WHERE user_id = ? AND type = ? ORDER BY id ASC`,
  [aid, type]
);
// 通知是 fire-and-forget（推迟到微任务），断言前让事件循环转一圈
const settleTick = () => new Promise((r) => setTimeout(r, 30));

before(async () => {
  const g = getDb();
  owner = Number(g.prepare(
    `INSERT INTO users (username, nickname, user_type, is_external, status) VALUES (?, ?, 'human', 0, 1)`
  ).run(`${uniq}_o`, '房间信号主人').lastInsertRowid);
});

/* ── ① 预览截了就要说出来 ─────────────────────────────────────── */
test('① 日记行超 160 字：extra.truncated=true；没截就 false（不能让她把半句当整句）', async () => {
  const L = mkAgent('长行');
  const S = mkAgent('短行');
  await request(app).post(`/api/owners/agents/${L.id}/diary`).set(bearer(humanToken(owner)))
    .send({ body: '今'.repeat(200) }).expect(201);
  await request(app).post(`/api/owners/agents/${S.id}/diary`).set(bearer(humanToken(owner)))
    .send({ body: '短的一句' }).expect(201);
  await settleTick();

  // 两个 Agent 各一封，别拿同一只测：合并后 extra 会被最新那条覆盖，
  // 那正是②要测的行为，混在一起测就分不清"没标"还是"被覆盖了"。
  const lx = JSON.parse((await signals(L.id, 'diary_entry'))[0].extra);
  assert.equal(lx.truncated, true, '预览被砍到 160 却没标记 → 她会以为那就是主人写的整句');
  assert.equal(lx.body.length, 160);
  const sx = JSON.parse((await signals(S.id, 'diary_entry'))[0].extra);
  assert.equal(sx.truncated, false, '没截也标"摘录"=骗她去看原帖，白跑一趟');
  assert.equal(sx.body, '短的一句');
});

/* ── ② 同类信号合并，不刷屏 ───────────────────────────────────── */
test('② 主人连写三行 → 未读只有 1 封且 count=3，entryId 指向最新一行', async () => {
  const A = mkAgent('合并');
  const t = bearer(humanToken(owner));
  const ids = [];
  for (const line of ['第一行', '第二行', '第三行']) {
    const r = await request(app).post(`/api/owners/agents/${A.id}/diary`).set(t).send({ body: line }).expect(201);
    ids.push(r.body?.id ?? r.body?.entry?.id);
  }
  await settleTick();

  const rows = await signals(A.id, 'diary_entry');
  assert.equal(rows.length, 1, `十行刷十封=噪声，应该合并（实际 ${rows.length} 封）`);
  const x = JSON.parse(rows[0].extra);
  assert.equal(x.count, 3, '合并了却没说总共几条 → 她回完最新一条以为就处理干净了');
  assert.equal(x.entryId, ids[2], '要递最新那行的 entryId（她顺手接的就是刚写的那句）');
  assert.equal(x.body, '第三行');
});

test('②b 她已经读过的那封是历史：再写一行另起一封，绝不偷改已读的', async () => {
  const A = mkAgent('已读另起');
  const t = bearer(humanToken(owner));
  await request(app).post(`/api/owners/agents/${A.id}/diary`).set(t).send({ body: '第一行' }).expect(201);
  await settleTick();
  const first = (await signals(A.id, 'diary_entry'))[0];
  await db.run(`UPDATE notifications SET is_read = 1 WHERE id = ?`, [Number(first.id)]);

  await request(app).post(`/api/owners/agents/${A.id}/diary`).set(t).send({ body: '第二行' }).expect(201);
  await settleTick();

  const rows = await signals(A.id, 'diary_entry');
  assert.equal(rows.length, 2, '已读的也被合并=把她看过的东西悄悄改掉');
  const oldX = JSON.parse(rows[0].extra);
  assert.equal(oldX.body, '第一行', '已读那封的内容被改写了');
  assert.equal(JSON.parse(rows[1].extra).count, 1, '新起的一封计数应该从 1 开始');
});

/* ── ③ 资料通知不合并：每份料各有 noteId ───────────────────────── */
test('③ 两份资料 = 两封通知（合并会把另一份 noteId 藏起来，那是读侧缺口）', async () => {
  const A = mkAgent('资料不并');
  const t = bearer(humanToken(owner));
  const r1 = await request(app).post(`/api/owners/agents/${A.id}/self-notes`)
    .set(t).send({ kind: 'profile', body: '我在县城长大' }).expect(201);
  // 串行队列挡第二条，所以先让她把第一条消化掉（走 lib，不绕权限）
  await settleSelfNote({ agentId: A.id, selfNoteId: r1.body.id, nothingToRecord: true });
  const r2 = await request(app).post(`/api/owners/agents/${A.id}/self-notes`)
    .set(t).send({ kind: 'preference', body: '别在下午找我做决断' }).expect(201);
  await settleTick();

  const rows = await signals(A.id, 'owner_material');
  assert.equal(rows.length, 2, '资料通知被合并了 → 其中一份的 noteId 她再也看不见');
  const noteIds = rows.map((x) => JSON.parse(x.extra).noteId).sort((a, b) => a - b);
  assert.deepEqual(noteIds, [r1.body.id, r2.body.id].sort((a, b) => a - b));
  assert.ok(rows.every((x) => JSON.parse(x.extra).count === undefined || JSON.parse(x.extra).count === 1),
    '资料这型不该带合并计数');
});

/* ── ④ 通知不许把主人的正经写入搞挂 ───────────────────────────── */
test('④ 通知表写坏时，主人写日记仍然 201（素材层不许拖挂业务——首轮实测就是 500）', async () => {
  const A = mkAgent('表坏');
  const t = bearer(humanToken(owner));
  const rename = (from, to) => db.run(isMaria
    ? `RENAME TABLE ${from} TO ${to}` : `ALTER TABLE ${from} RENAME TO ${to}`);
  await rename('notifications', 'notifications_off');
  try {
    await request(app).post(`/api/owners/agents/${A.id}/diary`).set(t)
      .send({ body: '通知发不出去也得让我把这行写进去' }).expect(201);
  } finally {
    await rename('notifications_off', 'notifications');
  }
  await settleTick();
  const rows = await signals(A.id, 'diary_entry');
  assert.equal(rows.length, 0, '表坏的时候不该假装发成功');
});

/* ── ⑤ 主人「回复」也要发信号（09-30 补：此前回复是静默路径） ──── */
test('⑤ 主人回复某条 → Agent 同样收到 diary_entry 信号（此前只有新写一行会发）', async () => {
  const A = mkAgent('回复发信号');
  const t = bearer(humanToken(owner));
  const w = await request(app).post(`/api/owners/agents/${A.id}/diary`).set(t)
    .send({ body: '他先写的一行' }).expect(201);
  const entryId = w.body?.id ?? w.body?.entry?.id;
  await settleTick();
  // 把这封"新写一行"标已读，隔离出回复那一封（否则会被合并，分不清是新增还是合并）
  await db.run(`UPDATE notifications SET is_read = 1 WHERE user_id = ? AND type = 'diary_entry'`, [A.id]);

  await request(app).post(`/api/owners/diary/${entryId}/reply`).set(t)
    .send({ text: '回你一句' }).expect(200);
  await settleTick();

  const rows = await signals(A.id, 'diary_entry');
  assert.equal(rows.length, 2, '主人回复没发信号 → 她回了话而 Agent 永远不知道该去听');
  const x = JSON.parse(rows[1].extra);
  assert.equal(x.entryId, entryId, '回复信号要指向被回复的那条 entryId');
  assert.equal(x.body, '回你一句');
  assert.equal(x.truncated, false);
});

test('⑤b 回复与新写一行走同一型：未读时合并、计数递增（不偷偷覆盖成另一条）', async () => {
  const A = mkAgent('回复合并');
  const t = bearer(humanToken(owner));
  const w = await request(app).post(`/api/owners/agents/${A.id}/diary`).set(t)
    .send({ body: '新写一行' }).expect(201);
  const entryId = w.body?.id ?? w.body?.entry?.id;
  await settleTick();
  await request(app).post(`/api/owners/diary/${entryId}/reply`).set(t)
    .send({ text: '紧接着回一句' }).expect(200);
  await settleTick();

  const rows = await signals(A.id, 'diary_entry');
  assert.equal(rows.length, 1, '同一型不该分裂成两封（合并是这一型的有意设计）');
  const x = JSON.parse(rows[0].extra);
  assert.equal(x.count, 2, '合并了却不说共几条 → 她回完最新一句以为就处理干净了');
  assert.equal(x.body, '紧接着回一句', 'extra 指向最新一条（她顺手接的就是刚说的那句）');
});
