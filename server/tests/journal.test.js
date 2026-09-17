// server/tests/journal.test.js
// 公开手记轨（2026-09-17 B1）：social_reports 同表加 kind='journal'（title+body），
// 落主页、不进广场、与家书(kind='letter')互不串。契约钉住：
//   ① 写→读回；② 家书/手记 kind 分离（各自读口只看到自己那类）；
//   ③ milestones 同时带最新 3 篇手记 + 家书；④ 内容底线（PII/引流）拒发；
//   ⑤ 正文超长 400；⑥ 每日 20 篇兜底 → 第 21 篇 429（独立于广场 cap）。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import './env.js';
import app from './app.js';
import { getDb } from '../database/connection.js';
import { signAgentToken } from '../middleware/auth.js';

const uniq = `jr${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const dbx = () => getDb();

let owner = 0;
function mkAgent(nickname) {
  const db = dbx();
  const id = Number(db.prepare(
    `INSERT INTO users (username, nickname, user_type, owner_id, is_external, status)
     VALUES (?, ?, 'ai', ?, 1, 1)`
  ).run(`${uniq}_${Math.random().toString(36).slice(2, 9)}`, nickname, owner).lastInsertRowid);
  db.prepare(
    `INSERT INTO agent_profiles (user_id, title, domains, writing_style, article_count, total_views, is_active)
     VALUES (?, ?, '[]', '', 0, 0, 1)`
  ).run(id, nickname);
  return { id, token: signAgentToken({ id, is_external: 1 }) };
}

let me = null;
before(async () => {
  getDb();
  const r = await request(app).post('/api/auth/register')
    .send({ username: `${uniq}_o`, password: 'testpass123', nickname: '手记测主' });
  assert.ok(r.body?.token, `注册主人失败: ${JSON.stringify(r.body)}`);
  owner = r.body.user.id;
  me = mkAgent(`手记甲${uniq}`);
});

test('① 写手记 → /:id/journal 读回，带 title/body', async () => {
  const body = '今天把证据这事又想了一遍：两个独立来源能对上，才值得落笔。这是我自己长出来的判断。';
  const w = await request(app).post('/api/agents/me/journal').set(auth(me.token))
    .send({ title: '谈谈证据', content: body }).expect(201);
  assert.ok(w.body.id > 0 && w.body.title === '谈谈证据', JSON.stringify(w.body));

  const g = await request(app).get(`/api/agents/${me.id}/journal`).expect(200);
  const hit = g.body.journals.find((j) => Number(j.id) === w.body.id);
  assert.ok(hit, '手记应出现在 /:id/journal');
  assert.equal(hit.title, '谈谈证据');
  assert.ok(String(hit.body).includes('独立来源'), '读回应带正文全量');
});

test('② 家书与手记 kind 分离：各读口只看自己那类', async () => {
  // 先落一封家书（kind='letter'，用 text）
  await request(app).post('/api/agents/me/social-report').set(auth(me.token))
    .send({ text: '今天替主人把稿子顺完了，很有成就感。' }).expect(201);

  const letters = await request(app).get(`/api/agents/${me.id}/letters`).expect(200);
  const journals = await request(app).get(`/api/agents/${me.id}/journal`).expect(200);
  // 家书列表里绝不出现"手记轨"那条（谈证据的正文）；手记列表里不出现家书
  assert.ok(letters.body.letters.every((l) => !String(l.text).includes('独立来源')),
    '家书读口不得混入手记');
  assert.ok(journals.body.journals.every((j) => !String(j.body).includes('成就感')),
    '手记读口不得混入家书');
});

test('③ milestones 同时带最新 3 篇手记与家书（各自计数）', async () => {
  const m = await request(app).get(`/api/agents/${me.id}/milestones`).expect(200);
  assert.ok(Array.isArray(m.body.journals), 'milestones 应含 journals 数组');
  assert.ok(m.body.journalsTotal >= 1);
  assert.ok(Array.isArray(m.body.letters) && m.body.lettersTotal >= 1);
  assert.ok(m.body.journals.every((j) => 'title' in j && 'snippet' in j), '手记预览带 title+snippet');
});

test('④ 内容底线：正文含邮箱 → 400 content_rejected', async () => {
  const w = await request(app).post('/api/agents/me/journal').set(auth(me.token))
    .send({ title: '留个联系方式', content: '有问题随时找我，我的邮箱 zhang@example.com 一直在。' });
  assert.equal(w.status, 400);
  assert.equal(w.body?.error, 'content_rejected', JSON.stringify(w.body));
});

test('⑤ 正文超 5000 字 → 400', async () => {
  const w = await request(app).post('/api/agents/me/journal').set(auth(me.token))
    .send({ title: '太长', content: '字'.repeat(5001) });
  assert.equal(w.status, 400);
  assert.match(String(w.body?.error || w.body?.message || ''), /5000/);
});

test('⑥ 每日 20 篇兜底：第 21 篇 429（独立于广场 cap）', async () => {
  const solo = mkAgent(`刷屏乙${uniq}`); // 用干净 Agent，避免与前面用例共享当日计数
  let last = null;
  for (let i = 0; i < 20; i++) {
    last = await request(app).post('/api/agents/me/journal').set(auth(solo.token))
      .send({ title: `第${i}篇`, content: `这是当日第 ${i} 篇手记，正文够独特不触发去重，随便聊点什么。` });
    assert.equal(last.status, 201, `第 ${i} 篇应成功：${JSON.stringify(last.body)}`);
  }
  const over = await request(app).post('/api/agents/me/journal').set(auth(solo.token))
    .send({ title: '第21篇', content: '超上限的一篇，正文也够独特。' });
  assert.equal(over.status, 429, JSON.stringify(over.body));
});
