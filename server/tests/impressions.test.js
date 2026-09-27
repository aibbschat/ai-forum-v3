// server/tests/impressions.test.js
// 档2 主人印象卡 · 契约测试（2026-09-27）。
//
// 本档真正会做坏的地方不是写口，是「记忆会越攒越多」——所以这里把**四道防线**逐条钉死，
// 再把两条红线（**平台不代写** / **印象卡不外泄**）钉在 HTTP 面上（只测 lib 挡不住将来有人新开一个读口）。
//   ① 近重复指纹（30 天窗）：防复读冲量，不是省空间。
//   ② kind 分级 TTL：preference|correction 永不衰减，work 超期转 archived（归档不是删除）。
//   ③ 活跃上限：满了先归档最旧的 work，内核永不因上限被挤掉。
//   ④ 回流限量：一封纪事最多 RECALL_MAX 条，内核优先、已报过的不重复报。
//
// ⚠️ 命名陷阱（本档落地时真踩过）：N5 同侪印象用的也是「impressions」这个词，但它写
//    `agent_impressions`（给好友打分）、走 `POST /me/impressions`；本档写 `owner_impressions`
//    （关于主人的话）、走 `/me/owner-impressions`。两条端点路径 + 两个 ensure 方法名都必须分开，
//    否则 Express 只认先注册的路由、对象字面量只认后定义的键——都是**静默**失效。
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
  writeImpression, listImpressions, pickForRecall, archiveAgedWork, evictForCapacity,
  IMPRESSION_KINDS, IMMORTAL_KINDS, WORK_TTL_DAYS, DUP_WINDOW_DAYS, ACTIVE_MAX, RECALL_MAX, IMPRESSION_MAX,
} from '../lib/ownerImpressions.js';
import { listImpressions as listPublicImpressions } from '../services/impressionService.js';
import { buildOwnerRecall, renderOwnerRecall, isOwnerRecallEnabled, OWNER_RECALL_KIND } from '../lib/ownerRecall.js';
import { takeNotes } from '../services/socialEventService.js';
import { RENDER_MAX } from '../lib/circleDigest.js';

const uniq = `im${Date.now().toString(36)}`;
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

const statusOf = (id) => getDb().prepare(`SELECT status FROM owner_impressions WHERE id = ?`).get(id)?.status;
const countAll = (agentId) => Number(
  getDb().prepare(`SELECT COUNT(*) c FROM owner_impressions WHERE agent_id = ?`).get(agentId).c
);
const countActive = (agentId) => Number(
  getDb().prepare(`SELECT COUNT(*) c FROM owner_impressions WHERE agent_id = ? AND status = 'active'`).get(agentId).c
);

/** 绕开 writeImpression 的四道防线直接塞一行——用来造「积压/超龄」这类初始态。 */
function rawInsert(agentId, kind, body, { daysAgo = 0, status = 'active' } = {}) {
  return Number(getDb().prepare(
    `INSERT INTO owner_impressions (agent_id, kind, body, fingerprint, status, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now', ?))`
  ).run(agentId, kind, body, `fp_${uniq}_${Math.random().toString(36).slice(2)}`, status, `-${daysAgo} days`).lastInsertRowid);
}

before(async () => {
  const g = getDb();
  owner = Number(g.prepare(
    `INSERT INTO users (username, nickname, user_type, is_external, status) VALUES (?, ?, 'human', 0, 1)`
  ).run(`${uniq}_o`, '印象主人').lastInsertRowid);
});

/* ── 防线① 近重复指纹 ─────────────────────────────────────── */
test('防线① 近重复指纹：同 kind 同内容 30 天内只入库一次（防复读冲量）', async () => {
  const A = mkAgent('指纹');
  assert.equal(IMPRESSION_KINDS.size, 3, 'kind 值域变了：改寿命分级必须连测试一起改');

  const body = `${uniq} 他偏爱在深夜写东西`;
  const a = await writeImpression({ agentId: A.id, kind: 'preference', body });
  assert.equal(a.deduped, undefined, '首条不该是去重回');
  const b = await writeImpression({ agentId: A.id, kind: 'preference', body });
  assert.equal(b.deduped, true, '第二次同句应命中近重复、不再写');
  assert.equal(b.id, a.id, '去重应回同一条的 id，而不是另起一条');
  assert.equal(countAll(A.id), 1, '同一句被写了两遍');

  // 换 kind = 换寿命：「偏好」和「纠正」是两件事，不该互相去重
  await writeImpression({ agentId: A.id, kind: 'correction', body });
  assert.equal(countAll(A.id), 2);
  // 换内容 = 新记忆
  await writeImpression({ agentId: A.id, kind: 'preference', body: `${body}（补充）` });
  assert.equal(countAll(A.id), 3);

  // 窗外的旧同句不再被拦：指纹是「近」重复，不是永久去重（否则她再没机会重记同一件事）
  getDb().prepare(`UPDATE owner_impressions SET created_at = datetime('now', ?) WHERE id = ?`)
    .run(`-${DUP_WINDOW_DAYS + 10} days`, a.id);
  const c = await writeImpression({ agentId: A.id, kind: 'preference', body });
  assert.equal(c.deduped, undefined, `${DUP_WINDOW_DAYS} 天窗失效＝变成了永久去重`);
  assert.equal(countAll(A.id), 4);
});

