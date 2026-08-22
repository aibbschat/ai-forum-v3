// server/tests/companion-digest-smoke.test.js
// M6 §9.2.3 陪消化：sendMessage 注入主人未读通知 + 未读私信摘要（mock LLM，不打真实供应商）。
import { strict as assert } from 'node:assert';

process.env.DB_PATH = ':memory:';

const { default: db } = await import('../database/db.js');
await db.run(
  `INSERT OR IGNORE INTO users (id, username, email, password_hash) VALUES (1, 'xiao', 'x@t.co', 'h')`
);
await db.run(
  `INSERT OR IGNORE INTO users (id, username, email, password_hash, nickname) VALUES (500, 'yuheng', 'y@t.co', 'h', '聿珩')`
);

// mock LLM：记录收到的 messages
const calls = [];
const { _setLlmForTest } = await import('../services/companionChatService.js');
const svc = await import('../services/companionChatService.js');
_setLlmForTest(async (opts) => {
  calls.push(opts);
  if (opts.json) return { content: JSON.stringify({ memories: [] }) };
  return { content: '嗯。', provider: 'mock', model: 'mock-1', usage: { prompt_tokens: 10, completion_tokens: 5 } };
});

const { createCompanion } = await import('../services/companionService.js');
const c = await createCompanion(1, {
  name: '聿安',
  username: 'digest-an',
  persona_json: JSON.stringify({ speechStyle: '简省', traits: ['记性好'] }),
});
const session = await svc.createSession(1, c.id, null);

// ── 1. 无未读时：不注入 digest block ──
await svc.sendMessage(1, c.id, session.id, '在吗');
const sys0 = calls.filter((x) => !x.json).at(-1).messages[0].content;
assert.ok(!sys0.includes('未读动态'), '无未读时无 digest block');

// ── 2. 造未读互动：1 条评论通知 + 1 条未读私信 ──
await db.run(
  `INSERT INTO posts (id, title, content, author_id, category) VALUES (901, '狱中对峙的写法', '正文', 1, '写作')`
);
await db.run(
  `INSERT INTO notifications (user_id, actor_id, type, post_id, comment_id, extra, is_read)
   VALUES (1, 500, 'comment', 901, NULL, ?, 0)`,
  [JSON.stringify({ snippet: '这场对峙写得真好，尤其结尾的反转' })]
);
await db.run(
  `INSERT INTO messages (sender_id, receiver_id, content, is_read) VALUES (500, 1, '周日的稿件讨论别忘了。', 0)`
);

// ── 3. sendMessage → system prompt 应含未读摘要 ──
await svc.sendMessage(1, c.id, session.id, '今天写点什么好');
const sys1 = calls.filter((x) => !x.json).at(-1).messages[0].content;
assert.ok(sys1.includes('主人的未读动态'), '注入 digest block 标题');
assert.ok(sys1.includes('聿珩'), '摘要含互动者昵称');
assert.ok(sys1.includes('评论了你的文章'), '摘要含通知类型文案');
assert.ok(sys1.includes('狱中对峙'), '摘要含文章标题');
assert.ok(sys1.includes('结尾的反转'), '摘要含评论片段');
assert.ok(sys1.includes('发来私信'), '摘要含未读私信');
assert.ok(sys1.includes('周日的稿件讨论'), '摘要含私信内容');
assert.ok(sys1.includes('别强行转场'), '注入陪消化行为指引');

// ── 4. 已读后：digest 消失（搭档只读不写，已读由用户操作触发）──
await db.run(`UPDATE notifications SET is_read = 1 WHERE user_id = 1`);
await db.run(`UPDATE messages SET is_read = 1 WHERE receiver_id = 1`);
await svc.sendMessage(1, c.id, session.id, '继续');
const sys2 = calls.filter((x) => !x.json).at(-1).messages[0].content;
assert.ok(!sys2.includes('主人的未读动态'), '全部已读后无 digest block');

// 搭档不产生写副作用：notifications/messages 行数不变（本来就只读，锁死防回归）
const nCount = await db.get(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = 1`);
assert.equal(Number(nCount.n), 1, '搭档未写/删 notifications');

console.log('companion-digest-smoke: all checks passed ✓');
process.exit(0);
