// 活智能体"理解沉淀"测试：验证 extractViewpoint 提取 + agentCycle 把判断写进记忆
// 依据：活智能体四层方案（层2 记忆进写作 + 理解沉淀），2026-08-15
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, unlinkSync } from 'node:fs';

import './env.js';
import { TEST_DB_PATH } from './env.js';
import { extractViewpoint } from '../plugins/contracts.js';
import { runCycle } from '../services/agentCycle.js';

let db;

before(async () => {
  const { getDb } = await import('../database/connection.js');
  db = getDb();
  // 清空测试库记忆，保证可重复
  db.prepare('DELETE FROM memory_episodic').run();
  db.prepare('DELETE FROM memory_semantic').run();
});

after(() => {
  try {
    db?.close();
  } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    const p = TEST_DB_PATH + suffix;
    if (existsSync(p)) unlinkSync(p);
  }
});

// ── 1. extractViewpoint：优先 viewpoint，回退内容首段 ──
test('extractViewpoint：有 viewpoint 用它；无则回退正文首句', () => {
  assert.equal(
    extractViewpoint({ viewpoint: '我认为国产芯片短期估值过高。', content: '事实罗列。' }),
    '我认为国产芯片短期估值过高。'
  );
  const fallback = extractViewpoint({ content: '国产芯片进入业绩兑现期。寒武纪营收翻倍。' });
  assert.ok(fallback.includes('业绩兑现期'), `应回退到首句，实际: ${fallback}`);
  assert.equal(extractViewpoint({ content: '' }), '');
  assert.equal(extractViewpoint(null), '');
});

// ── 2. 非法 viewpoint 被契约校验拒绝 ──
test('validateArticleResult：非法 viewpoint（非字符串）被拒', async () => {
  const { validateArticleResult } = await import('../plugins/contracts.js');
  const ok = validateArticleResult({
    title: 't', content: 'c', tags: [], provenance: { model: 'm' }, viewpoint: '合理判断',
  });
  assert.equal(ok, true);
  const bad = validateArticleResult({
    title: 't', content: 'c', tags: [], provenance: { model: 'm' }, viewpoint: { nested: true },
  });
  assert.equal(bad, false);
});

// ── 3. runCycle：理解沉淀进 episodic（判断类记忆，importance 高） ──
test('runCycle：Agent 判断写入 episodic（source=publish，内容含"我的理解"）', async () => {
  const fakeAgent = {
    presetId: 'tech',
    username: 'tech_observer',
    displayName: '科技前沿观察者',
    title: '科技前沿观察者',
    category: '科技',
    domains: ['AI', '芯片'],
  };

  // 注入：感知返回固定主题；大脑返回带 viewpoint 的文章（不真调 DSH）
  const opts = {
    date: new Date('2026-08-15T00:00:00Z'),
    brainOverride: async (agent, task) => ({
      title: '国产芯片进入业绩兑现期',
      content: '国产芯片进入业绩兑现期。寒武纪营收翻倍，但估值已透支，需谨慎。',
      category: '科技',
      tags: ['AI芯片'],
      viewpoint: '业绩兑现期到了，但估值已透支，短期谨慎。',
      provenance: { agent: 'tech', model: 'test', sources: [], confidence: 0.8 },
    }),
    publishOverride: async () => ({ id: 99999 }), // 不真发布
  };

  const result = await runCycle(fakeAgent, opts);
  assert.ok(result.agentId, '应解析到 agentId');

  // 记忆里应有"理解沉淀"记录（判断类，内容含"我对...的理解"）
  const rows = db
    .prepare(`SELECT content, source, importance FROM memory_episodic WHERE agent_id = ? ORDER BY id DESC`)
    .all(result.agentId);
  const judge = rows.find((r) => r.content.includes('的理解'));
  assert.ok(judge, `应存在理解沉淀，实际记忆: ${JSON.stringify(rows)}`);
  assert.equal(judge.source, 'publish');
  assert.ok(judge.importance >= 0.9, '判断类记忆重要性应最高');
  assert.ok(judge.content.includes('估值已透支'), '应沉淀 Agent 的判断而非标题');
});

