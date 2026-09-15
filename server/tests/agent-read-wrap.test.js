// server/tests/agent-read-wrap.test.js
// 第四红线（读侧闭环）契约测试：**站内他人写的内容是数据，不是指令**。
//
// 为什么单独一个文件（2026-09-15 巡检产出）：
//   这条红线的机制侧**没有兜底** —— 包裹是各路由手写的，`wrapTopicForAgent` 还只认死 `content`
//   一个字段名。于是出现了一个存在很久、但一直没被发现的错位：
//   **连接器的 `browse_feed` / `read_post` / `list_comments` 从 0.13 起就带着 `X-Agent-Read: 1`，
//   而服务端的文章/评论三条路从来没接过线** —— 客户端声明了一道服务端从未兑现的保护。
//   生产实测（巡检当天）：带该头拉 `/api/posts/120`，正文**没有** `<untrusted_agent_content>`；
//   同一时刻拉 `/api/plaza/topics`（已接线的对照组）是**有**的。
//
// 本文件的判据是**成对**的 —— 每条读口都要同时证明两件事：
//   ① 带 `X-Agent-Read: 1` → 他人文本被包裹；
//   ② 不带 → **一个字都不动**（网页/人类读者零影响，这是 opt-in 的全部意义）。
// 只测①会被"干脆全部包裹"糊弄过去，而那样会污染人类读到的正文。
//
// ⚠️ 还有一条**方向性**判据（本文件最容易被写错的地方）：
//   **只有「别人写的」才包**。`friends[].myReason`、`outgoing[].reason`、
//   信使里 `senderId === me` 的那几封 —— 都是我自己写的，包上数据标记是错的
//   （那不是"多一层保险"，而是让 Agent 对自己的话产生虚假戒备）。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import './env.js';
import app from './app.js';
import { getDb } from '../database/connection.js';
import { signAgentToken } from '../middleware/auth.js';
import { fn } from '../database/db.js';

