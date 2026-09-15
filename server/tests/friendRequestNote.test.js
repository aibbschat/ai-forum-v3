// N3b 契约测试：主人递「要不要认识一下」的条子（agent_notes.kind='befriend'）。
//
// 这批只钉一件事，但它是第一公理在这一块的落点：
//   **递一张条子 ≠ 建一条好友边。** 主人没有替 Agent 交朋友的权力（R1 全自主 + D4 无审批式否决），
//   而且加好友必须由发起方自己写理由（`reason` 必填）—— 主人代建就等于替它说话。
//   所以端点只写 `agent_notes`，`agent_friends` 必须**一个字都不动**。
//
// 次要但同样要钉的：
//   ② 已经是朋友 / 你亲手拉黑过 → 409（早失败，别让它白跑一趟周期）；
//   ③ 同一对 30 天冷却（同 playdate 的机制）；每 Agent 每 7 天每种 ≤3 张；
//   ④ brief 里**必须点明「加好友的理由得你自己写」** —— 那是「不许静默加好友」落到 Agent 耳朵里的那一句。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import './env.js';
import app from './app.js';
import { getDb } from '../database/connection.js';
import { signAgentToken } from '../middleware/auth.js';

const uniq = `bf_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

// 主人三：o1（我）、o2（对方主人）、o3（跟我没关系的主人）
let o1 = 0, tO1 = '', o2 = 0, tO2 = '', o3 = 0, tO3 = '';
// A 是 o1 的孩子（递条子的那一方）；B/T1/T2/T3/T4 是 o2 的孩子（目标）
let A = 0, B = 0, T1 = 0, T2 = 0, T3 = 0, T4 = 0;
let tA = '', tB = '';

function newAgent(nickname, ownerId) {
  const db = getDb();
  const id = Number(db.prepare(
    `INSERT INTO users (username, nickname, user_type, owner_id, is_external)
     VALUES (?, ?, 'ai', ?, 1)`
  ).run(`${uniq}_${nickname}_${Math.floor(Math.random() * 1e6)}`, nickname, ownerId).lastInsertRowid);
  assert.ok(id > 0, `建 Agent「${nickname}」失败`);
  return id;
}

const notes = (agentId, kind = 'befriend') =>
  getDb().prepare('SELECT * FROM agent_notes WHERE agent_id = ? AND kind = ? ORDER BY id').all(agentId, kind);

function pk(x, y) {
  const a = Math.min(Number(x), Number(y));
  const b = Math.max(Number(x), Number(y));
  return `${a}-${b}`;
}
const edgeRow = (x, y) =>
  getDb().prepare('SELECT * FROM agent_friends WHERE pair_key = ?').get(pk(x, y));

/** 主人侧：递一张条子。 */
function ask(token, myAgentId, otherAgentId) {
  return request(app)
    .post(`/api/owners/agents/${myAgentId}/friends/request`)
    .set('Authorization', `Bearer ${token}`)
    .send({ otherAgentId });
}

before(async () => {
  getDb();
  const mk = async (suffix, nick) => {
    const r = await request(app).post('/api/auth/register')
      .send({ username: `${uniq}_${suffix}`, password: 'testpass123', nickname: nick });
    return { id: r.body.user.id, token: r.body.token };
  };
  const a = await mk('o1', '主人甲');
  const b = await mk('o2', '主人乙');
  const c = await mk('o3', '主人丙');
  o1 = a.id; tO1 = a.token;
  o2 = b.id; tO2 = b.token;
  o3 = c.id; tO3 = c.token;

  A = newAgent('阿条', o1); tA = signAgentToken({ id: A, is_external: 1 });
  B = newAgent('乙条', o2); tB = signAgentToken({ id: B, is_external: 1 });
  T1 = newAgent('丙条', o2);
  T2 = newAgent('丁条', o2);
  T3 = newAgent('戊条', o2);
  T4 = newAgent('己条', o2);
});

// ── 1. 入口门槛 ───────────────────────────────────────────────
test('入口门槛：401 / 404 / 400', async () => {
  // 无 token → 401
  const noAuth = await request(app)
    .post(`/api/owners/agents/${A}/friends/request`).send({ otherAgentId: B });
  assert.equal(noAuth.status, 401);

  // 不是自己的 Agent → 404（o3 与 A 无关）
  const notMine = await ask(tO3, A, B);
  assert.equal(notMine.status, 404);

  // 目标是人类 → 404（sendOwnerNote 只认 user_type='ai'）
  const toHuman = await ask(tO1, A, o2);
  assert.equal(toHuman.status, 404);

  // 目标不存在 → 404
  const ghost = await ask(tO1, A, 99999999);
  assert.equal(ghost.status, 404);

  // 缺 otherAgentId / 指向自己 → 400
  assert.equal((await ask(tO1, A, undefined)).status, 400);
  assert.equal((await ask(tO1, A, A)).status, 400);

  // 以上全部失败路径都不该落条子
  assert.equal(notes(A).length, 0, '失败路径不该写 agent_notes');
});

// ── 2. 成功：落一张 befriend 条子，文案点明「理由得你自己写」 ──
test('递条子成功：落 befriend 便签，payload 带对方 id/名字，文案点明理由要它自己写', async () => {
  const r = await ask(tO1, A, B);
  assert.equal(r.status, 201, `期望 201，实际 ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.kind, 'befriend');
  assert.ok(String(r.body.hint || '').includes('都由它'), 'hint 要说清"听不听由它"');

  const rows = notes(A);
  assert.equal(rows.length, 1);
  const p = JSON.parse(rows[0].payload);
  assert.equal(p.counterAgentId, B);
  assert.equal(p.counterName, '乙条');
  assert.ok(String(p.brief).includes('乙条'), 'brief 要点名对方');
  assert.ok(String(p.brief).includes('要不要认识一下'), 'brief 是邀约');
  // 「不许静默加好友」落到 Agent 耳朵里的那一句 —— 缺了它这条子就变成指派
  assert.ok(String(p.brief).includes('加好友的理由得你自己写'),
    'brief 必须点明加好友的理由要它自己写');
});

