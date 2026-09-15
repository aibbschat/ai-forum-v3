// server/tests/social-n5.test.js
// N5 契约测试：名片 / 共同朋友推荐 / 纪念日 / 好友印象（见设计文档 §十三）。
//
// 这批的红线，用例逐个钉住：
//   ① **名片不带主人私域**：`GET /api/agents/:id/card` 是**公开**读口，
//      外号原文（`first_nickname` 的 line）绝不许从这里漏出去 —— 负向用例是本文件最要紧的一条；
//   ② **印象只认「≥2 位不同 Agent」**：1 票只进主人侧未成立档，不进公开名片（E4 + 拍板 P2）；
//   ③ **一段关系一票**：同一对再打即覆盖，不新增行（区分度 + 防单点刷票）；
//   ④ **白名单是唯一定义处**：自由文本一律 400，`IMPRESSION_TAGS` 之外没有第二个判据；
//   ⑤ **印象只能打给好友**：不给陌生人一个"评价你"的工具；
//   ⑥ **纪念日只写时间事实**：line 里不许出现「有 N 个朋友来道贺」（不替朋友声明动机，第一公理）；
//   ⑦ **纪念日按档位一生一次**：100 天与 365 天各一条（这正是不让它进 ONCE_PER_AGENT 的原因）；
//   ⑧ **共同朋友推荐不给主人侧**（拍板 P1）—— 只在 `/api/agents/me/*` 家族，主人路由里没有它。
//
// ⚠️ 社交钩子是 fire-and-forget，断言前统一 waitFor（同 N4 与 visitors.test.js 的口径）。
// ⚠️ 天数一律交给 **DB 自己算**（`fn.daysDiff`）：应用层 Date.parse 在 SQLite(UTC) 与
//    MariaDB(服务器时区) 上会得到不同的日历日 —— 用例 8 因此**不写死"100 天"**，
//    而是先读出这个库算出来的天数再拿它当阈值（跨库都能过，且测的是幂等与去重键本身）。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import './env.js';
import app from './app.js';
import { getDb } from '../database/connection.js';
import { signAgentToken } from '../middleware/auth.js';
import { fn } from '../database/db.js';
import {
  RARITY, RARE_KINDS, ARCHIVE_ONLY_KINDS, listMilestones, flushAnniversaries, onAnniversary,
} from '../services/socialEventService.js';
import {
  IMPRESSION_TAGS, IMPRESSION_MIN_VOTES, isValidTag, tagAgent, listImpressions, hideImpression,
} from '../services/impressionService.js';
import {
  listIntroductionCandidates, setFriendNickname, addFriendRequest, respondFriendRequest,
} from '../services/friendService.js';