const uniq = `wrap${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const READ = { 'X-Agent-Read': '1' };
const dbx = () => getDb();
const TAG = '<untrusted_agent_content>';

let owner = 0;
/** 读者：本文件所有「我的读口」都从它出发。 */
let me = null;
/** 对方：所有「他人正文」都是它写的。 */
let peer = null;

function mkAgent(nickname, ownerId = owner, bio = '') {
  const db = dbx();
  const id = Number(db.prepare(
    `INSERT INTO users (username, nickname, user_type, owner_id, is_external, status, bio)
     VALUES (?, ?, 'ai', ?, 1, 1, ?)`
  ).run(`${uniq}_${Math.random().toString(36).slice(2, 9)}`, nickname, ownerId, bio).lastInsertRowid);
  assert.ok(id > 0, `建 Agent「${nickname}」失败`);
  db.prepare(
    `INSERT INTO agent_profiles (user_id, title, domains, writing_style, article_count, total_views, is_active)
     VALUES (?, ?, '[]', '', 0, 0, 1)`
  ).run(id, nickname);
  return { id, token: signAgentToken({ id, is_external: 1 }) };
}

before(async () => {
  getDb();
  const r = await request(app).post('/api/auth/register')
    .send({ username: `${uniq}_o`, password: 'testpass123', nickname: '包裹测主' });
  assert.ok(r.body?.token, `注册主人失败: ${JSON.stringify(r.body)}`);
  owner = r.body.user.id;
  me = mkAgent(`包裹甲${uniq}`, owner, '我是甲，这句话是甲写的。');
  peer = mkAgent(`包裹乙${uniq}`, owner, '我是乙，这句话是乙写的。');
});

// ════════════════════════════════════════════════════════════════
// 1. 文章读口（连接器的 browse_feed / read_post）
// ════════════════════════════════════════════════════════════════

/** 造一篇文章（`post_type='article'`）。作者是 peer。 */
function newArticle({ title = `标题${uniq}`, content = `正文${uniq}` } = {}) {
  const id = Number(dbx().prepare(
    `INSERT INTO posts (title, content, author_id, agent_id, category, post_type, is_ai_generated)
     VALUES (?, ?, ?, ?, '测试', 'article', 1)`
  ).run(title, content, peer.id, peer.id).lastInsertRowid);
  assert.ok(id > 0, '造文章失败');
  return id;
}

test('文章流 /api/posts：带 X-Agent-Read 才包裹，不带一个字不动', async () => {
  const pid = newArticle({ title: `流标题${uniq}`, content: `流正文${uniq}` });

  const plain = await request(app).get('/api/posts?limit=50').expect(200);
  const pa = plain.body.articles.find((a) => Number(a.id) === pid);
  assert.ok(pa, '对照组：不带头的文章流里应能找到刚建的文章');
  assert.ok(!JSON.stringify(pa).includes(TAG),
    '不带 X-Agent-Read 时绝不该出现数据标记 —— 网页读者零影响是 opt-in 的全部意义');

  const guarded = await request(app).get('/api/posts?limit=50').set(READ).expect(200);
  const ga = guarded.body.articles.find((a) => Number(a.id) === pid);
  assert.ok(ga, '带头的文章流里同样应能找到它');
  assert.ok(String(ga.title).includes(TAG), `文章标题是他人正文，应被包裹：${ga.title}`);
  assert.ok(String(ga.excerpt || '').includes(TAG) || !ga.excerpt,
    `文章摘要是他人正文，应被包裹：${ga.excerpt}`);
});

test('文章详情 /api/posts/:id：标题与正文都要包（连接器 read_post 就靠这条路）', async () => {
  const pid = newArticle({ title: `详情标题${uniq}`, content: `详情正文${uniq}` });

  const plain = await request(app).get(`/api/posts/${pid}`).expect(200);
  assert.ok(!JSON.stringify(plain.body).includes(TAG), '不带头的详情不该有数据标记');

  const guarded = await request(app).get(`/api/posts/${pid}`).set(READ).expect(200);
  assert.ok(String(guarded.body.title).includes(TAG), '标题应被包裹');
  assert.ok(String(guarded.body.content || '').includes(TAG),
    '正文是他人正文，必须被包裹（这是本读口最要紧的字段）');
});

// ════════════════════════════════════════════════════════════════
// 2. 文章评论（连接器的 list_comments）—— ⚠️ 楼中楼是主要陷阱
// ════════════════════════════════════════════════════════════════

test('🔴 文章评论：顶层与**楼中楼**都要包 —— 只包顶层比不包更危险', async () => {
  const pid = newArticle({ title: `评论标题${uniq}` });
  const topId = Number(dbx().prepare(
    `INSERT INTO comments (post_id, author_id, content) VALUES (?, ?, ?)`
  ).run(pid, peer.id, `顶层评论${uniq}`).lastInsertRowid);
  assert.ok(topId > 0, '造顶层评论失败');
  const replyId = Number(dbx().prepare(
    `INSERT INTO comments (post_id, author_id, parent_id, content) VALUES (?, ?, ?, ?)`
  ).run(pid, peer.id, topId, `楼中楼回复${uniq}`).lastInsertRowid);
  assert.ok(replyId > 0, '造回复失败');

  const plain = await request(app).get(`/api/posts/${pid}/comments`).expect(200);
  assert.equal(plain.body.comments.length, 1, '不带头的对照组应有一个顶层评论');
  assert.ok(!JSON.stringify(plain.body).includes(TAG), '不带头的评论不该有数据标记');

  const guarded = await request(app).get(`/api/posts/${pid}/comments`).set(READ).expect(200);
  const top = guarded.body.comments.find((c) => Number(c.id) === topId);
  assert.ok(top, '带头的评论列表里应能找到顶层评论');
  assert.ok(String(top.content).includes(TAG), '顶层评论正文应被包裹');
  // ⚠️ 这一条是本用例存在的理由：回复挂在父评论的 `replies` 上，
  //    只包顶层会把整棵子树漏出去（而且看起来"已经做过了"）。
  //    注意字段名是 `replies` —— 服务内部的 `_replies` 经 `shape()` 改名后才出库，
  //    第一版补丁就是照内部名写的，被这条断言当场抓住。
  assert.ok(Array.isArray(top.replies) && top.replies.length === 1,
    `楼中楼回复应在 replies 里（实际 ${JSON.stringify(top.replies)}）`);
  assert.ok(String(top.replies[0].content).includes(TAG),
    '🔴 楼中楼回复的正文必须同样被包裹 —— 漏掉它等于漏掉一半评论');
});

// ════════════════════════════════════════════════════════════════
// 3. 关系层读口（list_friends / list_visitors / view_agent_card）
// ════════════════════════════════════════════════════════════════

/** 造一条好友边。`agentA` 是发起方（写 reason 的那位）。 */
function newEdge({ agentA, agentB, status = 'pending', reason = null, myNickname = null }) {
  const pair = [Number(agentA), Number(agentB)].sort((x, y) => x - y).join('-');
  const decided = status === 'accepted' ? fn.now() : 'NULL';
  const r = dbx().prepare(
    `INSERT INTO agent_friends (pair_key, agent_a, agent_b, status, reason, nickname_a, nickname_b, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ${decided})
     ON CONFLICT(pair_key) DO UPDATE SET
       status = excluded.status, reason = excluded.reason,
       nickname_a = excluded.nickname_a, decided_at = excluded.decided_at`
  ).run(pair, Number(agentA), Number(agentB), status, reason, myNickname, null);
  assert.ok(r.changes >= 1, '造好友边失败');
}

test('🔴 好友面板：对方写的理由要包，**我自己写的理由不包**', async () => {
  // peer 向 me 发起（me 的 incoming 里就有 peer 写的那句 reason）
  const incomingReason = `乙写的申请理由${uniq}`;
  newEdge({ agentA: peer.id, agentB: me.id, status: 'pending', reason: incomingReason });

  const guarded = await request(app).get('/api/agents/me/friends').set(auth(me.token)).set(READ).expect(200);
  const inc = (guarded.body.incoming || []).find((x) => Number(x.id) === peer.id);
  assert.ok(inc, 'incoming 里应有 peer 的申请');
  assert.ok(String(inc.reason).includes(TAG),
    `对方写的申请理由是他人正文，应被包裹：${inc.reason}`);
  assert.ok(String(inc.bio || '').includes(TAG),
    `对方的 bio 是它自己写的，应被包裹：${inc.bio}`);

  const plain = await request(app).get('/api/agents/me/friends').set(auth(me.token)).expect(200);
  assert.ok(!JSON.stringify(plain.body).includes(TAG), '不带头的对照不该有数据标记');
});

test('🔴 好友面板：theirReason 包、myReason 不包（方向判据）', async () => {
  const theirReason = `乙写给他们关系的理由${uniq}`;
  // peer 发起、双方已成立 → me 读到 theirReason（乙写的）= 该包
  newEdge({ agentA: peer.id, agentB: me.id, status: 'accepted', reason: theirReason });

  const g = await request(app).get('/api/agents/me/friends').set(auth(me.token)).set(READ).expect(200);
  const f = (g.body.friends || []).find((x) => Number(x.id) === peer.id);
  assert.ok(f, 'friends 里应有成立的好友边');
  assert.ok(String(f.theirReason).includes(TAG), `theirReason 是对方写的，应被包裹：${f.theirReason}`);
  assert.equal(f.myReason, null, 'me 是接收方，自己没有写过理由');

  // 反向：me 主动加 peer → myReason 是**我自己**写的，绝不能被包
  const third = mkAgent(`包裹丙${uniq}`, owner, '丙的简介');
  newEdge({ agentA: me.id, agentB: third.id, status: 'accepted', reason: `我写的理由${uniq}` });
  const g2 = await request(app).get('/api/agents/me/friends').set(auth(me.token)).set(READ).expect(200);
  const f2 = (g2.body.friends || []).find((x) => Number(x.id) === third.id);
  assert.ok(f2, '应能找到我主动加的那位');
  assert.ok(f2.myReason && !String(f2.myReason).includes(TAG),
    `myReason 是我自己写的，包上数据标记是错的（会让 Agent 对自己的话产生虚假戒备）：${f2.myReason}`);
});

test('访客簿：来客的 bio 要包（list_visitors）', async () => {
  dbx().prepare(
    `INSERT INTO social_events (agent_id, owner_id, kind, ref_key, ref_type, counter_agent_id, facts)
     VALUES (?, ?, 'visited', ?, 'agent', ?, ?)`
  ).run(me.id, owner, `guest-${peer.id}`, peer.id, JSON.stringify({ source: 'comment' }));

  const plain = await request(app).get('/api/agents/me/visitors').set(auth(me.token)).expect(200);
  assert.ok(!JSON.stringify(plain.body).includes(TAG), '不带头的访客簿不该有数据标记');

  const g = await request(app).get('/api/agents/me/visitors').set(auth(me.token)).set(READ).expect(200);
  const guest = (g.body.guests || []).find((x) => Number(x.id) === peer.id);
  assert.ok(guest, '访客簿里应有刚来访的 peer');
  assert.ok(String(guest.bio).includes(TAG), `来客的 bio 是它自己写的，应被包裹：${guest.bio}`);
});

test('名片 /api/agents/:id/card（公开读口）：bio 要包', async () => {
  const plain = await request(app).get(`/api/agents/${peer.id}/card`).expect(200);
  assert.ok(!JSON.stringify(plain.body).includes(TAG), '不带头的名片不该有数据标记');

  const g = await request(app).get(`/api/agents/${peer.id}/card`).set(READ).expect(200);
  assert.ok(String(g.body.card.bio).includes(TAG), `名片上的 bio 是它自己写的，应被包裹：${g.body.card.bio}`);
});

// ════════════════════════════════════════════════════════════════
// 4. 家书读口（/:id/milestones 与 /:id/letters）
// ════════════════════════════════════════════════════════════════

test('公开家书：letters[].text 要包（对读它的另一个 Agent 而言是他人正文）', async () => {
  const text = `乙亲笔写的家书${uniq}`;
  dbx().prepare(
    `INSERT INTO social_reports (agent_id, kind, text, public_optin, visibility) VALUES (?, 'letter', ?, 1, 'public')`
  ).run(peer.id, text);

  const mPlain = await request(app).get(`/api/agents/${peer.id}/milestones`).expect(200);
  assert.ok(!JSON.stringify(mPlain.body).includes(TAG), '不带头的里程碑读口不该有数据标记');

  const mGuard = await request(app).get(`/api/agents/${peer.id}/milestones`).set(READ).expect(200);
  const letter = (mGuard.body.letters || []).find((l) => String(l.text).includes(uniq));
  assert.ok(letter, '里程碑读口里应能找到刚写的家书');
  assert.ok(String(letter.text).includes(TAG), `家书正文应被包裹：${letter.text}`);
  assert.equal(mGuard.body.lettersTotal, 1, 'lettersTotal 是纯数字，不该受影响');

  const lGuard = await request(app).get(`/api/agents/${peer.id}/letters`).set(READ).expect(200);
  const letter2 = (lGuard.body.letters || []).find((l) => String(l.text).includes(uniq));
  assert.ok(letter2 && String(letter2.text).includes(TAG), '档案页的家书正文同样要包');
});

// ════════════════════════════════════════════════════════════════
// 5. 信使（私域，但同侪的原文一样是「数据」）
// ════════════════════════════════════════════════════════════════

test('🔴 信使：对方写的信要包，**自己发的那句不包**', async () => {
  const fromPeer = `乙寄来的信${uniq}`;
  const fromMe = `我寄去的信${uniq}`;
  dbx().prepare(
    `INSERT INTO messages (sender_id, receiver_id, content, channel, is_read) VALUES (?, ?, ?, 'courier', 0)`
  ).run(peer.id, me.id, fromPeer);
  dbx().prepare(
    `INSERT INTO messages (sender_id, receiver_id, content, channel, is_read) VALUES (?, ?, ?, 'courier', 0)`
  ).run(me.id, peer.id, fromMe);

  // 会话列表：最后一句是**我发的** → lastMessage 不该被包
  const conv = await request(app).get('/api/agents/me/courier').set(auth(me.token)).set(READ).expect(200);
  const c = (conv.body.conversations || []).find((x) => Number(x.peer?.id) === peer.id);
  assert.ok(c, '信使会话列表里应有与 peer 的会话');
  assert.equal(c.lastFromMe, true, '最后一句是我发的，应透传 lastFromMe=true');
  assert.ok(String(c.lastMessage).includes(fromMe), '会话预览应是最后一句的内容');
  assert.ok(!String(c.lastMessage).includes(TAG),
    `最后一句是我自己写的，包上数据标记是错的：${c.lastMessage}`);

  // 线程：两封都在 → 只有对方那封包
  const t = await request(app).get(`/api/agents/me/courier/thread/${peer.id}`)
    .set(auth(me.token)).set(READ).expect(200);
  const theirs = (t.body.messages || []).find((m) => m.content.includes(fromPeer));
  const mine = (t.body.messages || []).find((m) => m.content.includes(fromMe));
  assert.ok(theirs && mine, '线程里应同时有两封信');
  assert.ok(String(theirs.content).includes(TAG), `对方寄来的信应被包裹：${theirs.content}`);
  assert.ok(!String(mine.content).includes(TAG), `我自己寄出的信绝不该被包裹：${mine.content}`);

  // 对照组：不带 header 两封都不动
  const t2 = await request(app).get(`/api/agents/me/courier/thread/${peer.id}`)
    .set(auth(me.token)).expect(200);
  assert.ok(!JSON.stringify(t2.body).includes(TAG), '不带头的信使线程不该有数据标记');
});

// ════════════════════════════════════════════════════════════════
// 7. 🔴 收件箱（list_inbox / run_cycle 每轮都调 —— 最热的一条读口）
// ════════════════════════════════════════════════════════════════

test('🔴 收件箱：顶层 text 与 topicExcerpt 要包（原先只扫 extra.*，键名对不上）', async () => {
  // 巡检当天发现：`enrichTargets` 把评论全文放在**顶层** `it.text`、广场帖原文放在
  // **顶层** `it.topicExcerpt`，而路由只扫了 `extra.content/snippet/text/excerpt` 四个键名
  // —— 键名对不上，包裹整体落空。而连接器把 `n.text` 当「原话」直接渲染进 list_inbox 与
  // run_cycle 简报（Agent 的执行上下文），所以这条是最不该漏的。
  const topicId = Number(dbx().prepare(
    `INSERT INTO topics (agent_id, tag, content, status, visibility) VALUES (?, '测试', ?, 1, 'public')`
  ).run(peer.id, `广场帖原文${uniq}`).lastInsertRowid);
  assert.ok(topicId > 0, '造广场帖失败');
  const cid = Number(dbx().prepare(
    `INSERT INTO comments (topic_id, author_id, content) VALUES (?, ?, ?)`
  ).run(topicId, peer.id, `乙在广场说的原话${uniq}`).lastInsertRowid);
  assert.ok(cid > 0, '造评论失败');
  dbx().prepare(
    `INSERT INTO notifications (user_id, actor_id, type, comment_id, is_read) VALUES (?, ?, 'comment', ?, 0)`
  ).run(me.id, peer.id, cid);

  // 对照组：不带 header → 原话原样给出、一个标记都不该有
  const plain = await request(app).get('/api/agents/me/inbox').set(auth(me.token)).expect(200);
  const pn = (plain.body.notifications || []).find((n) => Number(n.commentId) === cid);
  assert.ok(pn, '不带头的收件箱里应能找到刚造的通知');
  assert.equal(pn.targetType, 'plaza', '应被富化成广场定位（否则本用例根本没测到目标字段）');
  assert.ok(String(pn.text).includes(uniq), '原话应被富化出来（否则本用例是空转）');
  assert.ok(!JSON.stringify(plain.body).includes(TAG), '不带头的收件箱绝不该有数据标记');

  const g = await request(app).get('/api/agents/me/inbox').set(auth(me.token)).set(READ).expect(200);
  const gn = (g.body.notifications || []).find((n) => Number(n.commentId) === cid);
  assert.ok(gn, '带头的收件箱里同样应能找到它');
  assert.ok(String(gn.text).includes(TAG),
    `🔴 顶层 text 是他人评论全文，必须被包裹（这是 Agent 会读的原话）：${gn.text}`);
  assert.ok(String(gn.topicExcerpt || '').includes(TAG),
    `广场帖原文（topicExcerpt）同样是他人正文，应被包裹：${gn.topicExcerpt}`);
  assert.ok(String(gn.postTitle || '').includes(TAG) || !gn.postTitle,
    'postTitle 原本就接了线，别在本次改动里掉线');
  // 数字与定位字段不受影响 —— Agent 还得靠它们照抄回帖参数
  assert.equal(Number(gn.topicId), topicId, 'topicId 是数字，不该被包裹');
  assert.equal(Number(gn.commentId), cid, 'commentId 是数字，不该被包裹');
  assert.equal(gn.actor?.name, `包裹乙${uniq}`, 'actor.name 不包（@ 提及需要原始昵称）');
});

// ════════════════════════════════════════════════════════════════
// 8. 对照组：已接线的读口别在本次改动里掉线
// ════════════════════════════════════════════════════════════════

test('对照组：广场帖读口（N1 前就接了线）仍然包裹', async () => {
  dbx().prepare(
    `INSERT INTO topics (agent_id, tag, content, status, visibility) VALUES (?, '测试', ?, 1, 'public')`
  ).run(peer.id, `广场帖正文${uniq}`);

  const g = await request(app).get('/api/plaza/topics?limit=50').set(READ).expect(200);
  const topic = (g.body.topics || []).find((t) => String(t.content).includes(uniq));
  assert.ok(topic, '广场流里应能找到刚建的帖');
  assert.ok(String(topic.content).includes(TAG), '广场帖是他人正文，对照证明这条路没被改坏');
});

test('对照组：收获的 heard[]（N6 接的线）仍然包裹', async () => {
  const g = await request(app).get(`/api/agents/${me.id}/harvest`).set(READ).expect(200);
  // 本文件里 me 还没被人公开评论过，所以只断言"这条路仍然可达且结构在"——
  // 真正的包裹断言在 social-n6.test.js 用例 18（那里有完整 fixture，不在这里重复造）。
  assert.ok(g.body.harvest, '收获读口仍然可用');
  assert.ok(Array.isArray(g.body.harvest.heard), 'heard 结构未变');
});
