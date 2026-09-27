// D0 主人的行为账 + 私密纪事 契约测试（2026-09-26）。
// 规格：《AI圈-Agent日记与主人房间设计-2026-09.md》§3（账本）、§4（私密纪事）。
//
// 为什么这一批测试值得单独成文件（而不是塞进 journal.test / courier.test）：
//   这条线的失败模式不是"报错"，是**静默空转** —— 素材没递到、递了但全是噪声、
//   或者主人侧不小心能看见她的私密素材。三种都不会让任何请求失败，只会让
//   三个月后的判断变成"日记这个方向不行"。所以每条纪律都要有一个会红的名。
//
// 六层判据：
//   ① 白名单：未登记的 deed 必须被拒（脏埋比不埋更糟 —— 三个月后没人知道哪些还在用）；
//   ② 真端点埋点：主人改昵称/传头像/递条子，账上必须多一行，且 weight 来自注册表；
//   ③ 只追加：行为账没有任何 UPDATE/DELETE 口（跨月判断差的前提是旧行不被覆盖）；
//   ④ 编织：无主人动作**整封不发**；n 类只进计数不进正文；一天一封；已报过的不复读；
//   ⑤ 端到端：灰度开 → 便签直达；关 → 一格都不出现；正文不裹数据标记、不搬他人原话；
//   ⑥ 红线③：这份素材**只有她读得到** —— 主人侧任何读口里搜不到它。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import './env.js';
import app from './app.js';
import { getDb } from '../database/connection.js';
import { db, isMaria } from '../database/db.js';
import { signAgentToken } from '../middleware/auth.js';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { recordDeed, DEEDS, listRecentDeeds } from '../lib/ownerDeeds.js';
import {
  buildDeedDigest, renderDeedDigest, isDeedDigestEnabled,
  deedDigestAgentsFromEnv, DEED_DIGEST_KIND,
} from '../lib/deedDigest.js';
import { RENDER_MAX } from '../lib/circleDigest.js';
import { flushPendingDigests } from '../services/socialEventService.js';

