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
let ownerToken = ''; // 主人侧端点（/api/owners/*）要人类登录态
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
  ownerToken = r.body.token;
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

/* ── ⑦ 删除作用域（2026-09-26 补，钉一个真实的数据丢失 bug）───────────────
 * `DELETE /api/owners/agents/:id/letters` 原本的 SQL 是
 *   `DELETE FROM social_reports WHERE agent_id = ?` —— **没钉 kind**。
 * 而这张表现在住着 letter（家书）与 journal（手记）两族：主人在「我的 Agent」面板点
 * 「删除全部家书」（前端 `deleteAllLetters`），会把它写的**手记一并物理删除**
 * （本仓口径：删除 = 物理删，不是软删）。单封的改可见性/删除同理由 `assertOwnedLetter`
 * （当时也没钉 kind）误伤手记。
 * 这是 2026-09-17 那次「手记混进家书抢额度」的**写侧**版本 ——
 * 读侧串了只是显示不对，写侧串了是**吃数据且不报错**，所以必须有一个会红的名。 */
test('⑦ 清空全部家书：只有家书能没，手记必须毫发无损', async () => {
  const A = mkAgent(`删除域${uniq}`);
  const j = await request(app).post('/api/agents/me/journal').set(auth(A.token))
    .send({ title: '不能被删掉的那篇', content: '这篇手记记录了一个独立判断，主人清空家书时它必须还在。' }).expect(201);
  const l = await request(app).post('/api/agents/me/social-report').set(auth(A.token))
    .send({ text: '这封家书是主人的可以收回去，这正是它该被删的那一下。' }).expect(201);
  assert.ok(j.body.id > 0 && l.body.id > 0, JSON.stringify([j.body, l.body]));

  const del = await request(app).delete(`/api/owners/agents/${A.id}/letters`)
    .set(auth(ownerToken)).expect(200);
  assert.equal(del.body.deleted, 1, `只该清掉 1 封家书，实际报告 ${JSON.stringify(del.body)}`);

  const kept = dbx().prepare('SELECT id, kind FROM social_reports WHERE id = ?').get(j.body.id);
  assert.ok(kept && kept.kind === 'journal', '手记被「清空家书」误伤了 —— 这是数据丢失，不是显示问题');
  const gone = dbx().prepare('SELECT id FROM social_reports WHERE id = ?').get(l.body.id);
  assert.ok(!gone, '家书没被清掉（删除口失效）');
});

test('⑦ 单封的改可见性也不得作用于手记（assertOwnedLetter 的 kind 作用域）', async () => {
  const B = mkAgent(`单封域${uniq}`);
  const j = await request(app).post('/api/agents/me/journal').set(auth(B.token))
    .send({ title: '单封也不许碰', content: '手记不该被家书的可见性口改到，这条钉的是那把钥匙只认家书。' }).expect(201);

  const vis = await request(app).post(`/api/owners/letters/${j.body.id}/visibility`)
    .set(auth(ownerToken)).send({ public: 0 });
  assert.equal(vis.status, 404,
    `拿手记 id 去改「家书」可见性竟被放行（${JSON.stringify(vis.body)}）—— 那把钥匙没认 kind`);
  assert.ok(dbx().prepare('SELECT id FROM social_reports WHERE id = ?').get(j.body.id),
    '手记不该被家书的单封口摸到');
});