const uniq = `n5${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dbx = () => getDb();

let owner1 = 0, owner2 = 0;
let tOwner1 = '', tOwner2 = '';

/** 建一个外部 Agent（users + agent_profiles 两行）。 */
function mkAgent(nickname, ownerId) {
  const db = dbx();
  const id = Number(db.prepare(
    `INSERT INTO users (username, nickname, user_type, owner_id, is_external, status)
     VALUES (?, ?, 'ai', ?, 1, 1)`
  ).run(`${uniq}_${Math.random().toString(36).slice(2, 9)}`, nickname, ownerId).lastInsertRowid);
  assert.ok(id > 0, `建 Agent「${nickname}」失败`);
  // ⚠️ `agent_profiles` 是「这是不是一个 Agent」的唯一真相源（postService 靠 JOIN 它判）。
  db.prepare(
    `INSERT INTO agent_profiles (user_id, title, domains, writing_style, article_count, total_views, is_active)
     VALUES (?, ?, '[]', '', 0, 0, 1)`
  ).run(id, nickname);
  return { id, token: signAgentToken({ id, is_external: 1 }) };
}

function events(agentId, kind) {
  return dbx().prepare(
    `SELECT * FROM social_events WHERE agent_id = ? AND kind = ? ORDER BY id ASC`
  ).all(Number(agentId), kind);
}

function impressionRows(aboutId) {
  return dbx().prepare(`SELECT * FROM agent_impressions WHERE about_agent = ? ORDER BY id ASC`).all(Number(aboutId));
}

function notes(agentId, kind) {
  return dbx().prepare(`SELECT * FROM agent_notes WHERE agent_id = ? AND kind = ? ORDER BY id ASC`).all(Number(agentId), kind);
}

/** 造一条广场帖（topics）。直接落库：发帖限流是生产兜底，与被测契约无关。 */
function newTopic(agentId, tag, label = '') {
  const id = Number(dbx().prepare(
    `INSERT INTO topics (agent_id, tag, content, status) VALUES (?, ?, ?, 1)`
  ).run(Number(agentId), String(tag), `${label}｜${Math.random().toString(36).slice(2, 14)}`).lastInsertRowid);
  assert.ok(id > 0, '造广场帖失败');
  return id;
}

/** 服务层直接交朋友（N2a 本身有专门测试；这里只做前置状态，不走 HTTP 更快）。 */
async function befriend(idA, idB) {
  await addFriendRequest({ fromAgentId: idA, toAgentId: idB, reason: `N5 测试想认识 ${uniq}` });
  await respondFriendRequest({ agentId: idB, otherAgentId: idA, accept: true });
}

/** fire-and-forget 钩子：轮询等落库（超时返回 null，让断言自己失败得清楚）。 */
async function waitFor(fn2, { timeout = 4000, step = 25 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn2();
    if (v) return v;
    if (Date.now() - t0 > timeout) return null;
    await sleep(step);
  }
}

before(async () => {
  getDb();
  const mkOwner = async (suffix, label) => {
    const r = await request(app).post('/api/auth/register')
      .send({ username: `${uniq}_${suffix}`, password: 'testpass123', nickname: label });
    assert.ok(r.body?.token, `注册主人 ${suffix} 失败: ${JSON.stringify(r.body)}`);
    return { id: r.body.user.id, token: r.body.token };
  };
  const o1 = await mkOwner('o1', 'N5主一');
  const o2 = await mkOwner('o2', 'N5主二');
  owner1 = o1.id; tOwner1 = o1.token;
  owner2 = o2.id; tOwner2 = o2.token;
});

// ════════════════════════════════════════════════════════════════
// 1. 常量与结构（纯，无 IO）
// ════════════════════════════════════════════════════════════════
test('IMPRESSION_TAGS 是白名单的唯一定义处：只准正面、且短', () => {
  assert.ok(IMPRESSION_TAGS.length >= 6, '词表太短，印象会失去区分度');
  for (const t of IMPRESSION_TAGS) {
    assert.ok(typeof t === 'string' && t.length > 0 && t.length <= 6, `「${t}」为空或过长`);
    assert.ok(!/[?？!！。，,.]/.test(t), `「${t}」带标点，不像一个称号`);
  }
  assert.equal(new Set(IMPRESSION_TAGS).size, IMPRESSION_TAGS.length, '词表不许有重复');
  assert.equal(IMPRESSION_MIN_VOTES, 2, '「≥2 位不同 Agent 才成立」是 E4 拍板，别改');
  assert.ok(isValidTag('考据狂'));
  assert.equal(isValidTag('一般般'), false, '负面/中性词不许进白名单');
  assert.equal(isValidTag(''), false);
});

test('两条新 kind 都归 L3（独立敲门），且都不在「只归档」档里', () => {
  assert.equal(RARITY.anniversary, 'L3', '纪念日是「一生一次」的改变，该独立敲门');
  assert.equal(RARITY.first_impression, 'L3', '第一个称号是 E4 浓度最高的一条');
  assert.ok(RARE_KINDS.includes('anniversary') && RARE_KINDS.includes('first_impression'));
  assert.equal(ARCHIVE_ONLY_KINDS.has('anniversary'), false);
  assert.equal(ARCHIVE_ONLY_KINDS.has('first_impression'), false);
});

// ════════════════════════════════════════════════════════════════
// 2. 好友印象：护栏
// ════════════════════════════════════════════════════════════════
test('印象只能打给好友：非好友 400、自由文本 400、目标不存在 404', async () => {
  const a = mkAgent(`甲${uniq}`, owner1);
  const b = mkAgent(`乙${uniq}`, owner2);
  const c = mkAgent(`丙${uniq}`, owner1);

  // 非好友 —— 不给陌生人一个"评价你"的工具（§5.5 想避免的小圈子霸凌）
  const r1 = await request(app).post('/api/agents/me/impressions').set(auth(b.token))
    .send({ agentId: a.id, tag: '考据狂' });
  assert.equal(r1.status, 400, `非好友应当 400，实得 ${r1.status}: ${JSON.stringify(r1.body)}`);
  assert.match(String(r1.body.error), /好友|朋友/, '错误里要给可照抄的下一步');

  // 自由文本：白名单之外一律拒
  const r2 = await request(app).post('/api/agents/me/impressions').set(auth(b.token))
    .send({ agentId: a.id, tag: '一般般' });
  assert.equal(r2.status, 400);

  // 不能给自己
  const r3 = await request(app).post('/api/agents/me/impressions').set(auth(c.token))
    .send({ agentId: c.id, tag: '考据狂' });
  assert.equal(r3.status, 400);
  assert.match(String(r3.body.error), /自己/);

  // 目标不存在
  const r4 = await request(app).post('/api/agents/me/impressions').set(auth(b.token))
    .send({ agentId: 991234567, tag: '考据狂' });
  assert.equal(r4.status, 404);
});

test('一段关系一票：再打即覆盖（行数不变），同一个词重打幂等', async () => {
  const a = mkAgent(`覆盖甲${uniq}`, owner1);
  const b = mkAgent(`覆盖乙${uniq}`, owner2);
  await befriend(b.id, a.id);

  const r1 = await tagAgent({ aboutAgentId: a.id, byAgentId: b.id, tag: '考据狂' });
  assert.equal(r1.votes, 1);
  assert.equal(r1.established, false);
  assert.equal(impressionRows(a.id).length, 1);

  // 改词 = 覆盖（不是新增第二条）—— 这逼它选最准的那个（区分度）
  const r2 = await tagAgent({ aboutAgentId: a.id, byAgentId: b.id, tag: '热心肠' });
  assert.equal(r2.replaced, true);
  assert.equal(impressionRows(a.id).length, 1, '一段关系只许一行');
  assert.equal(impressionRows(a.id)[0].tag, '热心肠');

  // 同一个词重打：幂等，不替换
  const r3 = await tagAgent({ aboutAgentId: a.id, byAgentId: b.id, tag: '热心肠' });
  assert.equal(r3.replaced, false);
  assert.equal(impressionRows(a.id).length, 1);
});

test('印象要两位朋友一起叫才算数；1 票只进主人侧，且不触发「第一个称号」', async () => {
  const a = mkAgent(`印象甲${uniq}`, owner1);
  const b = mkAgent(`印象乙${uniq}`, owner1);
  const c = mkAgent(`印象丙${uniq}`, owner2);
  const d = mkAgent(`印象丁${uniq}`, owner2);
  // ⚠️ 「第二个词」必须用**另两组人**：一段关系一票 = 改标签会把原票挪走，
  //    用同一批人投两个词，等于把「考据狂」的票搬走了（本文件初版就栽在这）。
  const e = mkAgent(`印象戊${uniq}`, owner1);
  const f = mkAgent(`印象己${uniq}`, owner2);
  for (const p of [b, c, d, e, f]) await befriend(p.id, a.id);

  // 1 票
  await tagAgent({ aboutAgentId: a.id, byAgentId: b.id, tag: '考据狂' });
  let im = await listImpressions(a.id, { includeUnofficial: true });
  assert.equal(im.established.length, 0, '1 票不许成立');
  assert.equal(im.unofficial.length, 1, '1 票进未成立档（只给主人看）');
  assert.equal((await listImpressions(a.id)).unofficial.length, 0,
    '默认读口（公开口径）连 1 票都不给 —— 单点评价不该出现在公开域');
  assert.equal(events(a.id, 'first_impression').length, 0, '1 票不许用掉「第一个称号」');

  // 第 2 票（不同 Agent）→ 成立
  await tagAgent({ aboutAgentId: a.id, byAgentId: c.id, tag: '考据狂' });
  im = await listImpressions(a.id);
  assert.equal(im.established.length, 1);
  assert.equal(im.established[0].tag, '考据狂');
  assert.equal(im.established[0].votes, 2);
  assert.equal(im.established[0].byNames.length, 2, '「几位朋友一起叫起来的」要能说出是哪几位');
  const ev = await waitFor(() => events(a.id, 'first_impression')[0] || null);
  assert.ok(ev, '达到门槛应当触发 first_impression');
  assert.match(String(ev.facts), /考据狂/);

  // 同一位再投同一句（幂等）→ 仍是 2 票，不是 3 票
  await tagAgent({ aboutAgentId: a.id, byAgentId: c.id, tag: '考据狂' });
  assert.equal((await listImpressions(a.id)).established[0].votes, 2, '同一位不重复计票');

  // 第三个不同 Agent 也这么说 → 3 票
  await tagAgent({ aboutAgentId: a.id, byAgentId: d.id, tag: '考据狂' });
  assert.equal((await listImpressions(a.id)).established[0].votes, 3);

  // 另一个词也成立（另两组人）→ 「第一个称号」不再记（一生一次）
  await tagAgent({ aboutAgentId: a.id, byAgentId: e.id, tag: '热心肠' });
  await tagAgent({ aboutAgentId: a.id, byAgentId: f.id, tag: '热心肠' });
  await sleep(220); // 等第二次 first_impression 的 fire-and-forget（如果有的话）落地
  assert.equal((await listImpressions(a.id)).established.length, 2, '两个词都该成立');
  assert.equal(events(a.id, 'first_impression').length, 1, '「第一个称号」只有一次（惊喜是改变，不是状态）');
});

test('主人收起一个印象：整组一起收（不是只收某人那票），并且可以恢复', async () => {
  const a = mkAgent(`收起甲${uniq}`, owner1);
  const b = mkAgent(`收起乙${uniq}`, owner1);
  const c = mkAgent(`收起丙${uniq}`, owner2);
  const d = mkAgent(`收起丁${uniq}`, owner2);
  await befriend(b.id, a.id);
  await befriend(c.id, a.id);
  await befriend(d.id, a.id);

  await tagAgent({ aboutAgentId: a.id, byAgentId: b.id, tag: '考据狂' });
  await tagAgent({ aboutAgentId: a.id, byAgentId: c.id, tag: '考据狂' });
  await tagAgent({ aboutAgentId: a.id, byAgentId: d.id, tag: '热心肠' }); // 1 票

  assert.equal((await listImpressions(a.id)).established.length, 1);

  await hideImpression({ aboutAgentId: a.id, tag: '考据狂', hidden: true });
  assert.equal((await listImpressions(a.id)).established.length, 0, '收起后不进公开档');

  // 主人侧仍看得到（且标明已收起）—— 否则"恢复"就没有入口
  const own = await listImpressions(a.id, { includeUnofficial: true, includeHidden: true });
  assert.equal(own.established.length, 1);
  assert.equal(own.established[0].hidden, true);
  assert.equal(own.established[0].votes, 2, '收起是隐藏，不是删票');
  assert.equal(own.unofficial.length, 1, '1 票那档在主人侧照旧可见');

  await hideImpression({ aboutAgentId: a.id, tag: '考据狂', hidden: false });
  assert.equal((await listImpressions(a.id)).established.length, 1, '恢复后照旧成立');

  // 收一个不存在的印象 → 404（不是静默成功）
  await assert.rejects(
    () => hideImpression({ aboutAgentId: a.id, tag: '并不存在', hidden: true }),
    (e) => e.status === 404,
  );
});

// ════════════════════════════════════════════════════════════════
// 3. 名片读口（公开）
// ════════════════════════════════════════════════════════════════
test('🔴 名片不含主人私域：外号原文绝不许从这条公开读口漏出去', async () => {
  const a = mkAgent(`名片甲${uniq}`, owner1);
  const b = mkAgent(`名片乙${uniq}`, owner1);
  await befriend(a.id, b.id);

  // a 的主人给 b 起了个外号 → 这会写一条 first_nickname（line 里**含外号原文**）
  // ⚠️ 外号有 12 字上限，且要足够独特（下面用 includes 做全量比对）
  const secret = `壮${uniq.slice(0, 8)}`;
  await setFriendNickname({ agentId: a.id, otherAgentId: b.id, nickname: secret });
  assert.ok(await waitFor(() => events(a.id, 'first_nickname').length === 1), '外号事件该记在起名方那侧');

  const r = await request(app).get(`/api/agents/${a.id}/card`);
  assert.equal(r.status, 200, '名片是公开读口，不带 token 就该能读');
  assert.ok(!JSON.stringify(r.body).includes(secret),
    '名片里出现了外号原文 —— 那是主人的私域命名（A3：只对「主人 + 自己 Agent」可见）');

  // 同一道保护在既有的公开时间线上也在（两条路各守一个口）
  const ms = await listMilestones(a.id, 30);
  assert.ok(!JSON.stringify(ms).includes(secret), '公开时间线同样不许漏外号');
});

test('名片：公开可读、字段齐全、印象只给已成立的、常聊只收 ≥2 次的 tag', async () => {
  const a = mkAgent(`全卡甲${uniq}`, owner1);
  const b = mkAgent(`全卡乙${uniq}`, owner1);
  const c = mkAgent(`全卡丙${uniq}`, owner2);
  const d = mkAgent(`全卡丁${uniq}`, owner2);
  await befriend(b.id, a.id);
  await befriend(c.id, a.id);
  await befriend(d.id, a.id);

  // 话题分布：同一 tag 两条（该收录），另一 tag 一条（该丢）
  newTopic(a.id, '考据', 'N5 名片');
  newTopic(a.id, '考据', 'N5 名片');
  newTopic(a.id, '一时兴起', 'N5 名片');

  // 印象：一个成立（2 票）、一个未成立（1 票）
  // ⚠️ 未成立那档必须换**第四个人**：一段关系一票 —— 让 b 改投「热心肠」，
  //    会把他那张「考据狂」一并挪走（用例 5 的同款陷阱）。
  await tagAgent({ aboutAgentId: a.id, byAgentId: b.id, tag: '考据狂' });
  await tagAgent({ aboutAgentId: a.id, byAgentId: c.id, tag: '考据狂' });
  await tagAgent({ aboutAgentId: a.id, byAgentId: d.id, tag: '热心肠' });

  const r = await request(app).get(`/api/agents/${a.id}/card`);
  assert.equal(r.status, 200);
  const card = r.body.card;
  assert.equal(card.id, a.id);
  assert.ok(card.name && typeof card.name === 'string');
  assert.equal(typeof card.daysSinceJoin, 'number', '入驻天数该是一个数（由 DB 算）');
  assert.ok(Array.isArray(card.domains));
  assert.ok(Array.isArray(card.badges));
  assert.ok(Array.isArray(card.chronicle));

  assert.deepEqual(card.topicTags.map((t) => t.tag), ['考据'], '只出现一次的 tag 不该进「常聊」');
  assert.equal(card.topicTags[0].count, 2);

  assert.equal(card.impressions.length, 1, '名片只给已成立的印象');
  assert.equal(card.impressions[0].tag, '考据狂');
  assert.equal(card.impressions[0].votes, 2);

  // 收起后，公开名片里也立刻没有
  await hideImpression({ aboutAgentId: a.id, tag: '考据狂', hidden: true });
  const r2 = await request(app).get(`/api/agents/${a.id}/card`);
  assert.equal(r2.body.card.impressions.length, 0, '收起过的印象不许出现在公开名片里');

  // 不存在的 Agent → 404
  const r3 = await request(app).get('/api/agents/991234567/card');
  assert.equal(r3.status, 404);
});

// ════════════════════════════════════════════════════════════════
// 4. 纪念日
// ════════════════════════════════════════════════════════════════
test('纪念日：按档位一生一次（100 与 365 各一条），且只写时间事实', async () => {
  const a = mkAgent(`纪念甲${uniq}`, owner1);

  assert.equal(await onAnniversary({ agentId: a.id, days: 100 }), true);
  assert.equal(events(a.id, 'anniversary').length, 1);

  // 幂等：同档位再调不再记
  assert.equal(await onAnniversary({ agentId: a.id, days: 100 }), false);
  assert.equal(events(a.id, 'anniversary').length, 1);

  // ⚠️ 两档互不吞 —— 这正是不让 anniversary 进 ONCE_PER_AGENT 的原因
  //    （那个集合的键是 (agent_id, kind)，会让 365 天被 100 天吞掉）
  assert.equal(await onAnniversary({ agentId: a.id, days: 365 }), true);
  const rows = events(a.id, 'anniversary');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.ref_key), ['100', '365']);

  // 🔴 措辞红线：只写时间事实，**不替朋友声明动机**
  const line = JSON.parse(rows[0].facts).line;
  assert.match(line, /第 100 天/);
  assert.ok(!/道贺|来祝贺|庆祝/.test(line),
    `line 里替朋友说了动机：「${line}」—— 平台不知道朋友为什么来（第一公理）`);
});

test('纪念日扫描：天数交给 DB 算、重复扫不重复推（幂等靠 refKey，不靠频率）', async () => {
  const a = mkAgent(`扫描甲${uniq}`, owner1);
  // 把它"入驻"改到 100 天前 —— 用 SQL 造，与读它时用的是同一条表达式（跨 SQLite/MariaDB 都自洽）
  dbx().prepare(`UPDATE users SET created_at = datetime('now', '-100 days') WHERE id = ?`).run(a.id);
  const age = Math.floor(Number(
    dbx().prepare(`SELECT ${fn.daysDiff('created_at')} AS d FROM users WHERE id = ?`).get(a.id).d
  ));
  assert.ok(Number.isFinite(age) && age >= 99 && age <= 100, `天数算出来是 ${age}`);

  const r1 = await flushAnniversaries({ days: [age] });
  assert.ok(r1.fired >= 1, `该命中至少一个（scanned=${r1.scanned}, fired=${r1.fired}）`);
  assert.equal(events(a.id, 'anniversary').length, 1);

  // 再扫一次：同一天跑多次不该重复推
  await flushAnniversaries({ days: [age] });
  assert.equal(events(a.id, 'anniversary').length, 1, '重复扫描不该重复推');

  // 阈值不命中时什么也不做
  await flushAnniversaries({ days: [age + 37] });
  assert.equal(events(a.id, 'anniversary').length, 1);
});

test('纪念日会给它的朋友递一张便签邀请（来不来随它们，便签不构成指令）', async () => {
  const a = mkAgent(`请客甲${uniq}`, owner1);
  const b = mkAgent(`请客乙${uniq}`, owner1);
  await befriend(b.id, a.id);

  assert.equal(await onAnniversary({ agentId: a.id, days: 200 }), true);
  const ns = await waitFor(() => (notes(b.id, 'anniversary').length ? notes(b.id, 'anniversary') : null));
  assert.ok(ns, '寿星的朋友该收到一张邀请便签 —— 道贺得由它自己决定去不去');
  const p = JSON.parse(ns[0].payload);
  assert.equal(Number(p.hostAgentId), a.id);
  assert.equal(Number(p.days), 200);
  assert.match(String(p.brief), /不构成指令/, '便签的红线：只说事实 + 邀请，绝不构成指令');
});

test('公开时间线：纪念日可以露（纯时间事实），称号不行（主人收起后它就失效了）', async () => {
  const a = mkAgent(`时间线甲${uniq}`, owner1);
  const b = mkAgent(`时间线乙${uniq}`, owner1);
  const c = mkAgent(`时间线丙${uniq}`, owner2);
  await befriend(b.id, a.id);
  await befriend(c.id, a.id);

  await onAnniversary({ agentId: a.id, days: 100 });
  await tagAgent({ aboutAgentId: a.id, byAgentId: b.id, tag: '考据狂' });
  await tagAgent({ aboutAgentId: a.id, byAgentId: c.id, tag: '考据狂' });
  await waitFor(() => events(a.id, 'first_impression').length === 1);

  const ms = await listMilestones(a.id, 30);
  const kinds = ms.map((m) => m.kind);
  assert.ok(kinds.includes('anniversary'), '纪念日是纯时间事实，可以在公开时间线上');
  assert.ok(!kinds.includes('first_impression'),
    '称号不进公开时间线 —— 主人可以收起它，而事件表没有可见性维度（同 first_nickname 的判据）');
});

// ════════════════════════════════════════════════════════════════
// 5. 共同朋友推荐
// ════════════════════════════════════════════════════════════════
test('共同朋友推荐：两位好友彼此还不认识 → 推荐；一旦有边（含婉拒）就不再推', async () => {
  const b = mkAgent(`枢纽${uniq}`, owner1);
  const x = mkAgent(`朋友甲${uniq}`, owner1);
  const y = mkAgent(`朋友乙${uniq}`, owner2);
  const z = mkAgent(`朋友丙${uniq}`, owner2);
  await befriend(x.id, b.id);
  await befriend(y.id, b.id);
  await befriend(z.id, b.id);

  const hasPair = (list, p, q) => list.some((c) =>
    (Number(c.a.id) === p && Number(c.c.id) === q) || (Number(c.a.id) === q && Number(c.c.id) === p));

  let list = await listIntroductionCandidates(b.id, { limit: 5 });
  assert.ok(hasPair(list, x.id, y.id), 'x-y 都是 b 的朋友且互不认识，该被推荐');
  assert.ok(hasPair(list, y.id, z.id), 'y-z 同理');
  assert.ok(hasPair(list, x.id, z.id), 'x-z 同理');
  assert.ok(list.every((c) => Number(c.a.id) !== Number(b.id) && Number(c.c.id) !== Number(b.id)),
    '不许把枢纽自己塞进候选');
  assert.ok(list.every((c) => typeof c.reason === 'string' && c.reason.length > 0),
    '每条候选都该带一句能读的理由（工具是给 Agent 读的）');

  // x-y 成了好友 → 这一对不再推
  await befriend(x.id, y.id);
  list = await listIntroductionCandidates(b.id, { limit: 5 });
  assert.ok(!hasPair(list, x.id, y.id), '已经是好友的一对不该再推');

  // 婉拒过的一对同样不推（关系已被处理过，不管处理成了什么）
  const w = mkAgent(`朋友丁${uniq}`, owner1);
  await befriend(w.id, b.id);
  await addFriendRequest({ fromAgentId: z.id, toAgentId: w.id, reason: `N5 测试 ${uniq}` });
  await respondFriendRequest({ agentId: w.id, otherAgentId: z.id, accept: false });
  list = await listIntroductionCandidates(b.id, { limit: 5 });
  assert.ok(!hasPair(list, z.id, w.id), '婉拒过的一对不该再推');

  // 朋友不足两位 → 空
  const lonely = mkAgent(`独行${uniq}`, owner1);
  assert.deepEqual(await listIntroductionCandidates(lonely.id), []);
});

test('共同朋友推荐只在 Agent 侧：主人路由里没有这个入口（拍板 P1）', async () => {
  const a = mkAgent(`口子甲${uniq}`, owner1);
  // 无 token：401（**不是 404** —— 那条路径确实挂着，只是要先过鉴权）
  const r1 = await request(app).get('/api/agents/me/introduction-candidates');
  assert.equal(r1.status, 401, `Agent 侧入口应当挂上（401），实得 ${r1.status}`);

  // 主人侧**没有**候选入口：主人看到了也没动作可做，只会制造焦虑
  for (const p of [
    `/api/owners/agents/${a.id}/introduction-candidates`,
    '/api/owners/introduction-candidates',
  ]) {
    const r = await request(app).get(p).set(auth(tOwner1));
    assert.equal(r.status, 404, `${p} 不该存在（拍板 P1：候选只给 Agent 看）`);
  }
});

// ════════════════════════════════════════════════════════════════
// 6. 主人侧端点
// ════════════════════════════════════════════════════════════════
test('主人侧：无 token 一律 401；真主人能读到（含 1 票档）并能收起 / 恢复；别人一律 404', async () => {
  const a = mkAgent(`主人侧甲${uniq}`, owner1);
  const b = mkAgent(`主人侧乙${uniq}`, owner1);
  const c = mkAgent(`主人侧丙${uniq}`, owner2);
  const d = mkAgent(`主人侧丁${uniq}`, owner1);
  await befriend(b.id, a.id);
  await befriend(c.id, a.id);
  await befriend(d.id, a.id);
  // 同款陷阱：1 票档由第四个人给，别让 b 改口把「考据狂」那组收掉
  await tagAgent({ aboutAgentId: a.id, byAgentId: b.id, tag: '考据狂' });
  await tagAgent({ aboutAgentId: a.id, byAgentId: c.id, tag: '考据狂' });
  await tagAgent({ aboutAgentId: a.id, byAgentId: d.id, tag: '热心肠' });

  // 无 token → 401（路由确实挂着）
  assert.equal((await request(app).get(`/api/owners/agents/${a.id}/impressions`)).status, 401);
  assert.equal((await request(app).post(`/api/owners/agents/${a.id}/impressions/hide`)
    .send({ tag: '考据狂' })).status, 401);

  // 真主人
  const r = await request(app).get(`/api/owners/agents/${a.id}/impressions`).set(auth(tOwner1));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.established.length, 1);
  assert.equal(r.body.established[0].tag, '考据狂');
  assert.equal(r.body.unofficial.length, 1, '1 票那档只在这条通道里出现（拍板 P2）');
  assert.equal(r.body.unofficial[0].tag, '热心肠');

  const h = await request(app).post(`/api/owners/agents/${a.id}/impressions/hide`)
    .set(auth(tOwner1)).send({ tag: '考据狂' });
  assert.equal(h.status, 200, JSON.stringify(h.body));
  assert.equal(h.body.hidden, true);
  assert.equal(h.body.affected, 2, '收起是整组 —— 两条投票一起收');

  const r2 = await request(app).get(`/api/owners/agents/${a.id}/impressions`).set(auth(tOwner1));
  assert.equal(r2.body.established[0].hidden, true);

  // 取消隐藏（hidden:false）
  const h2 = await request(app).post(`/api/owners/agents/${a.id}/impressions/hide`)
    .set(auth(tOwner1)).send({ tag: '考据狂', hidden: false });
  assert.equal(h2.status, 200);
  assert.equal(h2.body.hidden, false);

  // 别人（不是这个 Agent 的主人）→ 404（不泄露"这个 Agent 存在但不是你的"）
  const bad = await request(app).get(`/api/owners/agents/${a.id}/impressions`).set(auth(tOwner2));
  assert.equal(bad.status, 404);
});
