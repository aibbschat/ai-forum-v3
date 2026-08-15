// 后端 API 契约回归测试（node:test + supertest）。
// 隔离临时 DB，不触碰 data/aiforum.db；可重复运行。
// 断言响应全部为 camelCase（与 normalize.js 单源一致），author 嵌套 {id,name,avatar}。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, unlinkSync } from 'node:fs';
import request from 'supertest';

import './env.js';
import app from './app.js';
import { TEST_DB_PATH } from './env.js';
import { getDb, closeDb } from '../database/connection.js';

// ── 断言工具 ─────────────────────────────────────────────────────
const SNAKE_RE = /_[a-z]/;

function assertCamelCaseKeys(value, path = 'root') {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertCamelCaseKeys(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      assert.ok(
        !SNAKE_RE.test(k),
        `${path}.${k} 应为 camelCase，收到 snake_case（normalize.js 漂移？）`
      );
      assertCamelCaseKeys(v, `${path}.${k}`);
    }
  }
}

// ── 夹具状态 ─────────────────────────────────────────────────────
let userToken = '';
let userId = 0;
let agentId = 0;
let postId = 0;
let commentId = 0;

before(async () => {
  getDb(); // 触发建表 + Agent 种子
  const agentsRes = await request(app).get('/api/agents');
  assert.equal(agentsRes.status, 200);
  assert.ok(agentsRes.body.agents.length >= 1, '应有 seed Agent');
  agentId = agentsRes.body.agents[0].id;

  const reg = await request(app).post('/api/auth/register').send({
    username: 'contract_user',
    password: 'testpass123',
    nickname: '契约测试用户',
  });
  assert.equal(reg.status, 200);
  userToken = reg.body.token;
  userId = reg.body.user.id;
});

after(() => {
  try {
    closeDb();
  } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    const p = TEST_DB_PATH + suffix;
    if (existsSync(p)) unlinkSync(p);
  }
});

// ── 1. 注册 → 登录 → token 可用性 ─────────────────────────────────
test('注册返回 token 且 /me 可用', async () => {
  assert.ok(userToken, '注册应返回 token');
  // 无 token → 401
  const noAuth = await request(app).get('/api/auth/me');
  assert.equal(noAuth.status, 401);
  // 有 token → 200 且 user 有效
  const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${userToken}`);
  assert.equal(me.status, 200);
  assert.equal(me.body.user.id, userId);
  assertCamelCaseKeys(me.body.user);
});

test('登录正确密码 → 200；错误密码 → 401', async () => {
  const ok = await request(app).post('/api/auth/login').send({
    username: 'contract_user',
    password: 'testpass123',
  });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
  assertCamelCaseKeys(ok.body.user);

  const bad = await request(app).post('/api/auth/login').send({
    username: 'contract_user',
    password: 'wrong-password',
  });
  assert.equal(bad.status, 401);
});

// ── 2. 发帖（内部发布桥是实际契约路径；公开 POST /api/posts 不存在，见说明） ──
test('发帖：无内部 token → 401；有 token → 201 入库且列表可见', async () => {
  const payload = {
    title: '契约测试文章：科技趋势观察',
    content: '本文用于验证发布桥契约与 camelCase 归一化。',
    agentId,
    category: '科技',
    tags: ['AI', '测试'],
    readingTime: 3,
  };

  const noToken = await request(app).post('/api/internal/dsh/publish').send(payload);
  assert.equal(noToken.status, 401);

  const ok = await request(app)
    .post('/api/internal/dsh/publish')
    .set('X-Internal-Token', 'test-internal-token')
    .send(payload);
  assert.equal(ok.status, 201);
  assert.ok(ok.body.id);
  postId = ok.body.id;

  const detail = await request(app).get(`/api/posts/${postId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.title, payload.title);
});

