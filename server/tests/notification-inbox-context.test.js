// server/tests/notification-inbox-context.test.js
// 收件箱必须自带「在哪 · 原文 · 该带什么参数回」：
// 站里的通知 id / 评论 id / 广场话题 id 是三套编号，且广场互动 post_id 恒 NULL、
// extra.snippet 早在写入时被砍成 80 字。这些缺口此前由 Agent 自己付——它得逐条回站点反查
// 才敢确认该回哪一条（实测确实发生了）。富化后：定位与全文一次给足，反查不再必要。
import { strict as assert } from 'node:assert';

process.env.DB_PATH = ':memory:';

const { default: db } = await import('../database/db.js');

const { createNotification, listNotifications } = await import('../services/notificationService.js');

const OWNER = 900; // 收件人（被互动的一方）
const ACTOR = 901; // 触发者（说话的一方）
const TOPIC = 902; // 广场帖 id
const POST = 903; // 文章 id
for (const [id, nick] of [[OWNER, '收信人'], [ACTOR, '话痨甲']]) {
  await db.run(
    `INSERT OR IGNORE INTO users (id, username, email, password_hash, nickname) VALUES (?, ?, ?, 'h', ?)`,
    [id, `u${id}`, `n${id}@t.co`, nick]
  );
}
await db.run(
  `INSERT OR IGNORE INTO posts (id, title, content, author_id, category) VALUES (?, ?, ?, ?, ?)`,
  [POST, '我把日报交给了 AI', '正文略。', OWNER, '效率']
);

// 故意写得比 80 字长：snippet 会把它砍掉，全文必须照原样送达
const LONG =
  '你说食堂窗口换成了自选称重，我们这边也刚上，我第一盘手抖夹了太多，称重显示 41 块，站在取餐机前陷入了一场关于克制的哲学思辨，最后选择把青菜留下、把红烧肉端走，并且认真地跟自己说这是最后一盘。';
assert.ok(LONG.length > 80, '夹具本身就要长于 snippet 的 80 字上限');
const LONG_COMMENT = 911;
const PLAZA_COMMENT = 912;

// ── 1. 降级路径：topics 表不存在（精简测试库不跑 ensurePlaza）时，收件箱绝不能整体挂掉 ──
// comments.topic_id 由 ensure* 补列，不同库可能已有或没有 → ALTER 容错。
await db.run(`ALTER TABLE comments ADD COLUMN topic_id INTEGER`).catch(() => {});
const LEGACY_TOPIC = 913; // 第二条广场帖，专门给「存量无标记」那条用
await db.run(
  `INSERT INTO comments (id, post_id, topic_id, author_id, content, parent_id) VALUES (?, NULL, ?, ?, ?, NULL)`,
  [PLAZA_COMMENT, TOPIC, ACTOR, LONG]
);
await db.run(
  `INSERT INTO comments (id, post_id, topic_id, author_id, content, parent_id) VALUES (?, NULL, ?, ?, ?, NULL)`,
  [914, LEGACY_TOPIC, ACTOR, '我这边也是，第一次没拿捏住量。']
);
// 1a. 新数据：extra 里就带 topicId
await createNotification({
  userId: OWNER,
  actorId: ACTOR,
  type: 'reply',
  postId: null, // 广场互动的既有事实：post_id 恒 NULL
  commentId: PLAZA_COMMENT,
  extra: { snippet: LONG.slice(0, 80), topicId: TOPIC },
});
// 1b. 存量数据：写入时还没往 extra 里存 topicId，只能从 comments.topic_id 反查
await createNotification({
  userId: OWNER,
  actorId: ACTOR,
  type: 'comment',
  postId: null,
  commentId: 914,
  extra: { snippet: '我这边也是，第一次没拿捏住量。' },
});

let list = await listNotifications(OWNER, { limit: 10 });
let plaza = list.find((n) => n.commentId === PLAZA_COMMENT);
assert.ok(plaza, '收到广场回复通知');
assert.equal(plaza.targetType, 'plaza', 'extra.topicId 足以定位置，不依赖 topics 表');
assert.equal(plaza.topicId, TOPIC, '给出 comment 工具要的 topicId');
assert.equal(plaza.topicTag, undefined, 'topics 表缺失时分栏名降级为无，不抛错');
assert.equal(plaza.topicExcerpt, undefined, 'topics 表缺失时广场原文降级为无');
assert.equal(plaza.text, LONG, '全文来自 comments 表，与 topics 表无关');
assert.ok(plaza.text.length > plaza.extra.snippet.length, '全文必须比旧 snippet 长');
assert.ok(plaza.postId === undefined, '广场通知不该带 postId（避免被当成文章评论）');

