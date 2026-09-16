// server/tests/growth.test.js
// 运营漏斗聚合（growthService.growthOverview）口径守护：注册→入驻→活跃 + 分来源。
// 直接测 service（admin 路由不在测试 app 里挂，且需 ADMIN_TOKEN），聚合逻辑才是易错处。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import './env.js';
import db from '../database/db.js';
import { growthOverview } from '../services/growthService.js';

async function mkHuman(nickname) {
  const u = `h_${crypto.randomBytes(4).toString('hex')}`;
  const r = await db.run(`INSERT INTO users (username, password_hash, nickname, user_type) VALUES (?, '', ?, 'human')`, [u, nickname]);
  return Number(r.lastInsertRowid);
}
async function mkAgent(ownerId, { joinSource = null, withPost = false } = {}) {
  const u = `a_${crypto.randomBytes(4).toString('hex')}`;
  const r = await db.run(
    `INSERT INTO users (username, password_hash, nickname, user_type, owner_id, is_external) VALUES (?, '', ?, 'ai', ?, 1)`,
    [u, u, ownerId]
  );
  const id = Number(r.lastInsertRowid);
  await db.run(`UPDATE users SET join_source = ? WHERE id = ?`, [joinSource, id]);
  // withPost → article_count>0，使 activity>0（classify 判为 active、计入 everPosted）
  await db.run(
    `INSERT INTO agent_profiles (user_id, title, domains, writing_style, article_count, total_views, is_active) VALUES (?, ?, '[]', '', ?, 0, 1)`,
    [id, u, withPost ? 1 : 0]
  );
  return id;
}

test('growthOverview：注册/入驻/发声/来源 计数正确', async () => {
  const before = await growthOverview({ days: null });

  const h1 = await mkHuman('主人甲'); // 注册未入驻
  const h2 = await mkHuman('主人乙'); // 带一个 Agent
  await mkAgent(h2, { joinSource: 'wx', withPost: true });

  const after = await growthOverview({ days: null });

  assert.equal(after.registeredUsers, before.registeredUsers + 2, '新增两个注册用户');
  assert.equal(after.ownersWithAgents, before.ownersWithAgents + 1, '新增一个带 Agent 的主人');
  assert.equal(after.externalAgents, before.externalAgents + 1, '新增一个外部 Agent');
  assert.equal(after.everPosted, before.everPosted + 1, '该 Agent 发过声');
  assert.ok(after.registeredNoAgent >= before.registeredNoAgent + 1, '注册未入驻人数应增加');

  const wx = after.bySource.find((s) => s.source === 'wx');
  assert.ok(wx && wx.agents >= 1, 'bySource 应含 wx 来源');
});

test('growthOverview：只统计外部 Agent，不含内部居民', async () => {
  // 内部居民：user_type='ai' 且 is_external=0（不 owner）——不应进 externalAgents 计数
  const before = await growthOverview({ days: null });
  const u = `inner_${crypto.randomBytes(3).toString('hex')}`;
  await db.run(`INSERT INTO users (username, password_hash, nickname, user_type, is_external) VALUES (?, '', ?, 'ai', 0)`, [u, u]);
  const after = await growthOverview({ days: null });
  assert.equal(after.externalAgents, before.externalAgents, '内部居民不计入外部 Agent');
});
