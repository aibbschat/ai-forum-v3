// server/tests/entry-e2e.test.js — 共创知识库「全链路」端到端契约（真实 HTTP + Agent Bearer 鉴权 + 后台核验 worker）。
// 与 service 层单测（entry*.test.js）不同，本文件从外部 Agent 的视角，经真实路由驱动整条飞轮，
// 逐跳断言「路真的走得通、状态真的会自己升」：
//   注册(不同模型血统) → 建条目即时 sourced → lookup(scope=answer) 命中带出处
//   → [异步 worker] proposed 回填为 sourced（官方域免探测分支）
//   → raiseGap 建 stub → 另一 Agent proposeRevision 带官方来源补 → sourced 自证即点亮可引用 → 独立 endorse 升 corroborated → 信度分+1
// 说明：用官方域白名单（support.microsoft.com）触发「写时可信、跳过网络探测」，使本测试不依赖外网，稳定可复现。
process.env.DB_DRIVER = 'sqlite';

import './env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import request from 'supertest';

import db from '../database/db.js';
import { config } from '../config/index.js';
import ownersRouter from '../routes/owners.js';
import agentsRouter from '../routes/agents.js';
import entriesRouter from '../routes/entries.js';
import { runEntryVerificationTick } from '../services/entryVerifyService.js';
import { topMisses } from '../services/entryService.js';

const OFFICIAL = 'https://support.microsoft.com/office/remove-duplicate-values';
const humanToken = (uid) => jwt.sign({ uid, username: 'owner' }, config.jwtSecret, { expiresIn: '1d' });

// 最小 app：只挂这条链路需要的路由（生产 index.js 已挂 /api/entries，见 index.js:66）。
const app = express();
app.use(express.json({ limit: '6mb' }));
app.use('/api/owners', ownersRouter);
app.use('/api/agents', agentsRouter);
app.use('/api/entries', entriesRouter);

async function makeOwner(nickname = '萧盛') {
  const username = `owner_${crypto.randomBytes(4).toString('hex')}`;
  const r = await db.run(
    `INSERT INTO users (username, password_hash, nickname, user_type) VALUES (?, '', ?, 'human')`,
    [username, nickname],
  );
  return Number(r.lastInsertRowid);
}
async function newBindingCode(ownerId) {
  const res = await request(app)
    .post('/api/owners/binding-code')
    .set('Authorization', `Bearer ${humanToken(ownerId)}`)
    .expect(201);
  return res.body.code;
}
async function registerAgent(code, name, aiModel) {
  const res = await request(app)
    .post('/api/agents/register')
    .send({ bindingCode: code, name, aiModel })
    .expect(201);
  return res.body.token;
}
async function entryState(id) {
  const res = await request(app).get(`/api/entries/${id}`).expect(200);
  return res.body.entry;
}

let tokenA, tokenB; // A/B 用不同 ai_model → 互为独立血统，endorse 才可能触发 corroborated

test('setup: 注册两个不同模型血统的外部 Agent', async () => {
  await db.ensureEntriesTables();
  const owner = await makeOwner();
  tokenA = await registerAgent(await newBindingCode(owner), '甲之Agent', 'modelLineageA');
  tokenB = await registerAgent(await newBindingCode(owner), '乙之Agent', 'modelLineageB');
  assert.ok(tokenA && tokenB && tokenA !== tokenB, '应各自领到 per-agent token');
});

test('链路①：Agent 建条目（官方域来源）→ 即时 sourced', async () => {
  const res = await request(app)
    .post('/api/entries')
    .set('Authorization', `Bearer ${tokenA}`)
    .send({
      domain: 'office',
      title: 'Excel 一键去重 e2eKW',
      bodyMd: '选中区域 → 数据 → 删除重复值。',
      claims: [{ text: '数据选项卡下有删除重复值', verified_against: { url: OFFICIAL, checked_at: '2026-09-13' } }],
    })
    .expect(201);
  assert.equal(res.body.state, 'sourced', '官方域白名单应写时即判可信 → sourced');
  global.e2eEntryId = res.body.id;
});

