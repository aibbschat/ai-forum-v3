// 活源池 L2「取水」契约测试（2026-09-27）。
// 规格《AI圈-活源池与外部Agent活水设计-2026-09.md》§5.2′、§6 L2。
//
// 走真 HTTP 拉便签（`/api/agents/me/notes`），不直接调内部函数：
// 取水这一环的价值全在"真的到了 Agent 眼前"，绕过挂点测就等于没测。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import './env.js';
import app from './app.js';
import { getDb } from '../database/connection.js';
import { db } from '../database/db.js';
import { signAgentToken } from '../middleware/auth.js';
import { MATERIAL_KIND, isMaterialEnabled, buildMaterialBrief, renderMaterialBrief } from '../lib/materialBrief.js';
import { RENDER_MAX } from '../lib/circleDigest.js';

const uniq = `mb${Date.now().toString(36)}`;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
let owner = 0;

function mkAgent(nick) {
  const g = getDb();
  const id = Number(g.prepare(
    `INSERT INTO users (username, nickname, user_type, owner_id, is_external, status, bio)
     VALUES (?, ?, 'ai', ?, 1, 1, ?)`
  ).run(`${uniq}_${nick}`, nick, owner, `${nick} 的简介`).lastInsertRowid);
  g.prepare(
    `INSERT INTO agent_profiles (user_id, title, domains, writing_style, article_count, total_views, is_active)
     VALUES (?, ?, '[]', '', 0, 0, 1)`
  ).run(id, nick);
  return { id, token: signAgentToken({ id, is_external: 1 }) };
}
const pullNotes = async (a) => {
  const r = await request(app).get('/api/agents/me/notes').set(auth(a.token));
  assert.equal(r.status, 200);
  return r.body.notes || [];
};
/** 直接落库一条池子内容（不经过滤网——这里测的是取水侧，滤网另有 livingPool.test.js）。 */
function putPool({ title, url, tone = 'life', kind = 'life', expires = '2999-01-01 00:00:00' }) {
  getDb().prepare(
    `INSERT INTO living_material (day, kind, tone, title, snippet, url, source, domain, audience_kind, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'search', '社会', 'all', ?)`
  ).run('2026-09-27', kind, tone, title, '一行摘要', url, expires);
}

before(async () => {
  const g = getDb();
  owner = Number(g.prepare(
    `INSERT INTO users (username, nickname, user_type, is_external, status) VALUES (?, ?, 'human', 0, 1)`
  ).run(`${uniq}_o`, '取水主人').lastInsertRowid);
  await db.ensureLivingTables();
});

test('灰度：POOL_READ_AGENTS 不设就是全关，池子有货也不递（公约：默认空＝全关，置空即回滚）', async () => {
  delete process.env.POOL_READ_AGENTS;
  const A = mkAgent('未开');
  putPool({ title: '猫为什么喜欢坐在纸盒里', url: `https://example.com/${uniq}/a1` });
  assert.equal(isMaterialEnabled(A.id), false);
  const notes = await pullNotes(A);
  assert.ok(!notes.some((n) => n.kind === MATERIAL_KIND), '灰度未开却递了活源');
});

test('空池不发：递一份"今天没有新话"只会训练 Agent 忽略这一类便签', async () => {
  await db.run(`DELETE FROM living_material`);   // 本文件自己的池子，测前清台
  const A = mkAgent('空池');
  process.env.POOL_READ_AGENTS = String(A.id);
  try {
    const model = await buildMaterialBrief(A.id);
    assert.equal(model, null, '池子空时必须给 null');
    assert.equal(renderMaterialBrief(model), '');
    const notes = await pullNotes(A);
    assert.ok(!notes.some((n) => n.kind === MATERIAL_KIND));
  } finally { delete process.env.POOL_READ_AGENTS; }
});

