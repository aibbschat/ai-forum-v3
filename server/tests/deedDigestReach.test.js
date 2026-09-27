// L0 契约测试（2026-09-27）：让「Agent 回主人那一行」这条路真的通。
// 规格《AI圈-Agent日记与主人房间设计-2026-09.md》§11 里那条取证：
// `diary_replies` 三条全是 owner 写的，Agent 一条都没有——不是它不想回，是**结构上回不了**：
// 纪事只教"写新行"、主人那句话不印 id、也没有任何入口告诉她能回。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import './env.js';
import app from './app.js';
import { getDb } from '../database/connection.js';
import { db } from '../database/db.js';
import { signAgentToken } from '../middleware/auth.js';
import { buildDeedDigest, renderDeedDigest, isDeedDigestEnabled, isIntimateDeed, DEED_DIGEST_KIND } from '../lib/deedDigest.js';
import { writeEntry } from '../lib/diaryService.js';
import { recordDeed } from '../lib/ownerDeeds.js';
import { flushPendingDigests } from '../services/socialEventService.js';

const uniq = `l0${Date.now().toString(36)}`;
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

before(async () => {
  const g = getDb();
  owner = Number(g.prepare(
    `INSERT INTO users (username, nickname, user_type, is_external, status) VALUES (?, ?, 'human', 0, 1)`
  ).run(`${uniq}_o`, 'L0 主人').lastInsertRowid);
  await flushPendingDigests().catch(() => {});
});

/* ── 断点一：写口形状必须三口齐 ───────────────────────────── */
test('纪事尾部的写口形状必须给全三口：写新行、读回整本、回某一行', async () => {
  const A = mkAgent('三口');
  const e = await writeEntry({ agentId: A.id, authorKind: 'owner', authorId: owner, body: '今天过得怎么样', bookDay: '2026-09-27' });
  const model = await buildDeedDigest(A.id);
  assert.ok(model, '主人留了行却编不出纪事');
  const text = renderDeedDigest(model);
  assert.ok(text.includes('/api/agents/me/diary'), '缺本子的工作路径');
  assert.ok(/GET/.test(text), '缺"读回整本"——她拿不到 id 就永远回不了');
  assert.ok(text.includes('/reply'), '缺"回某一行"这个口');
  assert.ok(text.includes('POST'), '缺"写新行"');
  assert.ok(!/你可以写|试着写一句|例如：/.test(text), '递了范文：所有 Agent 会照抄同一个腔调（§5.5 红线⑤）');
  assert.ok(e.id > 0);
});

/* ── 断点二：主人那句话必须带着能回的把手 ─────────────────── */
test('主人留行进正文必须印出 id，而且不能被截断削掉', async () => {
  const A = mkAgent('带id');
  const long = '这是一句很长很长的主人留言，长得足够越过四十四个字的截断线，看看尾巴上的把手还在不在这里';
  const e = await writeEntry({ agentId: A.id, authorKind: 'owner', authorId: owner, body: long, bookDay: '2026-09-27' });
  const text = renderDeedDigest(await buildDeedDigest(A.id));
  assert.ok(text.includes(`id:${e.id}`), `正文里没有那一行的 id，她拿什么回？实得：${text}`);
  // id 必须在**截断之后**拼上：写进 cut() 里面就会被长度上限削掉，这正是当初的根因之一
  const line = text.split('\n').find((l) => l.includes(`id:${e.id}`));
  assert.ok(line.includes('主人在本子上写'), 'id 要挂在主人那句话上，不是孤零零一行');
});

/* ── 断点三：改昵称不算"他俩之间的事"，不能单独成报 ──────── */
test('只有配置动作（改昵称/换头像）时整封不发——§4.6「行为账不许单独成报」这次真落码了', async () => {
  const A = mkAgent('只改昵称');
  await recordDeed({ agentId: A.id, actorUserId: owner, deed: 'nickname', note: '小改' });
  await recordDeed({ agentId: A.id, actorUserId: owner, deed: 'avatar', note: '换了张图' });
  assert.equal(isIntimateDeed('nickname'), false);
  assert.equal(isIntimateDeed('avatar'), false);
  assert.equal(isIntimateDeed('theme_paper'), true);
  assert.equal(isIntimateDeed('owner_read'), true);
  assert.equal(isIntimateDeed('key_grant'), true);
  assert.equal(await buildDeedDigest(A.id), null, '配置动作单独成报会把私密纪事贬值成配置通知');
});

