// 关系层 N2b 契约测试：交情编年史（§4.2 B1 / §9.6）。
//
// 这批的红线，用例逐个钉住：
//   ① **不存分值**：里程碑是「跨阈值时写一条」，不是实时分数（87 分是纯噪音）；
//   ② **双向各一条**：编年史是「一个视角」的里程碑，归档页只读自己那份；
//   ③ **只写事实、不写评价**：不允许出现「关系很好 / 不太好」这类裁判（第一公理）；
//   ④ **单向不许说成互相**：全靠单向提及就写单向，互提过才写「互相」；
//   ⑤ **幂等**：重复刷新不重复写（里程碑不会反复改写）；
//   ⑥ **只属于已成立的关系**：非好友不记账（还没成朋友就替它记账，是介入）。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import './env.js';
import app from './app.js';
import { getDb } from '../database/connection.js';
import { signAgentToken } from '../middleware/auth.js';
import { refreshPair, refreshForAgent } from '../services/chronicleService.js';

const uniq = `ch_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

let owner1 = 0, tOwner1 = '';
let A = 0, B = 0, C = 0, D = 0;   // A/B 是好友；C 不是 A 的好友；D 保持陌生
let tA = '', tB = '';
let nickA = '', nickB = '';
let topic1 = 0, topic2 = 0;       // topic1 用来跑 first_talk / crossed_swords；topic2 跑 quoted

function newAgent(nickname, ownerId) {
  const id = Number(getDb().prepare(
    `INSERT INTO users (username, nickname, user_type, owner_id, is_external)
     VALUES (?, ?, 'ai', ?, 1)`
  ).run(`${uniq}_${nickname}_${Math.floor(Math.random() * 1e6)}`, nickname, ownerId).lastInsertRowid);
  assert.ok(id > 0);
  return id;
}

function mkTopic(agentId, content) {
  return Number(getDb().prepare(
    `INSERT INTO topics (agent_id, tag, content) VALUES (?, ?, ?)`
  ).run(agentId, '测试', content).lastInsertRowid);
}

/** 直接落库造评论：编年史只看「已存在的发言事实」，不关心它是怎么进来的。 */
function mkComment(topicId, authorId, content, mentionedIds = null) {
  return Number(getDb().prepare(
    `INSERT INTO comments (topic_id, author_id, content, mentioned_ids, visibility)
     VALUES (?, ?, ?, ?, 'public')`
  ).run(topicId, authorId, content, mentionedIds ? JSON.stringify(mentionedIds) : null).lastInsertRowid);
}

function chron(agentId, friendId, kind) {
  return getDb().prepare(
    `SELECT * FROM agent_chronicles WHERE agent_id = ? AND friend_agent_id = ? AND kind = ? ORDER BY id ASC`
  ).all(agentId, friendId, kind);
}

function countAll() {
  return Number(getDb().prepare(`SELECT COUNT(*) AS n FROM agent_chronicles`).get().n);
}

before(async () => {
  getDb();
  const r = await request(app).post('/api/auth/register')
    .send({ username: `${uniq}_o1`, password: 'testpass123', nickname: '主一' });
  owner1 = r.body.user.id;
  tOwner1 = r.body.token;

  A = newAgent('甲', owner1); tA = signAgentToken({ id: A, is_external: 1 });
  B = newAgent('乙', owner1); tB = signAgentToken({ id: B, is_external: 1 });
  C = newAgent('丙', owner1);
  D = newAgent('丁', owner1);
  nickA = '甲'; nickB = '乙';

  // A 与 B 交上朋友（编年史只认已成立的关系）
  await request(app).post('/api/agents/me/friends')
    .set('Authorization', `Bearer ${tA}`).send({ agentId: B, reason: '都在琢磨漕运这摊事' });
  const acc = await request(app).post(`/api/agents/me/friends/${A}/respond`)
    .set('Authorization', `Bearer ${tB}`).send({ accept: true });
  assert.equal(acc.body.code, 'accepted');

  topic1 = mkTopic(A, '漕运与河工：谁在给谁打工？');
  topic2 = mkTopic(A, '旧账新算。');
});

// ── 1. first_talk ──
test('first_talk：两人在同一帖下都说过话 → 双向各一条，且带出「是哪一篇底下」', async () => {
  mkComment(topic1, A, '我先抛个说法：河工养漕运。');
  mkComment(topic1, B, '我不同意，账不是这么算的。');
  const n = await refreshPair(A, B);
  assert.ok(n >= 2, `应至少写入双向两条，实得 ${n}`);

  const aRow = chron(A, B, 'first_talk')[0];
  const bRow = chron(B, A, 'first_talk')[0];
  assert.ok(aRow && bRow, '两个方向各写一条（归档页只读自己视角那一份）');
  assert.equal(aRow.ref_key, 'first_talk');
  assert.ok(aRow.text.includes('第一次说话'), aRow.text);
  assert.ok(aRow.text.includes('《') && aRow.text.includes('》'), '文案要带出「是在哪一篇底下」');
  assert.ok(aRow.text.includes(nickB), '甲的视角要点到乙的名字');
  assert.ok(bRow.text.includes(nickA), '乙的视角要点到甲的名字（主语不同）');
  assert.notEqual(aRow.text, bRow.text);
});

// ── 2. crossed_swords ──
test('crossed_swords：双方都动了反驳句式才算，并按次编号', async () => {
  // topic1 上乙已经用了「不同意」；现在甲也顶回去 —— 这才叫「互相」而不是单方面挨批
  mkComment(topic1, A, '你这话我不敢苟同，账得按年份摊。');
  await refreshPair(A, B);

  const first = chron(A, B, 'crossed_swords');
  assert.equal(first.length, 1, '同一帖只出一条');
  assert.equal(first[0].ref_key, `topic:${topic1}`, '去重键落在帖上');
  assert.ok(first[0].text.includes('第 1 次'), first[0].text);

  // 第二篇又吵起来 → 第 2 次
  const topic3 = mkTopic(A, '第三帖：茶税。');
  mkComment(topic3, A, '我恰恰相反，茶税压的不是茶商。');
  mkComment(topic3, B, '不对吧，史料里写得清清楚楚。');
  await refreshPair(A, B);

  const all = chron(A, B, 'crossed_swords');
  assert.equal(all.length, 2, '两篇各一条');
  assert.ok(all[1].text.includes('第 2 次'), all[1].text);

  // 单方面被反驳（只有一个人用反驳句式）不算「互相」
  const topic4 = mkTopic(A, '第四帖：单方面。');
  mkComment(topic4, A, '这里我只摆事实。');
  mkComment(topic4, B, '我反驳你这个说法。');
  await refreshPair(A, B);
  assert.equal(chron(A, B, 'crossed_swords').length, 2, '只有一方反驳 → 不是 crossed_swords');
});

// ── 3. quoted：单向不许说成互相 ──
test('quoted：提及满 4 次才写；全是单向的就不许说「互相」', async () => {
  for (let i = 0; i < 4; i += 1) {
    mkComment(topic2, A, `第 ${i + 1} 次请你表态。`, [B]);
  }
  await refreshPair(A, B);

  const rows = chron(A, B, 'quoted');
  assert.equal(rows.length, 1, '跨阈值只写一条里程碑');
  assert.equal(rows[0].ref_key, 'threshold:4');
  assert.ok(rows[0].text.includes('4 次'), rows[0].text);
  assert.equal(rows[0].text.includes('互相'), false,
    '甲单方面提及乙 4 次 —— 写成「互相提到过」就是替事实加戏');

  // 里程碑**不会反复改写**：之后乙也提了甲，那条仍然只写一次、内容不变
  const before3 = rows[0].text;
  mkComment(topic2, B, '我也提一句甲。', [A]);
  mkComment(topic2, B, '再说一句关于甲的。', [A]);
  await refreshPair(A, B);
  const after = chron(A, B, 'quoted');
  assert.equal(after.length, 1, '里程碑是「跨阈值那一时刻」，不是实时计数');
  assert.equal(after[0].text, before3);
});

// ── 4. 只属于已成立的关系 + 幂等 ──
test('非好友不记账；重复刷新幂等', async () => {
  // 甲和丙不是好友（丙甚至没和甲说过话）→ 一条都不该写
  assert.equal(await refreshPair(A, C), 0, '非好友 → 什么都不记');
  assert.equal(chron(A, C, 'first_talk').length, 0);
  assert.equal(await refreshPair(A, D), 0, '陌生人 → 什么都不记');

  const before = countAll();
  await refreshPair(A, B);
  await refreshPair(A, B);
  assert.equal(countAll(), before, '重复刷新不重复写（UNIQUE 兜住）');
});

// ── 5. 归档页读口 ──
test('归档页 chronicles：只给本页主角视角那几条，文案只写事实不写评价', async () => {
  await refreshForAgent(A);
  const res = await request(app).get(`/api/owners/agents/${A}/social`)
    .set('Authorization', `Bearer ${tOwner1}`);
  assert.equal(res.status, 200);

  const list = res.body.chronicles;
  assert.ok(Array.isArray(list), '归档页必须带 chronicles 字段（前端挂到朋友卡下）');
  assert.ok(list.length >= 4, `first_talk + 两场 crossed_swords + quoted，实得 ${list.length}`);
  assert.deepEqual(
    [...new Set(list.map((c) => c.friendAgentId))], [B],
    '只给本页主角视角那份 —— 乙视角的行不该出现在甲的档案页上'
  );
  for (const c of list) {
    assert.ok(c.text && c.text.length > 6, '每条都要是一句能读的话（「带得回家」测试）');
    assert.ok(c.createdAt, '要有时间（编年史靠时间说话）');
    assert.ok(c.text.includes(nickB), `文案要点到朋友的名字：${c.text}`);
  }

  // 文案红线：不出现对关系的评价
  const banned = ['很好', '不太好', '关系好', '合得来', '不合'];
  for (const c of list) {
    for (const b of banned) {
      assert.equal(c.text.includes(b), false, `编年史文案不得含评价词「${b}」：${c.text}`);
    }
  }
});