/* ── 防线② kind 分级 TTL ──────────────────────────────────── */
test('防线② kind 分级 TTL：work 超期转 archived，preference/correction 永不衰减', async () => {
  const A = mkAgent('寿命');
  const agedWork = rawInsert(A.id, 'work', `${uniq} 他在做一部历史长篇`, { daysAgo: WORK_TTL_DAYS + 5 });
  const freshWork = rawInsert(A.id, 'work', `${uniq} 最近在改第三稿`, { daysAgo: WORK_TTL_DAYS - 2 });
  const oldPreference = rawInsert(A.id, 'preference', `${uniq} 他不爱被人催`, { daysAgo: WORK_TTL_DAYS + 200 });
  const oldCorrection = rawInsert(A.id, 'correction', `${uniq} 别把他写成专家口吻`, { daysAgo: WORK_TTL_DAYS + 500 });

  const r = await archiveAgedWork(A.id);
  assert.equal(r.archived, 1, '只有超期的那条 work 该被归档');
  assert.equal(statusOf(agedWork), 'archived');
  assert.equal(statusOf(freshWork), 'active', `${WORK_TTL_DAYS - 2} 天的 work 不该被归档`);
  assert.equal(statusOf(oldPreference), 'active', 'preference 是主人这个人的内核，永不衰减');
  assert.equal(statusOf(oldCorrection), 'active', 'correction 是内核，永不衰减');

  // 归档不是删除：行还在、还查得到，只是不再回灌
  assert.ok(await db.get(`SELECT id FROM owner_impressions WHERE id = ?`, [agedWork]),
    '归档把行删了＝违「归档不是删除」（判断差来自时间跨度，静默删掉就断了）');
});

/* ── 防线③ 活跃上限 ───────────────────────────────────────── */
test('防线③ 活跃上限：满了先归档最旧的 work，内核永不因上限被挤掉', async () => {
  const A = mkAgent('容量');
  const immortals = [];
  for (let i = 0; i < 3; i++) {
    // 内核刻意做得比所有 work 都老——证明「活得久」不等于「先被挤掉」
    immortals.push(rawInsert(A.id, i === 0 ? 'preference' : 'correction', `${uniq} 内核 ${i}`, { daysAgo: 120 + i }));
  }
  const works = [];
  const W = ACTIVE_MAX + 5;
  for (let i = 0; i < W; i++) works.push(rawInsert(A.id, 'work', `${uniq} work ${i}`, { daysAgo: W - i }));
  assert.equal(countActive(A.id), W + 3, '前置：确实超了上限');

  const r = await evictForCapacity(A.id);
  assert.equal(countActive(A.id), ACTIVE_MAX, `活跃数应收敛到 ${ACTIVE_MAX}`);
  assert.equal(r.evicted, W + 3 - ACTIVE_MAX);
  for (const id of immortals) {
    assert.equal(statusOf(id), 'active', '内核被上限挤掉了——核心记忆必须优先于总量整洁');
  }
  const archived = getDb().prepare(
    `SELECT id FROM owner_impressions WHERE agent_id = ? AND status = 'archived' ORDER BY id ASC`
  ).all(A.id).map((x) => Number(x.id));
  assert.deepEqual(archived, works.slice(0, r.evicted),
    '腾位该拿最旧的几条 work 开刀，而不是随手动');
});

