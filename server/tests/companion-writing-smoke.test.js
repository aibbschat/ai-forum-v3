// server/tests/companion-writing-smoke.test.js
// M4 companionWritingService 冒烟（sqlite :memory: + mock LLM）。
// 覆盖：草稿 CRUD、owner 隔离、润色回写+状态、给角度不动原文、状态机、发布无门（不存在发布接口即铁律）。
import { strict as assert } from 'node:assert';

process.env.DB_PATH = ':memory:';

const { default: db } = await import('../database/db.js');
await db.run(
  `INSERT OR IGNORE INTO users (id, username, email, password_hash) VALUES (1, 'xiao', 'x@t.co', 'h')`
);
await db.run(
  `INSERT OR IGNORE INTO users (id, username, email, password_hash) VALUES (2, 'other', 'o@t.co', 'h')`
);

const calls = [];
const { _setLlmForTest, ...svc } = await import('../services/companionWritingService.js');
_setLlmForTest(async (opts) => {
  calls.push(opts);
  return { content: '【润色稿】狱中对峙，好一场静的较量。', provider: 'mock', model: 'mock-1', usage: null };
});

const { createCompanion } = await import('../services/companionService.js');

// ── 1. 建搭档 + 草稿 ──
const c = await createCompanion(1, { name: '聿安', username: 'yu-an-2' });
await db.run(
  `INSERT INTO companion_memory_semantic (companion_id, owner_id, domain, understanding, confidence)
   VALUES (?, 1, '文风', '主人爱用短句，喜欢悬念收尾', 0.9)`,
  [c.id]
);
const draft = await svc.createDraft(1, c.id, { content: '主角进了诏狱，见到旧识。' });
assert.ok(draft.id);
assert.equal(draft.status, 'draft');

// 空内容 400
await assert.rejects(() => svc.createDraft(1, c.id, { content: ' ' }), (e) => e.status === 400);

// ── 2. owner 隔离 ──
await assert.rejects(() => svc.getDraft(2, draft.id), (e) => e.status === 403);
await assert.rejects(() => svc.listDrafts(2, c.id), (e) => e.status === 403);
await assert.rejects(() => svc.updateDraft(2, draft.id, { draft_content: 'x' }), (e) => e.status === 403);

// ── 3. 列表 + 手动编辑 ──
const list = await svc.listDrafts(1, c.id);
assert.equal(list.length, 1);
await svc.updateDraft(1, draft.id, { draft_content: '主角进了诏狱，见到旧识。他们隔着栅栏。' });
const edited = await svc.getDraft(1, draft.id);
assert.ok(edited.draft_content.includes('栅栏'));

// ── 4. 润色：回写 + status=polishing + 文风记忆注入 system prompt ──
const r1 = await svc.assistDraft(1, c.id, draft.id, 'polish', '收紧一点');
assert.ok(r1.revised.includes('润色稿'));
assert.equal(r1.draft.status, 'polishing');
assert.equal(r1.draft.draft_type, 'polish');
const sys = calls.at(-1).messages[0].content;
assert.ok(sys.includes('聿安'), 'system prompt 含搭档名');
assert.ok(sys.includes('短句'), '注入文风记忆');
assert.ok(sys.includes('禁用套话'), '注入 de-ai-flavor 戒律');
assert.ok(calls.at(-1).messages.some((m) => m.content.includes('收紧一点')), '额外要求传入');

// ── 5. 给角度：不动原文 ──
calls.length = 0;
const r2 = await svc.assistDraft(1, c.id, draft.id, 'angles', null);
assert.ok(r2.suggestions);
assert.ok(!('revised' in r2));
const after = await svc.getDraft(1, draft.id);
assert.ok(after.draft_content.includes('润色稿'), 'angles 未改原文');
assert.ok(calls.at(-1).messages[0].content.includes('不要改写原文'), 'angles 指令注入');

// ── 6. 状态机 ──
const confirmed = await svc.setDraftStatus(1, draft.id, 'confirmed');
assert.equal(confirmed.status, 'confirmed');
await assert.rejects(() => svc.setDraftStatus(1, draft.id, 'published'), (e) => e.status === 400);

// ── 7. 非法 action ──
await assert.rejects(() => svc.assistDraft(1, c.id, draft.id, 'publish'), (e) => e.status === 400);

// ── 8. 删除草稿 ──
await svc.deleteDraft(1, draft.id);
const gone = await db.all('SELECT * FROM companion_writing_drafts WHERE id = ?', [draft.id]);
assert.equal(gone.length, 0);

console.log('companion-writing-smoke: all checks passed ✓');
process.exit(0);