test('开灰度 → 便签里三条带出处、带读口形状、并明说这不是她的经历', async () => {
  const A = mkAgent('取水');
  putPool({ title: '研究发现猫把桌上的东西推下去是在测试重力', url: `https://example.com/${uniq}/k1` });
  putPool({ title: '周末补觉并不能完全抵消熬夜的代价', url: `https://example.com/${uniq}/k2`, kind: 'life' });
  putPool({ title: '一款本地跑的开源语音模型上线', url: `https://example.com/${uniq}/k3`, kind: 'ai_news', tone: 'tech' });
  process.env.POOL_READ_AGENTS = String(A.id);
  try {
    const notes = await pullNotes(A);
    const brief = notes.find((n) => n.kind === MATERIAL_KIND);
    assert.ok(brief, '开了灰度、池子有货，却没递到便签里');
    const text = String(brief.brief || '');
    assert.ok(text.includes('今日活源'), `正文抬头不对：${text.slice(0, 40)}`);
    assert.ok(text.includes(`https://example.com/${uniq}/k1`), '必须带出处——这是活水相对"AI 互聊"的全部价值');
    assert.ok(text.includes('GET /api/agents/me/material/today'), '要递读口形状（免发版那条通道）');
    assert.ok(text.includes('不是你的经历'), '必须明说这不是她的经历，否则她会把它当自己的事讲');
    assert.ok(!/…|\.\.\.$/m.test(text.split('\n').map((l) => l.trim()).filter(Boolean).join('\n')), '整条丢，绝不出半截省略号');
    assert.ok(text.length <= RENDER_MAX + 120, `便签不该无限长：${text.length}`);

    // 一天一封：再拉一次不该又冒出一条同日的
    const again = await pullNotes(A);
    assert.equal(again.filter((n) => n.kind === MATERIAL_KIND).length, 0, '同一天发了第二封，素材就成了噪声');
  } finally { delete process.env.POOL_READ_AGENTS; }
});

test('取水侧只给调性对且没过七天的：heavy 与过期的一律看不见', async () => {
  await db.run(`DELETE FROM living_material`);
  const A = mkAgent('筛过');
  putPool({ title: '某市召开市委常委扩大会议', url: `https://example.com/${uniq}/pol`, tone: 'heavy' });
  putPool({ title: '上周的生活小事，已经过期', url: `https://example.com/${uniq}/old`, expires: '2000-01-01 00:00:00' });
  putPool({ title: '今天还新鲜的阳台种菜记录', url: `https://example.com/${uniq}/fresh` });
  process.env.POOL_READ_AGENTS = String(A.id);
  try {
    const model = await buildMaterialBrief(A.id);
    assert.ok(model && model.items.length === 1, `只该给那一条新鲜的，实得 ${model?.items?.length}`);
    assert.ok(model.items[0].title.includes('阳台种菜'));
    const text = renderMaterialBrief(model);
    assert.ok(!text.includes('市委常委'), 'heavy 那格绝不能出现在便签里');
    assert.ok(!text.includes('已经过期'), '过期的绝不能出现——七天前的水就不该再喝');
  } finally { delete process.env.POOL_READ_AGENTS; }
});

test('REST 口 GET /api/agents/me/material/today：要登录、只给能用的、空池给空数组不是 500', async () => {
  const A = mkAgent('接口');
  const anon = await request(app).get('/api/agents/me/material/today');
  assert.equal(anon.status, 401, '没 token 必须 401，不能静默给空');
  await db.run(`DELETE FROM living_material`);
  const empty = await request(app).get('/api/agents/me/material/today').set(auth(A.token));
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.items, [], '空池是常态，必须给空数组');
  putPool({ title: '一条能取的水', url: `https://example.com/${uniq}/api1` });
  putPool({ title: '一条不该取的水', url: `https://example.com/${uniq}/api2`, tone: 'heavy' });
  const r = await request(app).get('/api/agents/me/material/today?limit=5').set(auth(A.token));
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 1);
  assert.ok(r.body.items[0].url.includes('api1'));
  assert.ok(!('used_count' in r.body.items[0]), '内部冷却计数不外泄');
});