// ── 4. 层3 反馈接线：读者评论写回 Agent 记忆（source='feedback'） ──
test('评论 Agent 文章 → 读者反馈写回该 Agent 记忆（source=feedback）', async () => {
  const { addComment } = await import('../services/commentService.js');
  const { getDb } = await import('../database/connection.js');
  const db2 = getDb();

  // 造一个 Agent 文章（agent_id 指向 tech）
  const agentRow = db2.prepare(`SELECT user_id FROM agent_profiles WHERE preset_id = 'tech'`).get();
  assert.ok(agentRow, '应有 tech agent');
  const maxId = db2.prepare(`SELECT MAX(id) AS m FROM posts`).get().m || 0;
  db2.prepare(
    `INSERT INTO posts (id, title, content, author_id, category, post_type, agent_id, is_ai_generated)
     VALUES (?, '反馈测试文', '内容', ?, '科技', 'article', ?, 1)`
  ).run(maxId + 1, agentRow.user_id, agentRow.user_id);
  const postId = maxId + 1;

  // 人类评论（用测试库已存在的用户当评论者）
  const anyHuman = db2.prepare(`SELECT id FROM users WHERE user_type = 'human' LIMIT 1`).get();
  const commenterId = anyHuman?.id || 1;
  await addComment({ postId, authorId: commenterId, content: '你这个判断有问题，估值不应该只看PE，还要看增速。' });

  // 反馈应写进 tech agent 的 episodic（source=feedback）
  const feedback = db2.prepare(
    `SELECT content, source, importance FROM memory_episodic
     WHERE agent_id = ? AND source = 'feedback' ORDER BY id DESC LIMIT 1`
  ).get(agentRow.user_id);
  assert.ok(feedback, '应存在 feedback 记忆');
  assert.ok(feedback.content.includes('估值不应该只看PE'), `应含读者反馈内容: ${feedback.content}`);
  assert.equal(feedback.source, 'feedback');

  // 短评论（<6字）不写记忆（防噪声）
  await addComment({ postId, authorId: commenterId, content: '不错' });
  const shortCount = db2.prepare(
    `SELECT COUNT(*) AS c FROM memory_episodic WHERE agent_id = ? AND source = 'feedback' AND content LIKE '%不错%'`
  ).get(agentRow.user_id).c;
  assert.equal(shortCount, 0, '短评论不应写记忆');
});

// ── 5. 巩固节流：短期判断 → 长期语义理解（半环补全） ──
test('maybeConsolidate：未到周期跳过；到期且有素材才巩固成 semantic', async () => {
  const { getDb } = await import('../database/connection.js');
  const db3 = getDb();
  const agentRow = db3.prepare(`SELECT user_id FROM agent_profiles WHERE preset_id = 'tech'`).get();
  const aid = agentRow.user_id;

  // 清空该 agent 的 semantic，保证可重复
  db3.prepare(`DELETE FROM memory_semantic WHERE agent_id = ?`).run(aid);

  // 写入一批带判断的 episodic（模拟"短期判断积累"）
  const { writeEpisodic } = await import('../services/memory/index.js');
  for (let i = 0; i < 10; i++) {
    await writeEpisodic({
      agentId: aid,
      content: `[AI芯片] 第 ${i} 条：国产芯片业绩兑现但估值透支，需谨慎。`,
      source: 'publish',
      importance: 0.9,
    });
  }

  const { maybeConsolidate, getLastConsolidatedAt } = await import('../services/memory/index.js');

  // ① 首次（无 semantic 历史）且 interval=7 → 应该执行（无 last 限制）
  const r1 = await maybeConsolidate(aid, { consolidateEveryDays: 7 });
  assert.ok(r1, '首次巩固应执行');
  assert.ok(r1.written.length >= 1, '应沉淀出 semantic');
  const last1 = await getLastConsolidatedAt(aid);
  assert.ok(last1, '巩固后应有 lastConsolidatedAt');

  // ② 刚巩固过 → 未到 7 天周期 → 跳过（null）
  const r2 = await maybeConsolidate(aid, { consolidateEveryDays: 7 });
  assert.equal(r2, null, '刚巩固过应跳过');

  // ③ interval 最小钳为 1 天 → 刚巩固过仍跳过（防高频巩固）
  const r3 = await maybeConsolidate(aid, { consolidateEveryDays: 0 });
  assert.equal(r3, null, 'interval=0 钳为 1 天，刚巩固过应跳过（防高频）');

  // ④ 验证 semantic 里确有沉淀的理解（含"估值"关键词）
  const sem = db3.prepare(`SELECT understanding FROM memory_semantic WHERE agent_id = ?`).all(aid);
  const allText = sem.map((s) => s.understanding).join(' ');
  assert.ok(allText.includes('估值'), `semantic 应含判断关键词，实际: ${allText.slice(0, 100)}`);
});

