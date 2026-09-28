// 日记 D3：逐条公开的**展示面 + 访客反馈 + 回执回流**（2026-09-28）。
// 规格：《AI圈-Agent日记与主人房间设计-2026-09.md》§7.1/§7.2/§7.3/§9。
//
// 这一批最容易做错的三件事，各钉一层：
//   ① 公开档**还要过审核那一关**：`audience`（给不给外人看）与 `visibility`（审核放不放行）
//      两列各管各，处置只撤公开展示、不删数据 —— 漏一条就等于"被下架的东西还挂在外面"。
//   ② 访客写口准入＝**持钥匙 AND 登录**（两条同时满足）：钥匙证明"这一行是主人放给谁看的"，
//      登录证明"说话的人有身份、可追溯"。缺任何一条都写不进去，且判定在服务端（前端藏不算藏）。
//   ③ 回流靠 `peerIds` **独立去重**：`diary_replies.id` 与 `owner_deeds.id`/`diary_entries.id`
//      不是一个 id 空间，混进同一个数组会串号（档2 的教训）——报过的不复读、一天硬一封。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import './env.js';
import app from './app.js';
import { getDb } from '../database/connection.js';
import { db } from '../database/db.js';
import { config } from '../config/index.js';
import {
  writeEntry, replyToEntry, readRoom, setAudience, issueKey,
  listPublicEntries, getPublicEntry, recentPeerFeedback, minDeedsRequired,
} from '../lib/diaryService.js';
import { buildDeedDigest, renderDeedDigest, DEED_DIGEST_KIND } from '../lib/deedDigest.js';
import { noindexMeta } from '../services/seoPageService.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const uniq = `d3${Date.now().toString(36)}`;
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const humanToken = (uid) => jwt.sign({ uid, username: 'guest' }, config.jwtSecret, { expiresIn: '1d' });
let owner = 0;
let guest = 0;

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
  return { id };
}

/** 临时改 env 跑一段，跑完还原（不污染同进程的其它用例）。 */
async function withEnv(kv, fn) {
  const prev = {};
  for (const k of Object.keys(kv)) prev[k] = process.env[k];
  Object.assign(process.env, kv);
  try { return await fn(); } finally {
    for (const k of Object.keys(kv)) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
  }
}

/** 把一条日记撕成公开：红线闸只认显式 ID（`DIARY_MIN_DEEDS` 在测试环境已被置 0 关掉）。 */
function makePublic(agentId, entryId) {
  return withEnv({ DIARY_PUBLISH_AGENTS: String(agentId) }, () =>
    setAudience({ entryId, actorKind: 'owner', actorId: owner, audience: 'public' }));
}

before(async () => {
  const g = getDb();
  owner = Number(g.prepare(
    `INSERT INTO users (username, nickname, user_type, is_external, status) VALUES (?, ?, 'human', 0, 1)`
  ).run(`${uniq}_o`, 'D3 主人').lastInsertRowid);
  guest = Number(g.prepare(
    `INSERT INTO users (username, nickname, user_type, is_external, status) VALUES (?, ?, 'human', 0, 1)`
  ).run(`${uniq}_g`, '来访的朋友').lastInsertRowid);
});

/* ── ① 审核列 ─────────────────────────────────────────────── */
test('visibility 审核列：两份 schema 都声明了（schema 1:1 映射）', () => {
  const block = (f) => readFileSync(resolve(__dirname, `../database/${f}`), 'utf8')
    .match(/CREATE TABLE IF NOT EXISTS diary_entries\s*\(([\s\S]*?)\);/)?.[1] || '';
  assert.match(block('schema.sql'), /\bvisibility\b/, 'SQLite 侧缺 visibility');
  assert.match(block('schema.mariadb.sql'), /\bvisibility\b/, 'MariaDB 侧缺 visibility');
});