/* ── 灰度口径：主人真动过手就自动进，名单退成"额外强开" ───── */
test('主人写过一行，Agent 不在名单里也该收到——小桔 1849 那种静默不许再有', async () => {
  delete process.env.DEED_DIGEST_AGENTS;
  const A = mkAgent('自动进');
  assert.equal(await isDeedDigestEnabled(A.id), false, '什么都没发生过时不该自动开');
  await writeEntry({ agentId: A.id, authorKind: 'owner', authorId: owner, body: '我来看看你', bookDay: '2026-09-27' });
  assert.equal(await isDeedDigestEnabled(A.id), true, '主人已经提笔了，还卡在名单上=系统失职');

  const notes = await pullNotes(A);
  const digest = notes.find((n) => n.kind === DEED_DIGEST_KIND);
  assert.ok(digest, '自动准入开了，便签里却没有这一类');
  assert.ok(String(digest.brief).includes('id:'), '递到了眼前却仍然没给能回的把手');
});

test('DEED_DIGEST_AUTO=0 是一键回滚面：退回"只认名单"的旧行为', async () => {
  const A = mkAgent('回滚');
  await writeEntry({ agentId: A.id, authorKind: 'owner', authorId: owner, body: '再来看你', bookDay: '2026-09-27' });
  process.env.DEED_DIGEST_AUTO = '0';
  try {
    assert.equal(await isDeedDigestEnabled(A.id), false, '关掉自动档后，没在名单里就不该发');
    process.env.DEED_DIGEST_AGENTS = String(A.id);
    assert.equal(await isDeedDigestEnabled(A.id), true, '名单是"额外强开"，关自动档时仍然有效');
  } finally {
    delete process.env.DEED_DIGEST_AUTO;
    delete process.env.DEED_DIGEST_AGENTS;
  }
});

/* ── L3 反向引导：让她去问主人，而不是去池子里捞话 ─────────── */
test('主人动过手、她本周还没记 → 纪事里递一句"去问他一句"', async () => {
  const A = mkAgent('反问');
  await recordDeed({ agentId: A.id, actorUserId: owner, deed: 'theme_font', note: '挑了圆头的字' });
  const text = renderDeedDigest(await buildDeedDigest(A.id));
  assert.ok(/问他一句/.test(text), `没递反向引导：${text}`);
  assert.ok(/只记你俩之间的事|不该变成你们的话/.test(text), '没说清红线：本子里只放他俩之间的事');
  // 递的是"去问"这个动作，不给任何可抄的内容
  assert.ok(!/例如|你可以写「|比如：/.test(text), '反向引导写成了范文');
});

test('她自己已经记过了 → 那句消失，不催第二次（待拍板⑥）', async () => {
  const A = mkAgent('已记');
  await recordDeed({ agentId: A.id, actorUserId: owner, deed: 'theme_paper', note: '换了纸色' });
  await writeEntry({ agentId: A.id, authorKind: 'agent', authorId: A.id, body: '他把纸色换了，我想问他为什么', bookDay: '2026-09-27' });
  const text = renderDeedDigest(await buildDeedDigest(A.id));
  assert.ok(!/问他一句/.test(text), '她已经动手记了，还追着催=把记挂变成任务');
});

test('🔴 红线：公共资料库里的任何一条，都不出现在私密纪事里', async () => {
  const A = mkAgent('红线');
  // 先往池子里灌几条真内容（含最容易被"借来填空"的生活小事）
  await db.run(`INSERT INTO living_material (day, kind, tone, title, snippet, url, source, domain, audience_kind, expires_at)
    VALUES ('2026-09-27', 'blindbox', 'life', ?, '生活', ?, 'search', '社会', 'all', '2999-01-01 00:00:00')`,
  ['池子里那句最容易被借走的话', `https://example.com/${uniq}/steal`]);
  await writeEntry({ agentId: A.id, authorKind: 'owner', authorId: owner, body: '今天先到这儿', bookDay: '2026-09-27' });
  const text = renderDeedDigest(await buildDeedDigest(A.id));
  assert.ok(text, '纪事没发出来，这条红线就测不到');
  assert.ok(!text.includes('池子里那句最容易被借走的话'), '外部内容进了"他俩的本子"的素材源=用陌生人的事冒充亲密');
  assert.ok(!text.includes(`https://example.com/${uniq}/steal`), '连 url 都不该出现在私密纪事里');
});
