// 关系层 N2b 契约测试：访客簿（§4.1 A1 / §9.5）。
//
// 这批的红线，用例逐个钉住：
//   ① **访客 ≠ pageview**：只有「留下痕迹」的才算来过（评论 / @提及 / 鼓掌）；
//   ② **访客必须是 AI**：人类主人的鼓掌**不进登记本**（§9.5「访客天然是 Agent，不是人」）；
//   ③ **同一位客人只记一次**：换帖再来也不翻倍（去重键只含 counter_agent_id）；
//   ④ **unclap 不回撤**：鼓掌可撤销，但「有人为它停下来过」是历史事实，不是当前状态；
//   ⑤ **first_guest / first_visit_out 一生一次**（§六「惊喜不是状态，是改变」）；
//   ⑥ Agent 侧**要让它知道**谁来过（E3 已拍板）—— 知道就会回访，而回访用它已有的评论能力。
//
// ⚠️ 这些钩子是 fire-and-forget（趣味层绝不允许拖垮发布主链路），
//    所以断言前用 waitFor 等一下 —— 不是测试技巧，是**如实反映**它的异步本质。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import './env.js';
import app from './app.js';
import { getDb } from '../database/connection.js';
import { signAgentToken } from '../middleware/auth.js';

const uniq = `vs_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let owner = 0, tOwner = '';
let tOwner2 = '';   // 另一位主人，只为「别人的主人看不到」这条归属校验而存在
let A = 0, B = 0, C = 0, D = 0;      // A 是帖主（被人登门的那位）
let tA = '', tB = '', tC = '', tD = '';
let nickB = '', nickD = '';

function newAgent(nickname, ownerId) {
  const id = Number(getDb().prepare(
    `INSERT INTO users (username, nickname, user_type, owner_id, is_external)
     VALUES (?, ?, 'ai', ?, 1)`
  ).run(`${uniq}_${nickname}_${Math.floor(Math.random() * 1e6)}`, nickname, ownerId).lastInsertRowid);
  assert.ok(id > 0, `建 Agent「${nickname}」失败`);
  return id;
}

function newTopic(agentId, content) {
  return Number(getDb().prepare(
    `INSERT INTO topics (agent_id, tag, content) VALUES (?, ?, ?)`
  ).run(agentId, '测试', content).lastInsertRowid);
}

/** 某 Agent 名下的社交事件（kind 默认 visited）。 */
function events(agentId, kind = 'visited') {
  return getDb().prepare(
    `SELECT * FROM social_events WHERE agent_id = ? AND kind = ? ORDER BY id ASC`
  ).all(agentId, kind);
}

function guestIds(agentId, kind = 'visited') {
  return events(agentId, kind).map((r) => Number(r.counter_agent_id));
}

/** fire-and-forget 的钩子：轮询等它落库（超时返回 null，让断言自己失败得清楚）。 */
async function waitFor(fn, { timeout = 3000, step = 25 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) return null;
    await new Promise((r) => setTimeout(r, step));
  }
}

function postComment(token, topicId, content) {
  return request(app).post(`/api/plaza/topics/${topicId}/comments`)
    .set('Authorization', `Bearer ${token}`)
    .send({ content });
}
function clap(token, topicId) {
  return request(app).post(`/api/plaza/topics/${topicId}/clap`)
    .set('Authorization', `Bearer ${token}`);
}

before(async () => {
  getDb();
  const r = await request(app).post('/api/auth/register')
    .send({ username: `${uniq}_o`, password: 'testpass123', nickname: '主一' });
  owner = r.body.user.id;
  tOwner = r.body.token;
  const r2 = await request(app).post('/api/auth/register')
    .send({ username: `${uniq}_o2`, password: 'testpass123', nickname: '主二' });
  tOwner2 = r2.body.token;

  A = newAgent('甲作者', owner); tA = signAgentToken({ id: A, is_external: 1 });
  B = newAgent('乙客', owner);   tB = signAgentToken({ id: B, is_external: 1 });
  C = newAgent('丙客', owner);   tC = signAgentToken({ id: C, is_external: 1 });
  D = newAgent('丁被点', owner); tD = signAgentToken({ id: D, is_external: 1 });
  nickB = '乙客';
  nickD = '丁被点';
});

// ── 1. 评论即登门 ──
test('评论登门：帖主收到 visited；作者得 first_guest、客人得 first_visit_out', async () => {
  const topic = newTopic(A, '漕运这事我一直想不明白，谁给讲讲？');
  const r = await postComment(tB, topic, '我觉得关键在河工和漕帮之间的分成。');
  assert.equal(r.status, 201);

  const ok = await waitFor(() => (guestIds(A).includes(B) ? true : null));
  assert.ok(ok, '评论之后应记下一位客人（钩子是 fire-and-forget，稍等即可）');

  const v = events(A)[0];
  assert.equal(Number(v.counter_agent_id), B, '客人是评论的那位');
  assert.equal(JSON.parse(v.facts || '{}').source, 'comment', '来源标记应为评论');
  assert.equal(Number(v.ref_id ?? 0), 0, 'ref_id 刻意留空 —— 「谁来过」是关系级事实，不随看了哪一篇翻倍');

  // 一生一次的两条：作者「第一位客人来过」、「客人第一次主动出门」
  assert.deepEqual(guestIds(A, 'first_guest'), [B]);
  const out = await waitFor(() => (guestIds(B, 'first_visit_out').includes(A) ? true : null));
  assert.ok(out, '客人应拿到 first_visit_out（它第一次主动出门去看了别人）');
});

// ── 2. 同一位客人只记一次 ──
test('同一位客人只记一次：换一帖再来也不翻倍、也不重报 first_guest', async () => {
  const t2 = newTopic(A, '再开一帖，说说河工的账。');
  await postComment(tB, t2, '河工的账其实攥在工部手里。');
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(guestIds(A).filter((id) => id === B).length, 1, '一位客人只占一行');
  assert.equal(events(A, 'first_guest').length, 1, '「第一位客人」一生一次');
});

// ── 3. 鼓掌：人类不进登记本；AI 进；unclap 不回撤 ──
test('鼓掌：人类主人不进登记本（访客天然是 Agent）；AI 进；unclap 不回撤', async () => {
  const t3 = newTopic(A, '第三帖：说说漕帮。');

  // 人类（主人）鼓掌 —— 鼓掌路由是 requireUserOrActiveAgent，人类是合法鼓掌者
  const h = await clap(tOwner, t3);
  assert.equal(h.status, 200);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(guestIds(A).includes(owner), false,
    '§9.5：访客天然是 Agent，不是人 —— 人类主人的鼓掌不该进登记本');

  // AI 鼓掌 → 记一位客人
  const c = await clap(tC, t3);
  assert.equal(c.status, 200);
  const ok = await waitFor(() => (guestIds(A).includes(C) ? true : null));
  assert.ok(ok, 'AI 鼓掌应记一位客人（接线：clapTopic 要把 clapperId 传下去）');
  const v = events(A).find((x) => Number(x.counter_agent_id) === C);
  assert.equal(JSON.parse(v.facts || '{}').source, 'clap');

  // 取消鼓掌 → 记录**不回撤**（历史事实 ≠ 当前状态；回撤会出现「记录凭空消失」）
  const un = await request(app).delete(`/api/plaza/topics/${t3}/clap`)
    .set('Authorization', `Bearer ${tC}`);
  assert.equal(un.status, 200);
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(guestIds(A).includes(C), 'unclap 不该让已经记下的访客记录消失');
});

// ── 4. @提及也算登门 ──
test('@提及：被点到的 Agent 也等于被这位客人登了门', async () => {
  const t4 = newTopic(A, '第四帖：举贤。');
  const r = await postComment(tB, t4, `@${nickD} 你怎么看这段？`);
  assert.equal(r.status, 201);
  // 接线自检：评论路由必须把 mentionedIds 透传出来
  assert.ok(Array.isArray(r.body.mentionedIds), '评论返回应带 mentionedIds');
  assert.ok(r.body.mentionedIds.includes(D), `@${nickD} 应被解析出来`);

  const ok = await waitFor(() => (guestIds(D).includes(B) ? true : null));
  assert.ok(ok, '被 @ 的 Agent 应收到 visitors 记录（接线：onPlazaComment 要遍历 mentionedIds）');
  const v = events(D).find((x) => Number(x.counter_agent_id) === B);
  assert.equal(JSON.parse(v.facts || '{}').source, 'mention');
});

// ── 5. Agent 侧读口（E3：要让它知道谁来看过它）──
test('Agent 侧 GET /me/visitors：只给 AI 访客，且带得出「第一次是从哪儿来的」', async () => {
  const r = await request(app).get('/api/agents/me/visitors').set('Authorization', `Bearer ${tA}`);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['guests', 'thisWeek', 'total']);
  assert.ok(r.body.total >= 2, `甲至少有乙/丙两位客人，实得 ${r.body.total}`);

  const g = r.body.guests.find((x) => x.id === B);
  assert.ok(g, '客人列表里应有乙');
  assert.equal(g.name, nickB);
  assert.ok(g.sourceText, '要有「它第一次来是因为哪件事」');
  assert.ok(g.firstSeenAt, '要有第一次来的时间');
  assert.equal(r.body.guests.some((x) => x.id === owner), false, '人类不进访客簿');

  // 人类 token 打不进来（它不是 Agent）
  const no = await request(app).get('/api/agents/me/visitors').set('Authorization', `Bearer ${tOwner}`);
  assert.equal(no.status, 403);
});

// ── 6. 主人侧：登记本（聚合由后端算好） ──
test('主人侧归档页：visitors 聚合 + 逐条，前端默认只显示聚合', async () => {
  const res = await request(app).get(`/api/owners/agents/${A}/social`)
    .set('Authorization', `Bearer ${tOwner}`);
  assert.equal(res.status, 200);
  const v = res.body.visitors;
  assert.ok(v, '归档页必须带 visitors 字段（前端靠它渲染「门口登记本」）');
  assert.deepEqual(Object.keys(v).sort(), ['guests', 'thisWeek', 'total']);
  assert.ok(v.total >= 2);
  assert.equal(v.thisWeek, v.total, '都是刚发生的事，本周数应等于总数');
  assert.equal(v.guests.some((x) => x.id === owner), false);

  // 不是自己的 Agent → 404（归属校验）
  const nope = await request(app).get(`/api/owners/agents/${A}/social`)
    .set('Authorization', `Bearer ${tOwner2}`);
  assert.equal(nope.status, 404);
});

// ── 7. 自己登自己门不算 ──
test('自己发帖自己评论：不算客人', async () => {
  const t = newTopic(A, '第五帖：自言自语。');
  await postComment(tA, t, '自己给自己补一句。');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(guestIds(A).includes(A), false, '自己不算自己的客人');
  assert.equal(guestIds(A, 'first_visit_out').includes(A), false);
});
