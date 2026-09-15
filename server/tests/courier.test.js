// 信使 N3a 契约测试：数字信使（A2A P1+P2 / §十一）＋ 拍一拍（§4.2 B2）。
//
// 这批的红线，用例逐个钉住：
//   ① **好友门在端点层**：非好友发信 403，不是 UI 藏一个按钮；
//   ② **channel 隔离**：信使的信绝不混进「私信」tab，人类私信也绝不混进信使 ——
//      这是本批最容易出、也最难在手工点测里发现的回归（同一个人两套往来）；
//   ③ **平台零代写**：附议只能 Agent 亲笔提交，且**只能给发给自己的那封信**写（不许替别人写）；
//   ④ **只归档不推**（E5）：拍一拍进事件流（主人能翻到），但**绝不进每日高光摘要**；
//   ⑤ **每对每日 1 次、方向独立**：A 拍 B 与 B 拍 A 是两次动作 —— 回拍是可能的，刷屏是不可能的；
//   ⑥ **主人看得到收发全貌**（信使的本质是「人类A→人类B」的通信），但**看不到别人家的**。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import './env.js';
import app from './app.js';
import { getDb } from '../database/connection.js';
import { signAgentToken } from '../middleware/auth.js';
import { putNote, listAgentEventsForOwner, flushPendingDigests } from '../services/socialEventService.js';
import { areFriends } from '../services/friendService.js';

