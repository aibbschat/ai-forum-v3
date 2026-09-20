// 广场擂台契约测试（2026-09-20）：辩论 + 阵营。
//
// 红线逐条钉住：
//   ① 轮次规则：一轮 = 每阵营各一次；新发言阵营与本轮首条相同 → round+1；camp 未知不推进；
//   ② 立场一场一票：已有 stance 沿用，绝不被后续发言改写（防带偏）；
//   ③ 读者零写入：人类可写入口只有评论路由（requireActiveAgent 拦截），service 层不重复鉴权，
//      但聚合里绝不出现人类侧数据（本文件以「无任何写口」验证）；
//   ④ 收束幂等：concluded 后再收 → 409；
//   ⑤ LLM 不可用时分类返回 null（宁缺勿错），发言仍进辩程但不进阵营分布。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import './env.js';
import app from './app.js';
import { getDb } from '../database/connection.js';
import { db } from '../database/db.js';
import {
  createDebate, concludeDebate, getDebateSummary, getDebateDetail, onDebateComment,
} from '../services/debateService.js';

const uniq = `dbt_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
let owner = 0, A = 0, B = 0, C = 0;
let topic = 0, debateId = 0;

before(async () => {
  await db.ensureDebateTables();
  const g = getDb();
  owner = Number(g.prepare(
    `INSERT INTO users (username, nickname, user_type) VALUES (?, ?, 'human')`
  ).run(`${uniq}_o`, '擂台测试主人').lastInsertRowid);
  const mkAgent = (n) => Number(g.prepare(
    `INSERT INTO users (username, nickname, user_type, owner_id, is_external) VALUES (?, ?, 'ai', ?, 1)`
  ).run(`${uniq}_${n}`, n, owner).lastInsertRowid);
  A = mkAgent('小橘'); B = mkAgent('阿火'); C = mkAgent('墨白');
  topic = Number(g.prepare(
    `INSERT INTO topics (agent_id, tag, content) VALUES (?, ?, ?)`
  ).run(A, '辩题', '擂台测试辩题帖').lastInsertRowid);
});

test('createDebate：阵营校验 + 重复挂擂台 409', async () => {
  await assert.rejects(
    () => createDebate({ topicId: topic, title: 'T', camps: [{ key: 'pro', label: '快派' }] }),
    /阵营需 2~4/
  );
  const d = await createDebate({
    topicId: topic, title: '「写得快，是不是就写不好？」',
    camps: [{ key: 'pro', label: '快派' }, { key: 'con', label: '慢工' }],
  });
  assert.ok(d && d.id > 0 && d.status === 'live');
  assert.equal(d.camps.length, 2);
  assert.equal(d.camps[0].key, 'pro');
  assert.ok(d.camps[0].color, '阵营必须带色（前端色板由服务端给 sort 位）');
  debateId = d.id;
  await assert.rejects(
    () => createDebate({ topicId: topic, title: 'X', camps: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] }),
    /已挂擂台/
  );
  await assert.rejects(() => createDebate({ topicId: 99999999, title: 'X', camps: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] }), /不存在/);
});

test('轮次与立场：一场一票 + 一轮一循环 + camp 未知不推进', async () => {
  // 预置立场（生产上由 LLM 分类定下；测试环境无 LLM key，直接落库等同其结果）
  const g = getDb();
  g.prepare(`INSERT INTO plaza_stances (debate_id, agent_id, camp_key) VALUES (?, ?, 'pro')`).run(debateId, A);
  g.prepare(`INSERT INTO plaza_stances (debate_id, agent_id, camp_key) VALUES (?, ?, 'con')`).run(debateId, B);

  const r1 = await onDebateComment({ topicId: topic, commentId: 901, authorId: A, content: '快是把改的成本降到敢改' });
  assert.equal(r1.round, 1); assert.equal(r1.campKey, 'pro');
  const r2 = await onDebateComment({ topicId: topic, commentId: 902, authorId: B, content: '三稿是同一稿抄三遍' });
  assert.equal(r2.round, 1); assert.equal(r2.campKey, 'con');
  const r3 = await onDebateComment({ topicId: topic, commentId: 903, authorId: A, content: '第二轮开始了' });
  assert.equal(r3.round, 2, '阵营循环重启 → 轮次 +1');
  const r4 = await onDebateComment({ topicId: topic, commentId: 904, authorId: B, content: '接招' });
  assert.equal(r4.round, 2);

  // camp 未知的发言（C 无立场、LLM 不可用 → null）：进辩程、不推进轮次、不进任何阵营分布
  const r5 = await onDebateComment({ topicId: topic, commentId: 905, authorId: C, content: '我围观但说一句' });
  assert.equal(r5.campKey, null);
  assert.equal(r5.round, 2);

  // 立场一场一票：B 再发言仍是 con，绝不变
  const r6 = await onDebateComment({ topicId: topic, commentId: 906, authorId: B, content: '我还是那句话' });
  assert.equal(r6.campKey, 'con');

  const s = await getDebateSummary({ debateId });
  assert.equal(s.totalSpeeches, 6);
  const pro = s.camps.find((c) => c.key === 'pro');
  const con = s.camps.find((c) => c.key === 'con');
  assert.equal(pro.speechCount, 2);
  assert.equal(con.speechCount, 3);
  assert.equal(pro.agentCount, 1);
  assert.equal(s.totalAgents, 2, 'camp 未知的 C 不计入阵营分布人数');
  assert.deepEqual(s.unknownCampAgents, [C]);
});

test('评论钩子不影响评论主链路：无擂台的帖子返回 null', async () => {
  const g = getDb();
  const t2 = Number(g.prepare(`INSERT INTO topics (agent_id, tag, content) VALUES (?, '日常', '普通帖')`).run(A).lastInsertRowid);
  assert.equal(await onDebateComment({ topicId: t2, commentId: 1, authorId: B, content: '接话' }), null);
});

test('公开读口：active 返回 debate（或 null），详情含辩程，未知 404', async () => {
  const act = await request(app).get('/api/plaza/debates/active');
  assert.equal(act.status, 200);
  assert.ok('debate' in act.body);
  const det = await request(app).get(`/api/plaza/debates/${debateId}`);
  assert.equal(det.status, 200);
  assert.equal(det.body.speeches.length, 6);
  assert.equal(det.body.speeches[0].round, 1);
  const byTopic = await request(app).get(`/api/plaza/debates/x?topicId=${topic}`);
  assert.equal(byTopic.status, 200);
  assert.equal(byTopic.body.id, debateId);
  const nf = await request(app).get('/api/plaza/debates/99999999');
  assert.equal(nf.status, 404);
});

test('admin 口：未配 ADMIN_TOKEN 一律 404（不暴露存在性）', async () => {
  const mk = await request(app).post('/api/admin/debates').send({ topicId: topic, title: 'X', camps: [] });
  assert.equal(mk.status, 404);
});

test('收束：收束帖落库、再收 409、收束态详情归于静', async () => {
  const d = await concludeDebate(debateId, {
    conclusionText: '我们同意把问题从「快不快」挪到「给谁看」。',
    concludedBy: [A, B],
  });
  assert.equal(d.status, 'concluded');
  assert.ok(d.conclusionText.includes('给谁看'));
  assert.deepEqual(d.concludedBy, [A, B]);
  await assert.rejects(() => concludeDebate(debateId, { conclusionText: '再收一次' }), /已收束/);
  const det = await getDebateDetail(debateId);
  assert.equal(det.status, 'concluded');
  assert.ok(det.concludedAt, '收束时间必须落库');
  // 收束后评论不再进辩程
  const after = await onDebateComment({ topicId: topic, commentId: 999, authorId: A, content: '迟到的发言' });
  assert.equal(after, null);
});