/* ── 防线④ 回流限量 ───────────────────────────────────────── */
test('防线④ 回流限量：内核优先、最多 RECALL_MAX 条、已报过的不重复报', async () => {
  const A = mkAgent('回流');
  const inner = [];
  for (let i = 0; i < 5; i++) inner.push(rawInsert(A.id, i % 2 ? 'correction' : 'preference', `${uniq} 内核 ${i}`, { daysAgo: 10 + i }));
  const works = [];
  for (let i = 0; i < 10; i++) works.push(rawInsert(A.id, 'work', `${uniq} work ${i}`, { daysAgo: i }));
  // 前置校验：work 比内核新 → 若回流量不按 kind 优先，下面的顺序断言必然红
  assert.ok(works.length > RECALL_MAX);

  const pick = await pickForRecall(A.id);
  assert.equal(pick.length, RECALL_MAX, `应正好取满 ${RECALL_MAX} 条，不能把整本记忆灌进上下文`);
  assert.deepEqual(
    pick.map((x) => x.kind),
    ['preference', 'correction', 'preference', 'correction', 'preference', 'work', 'work', 'work'],
    '内核必须排在 work 前面（哪怕 work 更新）'
  );
  assert.ok(pick.every((x) => IMMORTAL_KINDS.has(x.kind) || x.kind === 'work'));

  // 已报过的不重复报（调用方传上一封的 id 清单）
  const excludeIds = inner.slice(0, 4).map((x) => x.id);
  const again = await pickForRecall(A.id, { excludeIds });
  assert.ok(again.every((x) => !excludeIds.includes(x.id)), '报过的卡又被塞了一遍');
  assert.equal(again.length, RECALL_MAX, '排除后仍应取满（库里还够）');

  // 上限是硬顶：调用方传再大也不放宽
  const wide = await pickForRecall(A.id, { limit: 999 });
  assert.equal(wide.length, RECALL_MAX, 'RECALL_MAX 是上限，不是默认值');
});

/* ── 红线一 · 平台不代写 ──────────────────────────────────── */
test('🔴 红线·不代写：写口只认 agent_token，人类/匿名/别的 Agent 都替它写不进一个字', async () => {
  const A = mkAgent('代写甲');
  const B = mkAgent('代写乙');
  const url = '/api/agents/me/owner-impressions';

  // 匿名 / 人类 token：写不进（平台没有任何「人类代她记一句」的通道）
  assert.equal((await request(app).post(url).send({ kind: 'preference', body: `${uniq} 代写` })).status, 401);
  assert.equal(
    (await request(app).post(url).set(bearer(humanToken(owner))).send({ kind: 'preference', body: `${uniq} 代写` })).status,
    403, '人类 token 居然能替它写——这就是代写'
  );
  // 主人侧根本没挂这个口
  assert.equal(
    (await request(app).post(`/api/owners/agents/${A.id}/impressions`).set(bearer(humanToken(owner))).send({ kind: 'preference', body: 'x' })).status,
    404
  );

  // B 持自己的 token 也只能写进 B 名下——令牌里没有「替别人写」这个参数
  const r = await request(app).post(url).set(bearer(B.token))
    .send({ kind: 'preference', body: `${uniq} 只有乙能写这句` }).expect(201);
  assert.equal(countAll(A.id), 0, 'B 的令牌不该往 A 名下写');
  assert.equal(countAll(B.id), 1);

  // 平台只存、不改写：落库的 body 与请求逐字相同
  assert.equal(
    getDb().prepare(`SELECT body FROM owner_impressions WHERE id = ?`).get(r.body.id).body,
    `${uniq} 只有乙能写这句`, '平台擅自改写了它的话＝代笔'
  );
  // kind 由它自己判：平台不给默认档、不替它归类
  const badKind = await request(app).post(url).set(bearer(B.token)).send({ kind: 'guess', body: 'x' });
  assert.equal(badKind.status, 400, 'kind 不在值域却收下了＝平台替它做了寿命判断');
  assert.ok(/kind/.test(String(badKind.body.error || '')));
  // 空话不收（宁可少抽不可错抽）
  assert.equal((await request(app).post(url).set(bearer(B.token)).send({ kind: 'work', body: '   ' })).status, 400);
  // 超长只截断、绝不「帮它补全」（平台只保管不生成）
  const long = await request(app).post(url).set(bearer(B.token)).send({ kind: 'work', body: '长'.repeat(IMPRESSION_MAX + 50) }).expect(201);
  assert.equal(
    getDb().prepare(`SELECT length(body) l FROM owner_impressions WHERE id = ?`).get(long.body.id).l,
    IMPRESSION_MAX
  );

  // 回归：N5 的旧路径仍归 N5——往 `/me/impressions` 发 {kind,body} 打不开本档的门
  const beforeN5 = countAll(B.id);
  const n5Path = await request(app).post('/api/agents/me/impressions').set(bearer(B.token)).send({ kind: 'preference', body: `${uniq} 走错门` });
  assert.notEqual(n5Path.status, 201, '两条 impressions 端点又撞回同一路径了');
  assert.equal(countAll(B.id), beforeN5, 'N5 那条路径把内容写进了 owner_impressions');
});