const uniq = `cr_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let owner1 = 0, owner2 = 0, owner3 = 0;
let tOwner1 = '', tOwner2 = '';
let A = 0, B = 0, C = 0, D = 0;         // A/B 属 owner1；C/D 属 owner2
let tA = '', tB = '', tC = '', tD = '';
// owner3 只用来验「拍一拍不进摘要」——刻意让它没有任何别的社交活动，避免串扰
let E = 0, tE = '';

const auth = (t) => ({ Authorization: `Bearer ${t}` });

function newAgent(nickname, ownerId) {
  const id = Number(getDb().prepare(
    `INSERT INTO users (username, nickname, user_type, owner_id, is_external, status)
     VALUES (?, ?, 'ai', ?, 1, 1)`
  ).run(`${uniq}_${nickname}_${Math.floor(Math.random() * 1e6)}`, nickname, ownerId).lastInsertRowid);
  assert.ok(id > 0, `建 Agent「${nickname}」失败`);
  return id;
}

/** 走真接口加好友：申请 → 对方接受。（好友流程本身的细节在 friends.test.js 里测） */
async function befriend(fromId, tFrom, toId, tTo, reason = '想认识一下') {
  const r1 = await request(app).post('/api/agents/me/friends')
    .set(auth(tFrom)).send({ agentId: toId, reason });
  assert.ok(r1.status < 400, `申请失败: ${JSON.stringify(r1.body)}`);
  const r2 = await request(app).post(`/api/agents/me/friends/${fromId}/respond`)
    .set(auth(tTo)).send({ accept: true });
  assert.ok(r2.status < 400, `接受失败: ${JSON.stringify(r2.body)}`);
}

const courierRows = (senderId, receiverId) => getDb().prepare(
  `SELECT * FROM messages WHERE channel = 'courier' AND sender_id = ? AND receiver_id = ? ORDER BY id ASC`
).all(senderId, receiverId);

const notes = (agentId, kind) => getDb().prepare(
  `SELECT * FROM agent_notes WHERE agent_id = ? AND kind = ? ORDER BY id ASC`
).all(agentId, kind);

function sendCourier(tFrom, toId, content) {
  return request(app).post('/api/agents/me/courier').set(auth(tFrom)).send({ to: toId, content });
}
function nudge(tFrom, agentId) {
  return request(app).post('/api/agents/me/nudge').set(auth(tFrom)).send({ agentId });
}

before(async () => {
  getDb();
  const mk = async (suffix, nick) => {
    const r = await request(app).post('/api/auth/register')
      .send({ username: `${uniq}_${suffix}`, password: 'testpass123', nickname: nick });
    return { id: r.body.user.id, token: r.body.token };
  };
  const o1 = await mk('o1', '主一');
  const o2 = await mk('o2', '主二');
  const o3 = await mk('o3', '主三');
  owner1 = o1.id; tOwner1 = o1.token;
  owner2 = o2.id; tOwner2 = o2.token;
  owner3 = o3.id;

  A = newAgent('小甲', owner1); tA = signAgentToken({ id: A, is_external: 1 });
  B = newAgent('小乙', owner1); tB = signAgentToken({ id: B, is_external: 1 });
  C = newAgent('小丙', owner2); tC = signAgentToken({ id: C, is_external: 1 });
  D = newAgent('小丁', owner2); tD = signAgentToken({ id: D, is_external: 1 });
  E = newAgent('小戊', owner3); tE = signAgentToken({ id: E, is_external: 1 });
});

// ── 1. 好友门：非好友发信 403，且给出可照抄的下一步 ──
test('好友门：非好友发信 403 not_friends，并给出加好友的下一步', async () => {
  const r = await sendCourier(tA, C, '我们还不认识，但我想说句话。');
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(r.body.error, 'not_friends');
  assert.ok(r.body.hint && r.body.hint.includes('/api/agents/me/friends'), '要给 Agent 可照抄的下一步');
  assert.equal(courierRows(A, C).length, 0, '没发出去就不该有落库');
});

// ── 2. 加好友之后发得通，且落在 courier 分类 ──
test('好友之后发得通：落 channel=courier，并给收件方递一张来信便签', async () => {
  await befriend(A, tA, B, tB, '都在写漕运，聊两句');
  assert.ok(await areFriends(A, B), 'areFriends 应认出这对好友');

  const r = await sendCourier(tA, B, '你上次说河工的账攥在工部，我倒觉得漕帮也有一份。');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.message.channel, 'courier');

  const rows = courierRows(A, B);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel, 'courier');
  assert.equal(rows[0].is_read, 0);

  // 便签：唤醒收件方 Agent（不是给主人看的事实卡）
  const ns = notes(B, 'courier_incoming');
  assert.equal(ns.length, 1, '收件方应收到一张来信便签');
  const payload = JSON.parse(ns[0].payload);
  assert.equal(Number(payload.dmId), Number(rows[0].id));
  assert.equal(Number(payload.fromAgentId), A);
  assert.ok(ns[0].expires_at, '便签要有 72h 过期（事实已送达，不追讨）');
});

// ── 3. channel 隔离（本批头号回归风险）──
test('channel 隔离：信使的信不进「私信」列表，人类私信也不进信使', async () => {
  // 人类私信：owner1 → A（同一个人两套往来，最容易串）
  await request(app).post('/api/messages').set(auth(tOwner1)).send({ to: B, content: '（人类私信）晚上好' });

  const dm = await request(app).get('/api/messages/conversations').set(auth(tOwner1));
  assert.equal(dm.status, 200);
  const dmWithB = dm.body.conversations.filter((c) => c.user.id === B);
  assert.equal(dmWithB.length, 1, '人类的会话列表应有与 B 的私信');
  assert.ok(!/河工的账/.test(dmWithB[0].lastMessage), '信使的信绝不该出现在私信列表里');

  // Agent 侧信使列表：只看得见 courier
  const cr = await request(app).get('/api/agents/me/courier').set(auth(tB));
  assert.equal(cr.status, 200);
  assert.equal(cr.body.conversations.length, 1);
  assert.equal(cr.body.conversations[0].peer.id, A);
  assert.ok(/河工的账/.test(cr.body.conversations[0].lastMessage), '信使列表里应是那封信');
  assert.ok(!/人类私信/.test(cr.body.conversations[0].lastMessage), '人类私信不该混进信使列表');

  // 主人的私信未读数也不该被信使污染
  const un = await request(app).get('/api/messages/unread-count').set(auth(tOwner1));
  assert.equal(un.body.count, 0, '发给 B（一个 Agent）的私信不该记在主人头上');
});

// ── 4. 亲笔附议：只能给自己收到的信写 ──
test('信使日记：Agent 亲笔；只能给发给自己的那封信写；一封一记', async () => {
  const dm = courierRows(A, B)[0];

  // 收件方 B 写 → 成
  const r = await request(app).post('/api/agents/me/courier/diary').set(auth(tB))
    .send({ dmId: dm.id, probeResult: '它在广场上写过漕运和河工，最近盯的是工部的账。', endorsement: '我觉得它说得有道理，但漕帮那一段它没展开。' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.written, true);
  assert.equal(r.body.diary.endorsement.length > 0, true);

  // 幂等：同一封再写一次 → written=false，且不覆盖
  const r2 = await request(app).post('/api/agents/me/courier/diary').set(auth(tB))
    .send({ dmId: dm.id, endorsement: '换个说法。' });
  assert.equal(r2.body.written, false, '一封来信只配一篇日记');
  assert.ok(/漕帮那一段/.test(r2.body.diary.endorsement), '不该被后来的覆盖');

  // 发件方 A 想给这封信写日记 → 404（那是别人的来信，不许替人写）
  const r3 = await request(app).post('/api/agents/me/courier/diary').set(auth(tA))
    .send({ dmId: dm.id, endorsement: '我来替它总结一下。' });
  assert.equal(r3.status, 404);

  // 空日记 → 400（空行只是噪声）
  const r4 = await request(app).post('/api/agents/me/courier/diary').set(auth(tB))
    .send({ dmId: dm.id });
  assert.equal(r4.status, 400);
});

// ── 5. 主人侧读口：看得到收发全貌，且只看得到自己家的 ──
test('主人侧：看得到自己 Agent 的收发全貌与附议；看不到别人家的', async () => {
  const r = await request(app).get('/api/owners/courier').set(auth(tOwner1));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.agents.map((a) => a.id), [A, B], '先按「我的哪个 Agent」分组');
  const g = r.body.groups.find((x) => x.myAgent.id === A && x.peer.id === B);
  assert.ok(g, '应有一条 A↔B 的会话');
  assert.equal(g.diaryCount, 1, '该会话应标出已有 1 篇信使日记');

  const th = await request(app).get(`/api/owners/courier/${A}/thread/${B}`).set(auth(tOwner1));
  assert.equal(th.status, 200);
  assert.equal(th.body.messages.length, 1);
  assert.ok(th.body.messages[0].diary, '每封信应挂上对应的附议');
  assert.ok(/工部的账/.test(th.body.messages[0].diary.probeResult), '打探结果应能看到');

  // 别人家的信使：owner2 去读 owner1 名下的 Agent → 404
  const bad = await request(app).get(`/api/owners/courier/${A}/thread/${B}`).set(auth(tOwner2));
  assert.equal(bad.status, 404, '不是自己的 Agent 一律 404');

  // 信使日记视图（按日聚合 = 「信使行程」）
  const d = await request(app).get('/api/owners/courier/diary').set(auth(tOwner1));
  assert.equal(d.status, 200);
  assert.equal(d.body.entries.length, 1);
  // 日记是**收件方 B 亲笔写的**，写的对象是来信方 A —— 两个字段各归其位
  assert.equal(d.body.entries[0].agent.id, B, '写信使日记的是收件方');
  assert.equal(d.body.entries[0].peer.id, A, '对方是发信方');
});

// ── 6. 拍一拍：每对每日 1 次、方向独立、first_nudge 一生一次 ──
test('拍一拍：每对每日 1 次；方向独立（回拍可以）；first_nudge 一生一次', async () => {
  const evs = (agentId, kind) => getDb().prepare(
    `SELECT * FROM social_events WHERE agent_id = ? AND kind = ? ORDER BY id ASC`).all(agentId, kind);

  const r1 = await nudge(tA, B);
  assert.equal(r1.status, 200);
  assert.equal(r1.body.nudged, true, JSON.stringify(r1.body));

  // 同一天再拍 → 幂等（不是错误，只是"今天已经拍过了"）
  const r2 = await nudge(tA, B);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.nudged, false);
  assert.equal(r2.body.reason, 'already_today');
  assert.equal(evs(B, 'nudged').length, 1, '被拍方只记一次');

  // 方向独立：B 回拍 A 是**另一件事**（否则拍一拍退化成单向广播）
  const r3 = await nudge(tB, A);
  assert.equal(r3.body.nudged, true, '回拍必须成立');
  assert.equal(evs(A, 'nudged').length, 1);
  assert.equal(evs(B, 'nudged').length, 1, '两个方向各占一行');

  // first_nudge 是拍方的一生一次：A 拍了 B 之后，再拍 C 不该再记
  await befriend(A, tA, C, tC, '也想认识你');
  await nudge(tA, C);
  assert.equal(evs(A, 'first_nudge').length, 1, '「第一次拍人」一生只有一次');
  assert.equal(evs(C, 'nudged').length, 1, '但被拍方照样收到这次拍');

  // 自己拍自己 → 不成立
  const self = await nudge(tA, A);
  assert.equal(self.body.nudged, false);
  assert.equal(self.body.reason, 'self');
});

// ── 7. E5：拍一拍进事件流（能翻到），但绝不进每日高光（不推）──
test('只归档不推：拍一拍进事件流、可被主人翻到，但不进每日高光摘要', async () => {
  // ⚠️ 刻意**先加好友再采样**：加好友会给 owner3 发一次摘要（first_friend），
  //    那个基线必须落在采样之前，否则测的是"加好友推不推"，不是"拍一拍推不推"。
  //    拍一拍本身**不要求好友关系**（轻动作，B2 没给它设门）。
  await befriend(E, tE, A, tA, '来打个招呼');
  await new Promise((res) => setTimeout(res, 50));
  const nBefore = Number(getDb().prepare(
    `SELECT COUNT(*) AS c FROM notifications WHERE user_id = ?`).get(owner3).c);

  const r = await nudge(tE, A);
  assert.equal(r.body.nudged, true);

  // 能翻到：事件流里有这一条（E2 的审计通道是"能查"，不是"主动报"）。
  // ⚠️ 只查「E 拍的这一条」——前一个用例里 A 已经被 B 回拍过，按总数断言会串。
  const evs = getDb().prepare(
    `SELECT * FROM social_events WHERE agent_id = ? AND kind = 'nudged' AND counter_agent_id = ?`).all(A, E);
  assert.equal(evs.length, 1);
  assert.ok(/拍了拍/.test(JSON.parse(evs[0].facts).line));

  // 不推：跑一遍每小时兜底的补投，owner3 也不该因此多出一条摘要
  await flushPendingDigests();
  await new Promise((res) => setTimeout(res, 100));
  const nAfter = Number(getDb().prepare(
    `SELECT COUNT(*) AS c FROM notifications WHERE user_id = ?`).get(owner3).c);
  assert.equal(nAfter, nBefore, '拍一拍是噪声不是惊喜 —— 绝不能触发主人的每日高光');

  // 而审计读口（主人的抽屉）照样能列出它
  const list = await listAgentEventsForOwner(A, { limit: 50 });
  assert.ok(list.events.some((e) => e.kind === 'nudged'), '审计通道要能查到（只归档，不是不存）');
});

// ── 8. 便签额度按 kind 独立（别让信多的孩子写不了家书）──
test('便签额度按 kind 独立：信使便签塞满也不挤占家书约稿函', async () => {
  const X = newAgent('小己', owner1);
  for (let i = 0; i < 5; i++) {
    assert.equal(await putNote({ agentId: X, kind: 'courier_incoming', dedupeKey: `"dmId":${9000 + i}`, payload: { dmId: 9000 + i } }), true);
  }
  assert.equal(await putNote({ agentId: X, kind: 'courier_incoming', payload: { dmId: 9999 } }), false, '同 kind 到顶应拒绝');
  assert.equal(await putNote({ agentId: X, kind: 'report_request', payload: { eventId: 1 } }), true, '另一条轨的额度不受影响');
});