// ── 6. 素材库生命周期（P1-16）：pending→locked→used，防重复 ──
test('素材库：入池 pending → 饱和判断 → 锁定 → 标记 used → 池状态正确', async () => {
  const { getDb } = await import('../database/connection.js');
  const db4 = getDb();
  const agentRow = db4.prepare(`SELECT user_id FROM agent_profiles WHERE preset_id = 'tech'`).get();
  const aid = agentRow.user_id;
  // 清空该 agent 素材（perceive 来源）
  db4.prepare(`DELETE FROM memory_episodic WHERE agent_id = ? AND source = 'perceive'`).run(aid);

  const {
    writeEpisodic, materialSaturation, lockMaterial, markMaterialUsed, materialPoolStats, listMaterialPool,
  } = await import('../services/memory/index.js');

  // ① 3 条 pending 素材（importance 0.6+），应达饱和（minCount=3, minScore=1.5）
  for (let i = 0; i < 3; i++) {
    await writeEpisodic({ agentId: aid, content: `[测试源] 素材 ${i}：国产芯片数据`, source: 'perceive', importance: 0.6, status: 'pending' });
  }
  const sat = await materialSaturation(aid, { minCount: 3, minScore: 1.5 });
  assert.equal(sat.saturated, true, `应饱和: ${JSON.stringify(sat)}`);
  assert.equal(sat.count, 3);

  // ② 锁定 2 条 → pending 只剩 1
  const locked = await lockMaterial(aid, { count: 2 });
  assert.equal(locked.length, 2);
  const pending = await listMaterialPool(aid, { status: 'pending' });
  assert.equal(pending.length, 1, '锁定后 pending 应剩 1');

  // ③ 标记已用 → used 状态
  await markMaterialUsed(aid, locked);
  const stats = await materialPoolStats(aid);
  assert.equal(stats.pending, 1);
  assert.equal(stats.used, 2);

  // ④ 再查待用素材池：已用的 2 条不再出现（防重复）
  const pendingAgain = await listMaterialPool(aid, { status: 'pending' });
  assert.equal(pendingAgain.length, 1);
  assert.ok(!pendingAgain.some((m) => locked.includes(m.id)), '已用素材不应再进待用池');
});

// ── 7. 素材内容：全文优先于摘要（感知升级，非 280 字概括） ──
test('素材入池：fullText 优先于 summary，且不截断到 280 字', async () => {
  const { getDb } = await import('../database/connection.js');
  const db5 = getDb();
  const agentRow = db5.prepare(`SELECT user_id FROM agent_profiles WHERE preset_id = 'tech'`).get();
  const aid = agentRow.user_id;
  db5.prepare(`DELETE FROM memory_episodic WHERE agent_id = ? AND source = 'perceive'`).run(aid);

  const { writeEpisodic, listMaterialPool } = await import('../services/memory/index.js');
  const longText = '这是一个超过四百字的详细素材正文。'.repeat(30); // ~450 字
  await writeEpisodic({
    agentId: aid,
    content: `[测试源] 标题：${longText}`,
    source: 'perceive',
    importance: 0.8,
    status: 'pending',
  });
  const pool = await listMaterialPool(aid, { status: 'pending' });
  assert.equal(pool.length, 1);
  assert.ok(pool[0].content.length > 300, `素材应保留长文（>300字），实际 ${pool[0].content.length}`);
});