// 决策 X5（2026-08-15）：人类用户可公开发帖，POST /api/posts（需登录）
test('人类公开发帖：无 token → 401；有 token → 201 入库且作者正确', async () => {
  const payload = {
    title: '人类用户的公开帖子',
    content: '这是人类用户通过公开接口发布的帖子，验证 X5 决策。',
    category: '综合',
    tags: ['人类', '测试'],
  };

  const noAuth = await request(app).post('/api/posts').send(payload);
  assert.equal(noAuth.status, 401);

  const ok = await request(app)
    .post('/api/posts')
    .set('Authorization', `Bearer ${userToken}`)
    .send(payload);
  assert.equal(ok.status, 201);
  assert.ok(ok.body.id);
  const humanPostId = ok.body.id;

  // 详情作者应为注册用户本人（人类，非 Agent）
  const detail = await request(app).get(`/api/posts/${humanPostId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.author.id, userId);
  assert.equal(detail.body.title, payload.title);
  // 人类帖无 provenance（非 DSH 生成）
  assert.equal(detail.body.provenance, undefined);
});

// ── 3. 列表 GET /api/posts：camelCase + author 嵌套 ───────────────
test('GET /api/posts 返回 camelCase，author 嵌套 {id,name,avatar}', async () => {
  const res = await request(app).get('/api/posts');
  assert.equal(res.status, 200);
  assert.ok(res.body.articles.length >= 1);
  assertCamelCaseKeys(res.body.articles);

  const a = res.body.articles.find((x) => x.id === postId);
  assert.ok(a, '发布文章应出现在列表');
  assert.ok(a.author, '文章应带 author 嵌套');
  assert.equal(typeof a.author.id, 'number');
  assert.ok(a.author.name);
  assert.ok(a.author.avatar);
  assert.ok(a.createdAt, '应有 createdAt');
  assert.ok(Array.isArray(a.tags), 'tags 应为数组');
  assert.equal(a.viewCount, 0);
  assert.equal(a.likeCount, 0);
});

// ── 4. 搜索 GET /api/search?q=：规范 Article/Agent，无 snake_case ──
test('搜索返回规范 Article/Agent（camelCase，无 snake_case 残留）', async () => {
  const res = await request(app).get('/api/search').query({ q: '科技' });
  assert.equal(res.status, 200);
  assertCamelCaseKeys(res.body.articles);
  assertCamelCaseKeys(res.body.agents);

  const hit = res.body.articles.find((x) => x.id === postId);
  assert.ok(hit, '应能搜到发布文章');
  assert.ok(hit.author, '搜索文章应带 author 嵌套');

  const agent = res.body.agents.find((x) => x.id === agentId);
  assert.ok(agent, '应能搜到 seed Agent');
  assert.equal(typeof agent.articleCount, 'number');
  assert.ok(Array.isArray(agent.domains), 'Agent domains 应为数组');
});

// ── 5. 关注 / 取关：401 / 200 / 404 / 幂等 ────────────────────────
test('关注：无 token → 401；有效 → 200；重复关注幂等', async () => {
  const noAuth = await request(app).post(`/api/agents/${agentId}/follow`);
  assert.equal(noAuth.status, 401);

  const ok = await request(app)
    .post(`/api/agents/${agentId}/follow`)
    .set('Authorization', `Bearer ${userToken}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.following, true);
  assert.equal(typeof ok.body.followerCount, 'number');

  const again = await request(app)
    .post(`/api/agents/${agentId}/follow`)
    .set('Authorization', `Bearer ${userToken}`);
  assert.equal(again.status, 200);
  assert.equal(again.body.following, true, '重复关注应幂等保持 true');
});

test('关注：未知 Agent → 404', async () => {
  const res = await request(app)
    .post('/api/agents/999999/follow')
    .set('Authorization', `Bearer ${userToken}`);
  assert.equal(res.status, 404);
});

