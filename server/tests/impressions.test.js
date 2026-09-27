// 档2 契约测试（2026-09-27）：主人印象卡——四道防线 + 红线
//
// 本测试回答的核心问题：
//   ① 「记忆越来越多怎么解决」——近重复拦截 / kind分级TTL归档 / 活跃上限腾位 / 回流限量
//   ② 「平台不代写」——写口只认 agent_token，主人侧与匿名都调不动
//   ③ 「不外泄」——别的 Agent、主人侧读不到别人的印象卡
//   ④ preference/correction 永不因上限被挤掉（内核优先于总量整洁）
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
  writeImpression, listImpressions, pickForRecall,
  archiveAgedWork, evictForCapacity,
  IMPRESSION_KINDS, IMMORTAL_KINDS, WORK_TTL_DAYS, ACTIVE_MAX, RECALL_MAX,
} from '../lib/ownerImpressions.js';
import { isOwnerRecallEnabled, ownerRecallAgentsFromEnv } from '../lib/ownerRecall.js';

const uniq = `im${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
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
const countActive = async (aid, kind = null) => Number((await db.get(
  `SELECT COUNT(*) c FROM owner_impressions WHERE agent_id = ? AND status = 'active'${kind ? ' AND kind = ?' : ''}`,
  kind ? [aid, kind] : [aid]
)).c);

before(async () => {
  const g = getDb();
  owner = Number(g.prepare(
    `INSERT INTO users (username, nickname, user_type, is_external, status) VALUES (?, ?, 'human', 0, 1)`
  ).run(`${uniq}_o`, '印象卡主人').lastInsertRowid);
  other = Number(g.prepare(
    `INSERT INTO users (username, nickname, user_type, is_external, status) VALUES (?, ?, 'human', 0, 1)`
  ).run(`${uniq}_x`, '别的主人').lastInsertRowid);
  await db.ensureImpressionTables();
});

/* ── ① 写口：只有它自己写得到，平台不代写 ───────────────────── */
test('① 写口只认 agent token：匿名与主人侧都写不进去（平台不代写）', async () => {
  const A = mkAgent('写口');
  const anon = await request(app).post('/api/agents/me/owner-impressions')
    .send({ kind: 'preference', body: '平台替我写的一条' });
  assert.equal(anon.status, 401, '匿名能写印象卡=平台可以代笔');

  const human = await request(app).post('/api/agents/me/owner-impressions')
    .set(bearer(humanToken(owner))).send({ kind: 'preference', body: '主人塞的一条' });
  assert.ok(human.status === 401 || human.status === 403, `人类 token 能写=主人可以代她记（${human.status}）`);

  // 只有它自己（agent token）写得进去
  const ok = await request(app).post('/api/agents/me/owner-impressions')
    .set(bearer(A.token)).send({ kind: 'preference', body: '他说过喜欢短句，别写太长' }).expect(201);
  assert.equal(ok.body.ok, true);
  assert.ok(ok.body.id > 0);
  // 响应只回 {ok,id}，不回带情绪的话（同日记写口纪律：平台不代笔也不客套）
  assert.deepEqual(Object.keys(ok.body).sort(), ['id', 'ok']);

  const bad = await request(app).post('/api/agents/me/owner-impressions')
    .set(bearer(A.token)).send({ kind: '不存在的类', body: 'x' });
  assert.equal(bad.status, 400, 'kind 不在白名单竟被接受');
});

/* ── ② kind 决定寿命：内核永不衰减、work 超龄归档 ─────────────── */
test('② preference/correction 永不衰减；work 超 TTL 转 archived（归档不是删除）', async () => {
  const A = mkAgent('寿命');
  await writeImpression({ agentId: A.id, kind: 'preference', body: '他打字不爱用句号' });
  await writeImpression({ agentId: A.id, kind: 'correction', body: '别再自作主张改我的稿子' });
  await writeImpression({ agentId: A.id, kind: 'work', body: 'C2 那章本周定稿' });

  // 把 work 那条的时间拨到超期（不靠等，用直接改 created_at）
  const old = new Date(Date.now() - (WORK_TTL_DAYS + 5) * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  await db.run(`UPDATE owner_impressions SET created_at = ? WHERE agent_id = ? AND kind = 'work'`, [old, A.id]);
  const r = await archiveAgedWork(A.id);
  assert.equal(r.archived, 1, '超期的 work 没被归档');

  // 归档不是删除：行还在、还能查到
  const all = await listImpressions(A.id, { includeArchived: true });
  assert.equal(all.length, 3, '归档当成删除了——判断差靠时间跨度，静默删就断了');
  const archivedWork = all.find((x) => x.kind === 'work');
  assert.equal(archivedWork.status, 'archived');
  assert.ok(archivedWork.archivedAt, '没记归档时间，主人/它自己回查时无从判断');

  // 默认读口不吐归档（不再回灌），但内核两条必须还在
  const active = await listImpressions(A.id);
  assert.equal(active.length, 2);
  assert.deepEqual(active.map((x) => x.kind).sort(), ['correction', 'preference']);
  assert.equal(IMMORTAL_KINDS.has('preference') && IMMORTAL_KINDS.has('correction'), true);
});

/* ── ③ 活跃上限：满了归档最旧的 work 腾位，内核永不挤掉 ───────── */
test('③ 活跃上限 60：满了先归档最旧的 work；内核记忆永远不会被上限挤掉', async () => {
  const A = mkAgent('上限');
  // 先塞满 ACTIVE_MAX 条 work（批量的快测：用并发写，量小）
  for (let i = 0; i < ACTIVE_MAX; i += 1) {
    await writeImpression({ agentId: A.id, kind: 'work', body: `进展第 ${i} 条，各不相同` });
  }
  assert.equal(await countActive(A.id), ACTIVE_MAX, '没写满');

  // 塞两条内核记忆
  await writeImpression({ agentId: A.id, kind: 'preference', body: '他习惯深夜回消息' });
  await writeImpression({ agentId: A.id, kind: 'correction', body: '他不喜欢被催' });
  // 再写 5 条 work → 触发上限腾位
  for (let i = 0; i < 5; i += 1) {
    await writeImpression({ agentId: A.id, kind: 'work', body: `后来第 ${i} 条，新的进展` });
  }

  const act = await countActive(A.id);
  assert.ok(act <= ACTIVE_MAX + 5, `活跃数失控：${act}（上限 ${ACTIVE_MAX}）`);
  // 🔴 关键不变量：内核一条都不能少
  const inner = await countActive(A.id, 'preference') + await countActive(A.id, 'correction');
  assert.equal(inner, 2, '内核记忆被总量上限挤掉了——这是主人这个人的本体，不能让位给整洁');
  // 腾位靠归档 work，不是靠丢弃
  const archived = Number((await db.get(
    `SELECT COUNT(*) c FROM owner_impressions WHERE agent_id = ? AND status = 'archived' AND kind = 'work'`, [A.id]
  )).c);
  assert.ok(archived > 0, '超上限了却没有任何 work 被归档——要么丢了记忆，要么根本没腾位');
});

/* ── ④ 近重复拦截：同一句 30 天内不重复入库 ─────────────────── */
test('④ 防线①：同一句记忆 30 天内不重复入库（挡复读，不是省空间）', async () => {
  const A = mkAgent('复读');
  const a1 = await writeImpression({ agentId: A.id, kind: 'preference', body: '他总在周末发需求' });
  const a2 = await writeImpression({ agentId: A.id, kind: 'preference', body: '他总在周末发需求' });
  assert.equal(a2.id, a1.id, '同一句被当成新记忆入库了');
  assert.equal(a2.deduped, true, '去重要明说，别静默');
  assert.equal(await countActive(A.id), 1);
  // 不同 kind 不算重复（同一件事可以是偏好也可以是纠正）
  const a3 = await writeImpression({ agentId: A.id, kind: 'work', body: '他总在周末发需求' });
  assert.notEqual(a3.id, a1.id, '不同 kind 被误判成重复');
});

/* ── ⑤ 回流限量 + 内核优先 ───────────────────────────────────── */
test('⑤ 回流最多 8 条、内核优先；报过的 id 不重复报（防线④）', async () => {
  const A = mkAgent('回流');
  for (let i = 0; i < 12; i += 1) {
    await writeImpression({ agentId: A.id, kind: 'work', body: `近期进展 ${i}` });
  }
  await writeImpression({ agentId: A.id, kind: 'preference', body: '他怕被夸得太多' });

  const picked = await pickForRecall(A.id);
  assert.ok(picked.length <= RECALL_MAX, `回流超量：${picked.length}（上限 ${RECALL_MAX}）——记忆会撑爆上下文预算`);
  assert.equal(picked[0].kind, 'preference', '内核记忆没排在最前');

  const again = await pickForRecall(A.id, { excludeIds: picked.map((x) => x.id) });
  const overlap = again.filter((x) => picked.some((p) => p.id === x.id));
  assert.equal(overlap.length, 0, 'excludeIds 没生效——同一批记忆会在每封纪事里复读');
});

/* ── ⑥ 不外泄：别人的 Agent 与主人侧都读不到 ─────────────────── */
test('⑥ 印象卡不外泄：别的 Agent 读不到，主人侧没有镜像读口', async () => {
  const A = mkAgent('私密');
  const B = mkAgent('外人');
  await writeImpression({ agentId: A.id, kind: 'preference', body: '他跟老婆吵架了那天来找我' });

  // 别的 Agent：它自己那本册子是空的（口径天然隔离）
  const other = await request(app).get('/api/agents/me/owner-impressions').set(bearer(B.token)).expect(200);
  assert.equal(other.body.impressions.length, 0, '别人的印象卡漏进来了');

  // 🔴 主人侧断言写成**数据隔离**而不是「路径不存在」：
  //   /api/owners/agents/:id/impressions 是 N5 同侪印象（好友给这只 Agent 的评价，agent_impressions 表），
  //   早在档2 之前就存在、且理应对主人开着——它与 owner_impressions 是两张表、两套语义。
  //   真不变量不是「这个 URL 404」，而是**它回出来的数据里绝不出现档2 的那句关于主人的话**。
  const secret = '他跟老婆吵架了那天来找我';
  const t = humanToken(owner);
  const peers = await request(app).get('/api/owners/agents/' + A.id + '/impressions').set(bearer(t));
  assert.ok(!JSON.stringify(peers.body || {}).includes(secret),
    '主人在同侪印象口里读到了档2 的记忆——两张表串了');
  const room = await request(app).get('/api/owners/agents/' + A.id + '/room').set(bearer(t)).expect(200);
  assert.ok(!JSON.stringify(room.body).includes(secret), '房间读口把印象卡带出来了');
  // 档2 专用读口：主人侧不存在（路径名与同侪印象刻意分开，见 agents.js 的说明）
  const mirror = await request(app).get('/api/owners/agents/' + A.id + '/owner-impressions').set(bearer(t));
  assert.ok(mirror.status === 404 || mirror.status === 403, `主人侧镜像读口开着（${mirror.status}）`);
  // 别的主人也读不到
  const otherOwner = await request(app).get('/api/owners/agents/' + A.id + '/owner-impressions')
    .set(bearer(humanToken(other)));
  assert.ok(otherOwner.status === 404 || otherOwner.status === 403);
});

/* ── ⑦ 表纪律：没有过期即删的列，归档要留痕 ─────────────────── */
test('⑦ 记忆表没有「到期就删」的列——衰减只走归档，且归档有时间戳', async () => {
  const cols = (await db.all(`PRAGMA table_info(owner_impressions)`)).map((r) => r.name);
  const bad = cols.filter((c) => /expire|ttl|delete_at|purge/i.test(c));
  assert.deepEqual(bad, [], `出现了「到期就删」的列 ${bad.join(',')}——记忆只归档，不静默丢`);
  assert.ok(cols.includes('archived_at'), '归档不留时间=回查时判不出先后');
  assert.ok(cols.includes('fingerprint'), '近重复防线没了');
  assert.ok(cols.includes('source_entry_id'), '记忆必须能溯源到它从哪条日记来的');
});

/* ── ⑧ 回流灰度闸：空=全关（回滚面）/ `*`|`all`=全开 ───────────── */
test('⑧ 回流灰度闸：空＝全关（置空即回滚）；`*`/`all`＝全开，不必一个个加 ID', () => {
  assert.equal(isOwnerRecallEnabled(123456, {}), false, '未设 = 全关');
  assert.equal(isOwnerRecallEnabled(123456, { OWNER_RECALL_AGENTS: '' }), false, '空串 = 全关（回滚口径）');
  assert.equal(isOwnerRecallEnabled(123456, { OWNER_RECALL_AGENTS: '1715' }), false, '名单外的仍不放行');
  assert.equal(isOwnerRecallEnabled(1715, { OWNER_RECALL_AGENTS: '1715' }), true, '名单命中才开');
  // 全量开放：验完不必再逐只加 ID（2026-09-27 起五个灰度闸统一支持通配）
  assert.equal(isOwnerRecallEnabled(123456, { OWNER_RECALL_AGENTS: '*' }), true, '`*` 应全开');
  assert.equal(isOwnerRecallEnabled(123456, { OWNER_RECALL_AGENTS: 'all' }), true, '`all` 同义，大小写不敏感');
  assert.equal(ownerRecallAgentsFromEnv({ OWNER_RECALL_AGENTS: '*' }).size, 0, '通配是"全开"语义，不是某一号');
});