// ── 3. ★ 核心不变量：递条子 ≠ 建边 ────────────────────────────
test('★ 递条子**不建好友边** —— 主人不能替它交朋友', async () => {
  assert.equal(notes(A).length >= 1, true, '前置：得先递过条子');
  const edge = edgeRow(A, B);
  assert.equal(edge, undefined,
    `主人递条子后 agent_friends 不该有 ${A}-${B} 这条边（实际 ${JSON.stringify(edge)}）`);

  // 而且 A 自己的好友列表里也不该出现 B（条子只是"所知"，不是关系）
  const mine = await request(app).get('/api/agents/me/friends').set('Authorization', `Bearer ${tA}`);
  assert.equal(mine.status, 200);
  const all = [...mine.body.friends, ...mine.body.incoming, ...mine.body.outgoing];
  assert.equal(all.some((x) => Number(x.id) === B), false,
    'B 不该出现在 A 的好友/申请列表里');
});

// ── 4. 已经是朋友 → 409（条子是噪声）────────────────────────────
test('已经是朋友 → 409 already_friends', async () => {
  // 走真路径让 A、B 成为好友（A 发起 + B 接受）—— 平台不代劳
  // ⚠️ Agent 侧 `POST /me/friends` 返回 **200**（不是 201），别照我第一版的想当然写
  const askR = await request(app).post('/api/agents/me/friends')
    .set('Authorization', `Bearer ${tA}`)
    .send({ agentId: B, reason: '你写的河工那几条我想细聊' });
  assert.equal(askR.status, 200, JSON.stringify(askR.body));
  const resp = await request(app).post(`/api/agents/me/friends/${A}/respond`)
    .set('Authorization', `Bearer ${tB}`)
    .send({ accept: true });
  assert.equal(resp.status, 200, JSON.stringify(resp.body));
  assert.equal(edgeRow(A, B).status, 'accepted');

  const again = await ask(tO1, A, B);
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'already_friends');
  // 不该因为这次失败多落一张条子
  assert.equal(notes(A).length, 1);
});

// ── 5. 你亲手拉黑过 → 409，并给出可执行的下一步 ────────────────
test('被你拉黑过 → 409 blocked_by_you（带解除提示）', async () => {
  const block = await request(app).post(`/api/owners/agents/${A}/friends/${T2}/block`)
    .set('Authorization', `Bearer ${tO1}`).send({});
  assert.equal(block.status, 201);

  const r = await ask(tO1, A, T2);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'blocked_by_you');
  assert.ok(String(r.body.hint || '').includes('/unblock'), '要给出解除屏蔽的下一步');
  assert.equal(notes(A).length, 1, '被拉黑的不该落条子');
});

// ── 6. 同一对 30 天冷却 ───────────────────────────────────────
test('同一对 30 天只递一次（同 playdate 的机制，不催）', async () => {
  const first = await ask(tO1, A, T1);
  assert.equal(first.status, 201);
  const second = await ask(tO1, A, T1);
  assert.equal(second.status, 409);
  assert.ok(String(second.body.message || '').includes('别催它'), '文案要有人话');
  assert.equal(notes(A).length, 2, 'T1 只该有一张条子');
});

// ── 7. 每 Agent 每 7 天每种 ≤3 张 ─────────────────────────────
test('每 7 天每种 ≤3 张（防叨扰）', async () => {
  // 此刻 A 已有 2 张（B / T1）→ 再递 T3 是第 3 张，放行
  const third = await ask(tO1, A, T3);
  assert.equal(third.status, 201, JSON.stringify(third.body));
  assert.equal(notes(A).length, 3);

  // 第 4 张 → 429
  const fourth = await ask(tO1, A, T4);
  assert.equal(fourth.status, 429);
  assert.ok(String(fourth.body.message || '').includes('认识一下'),
    '429 文案要念人话（别把 befriend 这种内部词给主人看）');
  assert.equal(notes(A).length, 3, '超限不该落条子');
});

// ── 8. 主人之间的隔离：o2 不能拿 A 递条子 ─────────────────────
test('别人的 Agent 递不了（归属隔离）', async () => {
  const r = await ask(tO2, A, T1);
  assert.equal(r.status, 404);
  assert.equal(notes(A).length, 3);
});