test('🔴 被处置（flagged）的行只撤公开展示：匿名与独立页都读不到，主人照旧读得到', async () => {
  const A = mkAgent('处置');
  const body = `${uniq} 这一行先公开、再被处置`;
  const e = await writeEntry({ agentId: A.id, authorKind: 'agent', authorId: A.id, body, bookDay: '2026-09-28' });
  await makePublic(A.id, e.id);
  assert.equal((await getPublicEntry(A.id, e.id)).body, body, '公开后独立页应读得到');

  await db.run(`UPDATE diary_entries SET visibility = 'flagged' WHERE id = ?`, [e.id]);

  assert.equal(await getPublicEntry(A.id, e.id), null, '被处置的行不该再出现在独立页');
  assert.ok(!(await listPublicEntries(A.id)).some((x) => x.id === e.id), '被处置的行不该出现在公开列表');
  const anon = await readRoom(A.id, { canReadPrivate: false });
  const anonRow = anon.entries.find((x) => x.id === e.id);
  assert.ok(!anonRow.body, '被处置的行不该对匿名出正文');
  // 处置不是删除：主人照旧读得到（撤回/申诉的余地留着）
  const own = await readRoom(A.id, { canReadPrivate: true });
  assert.equal(own.entries.find((x) => x.id === e.id).body, body, '处置只撤公开展示，不删数据');
});

/* ── ①b 「往外撕」门槛 ────────────────────────────────────── */
test('DIARY_MIN_DEEDS：未设/写坏→默认 3；置 0 放开、置大即关死（纯函数语义）', () => {
  assert.equal(minDeedsRequired({}), 3, '未设该保守默认 3');
  assert.equal(minDeedsRequired({ DIARY_MIN_DEEDS: 'oops' }), 3, '写坏了也回默认');
  assert.equal(minDeedsRequired({ DIARY_MIN_DEEDS: '-1' }), 3, '负数不合法，回默认');
  assert.equal(minDeedsRequired({ DIARY_MIN_DEEDS: '0' }), 0, '置 0＝放开这一档');
  assert.equal(minDeedsRequired({ DIARY_MIN_DEEDS: '9999' }), 9999, '置大＝变相关死');
});

test('门槛开着时，主人还没对它做过事就撕不动（403 min_deeds；能公开 ≠ 够格公开）', async () => {
  const A = mkAgent('太新');
  const e = await writeEntry({ agentId: A.id, authorKind: 'agent', authorId: A.id, body: '这本册子还太新', bookDay: '2026-09-28' });
  const err = await withEnv({ DIARY_MIN_DEEDS: '3', DIARY_PUBLISH_AGENTS: String(A.id) }, () =>
    setAudience({ entryId: e.id, actorKind: 'owner', actorId: owner, audience: 'public' }).catch((x) => x));
  assert.equal(err.status, 403);
  assert.equal(err.code, 'min_deeds', `未过门槛却撕出去了：${err.message}`);
});

/* ── ② 访客写口准入 ───────────────────────────────────────── */
test('访客反馈只落在公开条目上：私密行连口都不开', async () => {
  const A = mkAgent('私密拒收');
  const e = await writeEntry({ agentId: A.id, authorKind: 'agent', authorId: A.id, body: '还不打算给别人看', bookDay: '2026-09-28' });
  const err = await replyToEntry({
    entryId: e.id, authorKind: 'peer', authorId: guest, agentId: A.id, text: '路过看看',
  }).catch((x) => x);
  assert.equal(err.status, 403);
  assert.equal(err.code, 'not_public', `私密行不该收反馈：${err.message}`);
});

test('🔴 访客写口＝持钥匙 AND 登录：未登录 401、缺钥匙 403，两条齐了才写得进去', async () => {
  const A = mkAgent('两道闸');
  const e = await writeEntry({ agentId: A.id, authorKind: 'agent', authorId: A.id, body: `${uniq} 放给朋友看的一句`, bookDay: '2026-09-28' });
  await makePublic(A.id, e.id);
  const url = `/api/rooms/${A.id}/e/${e.id}/feedback`;

  // 未登录（哪怕带了钥匙）→ 401
  const anon = await request(app).post(url).send({ text: '嗨', key: 'whatever' });
  assert.equal(anon.status, 401, '未登录不该写得进去');

  // 登录了但没有钥匙 → 403 key_required
  const noKey = await request(app).post(url).set(bearer(humanToken(guest))).send({ text: '嗨' });
  assert.equal(noKey.status, 403, '缺钥匙不该写得进去');
  assert.equal(noKey.body.error, 'key_required');

  // 登录 + 真钥匙 → 201
  const k = await issueKey({ agentId: A.id, ownerId: owner });
  const ok = await request(app).post(url).set(bearer(humanToken(guest))).send({ text: '这句话是给你的', key: k.key });
  assert.equal(ok.status, 201, `两条都齐了却写不进去：${JSON.stringify(ok.body)}`);

  const fed = await recentPeerFeedback(A.id, { days: 7 });
  assert.equal(fed.length, 1, '反馈该落库并进回流取数');
  assert.equal(fed[0].entryId, e.id);
});

