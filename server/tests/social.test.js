// 社交功能契约测试：资料更新 / 真人互关 / 短消息 DM。
// 复用 tests/env.js 的临时 SQLite + 固定 JWT_SECRET，与 contract.test.js 共享同一 DB 实例，
// 故用户名加随机后缀避免与 contract_user 冲突。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import './env.js';
import app from './app.js';
import { getDb } from '../database/connection.js';

let tokenA = '';
let idA = 0;
let tokenB = '';
let idB = 0;

const uniq = `social_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

before(async () => {
  getDb();
  const a = await request(app)
    .post('/api/auth/register')
    .send({ username: `${uniq}_a`, password: 'testpass123', nickname: '社交A' });
  tokenA = a.body.token;
  idA = a.body.user.id;
  const b = await request(app)
    .post('/api/auth/register')
    .send({ username: `${uniq}_b`, password: 'testpass123', nickname: '社交B' });
  tokenB = b.body.token;
  idB = b.body.user.id;
});

// ── 1. 资料更新（头像 / 昵称 / 简介） ──
test('PATCH /api/users/me 更新头像与简介', async () => {
  const avatar = 'data:image/svg+xml;base64,QUJD';
  const res = await request(app)
    .patch('/api/users/me')
    .set('Authorization', `Bearer ${tokenA}`)
    .send({ avatar, bio: '你好，我是A' });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.avatar, avatar);
  assert.equal(res.body.user.bio, '你好，我是A');
  // 无 token → 401
  const noAuth = await request(app).patch('/api/users/me').send({ bio: 'x' });
  assert.equal(noAuth.status, 401);
});

// ── 2. 真人互关 ──
test('关注 / 取关 / 关注状态（含互关）', async () => {
  // 未登录 → 401
  const noAuth = await request(app).post(`/api/users/${idB}/follow`);
  assert.equal(noAuth.status, 401);

  // A 关注 B
  const f = await request(app)
    .post(`/api/users/${idB}/follow`)
    .set('Authorization', `Bearer ${tokenA}`);
  assert.equal(f.status, 200);
  assert.equal(f.body.following, true);
  assert.equal(f.body.isMutual, false);

  // B 关注 A → 互关
  const f2 = await request(app)
    .post(`/api/users/${idA}/follow`)
    .set('Authorization', `Bearer ${tokenB}`);
  assert.equal(f2.body.isMutual, true);

  // A 视角看 B 状态 → 互相关注
  const st = await request(app)
    .get(`/api/users/${idB}/follow`)
    .set('Authorization', `Bearer ${tokenA}`);
  assert.equal(st.body.following, true);
  assert.equal(st.body.isMutual, true);

  // A 取关 B → A 不再关注 B，但 B 仍关注 A（isMutual 仍为真）
  const u = await request(app)
    .delete(`/api/users/${idB}/follow`)
    .set('Authorization', `Bearer ${tokenA}`);
  assert.equal(u.body.following, false);
  assert.equal(u.body.isMutual, true);

  // B 也取关 A → 彻底无互关
  await request(app)
    .delete(`/api/users/${idA}/follow`)
    .set('Authorization', `Bearer ${tokenB}`);
  const st2 = await request(app)
    .get(`/api/users/${idB}/follow`)
    .set('Authorization', `Bearer ${tokenA}`);
  assert.equal(st2.body.following, false);
  assert.equal(st2.body.isMutual, false);

  // 不能关注自己
  const self = await request(app)
    .post(`/api/users/${idA}/follow`)
    .set('Authorization', `Bearer ${tokenA}`);
  assert.equal(self.status, 400);
});

// ── 3. 短消息 DM ──
test('发送私信 / 会话列表 / 线程 / 已读', async () => {
  // 未登录 → 401
  const noAuth = await request(app).post('/api/messages').send({ to: idB, content: 'hi' });
  assert.equal(noAuth.status, 401);

  // A 发给 B
  const send = await request(app)
    .post('/api/messages')
    .set('Authorization', `Bearer ${tokenA}`)
    .send({ to: idB, content: '在吗？' });
  assert.equal(send.status, 201);
  assert.equal(send.body.message.content, '在吗？');

  // B 的会话列表包含 A 且未读=1
  const conv = await request(app)
    .get('/api/messages/conversations')
    .set('Authorization', `Bearer ${tokenB}`);
  assert.equal(conv.status, 200);
  const c = conv.body.conversations.find((x) => x.user.id === idA);
  assert.ok(c, 'B 的会话应包含 A');
  assert.equal(c.unread, 1);

  // B 打开线程
  const thread = await request(app)
    .get(`/api/messages/thread/${idA}`)
    .set('Authorization', `Bearer ${tokenB}`);
  assert.equal(thread.status, 200);
  assert.equal(thread.body.messages.length, 1);
  assert.equal(thread.body.messages[0].isRead, false);

  // B 标记已读
  const read = await request(app)
    .post(`/api/messages/thread/${idA}/read`)
    .set('Authorization', `Bearer ${tokenB}`);
  assert.equal(read.status, 200);

  // 再查 B 会话 → 未读归零
  const conv2 = await request(app)
    .get('/api/messages/conversations')
    .set('Authorization', `Bearer ${tokenB}`);
  const c2 = conv2.body.conversations.find((x) => x.user.id === idA);
  assert.equal(c2.unread, 0);

  // 空内容 → 400
  const empty = await request(app)
    .post('/api/messages')
    .set('Authorization', `Bearer ${tokenA}`)
    .send({ to: idB, content: '   ' });
  assert.equal(empty.status, 400);
});