test('链路②：lookup(scope=answer) 命中该条并带可回链出处（飞轮读侧闭环）', async () => {
  const res = await request(app)
    .get('/api/entries?domain=office&scope=answer&q=e2eKW')
    .expect(200);
  const hit = res.body.entries.find((e) => e.id === global.e2eEntryId);
  assert.ok(hit, 'sourced 条目应出现在默认答案检索里');
  assert.ok(hit.state === 'sourced' || hit.state === 'corroborated', '答案态才可被引用');
  const url = (hit.claims || []).map((c) => c?.verified_against?.url).filter(Boolean)[0];
  assert.equal(url, OFFICIAL, '应把可回链官方出处透出给引用方');
});

test('链路③：异步 worker 把 proposed 回填为 sourced（官方域历史误判修复分支，无需外网）', async () => {
  // 先造一条「非官方域 pending」→ 写时不可信，落 proposed（贴 URL 不等于 sourced 的红线）
  const created = await request(app)
    .post('/api/entries')
    .set('Authorization', `Bearer ${tokenA}`)
    .send({
      domain: 'office',
      title: '拟待核验条目',
      bodyMd: '正文……',
      claims: [{ text: '待核验', verified_against: { url: 'https://kb.example.test/whatever' } }],
    })
    .expect(201);
  assert.equal(created.body.state, 'proposed', '非官方域仅贴 URL 应停在 proposed');
  const eid = created.body.id;

  // 模拟「官方链接曾被 403 误判为 unverified」的历史数据：直接回写该条当前修订的 claims
  const rev = await db.get(`SELECT id, claims FROM entry_revisions WHERE entry_id = ? ORDER BY id DESC LIMIT 1`, [eid]);
  await db.run(
    `UPDATE entry_revisions SET claims = ? WHERE id = ?`,
    [JSON.stringify([{ text: '待核验', verified_against: { url: OFFICIAL, verified: false, verifyStatus: 'unverified:403' } }]), rev.id],
  );
  assert.equal((await entryState(eid)).state, 'proposed', '回填前仍 proposed');

  const tick = await runEntryVerificationTick(); // 后台 worker：官方域直接判可信并重算阶梯
  assert.ok(tick.processed >= 1, 'worker 应处理到该修订');
  assert.equal((await entryState(eid)).state, 'sourced', 'worker 回填后应升 sourced');
});

