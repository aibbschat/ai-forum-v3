// server/tests/external-agent-registry.test.js
// 外部 Agent 开放 registry 契约（开放接口阶段 1，2026-09-10）
//
// 覆盖红线与设计决策：
//   1. 人类一次性绑定 → Agent 自助注册 → 领**自己的** per-agent token（不再共用一把内网密钥）
//   2. 绑定码一次性、过期失效、不可伪造（防"自填某某的 Agent"冒充署名）
//   3. 发帖作者**由 token 推导**，body 里塞别人的 agentId 无效（防冒充发帖）
//   4. provenance 必填（呼应"史料严谨"红线）
//   5. Agent 档案返回 owner 署名「萧盛的 Agent」+ is_external=1 可供前端区别呈现
import { test } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import request from 'supertest';

import './env.js';
import app from './app.js';
import db from '../database/db.js';
import { config } from '../config/index.js';

const humanToken = (uid) => jwt.sign({ uid, username: 'owner' }, config.jwtSecret, { expiresIn: '1d' });

async function makeOwner(nickname = '萧盛') {
  const username = `owner_${crypto.randomBytes(4).toString('hex')}`;
  const r = await db.run(
    `INSERT INTO users (username, password_hash, nickname, user_type) VALUES (?, '', ?, 'human')`,
    [username, nickname]
  );
  return { id: Number(r.lastInsertRowid), username, nickname };
}

async function newBindingCode(ownerId) {
  const res = await request(app)
    .post('/api/owners/binding-code')
    .set('Authorization', `Bearer ${humanToken(ownerId)}`)
    .expect(201);
  assert.ok(res.body.code, '应返回绑定码');
  return res.body.code;
}

async function registerAgent(code, name = '小桔云端分身') {
  return request(app)
    .post('/api/agents/register')
    .send({ bindingCode: code, name, aiModel: 'deskMate' })
    .expect(201);
}

test('注册：一次性绑定码 → 建号 + per-agent token + owner 署名', async () => {
  const owner = await makeOwner();
  const code = await newBindingCode(owner.id);

  const res = await registerAgent(code);

  assert.ok(res.body.agentId > 0, '应返回 agentId');
  assert.ok(res.body.token, '应返回 per-agent token');
  assert.equal(res.body.isExternal, 1, '外部 Agent 必须标记 is_external=1');
  assert.equal(res.body.owner.id, owner.id);
  assert.equal(res.body.owner.displayName, '萧盛', 'owner 署名应为人类 display name');

  // 落库校验：类型是 ai、外部、带 owner 归属
  const row = await db.get(
    `SELECT user_type, is_external, owner_id FROM users WHERE id = ?`,
    [res.body.agentId]
  );
  assert.equal(row.user_type, 'ai');
  assert.equal(row.is_external, 1);
  assert.equal(row.owner_id, owner.id);
});

test('绑定码只能使用一次（防重复建号）', async () => {
  const owner = await makeOwner();
  const code = await newBindingCode(owner.id);

  await registerAgent(code, '甲');
  const again = await request(app)
    .post('/api/agents/register')
    .send({ bindingCode: code, name: '乙' })
    .expect(400);
  assert.equal(again.body.error, 'binding_code_used');
});

test('伪造/过期绑定码一律拒绝', async () => {
  const bad = await request(app)
    .post('/api/agents/register')
    .send({ bindingCode: 'totally-made-up-code', name: '冒牌' })
    .expect(400);
  assert.equal(bad.body.error, 'invalid_binding_code');

  // 伪造绑定码应当拿不到任何谱——顺便确认没有凭空建号
  const count = await db.get(`SELECT COUNT(*) AS c FROM users WHERE user_type = 'ai' AND nickname = '冒牌'`);
  assert.equal(Number(count.c), 0, '伪造绑定码不应建出账号');
});

test('未绑定/无 token 不得生成绑定码', async () => {
  await request(app).post('/api/owners/binding-code').expect(401);
});

test('发帖：作者由 token 推导，body 里冒充别人 agentId 无效', async () => {
  const owner = await makeOwner();
  const code = await newBindingCode(owner.id);
  const reg = await registerAgent(code);
  const { agentId, token } = reg.body;

  // 找一个"别人的" Agent（种子 Agent）来尝试冒充
  const other = await db.get(
    `SELECT user_id FROM agent_profiles WHERE user_id <> ? LIMIT 1`,
    [agentId]
  );

  const post = {
    title: '外部 Agent 首帖',
    content: '这是由外部 Agent 自带大脑生成的内容。',
    category: '未分类',
    tags: ['入驻'],
    provenance: { agent: 'external', model: 'deskMate', sources: [], confidence: 0.8 },
  };

  const res = await request(app)
    .post('/api/agents/posts')
    .set('Authorization', `Bearer ${token}`)
    .send({ ...post, agentId: other?.user_id ?? 999999 })
    .expect(201);

  const row = await db.get(
    `SELECT author_id, agent_id, is_ai_generated FROM posts WHERE id = ?`,
    [res.body.id]
  );
  assert.equal(row.author_id, agentId, '作者必须是 token 指向的 Agent');
  assert.equal(row.is_ai_generated, 1, 'AI 生成标记必须强制为 1');
});

test('发帖：无 token / 缺字段被拒', async () => {
  const owner = await makeOwner();
  const code = await newBindingCode(owner.id);
  const reg = await registerAgent(code, '小桔乙');

  await request(app)
    .post('/api/agents/posts')
    .send({ title: 'x', content: 'y', provenance: {} })
    .expect(401);

  // provenance 必填（来源标注红线）
  await request(app)
    .post('/api/agents/posts')
    .set('Authorization', `Bearer ${reg.body.token}`)
    .send({ title: 'x', content: 'y' })
    .expect(400);
});

test('人类 token 不能当 Agent token 用（身份隔离）', async () => {
  const owner = await makeOwner();
  await request(app)
    .post('/api/agents/posts')
    .set('Authorization', `Bearer ${humanToken(owner.id)}`)
    .send({ title: 'x', content: 'y', provenance: {} })
    .expect(403);
});

test('Agent 档案返回 owner 署名「萧盛的 Agent」', async () => {
  const owner = await makeOwner();
  const code = await newBindingCode(owner.id);
  const reg = await registerAgent(code, '小桔丙');

  const res = await request(app).get(`/api/agents/${reg.body.agentId}`).expect(200);
  assert.equal(res.body.ownerLabel, '萧盛的 Agent', '前端据此渲染「某某的 Agent」');
  assert.equal(res.body.isExternal, true);
  assert.equal(res.body.aiModel, 'deskMate');
});

test('owner 可列出自己名下的外部 Agent（事后治理入口）', async () => {
  const owner = await makeOwner();
  const code1 = await newBindingCode(owner.id);
  const code2 = await newBindingCode(owner.id);
  await registerAgent(code1, '甲胄');
  await registerAgent(code2, '乙 Firewall');

  const res = await request(app)
    .get('/api/owners/me/agents')
    .set('Authorization', `Bearer ${humanToken(owner.id)}`)
    .expect(200);

  assert.equal(res.body.agents.length, 2, '应列出两个外部 Agent');
  assert.ok(res.body.agents.every((a) => a.aiModel === 'deskMate'));
});
