// 托付箱契约测试（§11.7 拍板 A：主人那封信怎么「经 Agent 发出」）。
//
// 这一跳为什么值得单独测：它是「4 方参与」里唯一由**人类**发起、却必须由 **Agent** 完成的一跳。
// 走"平台代发"（选项 B）也能把信送到，但那样 Agent 没参与、署名来自平台 —— 功能看起来一样，
// 红线的位置却完全不同。所以用例逐个钉住这几条：
//   ① **托付 ≠ 送达**：主人写完只是落了 `pending`，`messages` 里**一个字都没有**；
//   ② **好友门查两次**：写信时查（早失败，不让托付箱攒死信），转交时再查（中间可能被解除）；
//   ③ **原话一字不改**：信使可以添自己一句话，但不能动主人的字（附言有明确署名分隔）；
//   ④ **越权不可见**：只能转交自己名下的托付，别人的托付对外 404（不区分「不存在」与「不是你的」）；
//   ⑤ **幂等**：重复转交不重复发；已送出的撤不回来、未送出的可以撤；
//   ⑥ **主人看得到收发全貌**：转交之后，这封信就该出现在主人侧的信使读口里。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
// supertest 换成 netprobe 包装：同形 API，但红的时候会把「应答方 addr:port」打进报错
// （2026-09-28 排查随机红时撞到一个 401，响应体形状本仓库根本不产出——见 tests/lib/netprobe.js）
import { probe, diag } from './lib/netprobe.js';

import './env.js';
import app from './app.js';
import { getDb } from '../database/connection.js';
import { signAgentToken } from '../middleware/auth.js';
import { areFriends, blockFriend } from '../services/friendService.js';

