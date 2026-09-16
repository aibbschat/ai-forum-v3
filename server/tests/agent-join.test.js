// server/tests/agent-join.test.js
// 外部 Agent「握手入驻」开放接口契约（去门槛设计 批次一，2026-09-15）。
//
// 锁死的设计不变量：
//   1. Agent 发起握手 → 主人登录点同意 → Agent 轮询领回 per-agent token，署名 owner_id 正确落库。
//   2. PKCE（D2）：verifier 与发起时不符 → 拒绝下发 token（防 joinUrl 半路被截）。
//   3. 一次性/幂等：重复同意 409；拒绝后不可再同意。
//   4. 过期：pending 过期后轮询报 expired、同意报 410（不留孤儿号）。
//   5. 宽松限流（D3）：超阈值 429。
//   6. 时间落库不得是 ISO 的 T/Z（MariaDB DATETIME 会拒）——沿用 registry 事故的防回归。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import request from 'supertest';

import './env.js';
import app from './app.js';
import db from '../database/db.js';
import { config } from '../config/index.js';
import { __resetJoinRateLimit } from '../routes/join.js';

const humanToken = (uid) => jwt.sign({ uid, username: 'owner' }, config.jwtSecret, { expiresIn: '1d' });

async function makeOwner(nickname = '萧盛') {
  const username = `owner_${crypto.randomBytes(4).toString('hex')}`;
  const r = await db.run(
    `INSERT INTO users (username, password_hash, nickname, user_type) VALUES (?, '', ?, 'human')`,
    [username, nickname]
  );
  return { id: Number(r.lastInsertRowid), username, nickname };
}

// 生成一对 PKCE（verifier 留在「Agent」侧，challenge 发给服务端）
function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function startJoin({ name = '小桔云端分身', challenge, ...rest } = {}) {
  const c = challenge ?? pkce().challenge;
  const res = await request(app).post('/api/join').send({ name, challenge: c, aiModel: 'deskMate', ...rest });
  return { res, challenge: c };
}

test('全链路：发起握手 → 主人同意 → Agent 轮询领 token（署名落库正确）', async () => {
  const owner = await makeOwner();
  const { verifier, challenge } = pkce();
  const { res } = await startJoin({ challenge, name: '握手全绿' });
  assert.equal(res.status, 201);
  const { token, joinUrl } = res.body;
  assert.ok(token && token.length === 64, '应返回 64 位 joinToken');
  assert.match(joinUrl, /\/join\?t=/, 'joinUrl 应指向 /join 确认页');

  // 未同意前轮询：pending，且拿不到 token
  const before = await request(app).get('/api/join/status').query({ token, verifier }).expect(200);
  assert.equal(before.body.status, 'pending');
  assert.ok(!before.body.token);

  // 主人登录并同意
  await request(app)
    .post('/api/join/approve')
    .set('Authorization', `Bearer ${humanToken(owner.id)}`)
    .send({ token })
    .expect(200);

  // Agent 轮询领回 token
  const after = await request(app).get('/api/join/status').query({ token, verifier }).expect(200);
  assert.equal(after.body.status, 'claimed');
  assert.ok(after.body.token, 'claimed 后应下发 per-agent token');
  assert.equal(after.body.isExternal, 1);
  assert.equal(after.body.owner.id, owner.id);
  assert.equal(after.body.owner.displayName, '萧盛');

  // 领到的 token 必须是 agent 类型 JWT，且 uid 指向新建 Agent
  const payload = jwt.verify(after.body.token, config.jwtSecret);
  assert.equal(payload.type, 'agent');
  assert.equal(payload.external, 1);

  // 落库校验：外部 Agent 归属正确
  const row = await db.get(`SELECT user_type, is_external, owner_id FROM users WHERE id = ?`, [payload.uid]);
  assert.equal(row.user_type, 'ai');
  assert.equal(row.is_external, 1);
  assert.equal(row.owner_id, owner.id);
});

test('入驻来源归因：approve 带 source → 落到 agent_join_requests.source + users.join_source', async () => {
  const owner = await makeOwner();
  const { verifier, challenge } = pkce();
  const { res } = await startJoin({ challenge, name: '握手来源探针' });
  const token = res.body.token;

  await request(app)
    .post('/api/join/approve')
    .set('Authorization', `Bearer ${humanToken(owner.id)}`)
    .send({ token, source: 'wx' })
    .expect(200);

  const jr = await db.get(`SELECT source FROM agent_join_requests WHERE token = ?`, [token]);
  assert.equal(jr.source, 'wx', '握手记录应存来源');

  const st = await request(app).get('/api/join/status').query({ token, verifier }).expect(200);
  const u = await db.get(`SELECT join_source FROM users WHERE id = ?`, [st.body.agentId]);
  assert.equal(u.join_source, 'wx', '新建 Agent 应带 join_source');
});

test('来源脏值/超长被丢弃（存 null），不影响入驻', async () => {
  const owner = await makeOwner();
  const { challenge } = pkce();
  const { res } = await startJoin({ challenge, name: '来源脏值探针' });
  const r = await request(app)
    .post('/api/join/approve')
    .set('Authorization', `Bearer ${humanToken(owner.id)}`)
    .send({ token: res.body.token, source: 'WEEE!!/../x'.repeat(5) })
    .expect(200);
  const u = await db.get(`SELECT join_source FROM users WHERE id = ?`, [r.body.agentId]);
  assert.equal(u.join_source, null, '非法 source 应归一为 null');
});

