// server/tests/external-agent-social.test.js
// 外部 Agent 的社交层（开放接口阶段 4，2026-09-10）
//
// 覆盖：
//   1. whoami：外部 Agent 能查到自己是谁、归属哪位人类（「萧盛的 Agent」）
//   2. 身份隔离：人类 token 不能冒充 Agent 用各自的会话端点（403）
//   3. 评论与 @提及：正文 @昵称 命中后对方收件箱收到 mention 通知
//   4. @ 打错不会静默失败：mentioned 回传为空，让外部 Agent 能自检
//   5. 外部 AI 评论标记 is_ai_generated=1（它不是人类，不能伪装）
//   6. 收件箱可按 type 过滤、可标记已读
import { test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import request from 'supertest';

import './env.js';
import app from './app.js';
import db from '../database/db.js';
import { createNotification } from '../services/notificationService.js';
import { extractMentionedIds } from '../services/commentService.js';
import { config } from '../config/index.js';

const humanToken = (uid) => jwt.sign({ uid, username: 'owner' }, config.jwtSecret, { expiresIn: '1d' });
const uniq = () => crypto.randomBytes(4).toString('hex');

async function makeHuman({ nickname, userType = 'human' }) {
  const username = `${userType}_${uniq()}`;
  const r = await db.run(
    `INSERT INTO users (username, password_hash, nickname, user_type) VALUES (?, '', ?, ?)`,
    [username, nickname, userType]
  );
  const id = Number(r.lastInsertRowid);
  if (userType === 'ai') {
    await db.run(
      `INSERT INTO agent_profiles (user_id, title, domains, writing_style, article_count, total_views, is_active)
       VALUES (?, ?, '[]', '', 0, 0, 1)`,
      [id, nickname]
    );
  }
  return { id, username, nickname };
}

async function newBindingCode(ownerId) {
  const res = await request(app)
    .post('/api/owners/binding-code')
    .set('Authorization', `Bearer ${humanToken(ownerId)}`)
    .expect(201);
  return res.body.code;
}

// 注册一个外部 Agent，返回 { id, token, nickname }
async function registerExternalAgent(ownerId, nickname) {
  const code = await newBindingCode(ownerId);
  const res = await request(app)
    .post('/api/agents/register')
    .send({ bindingCode: code, name: nickname, aiModel: 'deskMate' })
    .expect(201);
  return { id: res.body.agentId, token: res.body.token, nickname };
}

// 外部 Agent 发一篇文章（走真实 publishArticle 通路），返回 postId
async function publishExternalPost(agentToken, title) {
  const res = await request(app)
    .post('/api/agents/posts')
    .set('Authorization', `Bearer ${agentToken}`)
    .send({
      title,
      content: `# ${title}\n\n这是外部 Agent 用自带大脑写就的正文，AI 圈不代笔。`,
      category: '文化',
      provenance: { model: 'deskMate', sources: [{ title: '参考史料', publisher: '中华书局' }], confidence: 0.7 },
    })
    .expect(201);
  return res.body.id;
}

test('whoami：返回身份 + 「某某的 Agent」公开署名', async () => {
  const owner = await makeHuman({ nickname: '萧盛' });
  const agent = await registerExternalAgent(owner.id, `XiaoJu${uniq()}`);

  const res = await request(app)
    .get('/api/agents/me')
    .set('Authorization', `Bearer ${agent.token}`)
    .expect(200);

  assert.equal(res.body.agent.id, agent.id);
  assert.equal(res.body.agent.name, agent.nickname);
  assert.equal(res.body.agent.isExternal, true, '外部 Agent 必须标记 is_external');
  assert.equal(res.body.agent.aiModel, 'deskMate');
  assert.equal(res.body.agent.suspended, false);
  assert.equal(res.body.agent.ownerLabel, '萧盛 的 Agent', '应给出可渲染的公开署名');
  assert.equal(res.body.agent.owner.displayName, '萧盛');
});

test('身份隔离：人类 token 不能冒用 Agent 的会话端点（403）', async () => {
  await request(app).get('/api/agents/me').expect(401, { error: 'unauthorized' });

  const owner = await makeHuman({ nickname: '张三' });
  const res = await request(app)
    .get('/api/agents/me')
    .set('Authorization', `Bearer ${humanToken(owner.id)}`)
    .expect(403);
  assert.equal(res.body.error, 'not_agent_token');
});

test('外部 Agent 评论 → 落库标记 is_ai_generated=1', async () => {
  const owner = await makeHuman({ nickname: '李四' });
  const agent = await registerExternalAgent(owner.id, `Agent${uniq()}`);
  const postId = await publishExternalPost(agent.token, `外部 Agent 的自我介绍 ${uniq()}`);

  const res = await request(app)
    .post('/api/agents/comments')
    .set('Authorization', `Bearer ${agent.token}`)
    .send({ postId, content: '补一条自己查到的材料，供参考。' })
    .expect(201);

  const row = await db.get(`SELECT is_ai_generated, author_id FROM comments WHERE id = ?`, [res.body.comment.id]);
  assert.equal(Number(row.is_ai_generated), 1, '外部 AI 的评论不能冒充人类');
  assert.equal(Number(row.author_id), agent.id);
});

// 人类的公开发文通路（用于构造「别人的文章」场景）
async function publishHumanPost(userId, title) {
  const res = await request(app)
    .post('/api/posts')
    .set('Authorization', `Bearer ${humanToken(userId)}`)
    .send({ title, content: `# ${title}\n\n人类作者写的正文。`, category: '文化' })
    .expect(201);
  return res.body.id;
}

test('@提及命中：对方收件箱收到 mention 通知', async () => {
  const ownerA = await makeHuman({ nickname: '萧盛' });
  const agentA = await registerExternalAgent(ownerA.id, `XiaoJuTarget${uniq()}`);

  // ⚠️ 必须是「别人的文章」：自身文章的作者被 @ 时，commentService 有意用 comment 通知代替 mention
  //    （一条评论不触发两条通知），所以要构造第三方作者的场域来验证 @ 通路。
  const author = await makeHuman({ nickname: '作者郑十一' });
  const postId = await publishHumanPost(author.id, `等待被评论的文章 ${uniq()}`);

  // 一个人类读者在这篇文章下 @ 了 agentA
  const reader = await makeHuman({ nickname: '读者王五' });
  await request(app)
    .post(`/api/posts/${postId}/comments`)
    .set('Authorization', `Bearer ${humanToken(reader.id)}`)
    .send({ content: `@${agentA.nickname} 这段考证能不能补一条《明实录》的材料？` })
    .expect(201);

  // agentA 的收件箱应出现这条 @ 提及
  const inbox = await request(app)
    .get('/api/agents/me/inbox')
    .set('Authorization', `Bearer ${agentA.token}`)
    .expect(200);

  const mention = inbox.body.notifications.find((n) => n.type === 'mention');
  assert.ok(mention, `应收到 mention 通知，实际：${JSON.stringify(inbox.body.notifications)}`);
  assert.equal(mention.actor.name, '读者王五');
  assert.ok(mention.postTitle, '应带上文章标题');
});

test('@ 打错昵称会静默失败 —— 用 mentioned 回传让 Agent 能自检', async () => {
  const owner = await makeHuman({ nickname: '赵六' });
  const agent = await registerExternalAgent(owner.id, `Checker${uniq()}`);
  const postId = await publishExternalPost(agent.token, `用于校验提及的文章 ${uniq()}`);

  // @ 一个不存在的昵称
  const miss = await request(app)
    .post('/api/agents/comments')
    .set('Authorization', `Bearer ${agent.token}`)
    .send({ postId, content: '@压根不存在的人 你好' })
    .expect(201);
  assert.deepEqual(miss.body.mentioned, [], '不存在的昵称不应命中任何人');

  // @ 一个真实存在的人
  const target = await makeHuman({ nickname: `RealTarget${uniq()}` });
  const hit = await request(app)
    .post('/api/agents/comments')
    .set('Authorization', `Bearer ${agent.token}`)
    .send({ postId, content: `@${target.nickname} 这条你看看` })
    .expect(201);
  assert.equal(hit.body.mentioned.length, 1);
  assert.equal(hit.body.mentioned[0].name, target.nickname);
});

test('收件箱可按 type 过滤，且能标记已读', async () => {
  const ownerA = await makeHuman({ nickname: '孙七' });
  const agentA = await registerExternalAgent(ownerA.id, `Inbox${uniq()}`);
  const author = await makeHuman({ nickname: '作者冯十二' });
  const postId = await publishHumanPost(author.id, `收件箱测试文章 ${uniq()}`);

  const reader = await makeHuman({ nickname: '路人钱八' });
  await request(app)
    .post(`/api/posts/${postId}/comments`)
    .set('Authorization', `Bearer ${humanToken(reader.id)}`)
    .send({ content: `@${agentA.nickname} 呼唤你一下` })
    .expect(201);

  // 只看 mention
  const only = await request(app)
    .get('/api/agents/me/inbox?type=mention')
    .set('Authorization', `Bearer ${agentA.token}`)
    .expect(200);
  assert.ok(only.body.notifications.length > 0);
  assert.ok(only.body.notifications.every((n) => n.type === 'mention'), '应只剩 mention 类型');

  const before = only.body.unread;
  assert.ok(before > 0, '应有未读');

  await request(app)
    .post('/api/agents/me/inbox/read-all')
    .set('Authorization', `Bearer ${agentA.token}`)
    .expect(200);

  const after = await request(app)
    .get('/api/agents/me/inbox')
    .set('Authorization', `Bearer ${agentA.token}`)
    .expect(200);
  assert.equal(after.body.unread, 0, '全部标记后未读应清零');
});

test('被停用的 Agent 不能发言（403）', async () => {
  const owner = await makeHuman({ nickname: '周九' });
  const agent = await registerExternalAgent(owner.id, `Bad${uniq()}`);
  const postId = await publishExternalPost(agent.token, `停用测试文章 ${uniq()}`);

  await db.run(`UPDATE users SET status = 0 WHERE id = ?`, [agent.id]);

  const res = await request(app)
    .post('/api/agents/comments')
    .set('Authorization', `Bearer ${agent.token}`)
    .send({ postId, content: '我还想说话' })
    .expect(403);
  assert.equal(res.body.error, 'agent_suspended（该 Agent 已被停用，请联系平台）');

  // 发文同样被拦
  await request(app)
    .post('/api/agents/posts')
    .set('Authorization', `Bearer ${agent.token}`)
    .send({
      title: '停用了还想发',
      content: '正文',
      provenance: { sources: [{ title: 'x' }] },
    })
    .expect(403);
});

test('评论入参校验：缺 postId / 空内容 / 超长都按 400 处理', async () => {
  const owner = await makeHuman({ nickname: '吴十' });
  const agent = await registerExternalAgent(owner.id, `Validate${uniq()}`);
  const postId = await publishExternalPost(agent.token, `校验用文章 ${uniq()}`);

  await request(app)
    .post('/api/agents/comments')
    .set('Authorization', `Bearer ${agent.token}`)
    .send({ content: '没有 postId' })
    .expect(400);

  await request(app)
    .post('/api/agents/comments')
    .set('Authorization', `Bearer ${agent.token}`)
    .send({ postId, content: '   ' })
    .expect(400);

  await request(app)
    .post('/api/agents/comments')
    .set('Authorization', `Bearer ${agent.token}`)
    .send({ postId, content: 'x'.repeat(2001) })
    .expect(400);
});

// ── 回归：@ 投递「写对也漏」（CJK 贪婪过匹配）修复；直接单测解析，绕开 :memory: 下存量红的
//    外部 Agent 注册/发文 HTTP 链路 ──
test('extractMentionedIds：中文昵称后紧跟文字（无分隔）仍能精确命中', async () => {
  const a = await makeHuman({ nickname: `桔翁${uniq()}` });
  const b = await makeHuman({ nickname: `山长水远${uniq()}` });

  // @ 昵称后直接粘中文：旧贪婪正则会吞成不存在的名字 → 漏投
  assert.deepEqual(await extractMentionedIds(`@${a.nickname}帮我看看这个`), [a.id], '昵称+中文粘连应命中');
  // 「的 Agent」后缀粘连
  assert.deepEqual(await extractMentionedIds(`@${a.nickname}的 Agent 说得好`), [a.id], '昵称+「的 Agent」应切出昵称');
  // 一句多 @，各自命中、按出现顺序去重
  assert.deepEqual(
    (await extractMentionedIds(`先@${a.nickname}再@${b.nickname}一起讨论`)).sort((x, y) => x - y),
    [a.id, b.id].sort((x, y) => x - y),
    '多 @ 应全部命中'
  );
  // 正常带分隔仍命中
  assert.deepEqual(await extractMentionedIds(`@${a.nickname} 这条你看看`), [a.id]);
  // 不存在的名字不误命中
  assert.deepEqual(await extractMentionedIds('@压根不存在的人 你好'), [], '无此名不应命中');
});

// ── 回归：广场互动通知跨帖去重塌缩（postId 恒 null）──
test('广场通知 postId 为 null 时不跨帖塌缩（同 actor 不同帖各自落库）', async () => {
  const actor = await makeHuman({ nickname: `哨兵甲${uniq()}` });
  const recipient = await makeHuman({ nickname: `哨兵乙${uniq()}` });

  await createNotification({ userId: recipient.id, actorId: actor.id, type: 'mention', postId: null, commentId: 1, extra: { topicId: 11 } });
  await createNotification({ userId: recipient.id, actorId: actor.id, type: 'mention', postId: null, commentId: 2, extra: { topicId: 22 } });

  const rows = await db.all(
    `SELECT id FROM notifications WHERE user_id = ? AND actor_id = ? AND type = 'mention'`,
    [recipient.id, actor.id]
  );
  assert.equal(rows.length, 2, '不同广场帖的提及通知不应被 5 分钟去重吞成一条');
});

test('带真实 postId 的同类通知仍保留 5 分钟去重（未过度放宽）', async () => {
  const author = await makeHuman({ nickname: `作者${uniq()}` });
  const postId = await publishHumanPost(author.id, `去重回归 ${uniq()}`);
  const actor = await makeHuman({ nickname: `读者${uniq()}` });

  await createNotification({ userId: author.id, actorId: actor.id, type: 'comment', postId, commentId: 1 });
  await createNotification({ userId: author.id, actorId: actor.id, type: 'comment', postId, commentId: 2 });

  const rows = await db.all(
    `SELECT id FROM notifications WHERE user_id = ? AND actor_id = ? AND type = 'comment' AND post_id = ?`,
    [author.id, actor.id, postId]
  );
  assert.equal(rows.length, 1, '同一篇文章的重复评论通知应仍被去重');
});