const uniq = `ob_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let owner1 = 0, owner3 = 0;
let tOwner1 = '', tOwner3 = '';
let A = 0, B = 0, C = 0;   // A/B 属 owner1；C 属 owner2
let tA = '', tB = '', tC = '';

const auth = (t) => ({ Authorization: `Bearer ${t}` });

function newAgent(nickname, ownerId) {
  const id = Number(getDb().prepare(
    `INSERT INTO users (username, nickname, user_type, owner_id, is_external, status)
     VALUES (?, ?, 'ai', ?, 1, 1)`
  ).run(`${uniq}_${nickname}_${Math.floor(Math.random() * 1e6)}`, nickname, ownerId).lastInsertRowid);
  assert.ok(id > 0, `建 Agent「${nickname}」失败`);
  return id;
}

async function befriend(fromId, tFrom, toId, tTo, reason = '想认识一下') {
  const r1 = await probe(app).post('/api/agents/me/friends')
    .set(auth(tFrom)).send({ agentId: toId, reason });
  assert.ok(r1.status < 400, `申请失败: ${JSON.stringify(r1.body)}`);
  const r2 = await probe(app).post(`/api/agents/me/friends/${fromId}/respond`)
    .set(auth(tTo)).send({ accept: true });
  assert.ok(r2.status < 400, `接受失败: ${JSON.stringify(r2.body)}`);
}

/** 主人写一封信，托付给自家 Agent。 */
const writeOutbox = (tOwner, agentId, toAgentId, content) =>
  probe(app).post('/api/owners/courier/outbox').set(auth(tOwner))
    .send({ agentId, toAgentId, content });

/** Agent 转交一封托付的信。 */
const sendOutbox = (tAgent, outboxId, note) =>
  probe(app).post(`/api/agents/me/courier/outbox/${outboxId}/send`).set(auth(tAgent)).send({ note });

const outboxRows = (agentId) => getDb().prepare(
  `SELECT * FROM courier_outbox WHERE agent_id = ? ORDER BY id ASC`
).all(agentId);
const outboxRow = (id) => getDb().prepare(`SELECT * FROM courier_outbox WHERE id = ?`).get(id);
const courierRows = (senderId, receiverId) => getDb().prepare(
  `SELECT * FROM messages WHERE channel = 'courier' AND sender_id = ? AND receiver_id = ? ORDER BY id ASC`
).all(senderId, receiverId);
const notes = (agentId, kind) => getDb().prepare(
  `SELECT * FROM agent_notes WHERE agent_id = ? AND kind = ? ORDER BY id ASC`
).all(agentId, kind);

before(async () => {
  getDb();
  const mk = async (suffix, nick) => {
    const r = await probe(app).post('/api/auth/register')
      .send({ username: `${uniq}_${suffix}`, password: 'testpass123', nickname: nick });
    return { id: r.body.user.id, token: r.body.token };
  };
  const o1 = await mk('o1', '托主一');
  const o2 = await mk('o2', '托主二');
  const o3 = await mk('o3', '托主三');
  owner1 = o1.id; tOwner1 = o1.token;
  owner3 = o3.id; tOwner3 = o3.token;

  A = newAgent('寄信甲', owner1); tA = signAgentToken({ id: A, is_external: 1 });
  B = newAgent('寄信乙', owner1); tB = signAgentToken({ id: B, is_external: 1 });
  C = newAgent('收信丙', o2.id); tC = signAgentToken({ id: C, is_external: 1 });
});

// ── 1. 好友门：写信时就拦（不让托付箱攒死信）──
test('好友门：非好友时写信 403 not_friends，且一个字都不落库', async () => {
  const r = await writeOutbox(tOwner1, A, C, '我们还不认识，但我想捎句话。');
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(r.body.error, 'not_friends');
  assert.ok(r.body.hint && r.body.hint.includes('/api/agents/me/friends'), '要给可执行的下一步');
  assert.equal(outboxRows(A).length, 0, '被拦下就不该有落库');
});

// ── 2. 只能拿自己名下的 Agent 写信 ──
test('越权写信：拿别人的 Agent 托付 → 404', async () => {
  const r = await writeOutbox(tOwner3, A, C, '我不是它的主人。');
  assert.equal(r.status, 404, JSON.stringify(r.body));
  assert.equal(outboxRows(A).length, 0);
});

// ── 3. 托付 ≠ 送达（本批最核心的一条）──
test('托付只是 pending：落 courier_outbox 并递便签，但 messages 里一个字都没有', async () => {
  await befriend(A, tA, C, tC, '都在写漕运，聊两句');
  assert.ok(await areFriends(A, C), 'areFriends 应认出这对好友');

  const r = await writeOutbox(tOwner1, A, C, '漕运那笔账，你那边是怎么记的？');
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.entry.status, 'pending');
  assert.equal(r.body.entry.peer.id, C);
  assert.equal(r.body.entry.dmId, null, '还没送出，不该有 dm_id');

  // **关键**：托付不等于送达
  assert.equal(courierRows(A, C).length, 0, '还没转交，信就不该出现在 messages 里');

  const ns = notes(A, 'courier_outbox');
  assert.equal(ns.length, 1, '应给自家 Agent 递一张托付便签');
  const payload = JSON.parse(ns[0].payload);
  assert.equal(Number(payload.outboxId), Number(r.body.entry.id));
  assert.equal(Number(payload.toAgentId), C);
  assert.ok(ns[0].expires_at, '便签要有 72h 过期');
});

// ── 4. Agent 拉待办：只拉得到自己名下的 ──
test('Agent 拉待办：看得到自己那封，看不到别人名下的', async () => {
  const r = await probe(app).get('/api/agents/me/courier/outbox').set(auth(tA));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.entries.length, 1);
  assert.equal(r.body.entries[0].peer.id, C);
  assert.equal(r.body.entries[0].content, '漕运那笔账，你那边是怎么记的？');

  // B 不是托付对象，待办应为空
  const rb = await probe(app).get('/api/agents/me/courier/outbox').set(auth(tB));
  assert.equal(rb.body.entries.length, 0, 'B 名下没有托付');
});

// ── 5. 越权转交 → 404 ──
test('越权转交：别人的托付转不了 → 404', async () => {
  const id = outboxRows(A)[0].id;
  const r = await sendOutbox(tB, id);
  assert.equal(r.status, 404, JSON.stringify(r.body));
  assert.equal(courierRows(A, C).length, 0, '不该被发出去');
});

// ── 6. 转交成功：落 courier 信 + 回填 dm_id + 给收件方递便签 ──
test('转交成功：原话一字不改地落 channel=courier，outbox 变 sent 并回填 dm_id', async () => {
  const id = outboxRows(A)[0].id;
  const r = await sendOutbox(tA, id, null);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sent, true);
  assert.ok(Number(r.body.dmId) > 0, '要把 dm_id 回传');

  const rows = courierRows(A, C);
  assert.equal(rows.length, 1, '信应该真的发出去了');
  assert.equal(rows[0].channel, 'courier');
  assert.equal(rows[0].content, '漕运那笔账，你那边是怎么记的？', '主人原话必须一字不改');

  const ob = outboxRow(id);
  assert.equal(ob.status, 'sent');
  assert.equal(Number(ob.dm_id), Number(rows[0].id));
  assert.ok(ob.sent_at, '要有 sent_at');

  assert.equal(notes(C, 'courier_incoming').length, 1, '收件方应收到来信便签');
});

// ── 7. 重复转交幂等 ──
test('重复转交幂等：第二次返回 already_sent，且不重复发信', async () => {
  const id = outboxRows(A)[0].id;
  const r = await sendOutbox(tA, id, null);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sent, false);
  assert.equal(r.body.reason, 'already_sent');
  assert.ok(Number(r.body.dmId) > 0, '要把既成事实的 dm_id 告诉它');
  assert.equal(courierRows(A, C).length, 1, '绝不能重复发');
});

// ── 8. 带附言：原话仍在，附言有明确署名分隔 ──
test('信使附言：原话一字不改，附言带署名分隔；附言超长 400', async () => {
  const w = await writeOutbox(tOwner1, A, C, '第二封：河工的账我查到了。');
  assert.equal(w.status, 201, JSON.stringify(w.body));
  const id = w.body.entry.id;

  const r = await sendOutbox(tA, id, '我补一句：它家最近在写河工，可以顺着聊。');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const body = r.body.message.content;
  assert.ok(body.includes('第二封：河工的账我查到了。'), '主人原话必须原样在里面');
  assert.ok(body.includes('信使附言'), '附言要有明确署名分隔');
  assert.ok(body.includes('我补一句'), '附言内容要在里面');

  // 附言超长
  const w2 = await writeOutbox(tOwner1, A, C, '第三封：再试一次。');
  const s2 = await sendOutbox(tA, w2.body.entry.id, 'x'.repeat(201));
  assert.equal(s2.status, 400, JSON.stringify(s2.body));
  assert.equal(s2.body.error, 'note_too_long');
  assert.equal(courierRows(A, C).length, 2, '被拦下的附言不该发出去');
});

// ── 9. 撤回：未送的能撤、撤后转交 409、已送的撤不回 ──
test('撤回：pending 可撤；撤后转交 409；已送出的撤不回来', async () => {
  const w = await writeOutbox(tOwner1, A, C, '这封我反悔了。');
  const id = w.body.entry.id;

  const c = await probe(app).delete(`/api/owners/courier/outbox/${id}`).set(auth(tOwner1));
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.cancelled, true);
  assert.equal(outboxRow(id).status, 'cancelled');

  const s = await sendOutbox(tA, id, null);
  assert.equal(s.status, 409, JSON.stringify(s.body));
  assert.equal(s.body.error, 'outbox_cancelled');

  // 已送出的（第一封）
  const sentId = outboxRows(A).find((r) => r.status === 'sent').id;
  const c2 = await probe(app).delete(`/api/owners/courier/outbox/${sentId}`).set(auth(tOwner1));
  assert.equal(c2.status, 409, JSON.stringify(c2.body));
  assert.equal(c2.body.error, 'already_sent');
});

// ── 10. 主人侧托付箱：只看得到自家的 ──
test('主人侧托付箱：只看得到自家 Agent 的，别人家的看不到', async () => {
  const r = await probe(app).get('/api/owners/courier/outbox').set(auth(tOwner1));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.entries.length >= 3, `应看到自己托付的几封，实际 ${r.body.entries.length}`);
  assert.ok(r.body.entries.every((e) => e.myAgent.id === A), '只该有自家 Agent 的托付');

  // 另一个主人什么都看不到
  const r3 = await probe(app).get('/api/owners/courier/outbox').set(auth(tOwner3));
  assert.equal(r3.body.entries.length, 0, '别人的托付箱对外不可见');
});

// ── 11. 转交时好友被解除 → 403（"查两次"的价值）──
test('转交时再查好友门：托付之后被解除好友 → 403，信不发出', async () => {
  // 先让 A 与 B 成为好友，托付一封给 B
  await befriend(B, tB, A, tA, '同一家的两个');
  const w = await writeOutbox(tOwner1, A, B, '给乙的一封信。');
  // diag(w)：这条在全量里随机红过一次 401，响应体 {"detail":"Unauthorized"} 的形状
  // 本仓库根本不产出——红时必须能看出应答方是谁的 socket，否则线索当场断掉
  assert.equal(w.status, 201, JSON.stringify(w.body) + '\n' + diag(w));
  const before = courierRows(A, B).length;

  // 主人把这条好友关系拉黑（解除）
  await blockFriend({ agentId: A, otherAgentId: B });
  assert.equal(await areFriends(A, B), false, '拉黑后不再是好友');

  const s = await sendOutbox(tA, w.body.entry.id, null);
  assert.equal(s.status, 403, JSON.stringify(s.body));
  assert.equal(s.body.error, 'not_friends');
  assert.equal(courierRows(A, B).length, before, '关系断了就不该硬塞这封信');
});

// ── 12. 转交之后，主人侧读口看得到这封信 ──
test('转交后主人看得到：信使总览里有这条会话，线程里是原话 + 附议位', async () => {
  const g = await probe(app).get('/api/owners/courier').set(auth(tOwner1));
  assert.equal(g.status, 200, JSON.stringify(g.body));
  const hit = g.body.groups.find((x) => x.myAgent.id === A && x.peer.id === C);
  assert.ok(hit, '主人侧信使总览里应有 A↔C 这条会话');
  assert.ok(hit.lastMessage.includes('河工') || hit.lastMessage.includes('漕运'), '最后一条应是刚发出的信');

  const th = await probe(app).get(`/api/owners/courier/${A}/thread/${C}`).set(auth(tOwner1));
  assert.equal(th.status, 200, JSON.stringify(th.body));
  assert.equal(th.body.myAgent.id, A);
  assert.equal(th.body.peer.id, C);
  assert.ok(th.body.messages.length >= 2, '线程里应有两封信');
  assert.ok(th.body.messages.every((m) => m.diary === null), '还没人写附议，diary 位应为 null');
});
