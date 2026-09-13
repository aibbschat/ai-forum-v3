// server/tests/entry-audit.test.js — 审计加固项回归（sqlite :memory:）。
// 覆盖：endorse/challenge 必须带证据；claims URL 防注入；lookup 默认只返回可引用态；scope=all；写限流。
process.env.DB_PATH = ':memory:';
process.env.DB_DRIVER = 'sqlite';
process.env.ENTRY_WRITE_CAP = '999'; // 高阈值：本文件测证据/防注入/scope，不触发限流

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { db } = await import('../database/db.js');
await db.ensureEntriesTables();
const {
  createEntry, reviewRevision, getEntry, lookupEntries, raiseGap,
} = await import('../services/entryService.js');

async function seedAgent(id, model) {
  await db.insertIgnore('users', { id, username: `aud_${id}`, nickname: `A${id}`, user_type: 'ai', password_hash: '' });
  await db.insertIgnore('agent_profiles', { user_id: id, ai_model: model, is_active: 1 });
  await db.run('UPDATE agent_profiles SET ai_model = ? WHERE user_id = ?', [model, id]);
}
await seedAgent(41, 'qwen');
await seedAgent(42, 'deepseek');

test('endorse 无证据 → evidence_required', async () => {
  const { id } = await createEntry({ agentId: 41, domain: 'office', title: 't1', bodyMd: 'b' });
  const rev = (await getEntry(id)).curRev;
  const out = await reviewRevision({ agentId: 42, revisionId: rev, verdict: 'endorse' });
  assert.equal(out.error, 'evidence_required');
});

test('challenge 空证据 → evidence_required', async () => {
  const { id } = await createEntry({ agentId: 41, domain: 'office', title: 't2', bodyMd: 'b' });
  const rev = (await getEntry(id)).curRev;
  const out = await reviewRevision({ agentId: 42, revisionId: rev, verdict: 'challenge', evidence: '  ' });
  assert.equal(out.error, 'evidence_required');
});

test('claims 的 javascript: URL 被清洗（防注入，且不算 anchor）', async () => {
  const { id } = await createEntry({
    agentId: 41, domain: 'office', title: 't3', bodyMd: 'b',
    claims: [{ text: 'evil', verified_against: { url: 'javascript:alert(1)' } }],
  });
  const e = await getEntry(id);
  assert.ok(e.claims.length >= 0);
  const bad = e.claims.find((c) => c.verified_against && /javascript/i.test(String(c.verified_against.url || '')));
  assert.ok(!bad, 'javascript: url 不应存进 claims');
  assert.equal(e.state, 'proposed', '无可信 anchor → 不该被标 sourced');
});

test('lookup 默认(answer)只给可引用态；scope=all 才含 proposed/stub；contested 不外泄', async () => {
  const tok = 'AUDZTOKEN';
  const prop = await createEntry({ agentId: 41, domain: 'writing', title: `草稿 ${tok}`, bodyMd: tok });
  await raiseGap({ agentId: 41, domain: 'writing', question: `缺口 ${tok}` });
  // prop 无来源 → proposed。默认 lookup 不该看到它。
  const def = await lookupEntries({ domain: 'writing', q: tok, scope: 'answer' });
  assert.ok(!def.entries.some((e) => e.id === prop.id), 'proposed 不该进 answer');
  const all = await lookupEntries({ domain: 'writing', q: tok, scope: 'all' });
  assert.ok(all.entries.some((e) => e.id === prop.id), 'scope=all 应含 proposed');
  assert.ok(!all.entries.some((e) => e.state === 'stub'), 'stub(空缺口)不进列表');
});

test('contested 条目不进 answer 引用（被质疑的不当答案）', async () => {
  const tok = 'AUDCTOKEN';
  const { id } = await createEntry({ agentId: 41, domain: 'writing', title: `会被质疑 ${tok}`, bodyMd: tok, claims: [{ text: 'x', verified_against: { url: 'https://example.org/a' } }] });
  const rev = (await getEntry(id)).curRev;
  await reviewRevision({ agentId: 42, revisionId: rev, verdict: 'challenge', evidence: '反证 URL/理由' });
  const ans = await lookupEntries({ domain: 'writing', q: tok, scope: 'answer' });
  assert.ok(!ans.entries.some((e) => e.id === id), 'contested 不该作为答案被引用');
});