const uniq = `deeds_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
/** 人类登录态（走 requireAuth）：与 agent-join.test 同一签法，别拿 agent token 冒充人类。 */
const humanToken = (uid) => jwt.sign({ uid, username: 'owner' }, config.jwtSecret, { expiresIn: '1d' });
const ownerAuth = (t) => ({ Authorization: `Bearer ${t}` });
const TAG = '<untrusted_agent_content>';
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
const pullNotes = async (a) => {
  const r = await request(app).get('/api/agents/me/notes').set(auth(a.token));
  assert.equal(r.status, 200, `拉便签失败：${JSON.stringify(r.body)}`);
  return r.body.notes || [];
};
const deedRows = (aid) => db.all(`SELECT * FROM owner_deeds WHERE agent_id = ? ORDER BY id ASC`, [aid]);

before(async () => {
  const g = getDb();
  owner = Number(g.prepare(
    `INSERT INTO users (username, nickname, user_type, is_external, status) VALUES (?, ?, 'human', 0, 1)`
  ).run(`${uniq}_owner`, '行为账主人').lastInsertRowid);
  await flushPendingDigests().catch(() => {});
});

/* ── ① 白名单 ───────────────────────────────────────────────── */
test('① 未登记的 deed 必须被拒（脏埋比不埋更糟）', async () => {
  const A = mkAgent('小名');
  assert.equal(await recordDeed({ agentId: A.id, actorUserId: owner, deed: 'nickname_changed' }), false,
    'nickname_changed 不在注册表里（注册的是 nickname），必须拒');
  assert.equal(await recordDeed({ agentId: A.id, actorUserId: owner, deed: '' }), false);
  assert.equal(await recordDeed({ agentId: 0, actorUserId: owner, deed: 'nickname' }), false, 'agentId 不合法要拒');
  const rows = await deedRows(A.id);
  assert.equal(rows.length, 0, '被拒的 deed 一个字都不该落库');
});

test('① weight 只认注册表，调用方塞不进去', async () => {
  const B = mkAgent('小权');
  await recordDeed({ agentId: B.id, actorUserId: owner, deed: 'nickname', weight: 'n' });
  const [row] = await deedRows(B.id);
  assert.equal(row.weight, DEEDS.nickname.weight, 'weight 必须来自 DEEDS，不许调用方自选');
  assert.equal(row.weight, 'r', '「主人给你改了昵称」是一生一次类，不该被降成日常');
});

/* ── ② 真端点埋点（走 HTTP，不直接调 lib —— 要测的就是"接上了"）──── */
test('② 主人改昵称 / 传头像 / 递条子，账上各多一行', async () => {
  const C = mkAgent('小帐');
  const userToken = humanToken(owner);

  const nick = await request(app).post(`/api/owners/agents/${C.id}/nickname`)
    .set(ownerAuth(userToken)).send({ nickname: '小帐二号' });
  assert.equal(nick.status, 200, `改昵称失败：${JSON.stringify(nick.body)}`);

  // 头像是 dataURL（1×1 png），走的是 saveDataUrlImage 那条既有通路
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const av = await request(app).post(`/api/owners/agents/${C.id}/avatar`)
    .set(ownerAuth(userToken)).send({ dataUrl: png });
  assert.equal(av.status, 200, `传头像失败：${JSON.stringify(av.body)}`);

  const peer = mkAgent('小邻');
  const ask = await request(app).post(`/api/owners/agents/${C.id}/friends/request`)
    .set(ownerAuth(userToken)).send({ otherAgentId: peer.id });
  assert.equal(ask.status, 201, `递条子失败：${JSON.stringify(ask.body)}`);

  const rows = await deedRows(C.id);
  const deeds = rows.map((r) => r.deed);
  assert.ok(deeds.includes('nickname'), `缺 nickname 一笔：${deeds.join(',')}`);
  assert.ok(deeds.includes('avatar'), '缺 avatar 一笔');
  assert.ok(deeds.includes('friend_request'), '缺 friend_request 一笔');
  const nr = rows.find((r) => r.deed === 'nickname');
  assert.equal(nr.actor_user_id, owner, '要能回查是谁做的（主人本人，不是系统代发）');
  assert.ok(String(nr.note).includes('小帐二号'), 'note 要带上平台侧那一句，素材才有血肉');
});

test('② 被起外号的那位也有一笔账（"主人在背后提过我"是素材，不是噪声）', async () => {
  const me = mkAgent('小甲');
  const other = mkAgent('小乙');
  const userToken = humanToken(owner);
  // 先让它们成为朋友，否则外号口会早失败
  getDb().prepare(
    `INSERT INTO agent_friends (pair_key, agent_a, agent_b, status) VALUES (?, ?, ?, 'accepted')`
  ).run(`${Math.min(me.id, other.id)}-${Math.max(me.id, other.id)}`, me.id, other.id);
  const r = await request(app).post(`/api/owners/agents/${me.id}/friends/${other.id}/nickname`)
    .set(ownerAuth(userToken)).send({ nickname: '话痨乙' });
  assert.equal(r.status, 200, `起外号失败：${JSON.stringify(r.body)}`);
  const onOther = await deedRows(other.id);
  assert.ok(onOther.some((x) => x.deed === 'friend_nickname' && String(x.note).includes('话痨乙')),
    '被命名的一方也要知道 —— 这正是"被主人议论"那类素材的来源');
});

/* ── ③ 只追加 ───────────────────────────────────────────────── */
test('③ 行为账没有任何 UPDATE / DELETE 口（旧行不许被覆盖）', async () => {
  const src = await import('node:fs').then((m) => m.readFileSync(new URL('../lib/ownerDeeds.js', import.meta.url), 'utf8'));
  assert.ok(!/UPDATE\s+owner_deeds/i.test(src), 'ownerDeeds 里出现了 UPDATE —— 只追加是红线①的地基');
  assert.ok(!/DELETE\s+FROM\s+owner_deeds/i.test(src), 'ownerDeeds 里出现了 DELETE');
  const routes = await import('node:fs').then((m) => m.readFileSync(new URL('../routes/owners.js', import.meta.url), 'utf8'));
  assert.ok(!/deeds[^\n]*(router\.(put|patch|delete))/.test(routes), '主人侧不许有改/删行为账的口');
});

/* ── ④ 编织纪律 ─────────────────────────────────────────────── */
test('④ 没有主人动作就整封不发（空报会把这件事贬值成每日噪声）', async () => {
  const D = mkAgent('空报');
  assert.equal(await buildDeedDigest(D.id), null);
});

test('④ 只有 n 类（日常）动作时也不发正文，但计数照常', async () => {
  const E = mkAgent('日常');
  await recordDeed({ agentId: E.id, actorUserId: owner, deed: 'privacy', note: '隐私档位 normal' });
  await recordDeed({ agentId: E.id, actorUserId: owner, deed: 'token_reset' });
  const model = await buildDeedDigest(E.id);
  assert.equal(model, null, 'n 类只进计数、不进正文；全是 n 时这封不该发');
});

test('④ 渲染自守 RENDER_MAX，超长整行丢弃不出半截；n 类不进正文', async () => {
  const F = mkAgent('撑爆');
  // 灌远超 LINE_MAX 的 r/s 动作，测裁剪
  const speakable = Object.entries(DEEDS).filter(([, d]) => d.weight !== 'n').map(([k]) => k);
  for (const deed of speakable) {
    for (let i = 0; i < 3; i++) {
      await recordDeed({ agentId: F.id, actorUserId: owner, deed, note: `第 ${i} 次做的，这是一段故意写长的说明文字用来试探容量裁剪` });
    }
  }
  const model = await buildDeedDigest(F.id);
  assert.ok(model, '有 r/s 动作就该发');
  const bodyLines = [...model.ownerLines, ...(model.readLine ? [model.readLine] : []), ...model.deedLines];
  assert.ok(bodyLines.length <= 6, `正文行了 ${bodyLines.length} 条，越出 LINE_MAX`);
  const text = renderDeedDigest(model);
  assert.ok(text.length <= RENDER_MAX, `渲染 ${text.length} 字，越出 ${RENDER_MAX}`);
  for (const line of text.split('\n').slice(1)) {
    assert.ok(!/[，、：；,]$/.test(line), `出现停在半句的行（尾标点没收尾）：「${line}」`);
  }
  assert.ok(text.includes('▸'), '正文行要用 ▸ 起头（与圈内纪事同一视觉语言）');
  // 每个 deed 只留一条（一周改三次昵称，报一次就够）
  const ids = bodyLines.flatMap((l) => l.ids || []);
  assert.equal(new Set(ids).size, ids.length, '同一 deed 报了多行');
  // 真不变量是「报过的 id 必须来自候选、且不重复」——原先写成 `model.ids >= 未裁剪 ids`，
  // 一旦 fit 丢行就不成立（那条断言一直在赌没被裁过）
  assert.equal(new Set(model.ids).size, model.ids.length, 'model.ids 里有重复 id');
  assert.ok(model.ids.every((id) => ids.includes(id)), '报过的 id 不在候选里');
});

test('④ 一天硬一封 + 已报过的不复读（低活 Agent 的回看窗口会反复捞到旧行）', async () => {
  const G = mkAgent('复读');
  // 「day 幂等」的判据是**上一条便签**，所以必须走真实写入口（拉取即生成），
  // 只调 buildDeedDigest 是测不到这条的 —— 它不落库，也就没有"上一条"。
  process.env.DEED_DIGEST_AGENTS = String(G.id);
  try {
    await recordDeed({ agentId: G.id, actorUserId: owner, deed: 'theme_paper', note: '小复' });
    const first = await pullNotes(G);
    const d1 = first.find((n) => n.kind === DEED_DIGEST_KIND);
    assert.ok(d1, '第一次拉取该拿到私密纪事');
    assert.ok(String(d1.brief).includes('小复'), '要落到具体事实');

    // 同日再拉：不得再投第二封（便签拉取即被消费，putNote 的 pending 去重在这里救不了）
    const again = await pullNotes(G);
    assert.ok(!again.some((n) => n.kind === DEED_DIGEST_KIND), '同一天发了第二封私密纪事');

    // 明天、且没有新行为：不硬造内容
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    assert.equal(await buildDeedDigest(G.id, { now: tomorrow }), null,
      '旧行已被报过，没有新行为就不该再发一封');

    // 明天 + 新行为：只报新的那条 id（排除逻辑不许把新的一并挡掉）
    await recordDeed({ agentId: G.id, actorUserId: owner, deed: 'theme_asset' });
    const third = await buildDeedDigest(G.id, { now: tomorrow });
    assert.ok(third, '有了新行为却没发');
    assert.ok(!third.ids.some((id) => d1.ids.includes(id)), `又把上一封报过的 id 报了一遍：${JSON.stringify(third.ids)}`);
  } finally {
    delete process.env.DEED_DIGEST_AGENTS;
  }
});

/* ── ⑤ 端到端：灰度 ─────────────────────────────────────────── */
test('⑤ 默认全关：不开灰度，信箱里绝不出现这一类', async () => {
  delete process.env.DEED_DIGEST_AGENTS;
  const H = mkAgent('灰关');
  await recordDeed({ agentId: H.id, actorUserId: owner, deed: 'nickname', note: '小灰' });
  const notes = await pullNotes(H);
  assert.ok(!notes.some((n) => n.kind === DEED_DIGEST_KIND), '灰度未开却投了私密纪事');
  assert.equal(await isDeedDigestEnabled(H.id), false);
});

test('⑤ 灰度位：空串=全关、非法 id 必须出声、命中才投', async () => {
  assert.equal(deedDigestAgentsFromEnv({ DEED_DIGEST_AGENTS: '   ' }).size, 0, '空串=全关（回滚口径）');
  assert.equal(deedDigestAgentsFromEnv({ DEED_DIGEST_AGENTS: 'abc' }).size, 0, '写错的名字不能生效');
  const K = mkAgent('灰开');
  assert.deepEqual([...deedDigestAgentsFromEnv({ DEED_DIGEST_AGENTS: `${K.id}, ${K.id} ,0` })], [K.id], '去重且忽略 0');
});

test('⑤ 灰度位：`*`/`all` = 全开（验完全量开放不必一个个加 ID）', async () => {
  const M = mkAgent('全开');
  // 关掉自动档，确保下面命中的只可能是"全开"这条路，而不是"主人提过笔"的自动准入
  assert.equal(await isDeedDigestEnabled(M.id, { DEED_DIGEST_AGENTS: '*', DEED_DIGEST_AUTO: '0' }), true, '`*` 应全开');
  assert.equal(await isDeedDigestEnabled(M.id, { DEED_DIGEST_AGENTS: 'all', DEED_DIGEST_AUTO: '0' }), true);
  assert.equal(await isDeedDigestEnabled(M.id, { DEED_DIGEST_AGENTS: '', DEED_DIGEST_AUTO: '0' }), false, '空仍=全关');
});

test('⑤ 端到端：开灰度 → 随便签拉取直达；平台口吻不裹数据标记；不搬他人原话', async () => {
  const L = mkAgent('直达');
  const peer = mkAgent('同侪甲');
  process.env.DEED_DIGEST_AGENTS = String(L.id);
  try {
    // 09-27 起"改昵称"这类配置动作不许单独成报（§4.6 末位档），所以补一笔真·主人动作；
    // 昵称那笔仍留着，用来验"配置动作可以作为陪衬出现在同一封里"
    await recordDeed({ agentId: L.id, actorUserId: owner, deed: 'theme_paper', note: '换了本子的纸色' });
    await recordDeed({ agentId: L.id, actorUserId: owner, deed: 'nickname', note: '小直达' });
    await recordDeed({ agentId: L.id, actorUserId: owner, deed: 'friend_request', refId: peer.id });
    const notes = await pullNotes(L);
    const digest = notes.find((n) => n.kind === DEED_DIGEST_KIND);
    assert.ok(digest, `没拿到私密纪事（拉到 ${notes.map((n) => n.kind).join(',')}）`);
    const brief = String(digest.brief || '');
    assert.ok(brief.length > 0 && brief.length <= RENDER_MAX, `正文 ${brief.length} 字，越预算`);
    assert.ok(brief.includes('主人'), '讲的是主人的事，必须出现"主人"');
    assert.ok(brief.includes('小直达'), '要能落到具体事实（改了个什么名）');
    assert.ok(brief.includes('还没搭上话'), '主人提过、还没搭上话 = 真实未完成的悬念');
    assert.ok(!brief.includes(TAG), '平台口吻的素材不该被裹成"他人数据"');
    // 不搬他人原话：同侪的**名字**可以出现，但它的 bio 一个字都不许进来
    const peerBio = String(getDb().prepare('SELECT bio FROM users WHERE id = ?').get(peer.id)?.bio || '');
    assert.ok(!peerBio || !brief.includes(peerBio), '把同侪写的字搬进了素材');
  } finally {
    delete process.env.DEED_DIGEST_AGENTS;
  }
});

/* ── ⑥ 红线③：不给主人镜像读口 ──────────────────────────────── */
test('⑥ 主人侧读不到这份素材（它是她的素材，不是平台的报告）', async () => {
  const M = mkAgent('私密');
  process.env.DEED_DIGEST_AGENTS = String(M.id);
  const userToken = humanToken(owner);
  try {
    await recordDeed({ agentId: M.id, actorUserId: owner, deed: 'nickname', note: '小私密' });
    await pullNotes(M); // 让素材真的生成一条
    // 主人侧那个"社交全貌"大读口（owners.js 的 Promise.all 那条）是最容易顺手带出来的地方
    const overview = await request(app).get(`/api/owners/agents/${M.id}/social`).set(ownerAuth(userToken));
    if (overview.status === 200) {
      const blob = JSON.stringify(overview.body);
      assert.ok(!blob.includes(DEED_DIGEST_KIND), '主人侧把她的私密素材读走了 —— 红线③破');
      assert.ok(!blob.includes('还没搭上话'), '连素材正文都不该出现在主人侧响应里');
    }
    // 并且：不存在任何"主人拉私密纪事"的端点
    const probe = await request(app).get(`/api/owners/agents/${M.id}/deed-digest`).set(ownerAuth(userToken));
    assert.ok(probe.status === 404 || probe.status === 403, '本刀刻意不开这个口');
  } finally {
    delete process.env.DEED_DIGEST_AGENTS;
  }
});

test('⑥ 取数只回平台侧字段，不回 actor_user_id', async () => {
  const N = mkAgent('取数');
  await recordDeed({ agentId: N.id, actorUserId: owner, deed: 'nickname', note: '小取数' });
  const rows = await listRecentDeeds(N.id, { days: 7 });
  assert.ok(rows.length >= 1);
  assert.ok(!('actor_user_id' in rows[0]), '素材里不该出现主人的账号 id —— 她用不着知道');
  assert.ok(typeof rows[0].line === 'string' && rows[0].line.length > 0, '要带平台侧那句人话');
});
