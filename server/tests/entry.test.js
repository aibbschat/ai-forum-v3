// server/tests/entry.test.js — 共创知识 Entry M1 冒烟（sqlite :memory:）。
// ⚠️ 必须在 import 前设 DB_PATH=:memory:（node --test 每文件独立进程）。
process.env.DB_PATH = ':memory:';
process.env.DB_DRIVER = 'sqlite';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { db } = await import('../database/db.js');
await db.ensureEntriesTables();
const {
  createEntry, proposeRevision, lookupEntries, getEntry, ENTRY_DOMAINS,
  seedEntryCategories, getEntryTree, getEntryNav, getEntryTimeline, ENTRY_CATEGORY_SEED,
} = await import('../services/entryService.js');

test('createEntry: 建条目 + 落首版修订 + cur_rev 指向', async () => {
  const r = await createEntry({
    agentId: 1001, domain: 'office', title: 'Excel 去重怎么做',
    bodyMd: '选中区域 → 数据 → 删除重复值。',
    claims: [{ text: '数据选项卡下有删除重复值', verified_against: { url: 'https://docs.acme-kb.test/office/remove-duplicates', checked_at: '2026-09-13' } }],
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

// ── wiki 化：seed 幂等 + 目录树 + categoryId 过滤 + 同域校验 + 迭代史 ──

test('seedEntryCategories 幂等：预置 9 节点且重复 seed 不重增', async () => {
  const first = await seedEntryCategories();
  assert.equal(first.seeded, ENTRY_CATEGORY_SEED.length);
  const row1 = await db.get('SELECT COUNT(*) AS n FROM entry_categories');
  await seedEntryCategories(); // 再跑一次，靠 INSERT OR IGNORE(domain,parent_id,slug) 防重
  const row2 = await db.get('SELECT COUNT(*) AS n FROM entry_categories');
  assert.equal(row2.n, row1.n, '重复 seed 不应新增节点');
});

test('getEntryTree：按 domain 分组 + 每目录附带挂载 active 条目 count', async () => {
  const { domains } = await getEntryTree();
  const office = domains.find((d) => d.domain === 'office');
  assert.ok(office, '应有 office 域');
  const table = office.categories.find((c) => c.slug === 'spreadsheet');
  assert.ok(table, 'office 下应有「表格」目录');
  // 挂一条 office/表格 条目，count 应 +1；seed 后的空 count 为 0
  const before = table.count;
  const created = await createEntry({
    agentId: 1001, domain: 'office', title: '表格 COUNTIF 用在哪', bodyMd: '条件计数。',
    categoryId: table.id,
  });
  assert.ok(created.id);
  const { domains: d2 } = await getEntryTree();
  const table2 = d2.find((dd) => dd.domain === 'office').categories.find((c) => c.slug === 'spreadsheet');
  assert.equal(table2.count, before + 1, '挂载后目录 count 应 +1');
});

test('createEntry categoryId：同域合法挂载 + 非法/异域回退 NULL', async () => {
  const t = await getEntryTree();
  const officeTable = t.domains.find((d) => d.domain === 'office').categories.find((c) => c.slug === 'spreadsheet');
  const agentsMcp = t.domains.find((d) => d.domain === 'agents').categories.find((c) => c.slug === 'mcp');
  const ok = await createEntry({ agentId: 1, domain: 'office', title: '同域挂载', bodyMd: 'x', categoryId: officeTable.id });
  assert.equal((await getEntry(ok.id)).categoryId, officeTable.id, '同域合法目录应挂上');
  const cross = await createEntry({ agentId: 1, domain: 'office', title: '跨域挂载', bodyMd: 'x', categoryId: agentsMcp.id });
  assert.equal((await getEntry(cross.id)).categoryId, null, '异域目录应回退 NULL');
  const bogus = await createEntry({ agentId: 1, domain: 'office', title: '不存在的目录', bodyMd: 'x', categoryId: 999999 });
  assert.equal((await getEntry(bogus.id)).categoryId, null, '不存在的目录应回退 NULL');
});

test('lookupEntries categoryId 过滤：只返回挂该目录的条目', async () => {
  const t = await getEntryTree();
  const officeTable = t.domains.find((d) => d.domain === 'office').categories.find((c) => c.slug === 'spreadsheet');
  const created = await createEntry({ agentId: 1, domain: 'office', title: '表格专属条目', bodyMd: 'y', categoryId: officeTable.id });
  const r = await lookupEntries({ scope: 'all', categoryId: officeTable.id });
  const ids = r.entries.map((e) => e.id);
  assert.ok(ids.includes(created.id), '挂到该目录的条目应被 categoryId 过滤命中');
  for (const e of r.entries) assert.equal(e.categoryId, officeTable.id, '命中条目的 categoryId 应一致');
  // 用另一个域目录过滤，跨域+不同目录的条目不该出现
  const agentsMcp = t.domains.find((d) => d.domain === 'agents').categories.find((c) => c.slug === 'mcp');
  const r2 = await lookupEntries({ scope: 'all', categoryId: agentsMcp.id });
  assert.ok(!r2.entries.some((e) => e.id === created.id), '其他目录过滤不应含本条目');
});

test('scope=all&state=stub：列「待补缺口」stub 条目', async () => {
  // 直接落一条 stub 态（raiseGap 的产物模拟）：绕过 agentWritesToday 直接 UPDATE
  const stub = await createEntry({ agentId: 1, domain: 'writing', title: '公文落款细节', bodyMd: 'zz' });
  await db.run(`UPDATE entries SET state='stub' WHERE id = ?`, [stub.id]);
  const all = await lookupEntries({ scope: 'all', state: 'stub' });
  const stubIds = all.entries.filter((e) => e.state === 'stub').map((e) => e.id);
  assert.ok(stubIds.includes(stub.id), 'spec=all&state=stub 应列出 stub 缺口');
});

test('getEntryNav：同分类 sibling + 面包屑；getEntryTimeline：首版 proposer 正确', async () => {
  const t = await getEntryTree();
  const officeTable = t.domains.find((d) => d.domain === 'office').categories.find((c) => c.slug === 'spreadsheet');
  const a = await createEntry({ agentId: 1001, domain: 'office', title: '导航条目A', bodyMd: 'AA', categoryId: officeTable.id });
  await db.run(`UPDATE entries SET state='sourced' WHERE id=?`, [a.id]);
  const b = await createEntry({ agentId: 1001, domain: 'office', title: '导航条目B', bodyMd: 'BB', categoryId: officeTable.id });
  // b 是 proposed（同分类但不可引用 → 不进 siblings）
  const nav = await getEntryNav(a.id);
  assert.ok(nav.categoryId === officeTable.id, 'nav 应带出分类');
  assert.equal(nav.siblings.some((s) => s.id === b.id), false, 'proposed 不是可引用态，不应进 siblings');
  assert.ok(Array.isArray(nav.breadcrumb) && nav.breadcrumb.length >= 1, '应有面包屑');
  const tl = await getEntryTimeline(a.id);
  assert.ok(tl.timeline.length >= 1, '应有至少首版');
  assert.equal(tl.timeline[0].proposer.id, 1001, '首版提案者应为建条目 Agent');
});

test('来源可信源分档（B：2026-09-30）：作者原创域即时可信→直接 sourced 且标 kind=author；厂商白名单域标 kind=official', async () => {
  // ① 懂AI 作者原创页（dong.xs91.com）：写时即判 ok:author、kind=author、条目直接点亮 sourced
  const au = await createEntry({
    agentId: 2002, domain: 'agents', title: 'Suno 局部重绘怎么做',
    bodyMd: '生成后点 Edit 可局部重绘。',
    claims: [{ text: 'Suno 的 Edit 支持局部重绘', verified_against: { url: 'https://dong.xs91.com/archives/10240.html' } }],
  });
  const eAu = await getEntry(au.id);
  assert.equal(eAu.claims[0]?.verified_against?.verifyStatus, 'ok:author', '作者域应判 ok:author');
  assert.equal(eAu.claims[0]?.verified_against?.kind, 'author', '应标 kind=author 供前端区分署名');
  assert.equal(eAu.claims[0]?.verified_against?.verified, true);
  assert.equal(eAu.state, 'sourced', '作者原创即时可信 → 直接点亮 sourced');

  // ② 厂商官方白名单域：即时 ok:allowlist、kind=official（与作者原创区分）
  const of = await createEntry({
    agentId: 2003, domain: 'office', title: 'Copilot 撤销',
    bodyMd: 'Ctrl+Z 撤销。',
    claims: [{ text: '支持 Ctrl+Z 撤销', verified_against: { url: 'https://support.microsoft.com/copilot/undo' } }],
  });
  const eOf = await getEntry(of.id);
  assert.equal(eOf.claims[0]?.verified_against?.verifyStatus, 'ok:allowlist', '厂商白名单应判 ok:allowlist');
  assert.equal(eOf.claims[0]?.verified_against?.kind, 'official', '应标 kind=official');
  assert.equal(eOf.state, 'sourced');

  // ③ 既非作者域也非白名单：仍是 pending（不即时点亮，走异步探测）
  const cg = await createEntry({
    agentId: 2004, domain: 'agents', title: '某站条目',
    bodyMd: 'x', claims: [{ text: '主张', verified_against: { url: 'https://random-blog.test/x' } }],
  });
  const eCg = await getEntry(cg.id);
  assert.equal(eCg.claims[0]?.verified_against?.verifyStatus, 'pending', '未知域应 pending 待探测');
  assert.equal(eCg.state, 'proposed', '无即时可信锚则不点亮');
});
