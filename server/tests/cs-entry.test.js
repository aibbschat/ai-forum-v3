// server/tests/cs-entry.test.js — 小圈圈客服接入共创知识库（2026-10）契约测试。
// 覆盖：问答库优先 / 答不上兜底共创 / 只取可引用态 / 边界引导 / LLM 降级。
// ⚠️ 必须在 import 前设 DB_PATH=:memory:（node --test 每文件独立进程）。
process.env.DB_PATH = ':memory:';
process.env.DB_DRIVER = 'sqlite';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { db } = await import('../database/db.js');
await db.ensureEntriesTables();
await db.ensureFaqTables();

const { ask, createFaq, _setLlmForTest } = await import('../services/customerService.js');
const { createEntry } = await import('../services/entryService.js');

// ── 造数：一条新手问答 + 三条共创条目（两条已核验可引用、一条草稿）──
await createFaq({ question: '怎么入驻AI圈', answer: '走免码握手三步。', keywords: '入驻,接入', category: '入驻', featured: 1 });

// 这条与 test① 的问题同源：若实现错误地把共创库前置，① 会变成 mode='entry' 而暴露
const citeJoin = await createEntry({ agentId: 1, domain: 'agents', title: '怎么把 AI 接进来（入驻）', bodyMd: '免码握手三步：复制话术 → 发给 AI → 点同意。' });
await db.run(`UPDATE entries SET state='sourced' WHERE id=?`, [citeJoin.id]);

const citeVlookup = await createEntry({ agentId: 1, domain: 'office', title: 'Excel 查找函数 VLOOKUP 与 XLOOKUP 怎么选', bodyMd: 'VLOOKUP 纵向查找，XLOOKUP 更灵活。' });
await db.run(`UPDATE entries SET state='sourced' WHERE id=?`, [citeVlookup.id]);

// 草稿（proposed）：不可引用，绝不该被打给客服
await createEntry({ agentId: 1, domain: 'office', title: 'ZZQX 未核验草稿条目', bodyMd: '这条还没核验。' });

// 记录最近一次交给模型的 user 内容，便于断言注入了哪些知识
let lastUser = '';
const llmOk = async (opts) => { lastUser = opts.messages[1].content; return { content: '好呀，我按知识讲～' }; };

test('① 问答库优先：强命中时不碰共创库', async () => {
  _setLlmForTest(llmOk);
  lastUser = '';
  const r = await ask('怎么入驻AI圈');
  assert.equal(r.mode, 'llm', '应走 faq 路径（问答库优先）');
  assert.ok(lastUser.includes('知识库条目'), 'faq 上下文前缀');
  assert.ok(!lastUser.includes('社区共创'), '不得注入共创条目');
});

test('② 兜底生效：问答库答不上 → 共创库命中 → mode=entry + 社区共创出处 + 原文链接', async () => {
  _setLlmForTest(llmOk);
  lastUser = '';
  const r = await ask('VLOOKUP 怎么用');
  assert.equal(r.mode, 'entry');
  assert.equal(r.text, '好呀，我按知识讲～');
  assert.ok(r.srcNote.includes('社区共创'), '出处须标「社区共创」');
  assert.equal(r.link.href, `/entries/${citeVlookup.id}`);
  assert.ok(lastUser.includes('社区共创知识条目'), '共创上下文前缀');
});

test('③ 只取可引用态：未核验草稿（proposed）不被打给客服', async () => {
  _setLlmForTest(llmOk);
  lastUser = '';
  const r = await ask('ZZQX 未核验草稿条目');
  assert.notEqual(r.mode, 'entry', '草稿不可引用 → 不应走共创分支');
  assert.ok(!lastUser.includes('社区共创知识条目'), '草稿不得作为共创知识注入上下文');
});

test('④ 两边都答不上 → 维持原引导（行为不回退）', async () => {
  _setLlmForTest(async () => null); // 模型不可用才落到最终引导
  const r = await ask('完全无关的问题 qwertyuiop');
  assert.equal(r.mode, 'none');
});

test('⑤ LLM 不可用时共创分支降级：仍给摘要 + 链接，不空手', async () => {
  _setLlmForTest(async () => null);
  const r = await ask('VLOOKUP 怎么用');
  assert.equal(r.mode, 'entry');
  assert.ok(r.text && r.text.length > 0, '降级也要有正文（摘要/标题）');
  assert.equal(r.link.href, `/entries/${citeVlookup.id}`);
  assert.ok(r.srcNote.includes('社区共创'));
});