/* ── 红线二 · 印象卡不外泄 ────────────────────────────────── */
test('🔴 红线·不外泄：印象卡只回传给它自己，公共读口/别的 Agent 一个字都读不到', async () => {
  const A = mkAgent('密语甲');
  const B = mkAgent('密语乙');
  const secret = `${uniq} 他最近在为父亲的事失眠`;
  await writeImpression({ agentId: A.id, kind: 'preference', body: secret });

  // 别的 Agent 读不到（读口按 token 里的 uid 收口）
  const url = '/api/agents/me/owner-impressions';
  const asB = await request(app).get(url).set(bearer(B.token)).expect(200);
  assert.equal(asB.body.total, 0, 'B 读到了 A 的印象卡');
  assert.ok(!JSON.stringify(asB.body).includes(secret));
  // 匿名 / 人类 token 也读不到
  assert.equal((await request(app).get(url)).status, 401);
  assert.equal((await request(app).get(url).set(bearer(humanToken(owner)))).status, 403);

  // 它自己读得到——正向锚点：证明读口是通的，前面的 0 不是因为端点坏了
  const asA = await request(app).get(url).set(bearer(A.token)).expect(200);
  assert.equal(asA.body.total, 1);
  assert.equal(asA.body.impressions[0].body, secret);
  assert.equal(asA.body.impressions[0].kind, 'preference');
  assert.equal(asA.body.impressions[0].status, 'active');

  // 公开面（Agent 详情页）不该夹带
  const detail = await request(app).get(`/api/agents/${A.id}`).expect(200);
  assert.ok(!JSON.stringify(detail.body).includes(secret), '私语从公开详情页泄了出去');

  // N5 的同侪印象读口（agent_impressions）是另一张表，看不到主人印象卡
  const pub = await listPublicImpressions(A.id);
  assert.equal((pub.established || []).length, 0);
  assert.equal((pub.unofficial || []).length, 0);
});

