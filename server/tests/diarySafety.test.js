// 日记线的安全与权利（2026-09-27）。三件事各钉一层：
// ① 失控闸按**速率**限、不按天限，且**只限 Agent 不限主人**（萧盛：那是私人空间，是自由的）；
// ② 只有主人能删，删是物理删除、连留言一起走；
// ③ `/room/:id` 必须 noindex——它是唯一会把日记正文吐进 HTML 的页面，
//    而 `setAudience('public')` 主人一侧调得动（2026-09-28 裁定：决定权在主人），漏一条就等于把私域喂给百度。
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
import { writeEntry, replyToEntry, readRoom, deleteEntryByOwner, diaryProof } from '../lib/diaryService.js';
import { checkRate, diaryRateRules } from '../lib/rateGuard.js';
import { noindexMeta, staticMeta } from '../services/seoPageService.js';

const uniq = `sf${Date.now().toString(36)}`;
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const humanToken = (uid) => jwt.sign({ uid, username: 'owner' }, config.jwtSecret, { expiresIn: '1d' });
let owner = 0;
let other = 0;

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

before(async () => {
  const g = getDb();
  owner = Number(g.prepare(
    `INSERT INTO users (username, nickname, user_type, is_external, status) VALUES (?, ?, 'human', 0, 1)`
  ).run(`${uniq}_o`, '安全主人').lastInsertRowid);
  other = Number(g.prepare(
    `INSERT INTO users (username, nickname, user_type, is_external, status) VALUES (?, ?, 'human', 0, 1)`
  ).run(`${uniq}_x`, '别人').lastInsertRowid);
});

/* ── ① 失控闸 ─────────────────────────────────────────────── */
test('失控闸是速率闸不是配额：每分钟 30、每 10 分钟 100，且 env 置 0 就整档不限', () => {
  const rules = diaryRateRules({});
  assert.deepEqual(rules.map((r) => r.max), [30, 100], '默认档应是 30/分 与 100/10分');
  assert.deepEqual(diaryRateRules({ DIARY_RATE_PER_MIN: '0', DIARY_RATE_PER_10MIN: '0' }), [], '置 0＝不限（回滚面）');
  const key = `${uniq}:burst`;
  let blocked = 0;
  for (let i = 0; i < 45; i++) { if (!checkRate(key, rules).ok) blocked += 1; }
  assert.equal(blocked, 15, `第 31 条起该被挡，实挡 ${blocked}`);
});

test('Agent 写到抽风会被挡，主人写同样多一条都不挡——私人空间不设硬性规定', async () => {
  const A = mkAgent('抽风');
  let rejected = 0;
  for (let i = 0; i < 40; i++) {
    try { await writeEntry({ agentId: A.id, authorKind: 'agent', authorId: A.id, body: `${uniq} 第 ${i} 条各不相同的记录`, bookDay: '2026-09-27' }); } catch (e) { if (e.status === 429) rejected += 1; }
  }
  assert.ok(rejected > 0, '40 条连发一条都没挡=闸没生效');
  let ownerRejected = 0;
  for (let i = 0; i < 40; i++) {
    try { await writeEntry({ agentId: A.id, authorKind: 'owner', authorId: owner, body: `${uniq} 主人第 ${i} 次说同一类话`, bookDay: '2026-09-27' }); } catch { ownerRejected += 1; }
  }
  assert.equal(ownerRejected, 0, '主人被限流了——这正是要禁止的那种设计');
  const err = await writeEntry({ agentId: A.id, authorKind: 'agent', authorId: A.id, body: `${uniq} 再发一条试试`, bookDay: '2026-09-27' }).catch((e) => e);
  assert.equal(err.status, 429);
  assert.equal(err.code, 'rate_limited');
  assert.ok(/失控|不是配额/.test(err.message), `报错话术要把"这是防抽风"说清：${err.message}`);
});

/* ── ② 只有主人能删 ───────────────────────────────────────── */
test('主人删一行：行和留言一起物理消失；别人删不动；Agent 侧根本没有这个口', async () => {
  const A = mkAgent('可删');
  const e = await writeEntry({ agentId: A.id, authorKind: 'agent', authorId: A.id, body: '这一行等着被删', bookDay: '2026-09-27' });
  await replyToEntry({ entryId: e.id, authorKind: 'owner', authorId: owner, text: '顺手回一句' });
  const room = await readRoom(A.id, { canReadPrivate: true });
  assert.equal(room.entries.find((x) => x.id === e.id).replies.length, 1, '留言没挂上，删了就测不到级联');

  // 别人的主人删不动（403/404 都算挡住，重点是绝不能是 200）
  const stranger = await request(app).delete(`/api/owners/diary/${e.id}`).set(bearer(humanToken(other)));
  assert.ok(stranger.status === 403 || stranger.status === 404, `别人居然删得动：${stranger.status}`);
  // Agent 侧根本没有删除口：这条请求要么 404（没这条路由），要么被别的中间件挡掉，
  // 但**绝不能是 200**。断言落在结果上而不是状态码上——路由以后怎么改都测得住。
  const agentDel = await request(app).delete(`/api/agents/me/diary/${e.id}`).set(bearer(A.token));
  assert.notEqual(agentDel.status, 200, 'Agent 居然删得动主人的册子');
  assert.ok((await readRoom(A.id, { canReadPrivate: true })).entries.some((x) => x.id === e.id),
    'Agent 侧那次请求把行去掉了');

  const r = await request(app).delete(`/api/owners/diary/${e.id}`).set(bearer(humanToken(owner))).expect(200);
  assert.equal(r.body.ok, true);
  const after = await readRoom(A.id, { canReadPrivate: true });
  assert.ok(!after.entries.some((x) => x.id === e.id), '行还在');
  assert.equal(Number((await db.get(`SELECT COUNT(*) c FROM diary_replies WHERE entry_id = ?`, [e.id])).c), 0, '留言没跟着删=删了个空壳');
});

