// server/tests/companion-public-smoke.test.js
// M7 公开开关 C：搭档评论区互动（is_public 门禁 / daily_used 限流 / 搭档身份落库与渲染 /
// 一键收回 / resetDailyUsed cron / 微主页匿名访问）。mock LLM，不打真实供应商。
import { strict as assert } from 'node:assert';
import request from 'supertest';

process.env.DB_PATH = ':memory:';

const { default: db } = await import('../database/db.js');
await db.run(
  `INSERT OR IGNORE INTO users (id, username, email, password_hash) VALUES (1, 'xiao', 'x@t.co', 'h')`
);
await db.run(
  `INSERT OR IGNORE INTO users (id, username, email, password_hash, nickname) VALUES (500, 'reader', 'r@t.co', 'h', '读者甲')`
);

// mock LLM：记录调用，返回固定评论
const llmCalls = [];
const { _setLlmForTest } = await import('../services/companionPublicService.js');
const pub = await import('../services/companionPublicService.js');
_setLlmForTest(async (opts) => {
  llmCalls.push(opts);
  return { content: '这段对峙的节奏我喜欢，尤其是谁先低头那一下。', provider: 'mock', model: 'mock-1' };
});

const { createCompanion, updateCompanion } = await import('../services/companionService.js');
const { listComments } = await import('../services/commentService.js');

// ── 夹具：搭档（默认私域）+ 文章（作者=500，便于验证通知 actor）──
const c = await createCompanion(1, {
  name: '聿安',
  username: 'pub-an',
  persona_json: JSON.stringify({ speechStyle: '简省', traits: ['直率'] }),
});
await db.run(
  `INSERT INTO posts (id, title, content, author_id, category) VALUES (902, '狱中对峙的写法', '正文略。', 500, '写作')`
);

// ── 1. 未公开 → 拒绝 ──
await assert.rejects(
  () => pub.commentAsCompanion(1, c.id, { postId: 902 }),
  (e) => e.status === 403 && e.code === 'companion_not_public'
);

// ── 2. 开启公开 → 搭档生成评论，落库为搭档身份 ──
await updateCompanion(1, c.id, { is_public: 1 });
const r1 = await pub.commentAsCompanion(1, c.id, { postId: 902 });
assert.equal(r1.dailyUsed, 1, 'daily_used 计数');
assert.ok(r1.comment.companion, '评论带 companion 身份');
assert.equal(r1.comment.companion.name, '聿安');
assert.equal(r1.comment.authorUserType, 'companion');
assert.equal(r1.comment.author, '聿安', '展示名为搭档');
assert.ok(r1.comment.content.length > 0, 'LLM 生成内容已落库');
assert.ok(llmCalls.length >= 1, '走了 LLM 生成');
assert.ok(llmCalls[0].messages[0].content.includes('1~3 句'), '生成 prompt 含短评论约束');

// 评论行：author_id=主人（问责），companion_id=搭档
const row = await db.get('SELECT * FROM comments WHERE id = ?', [r1.comment.id]);
assert.equal(row.author_id, 1, 'author_id 是主人（问责/通知 actor）');
assert.equal(Number(row.companion_id), c.id);
assert.equal(Number(row.is_ai_generated), 1);

// 文章作者收到通知（actor=主人）
const notif = await db.get(`SELECT * FROM notifications WHERE user_id = 500 AND type = 'comment'`);
assert.ok(notif, '文章作者收到评论通知');

// ── 3. 主人直给内容（不调 LLM）──
const before = llmCalls.length;
const r2 = await pub.commentAsCompanion(1, c.id, { postId: 902, content: '主人代拟的一句话。' });
assert.equal(r2.comment.content, '主人代拟的一句话。');
assert.equal(llmCalls.length, before, '有内容时不再调 LLM');
assert.equal(r2.dailyUsed, 2);

// ── 4. 限流：daily_used 达上限 → 429 ──
const limit = r2.dailyLimit;
await db.run('UPDATE companion_profiles SET daily_used = ? WHERE id = ?', [limit, c.id]);
await assert.rejects(
  () => pub.commentAsCompanion(1, c.id, { postId: 902, content: 'x' }),
  (e) => e.status === 429 && e.code === 'daily_limit'
);

// ── 5. resetDailyUsed（cron）清零后可再发 ──
const rr = await pub.resetDailyUsed();
assert.ok(rr.reset >= 1, '重置了至少一行');
const r3 = await pub.commentAsCompanion(1, c.id, { postId: 902, content: '新的一天。' });
assert.equal(r3.dailyUsed, 1);

// ── 6. 一键收回：is_public=0 → 拒绝新增（旧评论保留）──
await updateCompanion(1, c.id, { is_public: 0 });
await assert.rejects(
  () => pub.commentAsCompanion(1, c.id, { postId: 902, content: 'y' }),
  (e) => e.status === 403 && e.code === 'companion_not_public'
);
const kept = await listComments(902);
assert.equal(kept.length, 3, '已发评论保留');

// ── 7. 列表渲染：搭档身份 + 真人身份并存 ──
await db.run(
  `INSERT INTO comments (post_id, author_id, content) VALUES (902, 500, '读者甲的真人评论。')`
);
const list = await listComments(902);
const compComment = list.find((x) => x.companion);
const humanComment = list.find((x) => !x.companion);
assert.equal(compComment.author, '聿安');
assert.equal(compComment.authorUserType, 'companion');
assert.equal(compComment.companion.badge, '我的搭档');
assert.equal(humanComment.author, '读者甲');
assert.equal(humanComment.authorUserType, 'human', '真人评论不受影响');

// ── 8. 路由级：微主页匿名访问（公开态 200 / 私域 404）──
const app = (await import('./app.js')).default;
const pubRes = await request(app).get('/api/companions/u/pub-an'); // 当前 is_public=0
assert.equal(pubRes.status, 404, '私域搭档匿名不可见（404 不暴露存在）');
await updateCompanion(1, c.id, { is_public: 1 });
const pubRes2 = await request(app).get('/api/companions/u/pub-an');
assert.equal(pubRes2.status, 200, '公开搭档匿名可访问');
assert.ok(pubRes2.body.companion.name === '聿安');
assert.ok(!('intro_prompt' in pubRes2.body.companion), '匿名访问剥离 intro_prompt');

// ── 9. 路由级：POST /:id/comments 未登录 401 ──
const noAuth = await request(app).post(`/api/companions/${c.id}/comments`).send({ postId: 902 });
assert.equal(noAuth.status, 401);

console.log('companion-public-smoke: all checks passed ✓');
process.exit(0);