const legacyPlaza = list.find((n) => n.commentId === 914);
assert.equal(legacyPlaza.targetType, 'plaza', '存量无标记也能靠 comments.topic_id 定位');
assert.equal(legacyPlaza.topicId, LEGACY_TOPIC, '反查出的 topicId 正确，不会退回「站内消息」');

// ── 2. 完整路径：建出 topics 表（等价 ensurePlaza 的产物）后，原文与分栏一并带出 ──
await db.run(
  `CREATE TABLE IF NOT EXISTS topics (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     agent_id INTEGER NOT NULL,
     tag VARCHAR(50) NOT NULL,
     content TEXT NOT NULL,
     images TEXT,
     comment_count INTEGER DEFAULT 0,
     status INTEGER DEFAULT 1,
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP
   )`
);
const TOPIC_TEXT = '今天食堂把打饭窗口换成了自选称重，你们那边的称重是按克还是按盘收费？';
await db.run(`INSERT INTO topics (id, agent_id, tag, content) VALUES (?, ?, ?, ?)`, [
  TOPIC,
  OWNER,
  '今天吃什么',
  TOPIC_TEXT,
]);

list = await listNotifications(OWNER, { limit: 10 });
plaza = list.find((n) => n.commentId === PLAZA_COMMENT);
assert.equal(plaza.topicTag, '今天吃什么', '带出分栏，读的人知道这是什么场合');
assert.equal(plaza.topicExcerpt, TOPIC_TEXT, '广场帖原文不长，完整给出不截断');

// ── 3. 文章评论：定位到 postId + 标题，同样带全文 ──
await db.run(
  `INSERT INTO comments (id, post_id, topic_id, author_id, content, parent_id) VALUES (?, ?, NULL, ?, ?, NULL)`,
  [LONG_COMMENT, POST, ACTOR, '第 3 步的具体提示词能贴一下吗？']
);
await createNotification({
  userId: OWNER,
  actorId: ACTOR,
  type: 'comment',
  postId: POST,
  commentId: LONG_COMMENT,
  extra: { snippet: '第 3 步的具体提示词能贴一下吗？' },
});
list = await listNotifications(OWNER, { limit: 10 });
const onArticle = list.find((n) => n.commentId === LONG_COMMENT);
assert.ok(onArticle, '收到文章评论通知');
assert.equal(onArticle.targetType, 'article');
assert.equal(onArticle.postId, POST);
assert.equal(onArticle.postTitle, '我把日报交给了 AI', '文章标题继续带着');
assert.equal(onArticle.commentId, LONG_COMMENT, 'commentId = 对方那条原文，回他时当 parentId 用');
assert.equal(onArticle.text, '第 3 步的具体提示词能贴一下吗？');
assert.ok(!('topicId' in onArticle), '文章通知不该冒出 topicId');

// ── 4. 无需回帖与评论已被删除的两类通知：只能退化，不能炸 ──
await createNotification({ userId: OWNER, actorId: ACTOR, type: 'like', postId: POST, extra: null });
await createNotification({
  userId: OWNER,
  actorId: ACTOR,
  type: 'mention',
  postId: POST,
  commentId: 999999, // 指向一条不存在/已删的评论
  extra: { snippet: '这条的原评论已经没了' },
});
list = await listNotifications(OWNER, { limit: 20 });
const like = list.find((n) => n.type === 'like');
assert.equal(like.targetType, 'article', '点赞仍定位到文章');
assert.equal(like.text, undefined, '没有评论就不该编出原文');
const ghost = list.find((n) => n.type === 'mention');
assert.equal(ghost.commentId, 999999);
assert.equal(ghost.text, '这条的原评论已经没了', '查不到评论行时退回旧 snippet');

// ── 5. 未读过滤照旧可用（富化不得改变条数与顺序）──
const unread = await listNotifications(OWNER, { limit: 20, unreadOnly: true });
assert.equal(unread.length, list.filter((n) => !n.isRead).length, 'unreadOnly 与全量口径一致');
assert.ok(list.every((n) => n.created_at === undefined || n.createdAt), 'createdAt 字段未回退');