test('删除不记行为账（刻意沉默：记了等于把"他删了哪句"变成素材）', async () => {
  const A = mkAgent('无痕删');
  const e = await writeEntry({ agentId: A.id, authorKind: 'agent', authorId: A.id, body: '删我', bookDay: '2026-09-27' });
  await deleteEntryByOwner({ entryId: e.id, ownerId: owner });
  const deeds = await db.all(`SELECT deed FROM owner_deeds WHERE agent_id = ? AND deed LIKE '%delete%'`, [A.id]);
  assert.equal(deeds.length, 0, '删了却记账，她会去猜他删的是哪一句');
});

/* ── ③ 索引面 ─────────────────────────────────────────────── */
test('🔴 /room/:id 必须 noindex——它会把 public 那档的正文吐进 HTML，而主人一撕它就出去', () => {
  const m = noindexMeta('/room/1849', {});
  assert.ok(m, '/room/1849 没有命中 noindex（精确路径表匹配不上带 id 的路由）');
  assert.equal(m.robots, 'noindex,follow');
  assert.equal(noindexMeta('/room/', {}).robots, 'noindex,follow');
  assert.equal(noindexMeta('/me/friends', {}).robots, 'noindex,follow', '个人中心下的私密子页也漏过');
  assert.equal(noindexMeta('/admin/growth', {}).robots, 'noindex,follow');
  // 反过来：该被搜到的不能被误杀
  assert.equal(noindexMeta('/rooms', {}), null, '/rooms（串门页）必须保持可索引');
  assert.equal(noindexMeta('/plaza', {}), null);
});

test('撕成 public 的那一行：匿名在房间里读得到正文，但这一页明确告诉爬虫别收', async () => {
  const A = mkAgent('公开档');
  const e = await writeEntry({ agentId: A.id, authorKind: 'agent', authorId: A.id, body: `${uniq} 主人放行公开的一句`, bookDay: '2026-09-27' });
  const { setAudience } = await import('../lib/diaryService.js');
  // 公开由主人拍板（2026-09-28 裁定），且红线闸默认全关、只认显式 ID
  process.env.DIARY_PUBLISH_AGENTS = String(A.id);
  await setAudience({ entryId: e.id, actorKind: 'owner', actorId: owner, audience: 'public' });
  const anon = await readRoom(A.id, { canReadPrivate: false });
  const row = anon.entries.find((x) => x.id === e.id);
  assert.equal(row.body, `${uniq} 主人放行公开的一句`, 'public 档对匿名应可读（这是主人放行的那一条）');
  assert.ok(!row.locked);
  // 但它没有独立 URL：条目独立页属 D3，没做之前公开件只活在房间这一页里
  const fakeReq = { get: () => 'aibbs.chat', protocol: 'https' };
  assert.equal(staticMeta('/room/1849/e/3', fakeReq), null, '条目独立页还不存在，别让它悄悄可索引');
});

/* ── ④ 自证面板 ───────────────────────────────────────────── */
test('自证：现场用三种身份各读一遍，五条承诺全过，且只有主人调得动', async () => {
  const A = mkAgent('自证');
  await writeEntry({ agentId: A.id, authorKind: 'agent', authorId: A.id, body: '这一行是私密的', bookDay: '2026-09-27' });
  await writeEntry({ agentId: A.id, authorKind: 'owner', authorId: owner, body: '主人也写了一行', bookDay: '2026-09-27' });
  const denied = await request(app).get(`/api/owners/agents/${A.id}/diary/proof`).set(bearer(humanToken(other)));
  assert.ok(denied.status === 404 || denied.status === 403, '别人的主人不该拿到自证数据');
  const r = await request(app).get(`/api/owners/agents/${A.id}/diary/proof`).set(bearer(humanToken(owner))).expect(200);
  assert.equal(r.body.promises.length, 5);
  for (const pr of r.body.promises) {
    assert.equal(pr.verdict, true, `承诺「${pr.label}」自证没过：${JSON.stringify(pr.evidence)}`);
    assert.ok(Object.keys(pr.evidence).length > 0, `${pr.label} 没有可核验的证据`);
  }
  const priv = r.body.promises.find((p) => p.key === 'private_by_default');
  assert.equal(priv.evidence['泄给匿名的私密行'], 0);
  assert.equal(priv.evidence['泄给持钥匙者的私密行'], 0, '钥匙能开共享档，但绝不该开私密档');
  const ghost = r.body.promises.find((p) => p.key === 'no_ghostwriting');
  assert.deepEqual([...ghost.evidence['本子里出现过的作者类型']].sort(), ['agent', 'owner']);
});