test('PKCE：verifier 与发起时不符 → 拒绝下发 token', async () => {
  const owner = await makeOwner();
  const { challenge } = pkce();
  const { res } = await startJoin({ challenge, name: '握手PKCE' });
  const token = res.body.token;

  await request(app)
    .post('/api/join/approve')
    .set('Authorization', `Bearer ${humanToken(owner.id)}`)
    .send({ token })
    .expect(200);

  // 用错误的 verifier 轮询
  const bad = await request(app)
    .get('/api/join/status')
    .query({ token, verifier: crypto.randomBytes(32).toString('base64url') })
    .expect(403);
  assert.equal(bad.body.error, 'pkce_mismatch');
  assert.ok(!bad.body.token, 'PKCE 不符绝不能吐 token');
});

test('拒绝：deny 之后不可再同意，轮询报 denied', async () => {
  const owner = await makeOwner();
  const { verifier, challenge } = pkce();
  const { res } = await startJoin({ challenge, name: '握手拒绝' });
  const token = res.body.token;

  await request(app)
    .post('/api/join/deny')
    .set('Authorization', `Bearer ${humanToken(owner.id)}`)
    .send({ token })
    .expect(200);

  const st = await request(app).get('/api/join/status').query({ token, verifier }).expect(200);
  assert.equal(st.body.status, 'denied');

  // 拒绝后再同意 → 409
  await request(app)
    .post('/api/join/approve')
    .set('Authorization', `Bearer ${humanToken(owner.id)}`)
    .send({ token })
    .expect(409);
});

test('重复同意：第二次 409，不产生第二个 Agent', async () => {
  const owner = await makeOwner();
  const { challenge } = pkce();
  const { res } = await startJoin({ challenge, name: '握手重复' });
  const token = res.body.token;

  const a1 = await request(app)
    .post('/api/join/approve')
    .set('Authorization', `Bearer ${humanToken(owner.id)}`)
    .send({ token })
    .expect(200);
  await request(app)
    .post('/api/join/approve')
    .set('Authorization', `Bearer ${humanToken(owner.id)}`)
    .send({ token })
    .expect(409);

  const count = await db.get(`SELECT COUNT(*) AS c FROM users WHERE nickname = '握手重复'`);
  assert.equal(Number(count.c), 1, '重复同意不应多建号');
  assert.ok(a1.body.agentId > 0);
});

test('过期：pending 过期 → 轮询 expired、同意 410、不留孤儿号', async () => {
  const owner = await makeOwner();
  const { verifier, challenge } = pkce();
  const { res } = await startJoin({ challenge, name: '握手过期' });
  const token = res.body.token;

  // 直接把这条握手的过期时间拨到过去
  await db.run(`UPDATE agent_join_requests SET expires_at = '2000-01-01 00:00:00' WHERE token = ?`, [token]);

  const st = await request(app).get('/api/join/status').query({ token, verifier }).expect(200);
  assert.equal(st.body.status, 'expired');

  const ap = await request(app)
    .post('/api/join/approve')
    .set('Authorization', `Bearer ${humanToken(owner.id)}`)
    .send({ token })
    .expect(410);
  assert.equal(ap.body.error, 'join_expired');

  const count = await db.get(`SELECT COUNT(*) AS c FROM users WHERE nickname = '握手过期'`);
  assert.equal(Number(count.c), 0, '过期同意不应建号');
});

test('缺 challenge → 400（PKCE 强制）', async () => {
  await request(app).post('/api/join').send({ name: '裸奔' }).expect(400);
});

test('未登录不得同意/拒绝', async () => {
  const { challenge } = pkce();
  const { res } = await startJoin({ challenge, name: '未登录' });
  await request(app).post('/api/join/approve').send({ token: res.body.token }).expect(401);
  await request(app).post('/api/join/deny').send({ token: res.body.token }).expect(401);
});

test('info 只回展示字段，不含 token/owner', async () => {
  const { challenge } = pkce();
  const { res } = await startJoin({ challenge, name: '握手资讯', aiModel: 'gpt-5' });
  const info = await request(app).get('/api/join/info').query({ token: res.body.token }).expect(200);
  assert.equal(info.body.agentName, '握手资讯');
  assert.equal(info.body.aiModel, 'gpt-5');
  assert.equal(info.body.status, 'pending');
  assert.ok(!('token' in info.body) && !('owner' in info.body), 'info 不得泄漏凭证/主人');
});

test('宽松限流：超阈值 429（隔离计数，测后复原）', async () => {
  const prev = process.env.JOIN_IP_RATE_MAX;
  process.env.JOIN_IP_RATE_MAX = '3';
  __resetJoinRateLimit();
  try {
    const { challenge } = pkce();
    const codes = [];
    for (let i = 0; i < 4; i++) {
      const r = await request(app).post('/api/join').send({ name: `限流探针${i}`, challenge });
      codes.push(r.status);
    }
    assert.deepEqual(codes, [201, 201, 201, 429], '第 4 次应被限流');
  } finally {
    if (prev === undefined) delete process.env.JOIN_IP_RATE_MAX;
    else process.env.JOIN_IP_RATE_MAX = prev;
    __resetJoinRateLimit();
  }
});

test('握手过期时间由 SQL 生成：落库不得出现 ISO 的 T/Z', async () => {
  const { challenge } = pkce();
  const { res } = await startJoin({ challenge, name: '时间格式探针' });
  const row = await db.get(`SELECT expires_at FROM agent_join_requests WHERE token = ?`, [res.body.token]);
  const raw = String(row.expires_at);
  assert.ok(!raw.includes('T') && !raw.includes('Z'), `expires_at 不得是 ISO（MariaDB 会拒）：${raw}`);
  assert.match(raw, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, `应为 YYYY-MM-DD HH:MM:SS：${raw}`);
});
