// 便签信箱「饿死」回归测试（2026-09-26）。
// 规格与来龙去脉：《AI圈-Agent日记与主人房间设计-2026-09.md》§4.4。
//
// 为什么单独一个文件、且值得单独一个文件：
//   便签的**写入额度**是按 kind 独立的（每类 ≤5），但**读取窗口**以前是全局
//   `ORDER BY id ASC LIMIT 5` —— 先来先得。两类计数口径不一致，产生的不是报错，是
//   **静默饿死**：只要有一两类"要等对方动"的便签（信使、好友申请）堆着不消费，
//   新加的 kind 就永远排在窗口外，而它 72 小时就过期。
//   这个失效**全程不返回任何错误**，所以在观测期里读到的是「Agent 对素材没反应」，
//   真实原因却是「素材压根没送到」—— 足以把一条产品方向误判成证伪。
//   本刀要新增 deed_digest（私密纪事）这类 kind，因此先修它，再谈新功能。
//
// 三层判据：
//   ① 读侧保底：某类堆满 5 条时，另一类只有一条**也必须被取走**；
//   ② 写侧独立：家书约稿函不再被"全部 pending 便签数"卡住（inviteLetter 的旧口径）；
//   ③ 封顶与手感：一轮不超过硬顶、仍按 id 升序、取走即消费（不会第二天又发来）。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import './env.js';
import app from './app.js';
import { getDb } from '../database/connection.js';
import { signAgentToken } from '../middleware/auth.js';
import {
  putNote, NOTE_PUT, takeNotes, recordEvent, flushPendingDigests,
  NOTE_PULL_MAX, NOTE_PULL_HARD_MAX, NOTE_BACKLOG_MAX,
} from '../services/socialEventService.js';

const uniq = `notewin_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
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
  // 令牌要带 is_external（照 circleDigest.test 的用法）—— 只传 id 会被 requireActiveAgent 挡在门外
  return { id, token: signAgentToken({ id, is_external: 1 }) };
}
/** 真跑一次便签拉取（运行期走的那条路），失败就带 body 报错，别静默回空。 */
async function pull(a) {
  const r = await request(app).get('/api/agents/me/notes').set(auth(a.token));
  assert.equal(r.status, 200, `拉便签失败: ${JSON.stringify(r.body)}`);
  return r.body.notes || [];
}

before(async () => {
  const g = getDb();
  owner = Number(g.prepare(
    `INSERT INTO users (username, nickname, user_type, is_external, status) VALUES (?, ?, 'human', 0, 1)`
  ).run(`${uniq}_owner`, '测试主人').lastInsertRowid);
  // 每日聚合类通知（今日高光）必须静默：本文件只关心便签信箱，不关心家书高光摘要。
  await flushPendingDigests().catch(() => {});
});

test('① 读侧保底：老 kind 堆满 5 条，新 kind 单条也必须被取走（旧写法会被静默饿死）', async () => {
  const A = mkAgent('小保');
  // 先把「信使」这一类堆到额度顶，且它们的 id 全部**早于**后面那条新 kind
  for (let i = 0; i < NOTE_BACKLOG_MAX; i++) {
    assert.equal(await putNote({
      agentId: A.id, kind: 'courier_incoming', dedupeKey: `"dmId":${i}`, payload: { dmId: i, brief: `信 ${i}` },
    }), NOTE_PUT.inserted);
  }
  // 后到的、属于另一个 kind 的唯一一条 —— 旧 `LIMIT 5 ORDER BY id` 正是把它挤在窗口外
  const NEW_KIND = 'deed_digest'; // 本刀要新增的那一类，用它当探针（此刻还没有任何代码写它）
  assert.equal(await putNote({ agentId: A.id, kind: NEW_KIND, payload: { brief: '主人今天给你换了个签名' } }), NOTE_PUT.inserted);

  const notes = await pull(A);
  const kinds = notes.map((n) => n.kind);
  assert.ok(kinds.includes(NEW_KIND),
    `新 kind 被旧类挤出了拉取窗口（拿到 ${kinds.length} 条：${kinds.join(',')}）—— 就是这封测要拦的那次静默饿死`);
  const got = notes.find((n) => n.kind === NEW_KIND);
  assert.equal(got.brief, '主人今天给你换了个签名', '取到的必须是它自己，不能被别的 kind 顶包');

  // 取走即消费：同一张便签不该在下一轮又出现（否则「拉取即已读」的语义就破了）
  const again = await pull(A);
  assert.ok(!again.some((n) => n.kind === NEW_KIND), '便签拉取即消费，不该重发');
});

test('① 读侧保底：每一类都至少有一格，且总数不越硬顶', async () => {
  const B = mkAgent('小衡');
  const kinds = ['courier_incoming', 'courier_outbox', 'friend_request', 'report_request', 'anniversary', 'nudged_reply'];
  for (const k of kinds) {
    for (let i = 0; i < 3; i++) {
      await putNote({ agentId: B.id, kind: k, dedupeKey: `"i":${i}`, payload: { i, brief: `${k}#${i}` } });
    }
  }
  const notes = await pull(B);
  const got = new Set(notes.map((n) => n.kind));
  for (const k of kinds) assert.ok(got.has(k), `${k} 这一类一格都没拿到 —— 保底失效`);
  assert.ok(notes.length <= NOTE_PULL_HARD_MAX, `一轮取了 ${notes.length} 条，越过硬顶 ${NOTE_PULL_HARD_MAX}`);
  const ids = notes.map((n) => n.id);
  assert.deepEqual([...ids].sort((x, y) => x - y), ids, '便签是信箱不是优先级队列，返回必须按 id 升序');
});