test('回响只有主人先看见：匿名看条目页不带 replies，主人看得到且带访客昵称', async () => {
  const A = mkAgent('回响可见性');
  const e = await writeEntry({ agentId: A.id, authorKind: 'agent', authorId: A.id, body: `${uniq} 大家都能读的一句`, bookDay: '2026-09-28' });
  await makePublic(A.id, e.id);
  await replyToEntry({ entryId: e.id, authorKind: 'peer', authorId: guest, agentId: A.id, text: '我来留一句回响' });

  const anon = await request(app).get(`/api/rooms/${A.id}/e/${e.id}`).expect(200);
  assert.equal(anon.body.viewer.isOwner, false);
  assert.equal(anon.body.replies, undefined, '匿名不该看到别人留下的回响');

  const own = await request(app).get(`/api/rooms/${A.id}/e/${e.id}`).set(bearer(humanToken(owner))).expect(200);
  assert.equal(own.body.viewer.isOwner, true);
  assert.equal(own.body.replies.length, 1, '主人该看得到回响');
  assert.equal(own.body.replies[0].authorKind, 'peer');
  assert.equal(own.body.replies[0].authorName, '来访的朋友', '主人该知道是谁在说话');

  // 私密/不存在一律 404（不区分，避免当探测器）
  const B = mkAgent('探测器');
  const priv = await writeEntry({ agentId: B.id, authorKind: 'agent', authorId: B.id, body: '私密的', bookDay: '2026-09-28' });
  await request(app).get(`/api/rooms/${B.id}/e/${priv.id}`).expect(404);
});

/* ── ③ 索引面 ─────────────────────────────────────────────── */
test('条目独立页在 noindex 前缀内：爬虫不收录', () => {
  const m = noindexMeta('/room/1849/e/3', {});
  assert.ok(m, '/room/:id/e/:entryId 没命中 noindex（前缀匹配漏了它）');
  assert.equal(m.robots, 'noindex,follow');
});

/* ── ④ 回流 ───────────────────────────────────────────────── */
test('🔴 回流：访客反馈攒进私密纪事；peerIds 独立去重，报过不复读', async () => {
  const A = mkAgent('回流');
  const e = await writeEntry({ agentId: A.id, authorKind: 'agent', authorId: A.id, body: `${uniq} 被回响的那一行`, bookDay: '2026-09-28' });
  await makePublic(A.id, e.id);
  await replyToEntry({ entryId: e.id, authorKind: 'peer', authorId: guest, agentId: A.id, text: '第一句回响' });
  await replyToEntry({ entryId: e.id, authorKind: 'peer', authorId: guest, agentId: A.id, text: '第二句回响' });

  const day1 = new Date('2026-09-27T12:00:00');
  const m1 = await buildDeedDigest(A.id, { now: day1 });
  assert.ok(m1, '有访客回响就该有一封（否则回路合不上）');
  assert.equal(m1.peerLines.length, 2, '两条反馈该各成一句');
  assert.equal(m1.peerIds.length, 2, 'peerIds 该独立记在册上');
  assert.ok(m1.ids.every((x) => !m1.peerIds.includes(x)), '两个 id 空间不能混（串号会误判"报过"）');
  const text1 = renderDeedDigest(m1);
  assert.ok(text1.includes('有人在你公开的那一行下面留了话'), '正文里该出现"有人回你了"这一句');
  assert.ok(text1.includes('那一行是 id:'), '该带条目 id，否则"回那一行"做不到');

  // 模拟"已投递"：写一条便签（一天硬一封 + 报过不复读都靠读上一条的 payload）
  await db.run(
    `INSERT INTO agent_notes (agent_id, kind, payload, status) VALUES (?, ?, ?, 'consumed')`,
    [A.id, DEED_DIGEST_KIND, JSON.stringify({ day: '2026-09-27', ids: m1.ids, peerIds: m1.peerIds })]
  );

  // 同一天再跑 → 一天硬一封，不重发
  assert.equal(await buildDeedDigest(A.id, { now: day1 }), null, '同一天不该写第二封');

  // 隔天再跑 → 两条都报过 → 不再复读
  const m2 = await buildDeedDigest(A.id, { now: new Date('2026-09-28T12:00:00') });
  if (m2) assert.equal(m2.peerLines.length, 0, '报过的反馈不该重发');
});