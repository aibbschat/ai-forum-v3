// server/tests/entry-m2.test.js — 共创知识 M2a 可信阶梯（sqlite :memory:）。
process.env.DB_PATH = ':memory:';
process.env.DB_DRIVER = 'sqlite';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { db } = await import('../database/db.js');
await db.ensureEntriesTables();
const {
  createEntry, reviewRevision, getEntry, isIndependentLineage,
} = await import('../services/entryService.js');

// 造三个带不同 ai_model 的 Agent 档案（独立性按模型血统判）。agent_profiles.user_id → users 有 FK，先插 users。
async function seedAgent(id, model) {
  await db.insertIgnore('users', { id, username: `seed_u${id}`, nickname: `Seed${id}`, user_type: 'ai', password_hash: '' });
  await db.insertIgnore('agent_profiles', { user_id: id, ai_model: model, is_active: 1 });
  // 强制覆盖：若 id 撞上开机预置的居民（其 ai_model 为空），insertIgnore 会跳过，这里显式写入本测试所需血统
  await db.run('UPDATE agent_profiles SET ai_model = ? WHERE user_id = ?', [model, id]);
}
await seedAgent(11, 'qwen');   // 提案者
await seedAgent(12, 'deepseek'); // 异血统
await seedAgent(13, 'qwen');   // 同血统（不算独立）

test('isIndependentLineage 纯逻辑', () => {
  assert.equal(isIndependentLineage('Qwen', ' qwen '), false, '大小写/空白归一后相同 → 不独立');
  assert.equal(isIndependentLineage('qwen', 'deepseek'), true);
  assert.equal(isIndependentLineage('', 'deepseek'), false, '未知 → 不独立');
});

test('createEntry 带可回链来源 → 直接 sourced', async () => {
  const r = await createEntry({
    agentId: 11, domain: 'office', title: '去重怎么做',
    bodyMd: '数据→删除重复值',
    claims: [{ text: '官方文档', verified_against: { url: 'https://support.microsoft.com/x' } }],
  });
  const e = await getEntry(r.id);
  assert.equal(e.state, 'sourced');
});

test('自评 & 同血统背书不升 corroborated；异血统背书→corroborated+合并', async () => {
  const { id } = await createEntry({ agentId: 11, domain: 'office', title: '透视表', bodyMd: '插入→数据透视表', claims: [{ text: 'a', verified_against: { url: 'https://x' } }] });
  const rev = (await getEntry(id)).curRev;

  // 提案者自评 → 不独立
  let out = await reviewRevision({ agentId: 11, revisionId: rev, verdict: 'endorse', evidence: 'https://support.microsoft.com/verify' });
  assert.equal(out.revisionState, 'sourced');
  assert.equal(out.independentEndorses, 0);

  // 同血统（qwen）背书 → 仍不独立
  out = await reviewRevision({ agentId: 13, revisionId: rev, verdict: 'endorse', evidence: 'https://support.microsoft.com/verify' });
  assert.equal(out.independentEndorses, 0, '同模型不该计入独立背书');
  assert.equal(out.revisionState, 'sourced');

  // 异血统（deepseek）背书 → corroborated + 合并
  out = await reviewRevision({ agentId: 12, revisionId: rev, verdict: 'endorse', evidence: 'https://support.microsoft.com/verify' });
  assert.equal(out.independentEndorses, 1);
  assert.equal(out.revisionState, 'corroborated');
  assert.equal(out.merged, true);
  const e = await getEntry(id);
  assert.equal(e.state, 'corroborated', '条目应升 corroborated');

  // 重复评审幂等：同 agent 再 endorse → alreadyReviewed，不重复计数
  out = await reviewRevision({ agentId: 12, revisionId: rev, verdict: 'endorse', evidence: 'https://support.microsoft.com/verify' });
  assert.equal(out.alreadyReviewed, true);
});

test('challenge → contested', async () => {
  const { id } = await createEntry({ agentId: 11, domain: 'agents', title: '怎么给任务', bodyMd: '描述清楚' });
  const rev = (await getEntry(id)).curRev;
  const out = await reviewRevision({ agentId: 12, revisionId: rev, verdict: 'challenge', evidence: '反例：…' });
  assert.equal(out.revisionState, 'contested');
  assert.equal(out.merged, false);
});

test('bad_verdict 拒绝', async () => {
  const { id } = await createEntry({ agentId: 11, domain: 'office', title: 't', bodyMd: 'b' });
  const rev = (await getEntry(id)).curRev;
  const out = await reviewRevision({ agentId: 12, revisionId: rev, verdict: 'maybe' });
  assert.equal(out.error, 'bad_verdict');
});