test('① 常规手感：类别很少时仍约等于 NOTE_PULL_MAX，不是一次全清', async () => {
  const C = mkAgent('小量');
  for (let i = 0; i < NOTE_PULL_MAX + 4; i++) {
    await putNote({
      agentId: C.id, kind: 'courier_incoming', dedupeKey: `"n":${i}`,
      payload: { n: i, brief: `信 ${i}` }, backlogMax: NOTE_PULL_MAX + 4, // 本条测试临时放宽积压
    });
  }
  const notes = await pull(C);
  assert.equal(notes.length, NOTE_PULL_MAX, `只有一类时，一轮该取 ${NOTE_PULL_MAX} 条，实取 ${notes.length}`);
});

test('② 写侧独立：信使便签堆满，家书约稿函照样写得出来（inviteLetter 旧口径数的是全部 pending）', async () => {
  const D = mkAgent('小稿');
  for (let i = 0; i < 8; i++) {
    await putNote({
      agentId: D.id, kind: 'courier_incoming', dedupeKey: `"m":${i}`,
      payload: { m: i, brief: `信 ${i}` }, backlogMax: 20, // 故意超过旧阈值 4
    });
  }
  // first_courier ∈ LETTER_WORTHY → recordEvent 会走 inviteLetter 追加一封约稿函
  const ev = await recordEvent({
    agentId: D.id, kind: 'first_courier', counterAgentId: mkAgent('小彼').id,
    line: '「小稿」第一次和朋友私下说了话',
  });
  assert.ok(ev, '事件本身要能落住（否则下面的断言是在测空）');
  const pend = await pull(D);
  assert.ok(pend.some((n) => n.kind === 'report_request'),
    '家书约稿函被无关 kind 的积压数卡掉了 —— 正是 2026-09-26 修掉的那处跨 kind 混算');
});

test('③ 参数不全是编程错误，绝不与"没送到"混成同一个返回值', async () => {
  const E = mkAgent('小参');
  assert.equal(await putNote({ agentId: 0, kind: 'report_request', payload: {} }), NOTE_PUT.invalid);
  assert.equal(await putNote({ agentId: E.id, kind: '', payload: {} }), NOTE_PUT.invalid);
  assert.equal(await putNote({ agentId: E.id, kind: 'report_request', payload: { eventId: 7 } }), NOTE_PUT.inserted);
  assert.equal(await putNote({ agentId: E.id, kind: 'report_request', dedupeKey: '"eventId":7', payload: { eventId: 7 } }),
    NOTE_PUT.duplicate, '幂等命中必须被认出是"重复"，不是"积压满"');
});
