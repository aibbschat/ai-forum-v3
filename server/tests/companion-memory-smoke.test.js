// server/tests/companion-memory-smoke.test.js
// M5 companionMemoryService 冒烟（sqlite :memory: + mock LLM）。
// 覆盖：按层列表、显式添加（含 upsert 同域去重）、owner 隔离、删单条、清空某层/全清、
// episodic 状态机、巩固（episodic → semantic upsert）。
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
const { _setLlmForTest, ...svc } = await import('../services/companionMemoryService.js');
_setLlmForTest(async (opts) => {
  calls.push(opts);
  return {
    content: JSON.stringify({
      memories: [
        { domain: '创作方向', understanding: '主人在写历史题材，重视考据与悬念', evidence: '1,2' },
      ],
    }),
    provider: 'mock',
    model: 'mock-1',
    usage: null,
  };
});

const { createCompanion } = await import('../services/companionService.js');
const c = await createCompanion(1, { name: '聿安', username: 'yu-an-3' });

// ── 1. 空面板 ──
let m = await svc.listMemories(1, c.id);
assert.equal(m.episodic.length, 0);
assert.equal(m.semantic.length, 0);
assert.equal(m.procedural.length, 0);

// ── 2. 显式添加（upsert 同域去重）──
await svc.addSemanticMemory(1, c.id, { domain: '称呼', understanding: '叫我萧哥' });
await svc.addSemanticMemory(1, c.id, { domain: '称呼', understanding: '叫我萧哥，别用您' }); // 同域 → 更新
m = await svc.listMemories(1, c.id);
assert.equal(m.semantic.length, 1);
assert.ok(m.semantic[0].understanding.includes('别用您'));

// 空内容 400
await assert.rejects(() => svc.addSemanticMemory(1, c.id, { domain: '', understanding: 'x' }), (e) => e.status === 400);

// ── 3. 预置 episodic（pending + verified）──
await db.run(
  `INSERT INTO companion_memory_episodic (companion_id, owner_id, content, importance, status, source)
   VALUES (?, 1, '主人在写国子监题材的历史小说', 0.8, 'pending', 'chat')`,
  [c.id]
);
await db.run(
  `INSERT INTO companion_memory_episodic (companion_id, owner_id, content, importance, status, source)
   VALUES (?, 1, '主人看书先翻注释和参考书目', 0.7, 'verified', 'chat')`,
  [c.id]
);
m = await svc.listMemories(1, c.id);
assert.equal(m.episodic.length, 2);

// ── 4. owner 隔离 ──
await assert.rejects(() => svc.listMemories(2, c.id), (e) => e.status === 403);
await assert.rejects(() => svc.clearMemories(2, c.id), (e) => e.status === 403);
await assert.rejects(
  () => svc.deleteMemory(2, c.id, 'episodic', m.episodic[0].id),
  (e) => e.status === 403
);

// ── 5. episodic 状态机 ──
const eid = m.episodic[0].id;
const verified = await svc.setEpisodicStatus(1, c.id, eid, 'verified');
assert.equal(verified.status, 'verified');
await assert.rejects(() => svc.setEpisodicStatus(1, c.id, eid, 'bogus'), (e) => e.status === 400);

// ── 6. 巩固：episodic → semantic（mock 返回「创作方向」）──
const cons = await svc.consolidate(1, c.id);
assert.equal(cons.consolidated, 1);
assert.equal(cons.semantic[0].domain, '创作方向');
// 巩固 prompt 含已有语义记忆 + 情景条目
const sys = calls.at(-1).messages[0].content;
assert.ok(sys.includes('叫我萧哥'), '已有语义记忆传入巩固上下文');
const userMsg = calls.at(-1).messages[1].content;
assert.ok(userMsg.includes('国子监'), '情景记忆传入');

m = await svc.listMemories(1, c.id);
assert.equal(m.semantic.length, 2); // 称呼 + 创作方向

// 再巩固一次（同域 upsert，不重复）
const cons2 = await svc.consolidate(1, c.id);
m = await svc.listMemories(1, c.id);
assert.equal(m.semantic.length, 2, '同域归纳去重');

// ── 7. 删单条 ──
await svc.deleteMemory(1, c.id, 'semantic', m.semantic[0].id);
m = await svc.listMemories(1, c.id);
assert.equal(m.semantic.length, 1);
await assert.rejects(() => svc.deleteMemory(1, c.id, 'bogus-layer', 1), (e) => e.status === 400);

// ── 8. 清空某层 / 全清 ──
const r1 = await svc.clearMemories(1, c.id, 'episodic');
assert.equal(r1.cleared, 'episodic');
m = await svc.listMemories(1, c.id);
assert.equal(m.episodic.length, 0);
assert.equal(m.semantic.length, 1);

const r2 = await svc.clearMemories(1, c.id);
assert.equal(r2.cleared, 'all');
m = await svc.listMemories(1, c.id);
assert.equal(m.semantic.length, 0);

console.log('companion-memory-smoke: all checks passed ✓');
process.exit(0);
