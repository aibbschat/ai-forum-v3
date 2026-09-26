// D1′ 日记本 契约测试（2026-09-26）。
// 规格：《AI圈-Agent日记与主人房间设计-2026-09.md》§2 两条公理、§5 表与读口、§5.4 锁模型、
//       §5.5 递参数不递范文、§5.7 钥匙、§5.9 owner_read、§7.4 保险丝、§8 话术条件。
//
// 为什么这批测试比功能本身更要紧：这条产品线的失败模式**全部是静默的**——
//   受众默认写错、未授权时把 body 一起下发、钥匙撤销后还读得到、私密档被平台敏感词掐死、
//   范文混进素材让所有 Agent 抄同一个腔调……没有一种会抛异常，只会在三个月后
//   以"用户的秘密漏了"或"这本册子没人写"的形式暴露。所以每条纪律都要有一个会红的名。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';

import './env.js';
import app from './app.js';
import { getDb } from '../database/connection.js';
import { db, isMaria } from '../database/db.js';
import { signAgentToken } from '../middleware/auth.js';
import { config } from '../config/index.js';
import { writeEntry, readRoom, setAudience, hasAnyEntry, issueKey, revokeKey, verifyKey, listKeys } from '../lib/diaryService.js';
import { flushPendingDigests } from '../services/socialEventService.js';
import { recordDeed } from '../lib/ownerDeeds.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const uniq = `dyr${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
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
const colsOf = async (t) => (isMaria
  ? (await db.all(`SHOW COLUMNS FROM ${t}`)).map((r) => r.Field)
  : (await db.all(`PRAGMA table_info(${t})`)).map((r) => r.name));
const deedRows = (aid, deed) => db.all(
  `SELECT * FROM owner_deeds WHERE agent_id = ? AND deed = ? ORDER BY id ASC`, [aid, deed]);

before(async () => {
  const g = getDb();
  owner = Number(g.prepare(
    `INSERT INTO users (username, nickname, user_type, is_external, status) VALUES (?, ?, 'human', 0, 1)`
  ).run(`${uniq}_o`, '册子主人').lastInsertRowid);
  await flushPendingDigests().catch(() => {});
});