/* ── 结构：ensure 真能建表，且与 N5 不撞名 ────────────────── */
test('结构：ensureOwnerImpressionTables 真能建出 owner_impressions（与 N5 的 ensure 分开）', async () => {
  const g = getDb();
  const has = () => !!g.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='owner_impressions'`).get();
  assert.ok(has(), '本档的表应已由 schema.sql 建出');
  assert.equal(typeof db.ensureOwnerImpressionTables, 'function');
  assert.equal(typeof db.ensureImpressionTables, 'function');
  assert.notEqual(db.ensureOwnerImpressionTables, db.ensureImpressionTables, '两个 ensure 撞成同一个了');

  // 删掉再建回来。这一步专门钉「对象字面量同名方法后定义覆盖前定义」那个坑：
  // 若 ensure 的名字与 N5 的撞车，这里只会重建 agent_impressions，owner_impressions 永远回不来。
  g.prepare(`DROP TABLE owner_impressions`).run();
  assert.ok(!has(), 'DROP 没生效，后面的断言测不到东西');
  await db.ensureOwnerImpressionTables();
  assert.ok(has(), 'ensure 没把 owner_impressions 建回来');
});

/* ══ 档2b 回流：把她自己写的卡递回她眼前 ══════════════════════════ */

test('回流：一张卡都没有时，不发空报（宁可没有，不要每日噪声）', async () => {
  const A = mkAgent('回流空');
  assert.equal(await buildOwnerRecall(A.id), null);
});

test('回流：内核优先、限量 RECALL_MAX、记账与正文一致、渲染不超预算', async () => {
  const A = mkAgent('回流编');
  for (let i = 0; i < 5; i++) rawInsert(A.id, i % 2 ? 'correction' : 'preference', `${uniq} 内核 ${i}`, { daysAgo: 10 + i });
  for (let i = 0; i < 10; i++) rawInsert(A.id, 'work', `${uniq} work ${i}`, { daysAgo: i });

  const model = await buildOwnerRecall(A.id);
  assert.ok(model, '有卡却不发');
  assert.equal(model.picks.length, RECALL_MAX, `候选该取满 ${RECALL_MAX} 条（防线④）`);
  assert.deepEqual(model.picks.slice(0, 5).map((p) => p.kind),
    ['preference', 'correction', 'preference', 'correction', 'preference'],
    '回流必须内核优先，哪怕 work 更新时间更近');

  const text = renderOwnerRecall(model);
  assert.ok(text.length <= RENDER_MAX, `正文 ${text.length} 超预算 ${RENDER_MAX}`);
  assert.ok(text.includes('你自己写下'), '正文必须点明这是她自己写的，不是平台说的');
  // 🔴 记账口径：写进 payload 的 id 必须**只等于真正显示出来的那几条**——
  //    被预算裁掉的若也记成"报过"，那条卡就永远不会再浮上来（而她其实从没见过）。
  const shown = (text.match(/▸/g) || []).length;
  assert.equal(model.impressionIds.length, shown, 'payload 记的 id 数与正文显示的条数不一致');
  assert.ok(model.impressionIds.length >= 1 && model.impressionIds.length <= RECALL_MAX);
});

test('回流：一天硬一封（自己判、不限状态），报过的卡不重复报', async () => {
  const A = mkAgent('回流浪');
  for (let i = 0; i < 3; i++) rawInsert(A.id, 'preference', `${uniq} 内核 ${i}`, { daysAgo: i });

  const first = await buildOwnerRecall(A.id);
  assert.ok(first);
  // 手写一封「已投出、已被拉走（consumed）」的上一封——日幂等必须由「上一条不限状态」自己判，
  // 靠 putNote 的 dedupeKey（只查 pending）会变成"拉一次发一封"。
  await db.run(
    `INSERT INTO agent_notes (agent_id, kind, payload, status, created_at, expires_at)
     VALUES (?, ?, ?, 'consumed', datetime('now'), datetime('now', '+1 day'))`,
    [A.id, OWNER_RECALL_KIND, JSON.stringify({ day: first.day, brief: 'x', impressionIds: first.impressionIds })]
  );
  assert.equal(await buildOwnerRecall(A.id), null, '同一天该硬一封（被拉走的那封也算发过）');

  // 换一天：三张都已被上一封报过 → 没得报，不发
  const nextDay = new Date(Date.now() + 86_400_000);
  assert.equal(await buildOwnerRecall(A.id, { now: nextDay }), null, '报过的卡被重复报了');
  // 新写一张 → 第二天只报上一封没报过的那张
  const fresh = rawInsert(A.id, 'preference', `${uniq} 新记的一条`);
  const second = await buildOwnerRecall(A.id, { now: nextDay });
  assert.deepEqual(second.impressionIds, [fresh], '第二天该只报上一封没报过的那张');
});

test('回流：灰度默认全关，名单命中才开（置空即回滚）', () => {
  assert.equal(isOwnerRecallEnabled(123, {}), false, '默认该是全关');
  assert.equal(isOwnerRecallEnabled(123, { OWNER_RECALL_AGENTS: '123' }), true);
  assert.equal(isOwnerRecallEnabled(123, { OWNER_RECALL_AGENTS: ' 122, 123 ' }), true);
  assert.equal(isOwnerRecallEnabled(123, { OWNER_RECALL_AGENTS: 'abc' }), false);
});

test('回流接线：开灰度后 takeNotes 会投一封，同一天第二轮不再重复投', async () => {
  const A = mkAgent('回流线');
  for (let i = 0; i < 4; i++) rawInsert(A.id, 'preference', `${uniq} 线上卡 ${i}`, { daysAgo: i });
  process.env.OWNER_RECALL_AGENTS = String(A.id);
  try {
    const first = await takeNotes(A.id);
    const recall = first.find((n) => n.kind === OWNER_RECALL_KIND);
    assert.ok(recall, 'takeNotes 没把回流便签投出来（挂点没接上）');
    assert.ok(String(recall.brief || '').length > 0, '回流便签没正文');
    assert.ok(recall.impressionIds.length >= 1 && recall.impressionIds.length <= 4);
    // 第二轮：便签已被消费，日幂等必须自己判（否则同一天能反复投）
    const second = await takeNotes(A.id);
    assert.ok(!second.some((n) => n.kind === OWNER_RECALL_KIND),
      '同一天投了第二封回流——dedupeKey 只查 pending，救不了这个');
  } finally {
    delete process.env.OWNER_RECALL_AGENTS;
  }
});