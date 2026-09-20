// 社交功能契约测试：资料更新 / 真人互关 / 短消息 DM。
// 复用 tests/env.js 的临时 SQLite + 固定 JWT_SECRET，与 contract.test.js 共享同一 DB 实例，
// 故用户名加随机后缀避免与 contract_user 冲突。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';

import { TEST_COVERS_DIR } from './env.js';
import app from './app.js';
import { getDb } from '../database/connection.js';
import { listNotifications } from '../services/notificationService.js';

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
test('PATCH /api/users/me 头像解码落盘存短 URL + 更新简介', async () => {
  // 合法 png（1x1）。修复前这里会把整条 data URI 原样入库；现在应落盘并只存 /covers/... 短 URL。
  const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  const res = await request(app)
    .patch('/api/users/me')
    .set('Authorization', `Bearer ${tokenA}`)
    .send({ avatar: png, bio: '你好，我是A' });
  assert.equal(res.status, 200);
  const saved = String(res.body.user.avatar || '');
  assert.ok(saved.startsWith('/covers/'), `头像应为 /covers 短 URL，实得：${saved}`);
  assert.ok(!saved.startsWith('data:'), '头像绝不能再存整条 data URI');
  assert.equal(res.body.user.bio, '你好，我是A');
  // 文件确实写到了 COVERS_DIR
  assert.ok(existsSync(join(TEST_COVERS_DIR, saved.replace('/covers/', ''))), '落盘文件应存在');
});

test('PATCH /api/users/me 拒绝非法类型头像 / 未登录', async () => {
  // svg 不在允许类型（png/jpeg/gif/webp）内 → 400，且不落库
  const svg = 'data:image/svg+xml;base64,QUJD';
  const bad = await request(app)
    .patch('/api/users/me')
    .set('Authorization', `Bearer ${tokenA}`)
    .send({ avatar: svg });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'unsupported_image_type');
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

// ── 4. 「今日高光」摘要的字段契约（2026-09-15 补） ──
// 归档页 /agent/:id/social 的两处入口之一就挂在这张摘要卡片上，靠 items[].agentId 定位；
// 而 items[].href 依赖 ref_type。此前 sendDigest 的 SELECT 漏了 se.ref_type，
// 于是 p.ref_type 恒为 undefined、那句三元永远走右侧 —— 摘要里明明是「广场某帖」的瞬间，
// 点进去却只到 Agent 主页。这条用例把两件事一起钉住。
test('今日高光摘要：items 带 agentId，且 href 按 ref_type 指向广场帖', async () => {
  const db = getDb();
  const kidId = Number(db.prepare(
    `INSERT INTO users (username, nickname, user_type, owner_id) VALUES (?, ?, 'ai', ?)`
  ).run(`${uniq}_kid`, '小测', idA).lastInsertRowid);
  assert.ok(kidId > 0);

  const topicRef = 987654;
  db.prepare(
    `INSERT INTO social_events (agent_id, owner_id, kind, ref_type, ref_id, facts)
     VALUES (?, ?, 'grievance', 'topic', ?, ?)`
  ).run(kidId, idA, topicRef, JSON.stringify({ line: '它在「某某」帖下被三个人认真反驳了。' }));

  const { flushPendingDigests } = await import('../services/socialEventService.js');
  await flushPendingDigests();

  const list = await listNotifications(idA, { limit: 20 });
  const digest = list.find((n) => n.type === 'social_report');
  assert.ok(digest, '应投出一条 social_report 摘要');
  const item = (digest.extra?.items || [])[0];
  assert.ok(item, '摘要应含至少一条 item');
  assert.equal(item.agentId, kidId, 'items[].agentId 必须给出 —— 归档页入口靠它定位');
  assert.equal(item.agent, '小测');
  assert.equal(item.href, `/plaza/${topicRef}`, 'ref_type=topic 时必须链到广场帖（此前恒为 Agent 主页）');

  // 每日 ≤1 条硬闸：再冲刷一次不应重复投递
  await flushPendingDigests();
  const again = await listNotifications(idA, { limit: 20 });
  assert.equal(again.filter((n) => n.type === 'social_report').length, 1);
});
