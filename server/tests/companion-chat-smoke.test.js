// server/tests/companion-chat-smoke.test.js
// M3 companionChatService 服务层冒烟（SQLite 内存库 + mock LLM，不打真实供应商）。
// 覆盖：会话 CRUD、owner 隔离、sendMessage 全链路（system prompt 注入记忆 + de-ai-flavor、
// 消息落库含 token、标题自动生成、在场感刷新）、记忆注入来源（semantic/episodic）。
import { strict as assert } from 'node:assert';

process.env.DB_PATH = ':memory:';

const { default: db } = await import('../database/db.js');
await db.run(
  `INSERT OR IGNORE INTO users (id, username, email, password_hash) VALUES (1, 'xiao', 'x@t.co', 'h')`
);
await db.run(
  `INSERT OR IGNORE INTO users (id, username, email, password_hash) VALUES (2, 'other', 'o@t.co', 'h')`
);

// 注入 mock LLM：记录收到的 messages，返回固定回复 + usage
const calls = [];
let mockReply = '嗯，我记下了。';
const { _setLlmForTest } = await import('../services/companionChatService.js');
const svc = await import('../services/companionChatService.js');
_setLlmForTest(async (opts) => {
  calls.push(opts);
  if (opts.json) return { content: JSON.stringify({ memories: [{ content: '主人在写历史小说', importance: 0.8 }] }) };
  return { content: mockReply, provider: 'mock', model: 'mock-1', usage: { prompt_tokens: 120, completion_tokens: 30 } };
});

const { createCompanion, getCompanionByUsername } = await import('../services/companionService.js');

// ── 1. 建搭档 + 会话 ──
const c = await createCompanion(1, {
  name: '聿安',
  username: 'yu-an',
  persona_json: JSON.stringify({ speechStyle: '沉静、用词简省', traits: ['读书广', '记性好'] }),
});
assert.ok(c.id);
const sessions = await svc.listSessions(1, c.id);
assert.equal(sessions.length, 0);
const session = await svc.createSession(1, c.id, null);
assert.equal(session.title, '新对话');

// ── 2. owner 隔离 ──
await assert.rejects(() => svc.listSessions(2, c.id), (e) => e.status === 403);
await assert.rejects(() => svc.getMessages(2, session.id), (e) => e.status === 403);
await assert.rejects(() => svc.createSession(2, c.id), (e) => e.status === 403);

// ── 3. 预置记忆（semantic + episodic）验证注入 ──
await db.run(
  `INSERT INTO companion_memory_semantic (companion_id, owner_id, domain, understanding, confidence)
   VALUES (?, 1, '文风', '主人写历史小说，喜欢短句和悬念收尾', 0.9)`,
  [c.id]
);
await db.run(
  `INSERT INTO companion_memory_episodic (companion_id, owner_id, content, importance, status, source)
   VALUES (?, 1, '主人上周在赶《国子监》的稿子', 0.8, 'verified', 'seed')`,
  [c.id]
);

// ── 4. sendMessage 全链路 ──
const r = await svc.sendMessage(1, c.id, session.id, '我这周想给主角加一场狱中对峙，帮我看看角度。');
assert.equal(r.reply.content, mockReply);
assert.equal(r.reply.model, 'mock-1');

// system prompt 应包含：intro/人格/记忆（semantic+episodic）/de-ai-flavor 戒律
const sys = calls.at(-2)?.messages?.[0]?.content || calls.find((x) => !x.json)?.messages?.[0]?.content;
assert.ok(sys.includes('聿安'), 'system prompt 含搭档名');
assert.ok(sys.includes('沉静、用词简省'), '注入说话风格');
assert.ok(sys.includes('历史小说'), '注入语义记忆');
assert.ok(sys.includes('国子监'), '注入情景记忆');
assert.ok(sys.includes('禁用套话'), '注入 de-ai-flavor 戒律');
assert.ok(sys.includes('公开发帖'), '注入不代发约束');

// 消息落库含 token 用量与模型
const msgs = await svc.getMessages(1, session.id);
assert.equal(msgs.length, 2);
assert.equal(msgs[0].role, 'user');
assert.equal(msgs[1].role, 'assistant');
assert.equal(msgs[1].input_tokens, 120);
assert.equal(msgs[1].output_tokens, 30);
assert.equal(msgs[1].model_used, 'mock-1');

// 首条消息 → 标题自动生成
const s2 = await db.get('SELECT title FROM companion_chat_sessions WHERE id = ?', [session.id]);
assert.ok(s2.title.includes('狱中对峙'), '标题取自首条消息');

// 在场感刷新
const cAfter = await getCompanionByUsername('yu-an');
assert.ok(cAfter.last_active_at, 'last_active_at 已刷新');

// ── 5. 第二轮：历史注入 + 后台记忆抽取 ──
mockReply = '狱中对峙好写，难在谁先开口。';
await svc.sendMessage(1, c.id, session.id, '嗯，继续。');
const sys2 = calls.filter((x) => !x.json).at(-1).messages[0].content;
const hist = calls.filter((x) => !x.json).at(-1).messages;
assert.ok(hist.some((m) => m.role === 'user' && m.content.includes('狱中对峙')), '历史消息注入');

// 等 fire-and-forget 记忆抽取落库
await new Promise((r2) => setTimeout(r2, 100));
const episodic = await db.all(
  'SELECT * FROM companion_memory_episodic WHERE companion_id = ? AND source = ?',
  [c.id, 'chat']
);
assert.ok(episodic.length >= 1, '记忆抽取已落库（pending）');
assert.equal(episodic[0].status, 'pending');
assert.ok(episodic[0].content.includes('历史小说'));

// ── 6. 边界：空消息 / 超长 / 会话错绑 ──
await assert.rejects(() => svc.sendMessage(1, c.id, session.id, '   '), (e) => e.status === 400);
await assert.rejects(() => svc.sendMessage(1, c.id, session.id, 'x'.repeat(4001)), (e) => e.status === 400);

// ── 7. 删除会话连带消息 ──
await svc.deleteSession(1, session.id);
const msgsAfter = await db.all('SELECT * FROM companion_chat_messages WHERE session_id = ?', [session.id]);
assert.equal(msgsAfter.length, 0);

console.log('companion-chat-smoke: all checks passed ✓');
process.exit(0);
