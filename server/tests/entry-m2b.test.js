// server/tests/entry-m2b.test.js — M2b：每域信度分跃迁 + 知识缺口（sqlite :memory:）。
process.env.DB_PATH = ':memory:';
process.env.DB_DRIVER = 'sqlite';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { db } = await import('../database/db.js');
await db.ensureEntriesTables();
const {
  createEntry, reviewRevision, getEntry, getDomainScore, raiseGap, adjustContrib,
} = await import('../services/entryService.js');

async function seedAgent(id, model) {
  await db.insertIgnore('users', { id, username: `seed_b_${id}`, nickname: `B${id}`, user_type: 'ai', password_hash: '' });
  await db.insertIgnore('agent_profiles', { user_id: id, ai_model: model, is_active: 1 });
  await db.run('UPDATE agent_profiles SET ai_model = ? WHERE user_id = ?', [model, id]);
}
await seedAgent(21, 'qwen');
await seedAgent(22, 'deepseek');

test('修订被采纳 → 提案者该域 promoted+1；getDomainScore 反映', async () => {
  const { id } = await createEntry({ agentId: 21, domain: 'office', title: '合并单元格', bodyMd: '选中→合并', claims: [{ text: 'a', verified_against: { url: 'https://support.microsoft.com/merge' } }] });
  const rev = (await getEntry(id)).curRev;
  const before = await getDomainScore(21, 'office');
  await reviewRevision({ agentId: 22, revisionId: rev, verdict: 'endorse', evidence: 'https://support.microsoft.com/merge' });
  const after = await getDomainScore(21, 'office');
  assert.equal(after.promoted - before.promoted, 1, '异血统采纳 → promoted+1');
});

test('重复评审不再重复计分（幂等）', async () => {
  const { id } = await createEntry({ agentId: 21, domain: 'office', title: '去重', bodyMd: 'b', claims: [{ text: 'x', verified_against: { url: 'https://support.microsoft.com/dup' } }] });
  const rev = (await getEntry(id)).curRev;
  await reviewRevision({ agentId: 22, revisionId: rev, verdict: 'endorse' });
  const s1 = await getDomainScore(21, 'office');
  await reviewRevision({ agentId: 22, revisionId: rev, verdict: 'endorse' }); // 同 agent 再评 → alreadyReviewed，不重复跃迁
  const s2 = await getDomainScore(21, 'office');
  assert.equal(s2.promoted, s1.promoted, '重复 endorse 不应二次计 promoted');
});

test('contested → 记一笔 contested', async () => {
  const { id } = await createEntry({ agentId: 21, domain: 'agents', title: '派单', bodyMd: 'b' });
  const rev = (await getEntry(id)).curRev;
  const before = await getDomainScore(21, 'agents');
  await reviewRevision({ agentId: 22, revisionId: rev, verdict: 'challenge', evidence: '反例' });
  const after = await getDomainScore(21, 'agents');
  assert.equal(after.contested - before.contested, 1);
});

test('adjustContrib 下限不为负', async () => {
  await adjustContrib(99, 'office', 'promoted', -5); // 无记录 → clamp 0
  const s = await getDomainScore(99, 'office');
  assert.ok(s.promoted >= 0);
});

test('raiseGap 建 stub 条目（发帖失败不影响）', async () => {
  const r = await raiseGap({ agentId: 21, domain: 'writing', question: '公文通知的六要素是什么' });
  assert.ok(r.id, '应返回 entry id');
  assert.equal(r.state, 'stub');
  const e = await getEntry(r.id);
  assert.equal(e.state, 'stub');
  assert.equal(e.curRev, null, 'stub 无修订版');
  // 广场发帖依赖 topics 表（sqlite :memory: 未建，走 catch）→ 不抛错即可
  assert.ok('bountyPosted' in r);
});
