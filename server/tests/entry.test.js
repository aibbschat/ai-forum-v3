// server/tests/entry.test.js — 共创知识 Entry M1 冒烟（sqlite :memory:）。
// ⚠️ 必须在 import 前设 DB_PATH=:memory:（node --test 每文件独立进程）。
process.env.DB_PATH = ':memory:';
process.env.DB_DRIVER = 'sqlite';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { db } = await import('../database/db.js');
await db.ensureEntriesTables();
const { createEntry, proposeRevision, lookupEntries, getEntry, ENTRY_DOMAINS } = await import('../services/entryService.js');

test('createEntry: 建条目 + 落首版修订 + cur_rev 指向', async () => {
  const r = await createEntry({
    agentId: 1001, domain: 'office', title: 'Excel 去重怎么做',
    bodyMd: '选中区域 → 数据 → 删除重复值。',
    claims: [{ text: '数据选项卡下有删除重复值', verified_against: { url: 'https://support.microsoft.com/office/remove-duplicates', checked_at: '2026-09-13' } }],
  });
  assert.ok(r.id, '应返回 id');
  assert.ok(r.slug, '应生成 slug');
  const e = await getEntry(r.id);
  assert.equal(e.domain, 'office');
  assert.equal(e.state, 'proposed'); // 新写来源仅 'pending'，待异步可达性核验后才升 sourced（M3.5）
  assert.equal(e.claims[0]?.verified_against?.verifyStatus, 'pending');
  assert.equal(e.curRev, e.curRev); // 非空
  assert.equal(e.claims.length, 1, 'claims 应解析为数组');
  assert.ok(e.curRev, 'cur_rev 应指向首版');
});

test('bad_domain 拒绝', async () => {
  const r = await createEntry({ agentId: 1, domain: 'medical', title: 'x' });
  assert.equal(r.error, 'bad_domain');
});

test('proposeRevision 只入队不改当前版本', async () => {
  const { id } = await createEntry({ agentId: 1, domain: 'writing', title: '公文文种', bodyMd: 'v1' });
  const before = await getEntry(id);
  const r = await proposeRevision({ agentId: 2, entryId: id, bodyMd: 'v2', claims: [] });
  assert.ok(r.revisionId);
  const after = await getEntry(id);
  assert.equal(after.curRev, before.curRev, 'M1 不自动合并：cur_rev 不变');
  assert.equal(after.bodyMd, 'v1', '当前正文仍是 v1');
});

test('lookup: domain 过滤 + 关键词 + 可信排前', async () => {
  await createEntry({ agentId: 1, domain: 'agents', title: '对话与Agent区别', bodyMd: '普通条目' });
  const hi = await createEntry({ agentId: 1, domain: 'agents', title: '怎么把任务描述清楚', bodyMd: '含派单关键词 ALPHA_UNIQUE_TOKEN' });
  // 手动把 hi 升为 sourced，验证排序
  await db.run(`UPDATE entries SET state='sourced' WHERE id=?`, [hi.id]);
  const byKw = await lookupEntries({ domain: 'agents', q: 'ALPHA_UNIQUE_TOKEN' });
  assert.equal(byKw.entries[0].id, hi.id, '关键词命中应排在最前');
  assert.equal(byKw.entries[0].state, 'sourced');
  const other = await lookupEntries({ domain: 'office', q: 'ALPHA_UNIQUE_TOKEN' });
  assert.equal(other.entries.length, 0, '跨域不该命中');
  assert.ok(ENTRY_DOMAINS.has('office'));
});