test('取关：有效 → 200；重复取关幂等', async () => {
  const ok = await request(app)
    .delete(`/api/agents/${agentId}/follow`)
    .set('Authorization', `Bearer ${userToken}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.following, false);

  const again = await request(app)
    .delete(`/api/agents/${agentId}/follow`)
    .set('Authorization', `Bearer ${userToken}`);
  assert.equal(again.status, 200);
  assert.equal(again.body.following, false, '重复取关应幂等保持 false');
});

// ── 6. 评论 POST·GET：字段 camelCase ──────────────────────────────
test('发评论：无 token → 401；有效 → 201 返回 camelCase comment', async () => {
  const noAuth = await request(app).post(`/api/posts/${postId}/comments`).send({
    content: '无登录评论',
  });
  assert.equal(noAuth.status, 401);

  const ok = await request(app)
    .post(`/api/posts/${postId}/comments`)
    .set('Authorization', `Bearer ${userToken}`)
    .send({ content: '这是一条契约测试评论。' });
  assert.equal(ok.status, 201);
  assertCamelCaseKeys(ok.body.comment);
  const c = ok.body.comment;
  assert.equal(c.postId, postId);
  assert.equal(c.authorId, userId);
  assert.ok(c.author);
  assert.ok(c.authorAvatar);
  assert.ok(c.content);
  assert.equal(c.likeCount, 0);
  assert.equal(c.liked, false);
  assert.ok(c.createdAt);
  commentId = c.id;
});

test('GET 评论列表：camelCase，包含刚发的评论', async () => {
  const res = await request(app).get(`/api/posts/${postId}/comments`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.comments));
  assertCamelCaseKeys(res.body.comments);
  assert.ok(res.body.comments.some((c) => c.id === commentId));
});

test('评论点赞：无 token → 401；有 token → 切换 + 计数', async () => {
  const noAuth = await request(app).post(`/api/comments/${commentId}/like`);
  assert.equal(noAuth.status, 401);

  const on = await request(app)
    .post(`/api/comments/${commentId}/like`)
    .set('Authorization', `Bearer ${userToken}`);
  assert.equal(on.status, 200);
  assert.equal(on.body.liked, true);
  assert.equal(on.body.likeCount, 1);

  const off = await request(app)
    .post(`/api/comments/${commentId}/like`)
    .set('Authorization', `Bearer ${userToken}`);
  assert.equal(off.body.liked, false);
  assert.equal(off.body.likeCount, 0);
});

// ── P1-9/P1-10/P1-11 技能数据契约：assets 配图 + 图表 ─────────────
test('发布带 assets 的文章：封面兜底 + assets 落库 + 详情返回 camelCase', async () => {
  const payload = {
    title: '契约测试：带配图与图表的文章',
    content: '正文内容，包含技能产出。',
    agentId,
    category: '财经',
    tags: ['图表', '测试'],
    assets: [
      { type: 'image', url: 'https://example.com/cover.png', title: '封面图', position: 'cover' },
      { type: 'image', url: 'https://example.com/inline.png', title: '文内图', position: 'inline' },
      {
        type: 'chart',
        title: 'AI 芯片市占率',
        position: 'inline',
        data: { type: 'bar', labels: ['华为', '寒武纪'], datasets: [{ name: '市占率', values: [43, 11] }] },
      },
    ],
  };

  const ok = await request(app)
    .post('/api/internal/dsh/publish')
    .set('X-Internal-Token', 'test-internal-token')
    .send(payload);
  assert.equal(ok.status, 201);
  const withAssetsId = ok.body.id;

  // 详情：assets 数组存在、封面从 assets 兜底、字段 camelCase
  const detail = await request(app).get(`/api/posts/${withAssetsId}`);
  assert.equal(detail.status, 200);
  assert.ok(Array.isArray(detail.body.assets));
  assert.equal(detail.body.assets.length, 3);
  assert.equal(detail.body.coverImage, 'https://example.com/cover.png'); // 封面从 assets 兜底
  const chart = detail.body.assets.find((a) => a.type === 'chart');
  assert.ok(chart);
  assert.equal(chart.position, 'inline');
  assert.ok(chart.data);
  assert.deepEqual(chart.data.labels, ['华为', '寒武纪']);
  assertCamelCaseKeys(detail.body.assets[0]);

  // 列表也带 assets（listArticles 显式 SELECT 已含 assets）
  const list = await request(app).get('/api/posts?sort=latest&limit=50');
  assert.equal(list.status, 200);
  const found = list.body.articles.find((a) => a.id === withAssetsId);
  assert.ok(found);
  assert.ok(Array.isArray(found.assets));
  assert.equal(found.assets.length, 3);
});

test('assets 非法输入被过滤：坏 type 丢弃、坏 position 归 inline、非数组安全', async () => {
  const payload = {
    title: '契约测试：assets 过滤',
    content: '正文',
    agentId,
    category: '科技',
    assets: [
      { type: 'video', url: 'x', position: 'cover' },   // 非法 type → 丢弃
      { type: 'image', url: 'a.png', position: 'weird' }, // 非法 position → inline
      { type: 'image', url: 'b.png', position: 'inline', title: 123 }, // title 非法类型 → undefined
      null,                                             // 非对象 → 丢弃
      'string',                                         // 非对象 → 丢弃
    ],
  };
  const ok = await request(app)
    .post('/api/internal/dsh/publish')
    .set('X-Internal-Token', 'test-internal-token')
    .send(payload);
  assert.equal(ok.status, 201);

  const detail = await request(app).get(`/api/posts/${ok.body.id}`);
  assert.ok(Array.isArray(detail.body.assets));
  assert.equal(detail.body.assets.length, 2); // 只有 2 个合法 image
  assert.equal(detail.body.assets[0].position, 'inline'); // weird → inline
  // 封面兜底只认 position='cover' 的图片；本用例无 cover → 封面为空
  assert.equal(detail.body.coverImage, '');

  // assets 非数组（undefined）→ 安全，不发
  const noAssets = await request(app)
    .post('/api/internal/dsh/publish')
    .set('X-Internal-Token', 'test-internal-token')
    .send({ title: '无 assets', content: '正文', agentId, category: '科技' });
  assert.equal(noAssets.status, 201);
  const nd = await request(app).get(`/api/posts/${noAssets.body.id}`);
  assert.equal(nd.body.assets, undefined);
});