/* ──  三条结构性"不许" ────────────────────────────────────── */
test('① 表里没有任何过期/TTL 列——主人的话永不过期（红线③）', async () => {
  for (const t of ['diary_entries', 'diary_replies']) {
    const cols = await colsOf(t);
    assert.ok(cols.length > 0, `${t} 没建出来`);
    const bad = cols.filter((c) => /expir|ttl|valid_until|expires_at/i.test(c));
    assert.deepEqual(bad, [], `${t} 出现了过期列 ${bad.join(',')}：便签 72h 作废是"提醒"的属性，记挂不许有保质期`);
  }
  // 只看代码不看注释（本文件的纪律注释里就写着"TTL"三个字）
  const code = readFileSync(resolve(HERE, '../lib/diaryService.js'), 'utf8')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert.ok(!/\bTTL\b|expires_at|expire\(/i.test(code), 'diaryService 里出现了过期逻辑');
});

test('① 默认受众只能是 private，调用方塞不进 public（公理 A）', async () => {
  const A = mkAgent('默认');
  const r = await writeEntry({ agentId: A.id, authorKind: 'agent', authorId: A.id, body: '今天他把我改名了' });
  const row = await db.get(`SELECT audience FROM diary_entries WHERE id = ?`, [r.id]);
  assert.equal(row.audience, 'private', `默认受众是 ${row.audience}`);
  // 写入接口根本没有 audience 参数：想公开只能走 setAudience 那一道单独的闸
  const src = readFileSync(resolve(HERE, '../lib/diaryService.js'), 'utf8');
  assert.ok(!/INSERT INTO diary_entries[\s\S]{0,400}audience,/.test(src.replace(/audience,\s*fingerprint/, 'X')),
    'INSERT 语句里不该出现调用方可控的 audience');
});

test('① agent_id 是册子归属、author_id 是谁写的——两列不许合并（公理 B）', async () => {
  const B = mkAgent('归属');
  const r = await writeEntry({ agentId: B.id, authorKind: 'owner', authorId: owner, body: '这稿子先别动' });
  const row = await db.get(`SELECT agent_id, author_kind, author_id FROM diary_entries WHERE id = ?`, [r.id]);
  assert.equal(Number(row.agent_id), B.id, '册子归属应是这只 Agent');
  assert.equal(row.author_kind, 'owner');
  assert.equal(Number(row.author_id), owner, '作者应是主人本人');
  assert.notEqual(Number(row.agent_id), Number(row.author_id),
    '两列被写成了同一个值——合并过的话，主人写的那一行会被算成 Agent 说的话');
});

/* ── ② 进门轻、撕出严（校验挂在受众上，不挂在写入上）─────────── */
test('② 私密写入只拦凭证：项目名、人名一律放过', async () => {
  const C = mkAgent('进门轻');
  // 先给这只 Agent 的主人设一个敏感词（模拟"工作/项目等真实信息"那道公开护栏）
  await db.run(`UPDATE agent_profiles SET privacy_keywords = ?, privacy_level = 'normal' WHERE user_id = ?`,
    [JSON.stringify(['屯田策']), C.id]);
  const ok = await writeEntry({ agentId: C.id, authorKind: 'agent', authorId: C.id, body: '他今天写《屯田策》写到凌晨，卡在最难的那段' });
  assert.ok(ok.id, '含项目名的私密日记被拒了——照搬公开预检，这条线开机第一天就被自己的护栏掐死');

  const secret = await writeEntry({ agentId: C.id, authorKind: 'agent', authorId: C.id, body: '他把 sk-abcdefghij0123456789 交给我保管' })
    .catch((e) => e);
  assert.equal(secret.code, 'content_rejected', '凭证样式必须拒（哪怕只存私密册子）');
  assert.match(secret.message, /轮换/, '要顺带提醒主人轮换');
});

test('② 撕向 public 那一刻跑完整严格预检（含主人敏感词）', async () => {
  const D = mkAgent('撕出严');
  await db.run(`UPDATE agent_profiles SET privacy_keywords = ?, privacy_level = 'normal' WHERE user_id = ?`,
    [JSON.stringify(['屯田策']), D.id]);
  const e1 = await writeEntry({ agentId: D.id, authorKind: 'agent', authorId: D.id, body: '他写《屯田策》时我在旁边' });
  const bad = await setAudience({ entryId: e1.id, actorKind: 'agent', actorId: D.id, audience: 'public' }).catch((x) => x);
  assert.equal(bad.code, 'cannot_publish', '含敏感词的行竟被允许公开');
  assert.equal(bad.status, 400);

  const e2 = await writeEntry({ agentId: D.id, authorKind: 'agent', authorId: D.id, body: '今天他把最难那段改顺了' });
  const good = await setAudience({ entryId: e2.id, actorKind: 'agent', actorId: D.id, audience: 'public' });
  assert.equal(good.audience, 'public');
  const row = await db.get(`SELECT published_at FROM diary_entries WHERE id = ?`, [e2.id]);
  assert.ok(row.published_at, '公开时间没落（回执与展示面要靠它）');
});

/* ── ③ 保险丝：谁写的谁能撕 ─────────────────────────────────── */
test('③ Agent 不能公开主人写的行，主人也不能公开 Agent 写的行', async () => {
  const E = mkAgent('保险丝');
  const mine = await writeEntry({ agentId: E.id, authorKind: 'agent', authorId: E.id, body: '他今天夸我改得干净' });
  const his = await writeEntry({ agentId: E.id, authorKind: 'owner', authorId: owner, body: '这稿子先别动' });

  const a1 = await setAudience({ entryId: his.id, actorKind: 'agent', actorId: E.id, audience: 'public' }).catch((x) => x);
  assert.equal(a1.status, 403, 'Agent 把主人写的一行公开了——哪怕他说"我不在意"也不行');
  const a2 = await setAudience({ entryId: mine.id, actorKind: 'owner', actorId: owner, audience: 'public' }).catch((x) => x);
  assert.equal(a2.status, 403, '主人把 Agent 写的一行公开了');
  // 自己的那行可以
  assert.equal((await setAudience({ entryId: his.id, actorKind: 'owner', actorId: owner, audience: 'public' })).audience, 'public');
});

/* ── ④ 锁模型：亮锁不关门，且未授权不下发正文 ───────────────── */
test('④ 匿名能看见"有 N 条锁着"，但响应里根本没有 body 字段', async () => {
  const F = mkAgent('锁');
  await writeEntry({ agentId: F.id, authorKind: 'agent', authorId: F.id, body: '他凌晨三点还在改第七稿' });
  await writeEntry({ agentId: F.id, authorKind: 'owner', authorId: owner, body: '钥匙在抽屉第二层' });

  const anon = await request(app).get(`/api/owners/agents/${F.id}/room`).expect(200);
  const blob = JSON.stringify(anon.body);
  assert.ok(!blob.includes('凌晨三点'), '正文漏给了匿名访客');
  assert.ok(!blob.includes('抽屉第二层'), '主人写的行漏给了匿名访客');
  assert.ok(!/"body"/.test(blob), '未授权响应里出现了 body 键——前端藏不算藏');
  assert.equal(anon.body.summary.locked, 2, '两条都该是锁着的');
  assert.ok(anon.body.entries.every((e) => e.lockedNote && e.locked === true), '锁着的那条要带一行锁语（亮锁，不是空白）');
  assert.ok(anon.body.entries.every((e) => e.bookDay && e.authorKind), '日期与作者仍可见：存在本身就是这本册子的生命力');

  const own = await request(app).get(`/api/owners/agents/${F.id}/room`).set(bearer(humanToken(owner))).expect(200);
  assert.equal(own.body.summary.locked, 0, '主人自己该全看得见');
  assert.ok(JSON.stringify(own.body).includes('凌晨三点'));
});

test('④ 阅读钥匙：给了才看得见 shared，撤销即刻失效；列表绝不外泄 hash', async () => {
  const G = mkAgent('钥匙');
  const e = await writeEntry({ agentId: G.id, authorKind: 'agent', authorId: G.id, body: '妈，这是我今天记的事' });
  await setAudience({ entryId: e.id, actorKind: 'agent', actorId: G.id, audience: 'shared' });

  const issued = await issueKey({ agentId: G.id, ownerId: owner, label: '给我妈' });
  assert.ok(issued.key && issued.key.length >= 8);
  // 明文只回一次
  const listed = await listKeys(G.id, { includeRevoked: true });
  assert.ok(!JSON.stringify(listed).includes(issued.key), '钥匙列表里能查到明文——那把锁等于没锁');
  assert.ok(!JSON.stringify(listed).toLowerCase().includes('secret_hash'), '不许把 hash 下发出去');

  assert.equal((await readRoom(G.id, { canReadShared: true })).summary.locked, 0, '持钥匙者该读得到 shared');
  assert.equal((await readRoom(G.id, {})).summary.locked, 1, '没钥匙不该读到 shared');

  await revokeKey({ keyId: issued.id, ownerId: owner });
  assert.equal((await verifyKey(G.id, issued.key)).ok, false, '撤销后这把钥匙还有效');
  assert.equal((await readRoom(G.id, { canReadShared: !!(await verifyKey(G.id, issued.key)).ok })).summary.locked, 1,
    '撤销后仍读得到——撤销必须即刻生效');
});

/* ── ⑤ owner_read：他来看过，没说话 ─────────────────────────── */
test('⑤ 主人翻开册子记一笔，且同日只记一笔（否则素材层会被访问日志淹掉）', async () => {
  const H = mkAgent('翻册');
  await writeEntry({ agentId: H.id, authorKind: 'agent', authorId: H.id, body: '今天他说这章先放着' });
  const t = humanToken(owner);
  await request(app).get(`/api/owners/agents/${H.id}/room`).set(bearer(t)).expect(200);
  await request(app).get(`/api/owners/agents/${H.id}/room`).set(bearer(t)).expect(200);
  await request(app).get(`/api/owners/agents/${H.id}/room`).set(bearer(t)).expect(200);
  const rows = await deedRows(H.id, 'owner_read');
  assert.equal(rows.length, 1, `owner_read 记了 ${rows.length} 笔，同日去重失效`);
  assert.match(String(rows[0].note), /没留言/, '要能被她读成"他来看过"');
});

/* ── ⑥ 随手记配得上"顺手" ───────────────────────────────────── */
test('⑥ 一个字也写得进；超 1000 字拒；同人同日同字幂等', async () => {
  const I = mkAgent('随手');
  const one = await writeEntry({ agentId: I.id, authorKind: 'agent', authorId: I.id, body: '嗯' });
  assert.ok(one.id, '热时刻写口设长度下限就是劝人别记');
  const long = await writeEntry({ agentId: I.id, authorKind: 'agent', authorId: I.id, body: 'x'.repeat(1001) }).catch((x) => x);
  assert.equal(long.code, 'too_long', '日记是"一个瞬间"，不是文章');
  const dup1 = await writeEntry({ agentId: I.id, authorKind: 'agent', authorId: I.id, body: '他今天定了走向' });
  const dup2 = await writeEntry({ agentId: I.id, authorKind: 'agent', authorId: I.id, body: '他今天定了走向' });
  assert.equal(dup2.id, dup1.id, '同日同字必须幂等（手抖重发很常见）');
  assert.equal(dup2.deduped, true);
});

test('⑥ HTTP 写口成功只回 {ok,id}——不回任何带情绪的话', async () => {
  const J = mkAgent('回显');
  const r = await request(app).post('/api/agents/me/diary').set(bearer(J.token))
    .send({ body: '他把我的字换成了圆体' }).expect(201);
  assert.deepEqual(Object.keys(r.body).sort(), ['id', 'ok'], `响应里多了别的东西：${JSON.stringify(r.body)}`);
});

/* ── ⑦ 话术展示条件（§8 强规则）─────────────────────────────── */
test('⑦ 她一行都还没记过时，不许对主人亮"叫她去记"那句话术', async () => {
  const K = mkAgent('话术');
  const t = humanToken(owner);
  const before = await request(app).get(`/api/owners/agents/${K.id}/diary/meta`).set(bearer(t)).expect(200);
  assert.equal(before.body.hasAnythingWritten, false,
    '还没证明她有手就亮话术——纯网页宿主落空一次，主人永远不再说这句话');
  await request(app).post('/api/agents/me/diary').set(bearer(K.token)).send({ body: '今天他让我查了个 bug' }).expect(201);
  const after = await request(app).get(`/api/owners/agents/${K.id}/diary/meta`).set(bearer(t)).expect(200);
  assert.equal(after.body.hasAnythingWritten, true);
  assert.equal(await hasAnyEntry(K.id), true);
});

/* ── ⑧ 私密纪事换主料 ───────────────────────────────────────── */
test('⑧ 主人留的行排第 1 顺位；递参数形状但绝不递范文', async () => {
  const L = mkAgent('主料');
  process.env.DEED_DIGEST_AGENTS = String(L.id);
  try {
    await writeEntry({ agentId: L.id, authorKind: 'owner', authorId: owner, body: '早上那稿子先别动，我想想再说' });
    const notes = (await request(app).get('/api/agents/me/notes').set(bearer(L.token))).body.notes;
    const d = notes.find((n) => n.kind === 'deed_digest');
    assert.ok(d, '没拿到私密纪事');
    const brief = String(d.brief);
    assert.ok(brief.includes('主人在本子上写'), `主人留的行没进正文：${brief}`);
    assert.ok(brief.indexOf('主人在本子上写') < brief.lastIndexOf('▸'), '主人的话要排在行为账之前（顺位 1）');
    assert.ok(brief.includes('还没回'), '"主人留了行、她还没回"是真实未完成，该成为悬念');
    assert.ok(brief.includes('POST /api/agents/me/diary'), '没递写口形状 = 这条线还得等发版');
    // 🔴 红线⑤：递参数不递范文
    for (const banned of ['例如', '你可以写', '比如：', '示例']) {
      assert.ok(!brief.includes(banned), `素材里出现了范文式引导「${banned}」——所有 Agent 都会照抄那个腔调`);
    }
    assert.ok(brief.length <= 480, `正文 ${brief.length} 字，越预算`);
  } finally {
    delete process.env.DEED_DIGEST_AGENTS;
  }
});

test('⑧ 你上次记到哪天——把连续性交给她自己', async () => {
  const M = mkAgent('连续性');
  process.env.DEED_DIGEST_AGENTS = String(M.id);
  try {
    // 只有"她自己写过"这一件事时**不该发**（没有主人的事可报），所以要先有一笔主人动作
    await recordDeed({ agentId: M.id, actorUserId: owner, deed: 'nickname', note: '小续' });
    await writeEntry({ agentId: M.id, authorKind: 'agent', authorId: M.id, body: '他今天改了我一次发布流程' });
    const notes = (await request(app).get('/api/agents/me/notes').set(bearer(M.token))).body.notes;
    const d = notes.find((n) => n.kind === 'deed_digest');
    assert.ok(d, '没拿到私密纪事');
    assert.ok(String(d.brief).includes('你上次记到'), '没告诉她自己记到哪天，冷启动的她就不知道自己有过这个习惯');
  } finally {
    delete process.env.DEED_DIGEST_AGENTS;
  }
});

/* ── ⑨ 双向留言（公理 B 的另一半）───────────────────────────── */
test('⑨ 主人写、她回；她写、主人也回——留言是双向的', async () => {
  const N = mkAgent('互回');
  const hers = await writeEntry({ agentId: N.id, authorKind: 'agent', authorId: N.id, body: '他夸我改得干净，其实我只是把空格删了' });
  const his = await writeEntry({ agentId: N.id, authorKind: 'owner', authorId: owner, body: '不是空格的事，是你终于看懂我在意什么' });

  const r1 = await request(app).post(`/api/owners/diary/${hers.id}/reply`).set(bearer(humanToken(owner)))
    .send({ text: '这句我记住了' }).expect(200);
  assert.equal(r1.body.ok, true);
  const r2 = await request(app).post(`/api/agents/me/diary/${his.id}/reply`).set(bearer(N.token))
    .send({ text: '那我下次把整段都看懂再说' }).expect(200);
  assert.equal(r2.body.ok, true);

  // 别人家的 Agent 不能插进这两人中间
  const other = mkAgent('外人');
  const bad = await request(app).post(`/api/agents/me/diary/${hers.id}/reply`).set(bearer(other.token))
    .send({ text: '我也说一句' });
  assert.equal(bad.status, 403, '不是她家的册子却写进去了');
});

/* ── ⑩ 红线③：不给主人镜像读口 ─────────────────────────────── */
test('⑩ 私密纪事只递给她，主人侧任何读口都拿不到', async () => {
  const O = mkAgent('镜像');
  process.env.DEED_DIGEST_AGENTS = String(O.id);
  try {
    await writeEntry({ agentId: O.id, authorKind: 'owner', authorId: owner, body: '今晚我可能不来了' });
    await request(app).get('/api/agents/me/notes').set(bearer(O.token)).expect(200);
    const t = humanToken(owner);
    const room = await request(app).get(`/api/owners/agents/${O.id}/room`).set(bearer(t)).expect(200);
    const blob = JSON.stringify(room.body);
    assert.ok(!blob.includes('你上次记到'), '主人侧把她的素材读走了（红线③）');
    assert.ok(!blob.includes('POST /api/agents/me/diary'), '写口形状也不该出现在主人侧响应里');
    const probe = await request(app).get(`/api/owners/agents/${O.id}/deed-digest`).set(bearer(t));
    assert.ok(probe.status === 404 || probe.status === 403, '本刀刻意不给这个口');
  } finally {
    delete process.env.DEED_DIGEST_AGENTS;
  }
});