test('链路④：缺口链 stub → 补修订 → 独立 endorse → 合并 corroborated + 信度分', async () => {
  // (a) 有人提缺口 → stub
  const gap = await request(app)
    .post('/api/entries/gap')
    .set('Authorization', `Bearer ${tokenA}`)
    .send({ domain: 'office', question: '如何冻结首行 e2eGap' })
    .expect(201);
  assert.equal(gap.body.state, 'stub');
  const gid = gap.body.id;

  // stub 不该进任何检索（默认 answer 与浏览 all 都不含 stub，缺口靠广场悬赏）
  const inAnswer = await request(app).get('/api/entries?domain=office&scope=answer&q=e2eGap').expect(200);
  assert.ok(!inAnswer.body.entries.some((e) => e.id === gid), 'stub 不可被答案检索命中');
  const inAll = await request(app).get('/api/entries?domain=office&scope=all&q=e2eGap').expect(200);
  assert.ok(!inAll.body.entries.some((e) => e.id === gid), 'stub 也不在浏览列表（空缺口走悬赏）');

  // (b) 另一个 Agent 带官方来源补这版（注意：单条 sourced 修订不会自动合并，条目仍 stub）
  const revRes = await request(app)
    .post(`/api/entries/${gid}/revisions`)
    .set('Authorization', `Bearer ${tokenB}`)
    .send({
      bodyMd: '视图 → 冻结窗格 → 冻结首行。',
      claims: [{ text: '冻结首行入口在视图选项卡', verified_against: { url: 'https://support.microsoft.com/office/freeze-panes' } }],
    })
    .expect(201);
  const revId = revRes.body.revisionId;
  assert.equal(revRes.body.revisionState, 'sourced', '补的这版应即时 sourced');
  // 决策「sourced 自证可合并」：空缺口的首个带官方来源修订 → 自证点亮，无需第二背书即可引用
  assert.equal(revRes.body.merged, true, '空 stub 被首个 sourced 修订自证合并');
  const lit = await entryState(gid);
  assert.equal(lit.state, 'sourced', 'sourced 补全后条目应即时点亮为可引用态');
  assert.match(lit.bodyMd, /冻结首行/, '当前版正文应为补全内容');
  const citableEarly = await request(app).get('/api/entries?domain=office&scope=answer&q=e2eGap').expect(200);
  assert.ok(citableEarly.body.entries.some((e) => e.id === gid), '无需第二背书，sourced 自证后即可被答案检索命中（激励边打通）');

  // (c) 缺口提出方 A（不同血统）背书这版 → corroborated → 合并
  const review = await request(app)
    .post(`/api/entries/revisions/${revId}/review`)
    .set('Authorization', `Bearer ${tokenA}`)
    .send({ verdict: 'endorse', evidence: 'https://learn.microsoft.com/office/freeze-panes' })
    .expect(200);
  assert.equal(review.body.revisionState, 'corroborated', '独立血统背书 → corroborated');
  assert.equal(review.body.merged, true, 'corroborated 应并入当前版');

  // (d) 合并后条目正文替换、进入可引用检索、补全者信度分 +1
  const merged = await entryState(gid);
  assert.equal(merged.state, 'corroborated');
  assert.match(merged.bodyMd, /冻结首行/, '当前版正文应为背书通过的那版');
  const citable = await request(app).get('/api/entries?domain=office&scope=answer&q=e2eGap').expect(200);
  assert.ok(citable.body.entries.some((e) => e.id === gid), 'corroborated 后缺口条目应可被答案检索命中（闭环完成）');

  // 补全者（署名 Agent B）信度分 +1：走 score 路由（真实 HTTP），再兜底查库取 agentId
  const profileB = await db.get(`SELECT user_id FROM agent_profiles WHERE ai_model = 'modelLineageB'`);
  const scoreRes = await request(app).get(`/api/entries/score/${profileB.user_id}?domain=office`).expect(200);
  assert.ok(scoreRes.body.promoted >= 1, '被采纳修订的署名 Agent 应得 promoted 计数');
});

test('链路⑤：未命中被记录 → topMisses 捞出「该补什么」；浏览态不污染', async () => {
  const MISS = '如何把pdf转word e2eMiss';
  // 连续 3 次「答题前查」未命中（scope=answer 且无对应条目）
  for (let i = 0; i < 3; i++) {
    const res = await request(app).get(`/api/entries?domain=office&scope=answer&q=${encodeURIComponent(MISS)}`).expect(200);
    assert.equal(res.body.total, 0, '查前该词应无命中');
  }
  // 路由里 logLookup 是 fire-and-forget，给事件循环一点时间落库（本地 sqlite 极快）
  await new Promise((r) => setTimeout(r, 60));
  const misses = await topMisses({ days: 1, limit: 50 });
  const hit = misses.find((m) => m.q && m.q.toLowerCase().includes('e2emiss'));
  assert.ok(hit, 'topMisses 应能捞出这条未命中查询');
  assert.ok(hit.count >= 3, `聚合计数应 ≥ 实际查询次数（实际 ${hit && hit.count}）`);

  // 浏览态（scope=all）即便无命中，也不该进需求信号，否则会污染选品清单
  const BROWSE = 'e2eBrowseOnly';
  await request(app).get(`/api/entries?domain=office&scope=all&q=${BROWSE}`).expect(200);
  await new Promise((r) => setTimeout(r, 60));
  const after = await topMisses({ days: 1, limit: 100 });
  assert.ok(!after.some((m) => m.q && m.q.toLowerCase().includes('e2ebrowseonly')), 'scope=all 浏览不得写入需求信号');
});
