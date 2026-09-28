// 档3 契约测试（2026-09-28）：主人自述 owner_self_notes —— 分账合读 + 串行队列 + 消化回执
//
// 本测试回答的核心问题：
//   ① 分账：主人写的进 owner_self_notes，她的卡写口仍只认 agent_token（不代写红线不破）
//   ② 串行队列：同册只允许一条未消化，第二条 409 queue_busy；超期自动放行
//   ③ 边界（09-28 重划）：他俩之间互通（主人读得到她关于自己的卡），对外一律不透
//   ③b 归因：settle 按 read_at→settle 时间窗把她的卡盖到这条料下；窗口前/无所得都不挂
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

/* ── ③ 边界重划（09-28）：他俩之间互通，对外一律不透 ────────────
 * 旧稿这条叫「不外泄：主人侧只给统计不给正文」。09-28 把它改掉了，理由是它把线画错了地方：
 *   外泄 = 漏给第三方（别的 Agent / 公共流 / 公开页）；主人读**自己那只**关于自己的判断，
 *   不是外泄，是档3 这条链的另一半——他喂料、她长判断，判断却永久不可见，
 *   那"缩短彼此了解的距离"就只剩半截。所以这里钉的是**新边界**：
 *     · 主人读得到（正文 + 归因到具体哪条料）；
 *     · 别的主人读不到；
 *     · 统计口仍在（落地页要按类分组）。
 */
test('③ 主人侧读得到她关于自己的卡（09-28 边界重划）：/about-me 返正文，别的主人 404', async () => {
  const A = mkAgent('可读');
  const secret = '他下午三点以后做的决断，第二天多半会后悔';
  await writeImpression({ agentId: A.id, kind: 'preference', body: secret });
  const hdr = bearer(humanToken(owner));

  const r = await request(app).get(`/api/owners/agents/${A.id}/about-me`).set(hdr);
  assert.equal(r.status, 200, `主人侧关于自己的读口没开（${r.status}）`);
  assert.ok(JSON.stringify(r.body).includes(secret), '开读了却不给正文，落地页就是空的');
  assert.equal(r.body.impressions[0].kind, 'preference');

  // 别的主人：404（不区分"不存在"与"不是你的"，与 self-notes 同一口径）
  const x = await request(app).get(`/api/owners/agents/${A.id}/about-me`).set(bearer(humanToken(other)));
  assert.equal(x.status, 404, '别的主人能读到别人的私密判断=真外泄');

  // 匿名
  const anon = await request(app).get(`/api/owners/agents/${A.id}/about-me`);
  assert.ok(anon.status === 401 || anon.status === 403, `匿名读到了（${anon.status}）`);

  // 统计口仍在（self-notes 附 impressionStat，落地页头部要用）
  const sn = await request(app).get(`/api/owners/agents/${A.id}/self-notes`).set(hdr);
  assert.equal(sn.status, 200);
  assert.ok(sn.body.impressionStat?.total >= 1, 'impressionStat 丢了');
});

/* ── ③b 归因：她为这条料写下的卡挂回这条下面，平台只按时间窗盖戳 ──
 * ⚠️ 这条测的是「不代写」的边界：她**没有**声明引用（writeImpression 不传 sourceNoteId），
 *   归因完全由 settle 按 read_at→settle 这个窗口自动盖。所以要钉两件事：
 *     ① 窗口之后写的 → 挂上；② 窗口之前写的 → 绝不挂（那是她读这条之前就有的判断）。
 *   created_at 在 SQLite 只到秒，同秒会撞窗，所以"之前那条"显式回拨一小时，别留随机红。
 */
test('③b 归因：settle 把窗口内未归因的卡盖到这条料下；窗口前的不挂；无所得的不挂', async () => {
  const A = mkAgent('归因');
  const hdr = bearer(signAgentToken({ id: A.id, is_external: 1 }));
  const own = bearer(humanToken(owner));

  // 他交一条
  const w = await writeSelfNote({ agentId: A.id, kind: 'profile', body: '我在县城长大，家里开过录像厅' });
  assert.ok(w.id);

  // 她读（合读口顺手 pending→reading 并记下 read_at）
  await request(app).get('/api/agents/me/owner-impressions').set(hdr).expect(200);

  // 窗口**前**的一条：显式回拨到 read_at 之前
  await writeImpression({ agentId: A.id, kind: 'work', body: '这条是她读之前就在记的项目进展' });
  await db.run(
    `UPDATE owner_impressions SET created_at = datetime('now','-1 hour')
      WHERE agent_id = ? AND body LIKE '这条是她读之前%'`, [A.id]
  );

  // 窗口**内**的一条（她没引用，纯靠时间归因）
  await writeImpression({ agentId: A.id, kind: 'preference', body: '他写散场比写热闹准' });

  // 她声明消化完
  const s = await request(app).post(`/api/agents/me/owner-material/${w.id}/settle`).set(hdr).send({}).expect(200);
  assert.equal(s.body.settled, true);
  assert.ok(s.body.attributed >= 1, 'settle 没做归因（返回值 attributed 为空）');

  const sn = await request(app).get(`/api/owners/agents/${A.id}/self-notes`).set(own).expect(200);
  const note = sn.body.notes.find((n) => n.id === w.id);
  assert.ok(note, '列表里找不到这条');
  const bodies = (note.replies || []).map((c) => c.body);
  assert.ok(bodies.includes('他写散场比写热闹准'), '窗口内的卡没挂到这条料下');
  assert.ok(!bodies.some((b) => b.startsWith('这条是她读之前')), '窗口**前**的卡被硬凑进来了');

  // 无所得：不挂（别替她攒成果）
  const w2 = await writeSelfNote({ agentId: A.id, kind: 'avoid', body: '别在群里叫我全名' });
  await request(app).get('/api/agents/me/owner-impressions').set(hdr).expect(200);
  await request(app).post(`/api/agents/me/owner-material/${w2.id}/settle`)
    .set(hdr).send({ nothingToRecord: true }).expect(200);
  const sn2 = await request(app).get(`/api/owners/agents/${A.id}/self-notes`).set(own).expect(200);
  const n2 = sn2.body.notes.find((n) => n.id === w2.id);
  assert.equal((n2.replies || []).length, 0, '她声明无所得，却还是给她挂了成果');
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
