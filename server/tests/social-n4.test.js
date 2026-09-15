// server/tests/social-n4.test.js
// N4 契约测试：稀有度分级 / L3「第一次」独立推 + 同日合并 / 教子周报 / 三个新 kind / 第五动作（§十二）。
//
// 这批的红线，用例逐个钉住：
//   ① **分级只有一张表**：`RARITY` 是分级的唯一定义处，`ARCHIVE_ONLY_KINDS` 由它派生 ——
//      想改分级只能改这张表，改别处会被这里拦下；
//   ② **「一生一次」真的是「一生一次」**：`ONCE_PER_AGENT` 只归 `ref_key` 时的旧 bug
//      （first_guest 变成"每位客人一条"、first_clap 变成"每帖一条"）不许回来；
//   ③ **L3 独立推、同日合并成一条**：新 Agent 入驻首周不许把"稀有"变成"吵闹"（拍板 P1）；
//   ④ **L1 只归档**：拍一拍之流绝不进任何推送（E5）；
//   ⑤ **教子周报的措辞红线**：标题固定「它这几天的日子」——给内容、**不报数量**，
//      卡片数据里不许出现「错过 / 未读 / 没告诉你」这类让人内疚的口径（E2③）；
//   ⑥ **`spoken_of` 只扫附议，绝不扫信使/私信正文**（§12.2 红线）——负向用例是本批最要紧的一条；
//   ⑦ **`first_introduce` 只认"它真去了"**：主人递了条子不算，得被介绍的那位收到它的第一个社交痕迹；
//   ⑧ **`first_apology` 的三道过滤各自可隔离**：只认错 / 只反驳过 / 帖里没有别的 AI，各缺一条都不记。
//
// ⚠️ 所有社交钩子都是 fire-and-forget（趣味层绝不允许拖垮发布主链路），所以断言前统一 waitFor ——
//    不是测试技巧，是**如实反映**它的异步本质（同 visitors.test.js 的口径）。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import './env.js';
import app from './app.js';
import { getDb } from '../database/connection.js';
import { signAgentToken } from '../middleware/auth.js';
import {
  RARITY, RARE_KINDS, ARCHIVE_ONLY_KINDS, APOLOGY_RE, REBUT_RE, listOwnerNotes,
  listAgentEventsForOwner, listMilestones, flushWeeklyReports,
} from '../services/socialEventService.js';
import { areFriends } from '../services/friendService.js';

const uniq = `n4${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

let owner1 = 0, owner2 = 0, owner3 = 0, owner4 = 0, owner5 = 0;
let tOwner1 = '', tOwner2 = '';
let A = 0, B = 0, C = 0, D = 0, E = 0, F = 0, G = 0, DAN = 0;
let tA = '', tB = '', tC = '', tD = '', tE = '', tF = '', tG = '', tDAN = '';
const nick = {};   // id → nickname

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function newAgent(nickname, ownerId) {
  const dbx = getDb();
  const id = Number(dbx.prepare(
    `INSERT INTO users (username, nickname, user_type, owner_id, is_external, status)
     VALUES (?, ?, 'ai', ?, 1, 1)`
  ).run(`${uniq}_${Math.random().toString(36).slice(2, 9)}`, nickname, ownerId).lastInsertRowid);
  assert.ok(id > 0, `建 Agent「${nickname}」失败`);
  // ⚠️ `agent_profiles` 是「这是不是一个 Agent」的**唯一真相源**（postService 就靠它 JOIN）——
  //    只插 users 的话，发帖会 400 unknown_agent。
  dbx.prepare(
    `INSERT INTO agent_profiles (user_id, title, domains, writing_style, article_count, total_views, is_active)
     VALUES (?, ?, '[]', '', 0, 0, 1)`
  ).run(id, nickname);
  nick[id] = nickname;
  return id;
}

function events(agentId, kind) {
  return getDb().prepare(
    `SELECT * FROM social_events WHERE agent_id = ? AND kind = ? ORDER BY id ASC`
  ).all(agentId, kind);
}

/** 某主人收到的社交通知（可按 action 过滤：digest / rare / weekly / letter）。 */
function socialNotifs(ownerId, action = null) {
  return getDb().prepare(
    `SELECT id, extra, is_read, created_at FROM notifications
      WHERE user_id = ? AND type = 'social_report' ORDER BY id ASC`
  ).all(ownerId)
    .map((r) => ({ ...r, x: JSON.parse(r.extra || '{}') }))
    .filter((r) => !action || r.x.action === action);
}

/** fire-and-forget 钩子：轮询等它落库（超时返回 null，让断言自己失败得清楚）。 */
async function waitFor(fn, { timeout = 4000, step = 25 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) return null;
    await sleep(step);
  }
}

/**
 * 造一条**广场帖**（topics 表）。
 *
 * 直接落库，而不是走 `POST /api/plaza/topics` —— 发帖有「同一 Agent 间隔 300 秒」的防刷限流，
 * 而本文件需要同一个 Agent 反复造场域（那不是被测对象，只是舞台）。
 * 评论一律仍走真接口：社交钩子挂在评论通路上，那才是被测的东西。
 *
 * ⚠️ 也别用 `POST /api/agents/posts` —— 那落的是 `posts`（长文），而社交层的 ref_type 是 `topic`、
 *    评论落 `comments.topic_id`、鼓掌打 `plaza_claps.topic_id`。混用会得到一堆
 *    「事件记不上 / topic_not_found」的假失败（本文件初版就栽在这）。
 */
function newTopic(agentId, label) {
  const id = Number(getDb().prepare(
    `INSERT INTO topics (agent_id, tag, content, status) VALUES (?, '测试', ?, 1)`
  ).run(Number(agentId), `${label}｜${Math.random().toString(36).slice(2, 14)}`).lastInsertRowid);
  assert.ok(id > 0, '造广场帖失败');
  return id;
}

function comment(agentToken, topicId, content) {
  return request(app).post(`/api/plaza/topics/${topicId}/comments`)
    .set(auth(agentToken)).send({ content });
}

async function befriend(fromId, tFrom, toId, tTo, reason = '想认识一下') {
  const r1 = await request(app).post('/api/agents/me/friends')
    .set(auth(tFrom)).send({ agentId: toId, reason });
  assert.ok(r1.status < 400, `申请失败: ${JSON.stringify(r1.body)}`);
  const r2 = await request(app).post(`/api/agents/me/friends/${fromId}/respond`)
    .set(auth(tTo)).send({ accept: true });
  assert.ok(r2.status < 400, `接受失败: ${JSON.stringify(r2.body)}`);
}

/** 幂等的「确保是好友」：信使有好友门，用例之间不该靠执行顺序互相喂前置状态。 */
async function ensureFriends(fromId, tFrom, toId, tTo) {
  if (await areFriends(fromId, toId)) return;
  await befriend(fromId, tFrom, toId, tTo, `想认识一下 ${uniq}`);
}

before(async () => {
  getDb();
  const mkOwner = async (suffix, label) => {
    const r = await request(app).post('/api/auth/register')
      .send({ username: `${uniq}_${suffix}`, password: 'testpass123', nickname: label });
    assert.ok(r.body?.token, `注册主人 ${suffix} 失败: ${JSON.stringify(r.body)}`);
    return { id: r.body.user.id, token: r.body.token };
  };
  const o1 = await mkOwner('o1', 'N4主一');
  const o2 = await mkOwner('o2', 'N4主二');
  const o3 = await mkOwner('o3', 'N4主三');
  const o4 = await mkOwner('o4', 'N4主四');
  const o5 = await mkOwner('o5', 'N4主五');
  owner1 = o1.id; tOwner1 = o1.token;
  owner2 = o2.id; tOwner2 = o2.token;
  owner3 = o3.id;
  owner4 = o4.id;
  owner5 = o5.id;

  // 昵称一律带随机尾巴：`spoken_of` 做的是子串匹配，昵称若取得太普通，
  // 会被附议正文里无关的字撞上 —— 那是测试自身的坑，不是产品的。
  A = newAgent(`阿甲${uniq}`, owner1); tA = signAgentToken({ id: A, is_external: 1 });
  B = newAgent(`小乙${uniq}`, owner1); tB = signAgentToken({ id: B, is_external: 1 });
  C = newAgent(`阿丙${uniq}`, owner2); tC = signAgentToken({ id: C, is_external: 1 });
  D = newAgent(`小丁${uniq}`, owner2); tD = signAgentToken({ id: D, is_external: 1 });
  E = newAgent(`阿戊${uniq}`, owner3); tE = signAgentToken({ id: E, is_external: 1 });
  DAN = newAgent('单', owner2); tDAN = signAgentToken({ id: DAN, is_external: 1 });
});

// ════════════════════════════════════════════════════════════════
// 1. 分级表自身的一致性（纯常量，无 IO）
// ════════════════════════════════════════════════════════════════
test('RARITY 是分级的唯一定义处：三档互斥且穷尽，派生常量与它不漂移', () => {
  const levels = new Set(Object.values(RARITY));
  assert.deepEqual([...levels].sort(), ['L1', 'L2', 'L3'], 'RARITY 只许有 L1/L2/L3 三档');

  const l1 = Object.entries(RARITY).filter(([, r]) => r === 'L1').map(([k]) => k).sort();
  const l3 = Object.entries(RARITY).filter(([, r]) => r === 'L3').map(([k]) => k).sort();
  assert.deepEqual([...ARCHIVE_ONLY_KINDS].sort(), l1, 'ARCHIVE_ONLY_KINDS 必须由 RARITY 的 L1 派生');
  assert.deepEqual([...RARE_KINDS].sort(), l3, 'RARE_KINDS 必须由 RARITY 的 L3 派生');

  // 钉死成员：改分级时这里会响，逼改的人回来看一眼设计文档 §12.4。
  assert.deepEqual(l1, ['first_nudge', 'nudged', 'visited'],
    'L1（只归档）= visited / nudged / first_nudge —— 拍一拍与日常接话是噪声，不配推送（E5）');
  for (const k of ['first_friend', 'first_courier', 'first_nickname', 'first_introduce', 'first_apology']) {
    assert.equal(RARITY[k], 'L3', `${k} 是一生一次的「改变」，该独立敲门`);
  }
  // 可能反复发生的交情类不许进 L3（否则「独立敲门」会退化成订阅号）
  for (const k of ['courier_exchanged', 'reunion', 'spoken_of']) {
    assert.equal(RARITY[k], 'L2', `${k} 可能反复发生，应进每日聚合（L2）而不是独立推`);
  }
});

// ════════════════════════════════════════════════════════════════
// 2. 「一生一次」的语义（N4 修的既有 bug）
// ════════════════════════════════════════════════════════════════
test('first_guest 一生一次：第二位客人不再记，且行里留的仍是第一位（插入不归零）', async () => {
  const p1 = newTopic(A, `N4甲的第一篇 ${uniq}`);

  // B 是第一位客人（评论），这同时是 A 的 first_reply
  const r1 = await comment(tB, p1, `我不同意这个说法，史料上讲不通。${uniq}`);
  assert.ok(r1.status < 400, `评论失败: ${JSON.stringify(r1.body)}`);
  assert.ok(await waitFor(() => events(A, 'first_guest').length === 1 && 'ok'), 'A 应有 first_guest');

  // C 是第二位客人 —— first_guest 必须仍是 1 条
  const r2 = await comment(tC, p1, `补一条材料，供参考。${uniq}`);
  assert.ok(r2.status < 400);
  await sleep(250);

  const gg = events(A, 'first_guest');
  assert.equal(gg.length, 1, '「第一位客人」是一生一次：第二位客人不该再记一条');
  assert.equal(Number(gg[0].counter_agent_id), B,
    '去重键里 counter 归零，但**插入时仍写原值** —— 归档页要能说出「是跟谁」');
  assert.equal(events(A, 'visited').length, 2, 'A 家来过两位客人（B、C），来访本身各记一行');
});

test('first_clap 一生一次：第二条帖被鼓掌不再记一条', async () => {
  const p2 = newTopic(A, `N4甲的第二篇 ${uniq}`);
  const c2 = await request(app).post(`/api/plaza/topics/${p2}/clap`).set(auth(tB)).send({});
  assert.ok(c2.status < 400, `鼓掌失败: ${JSON.stringify(c2.body)}`);

  assert.ok(await waitFor(() => events(A, 'first_clap').length === 1 && 'ok'), 'A 应有 first_clap');
  await sleep(250);
  assert.equal(events(A, 'first_clap').length, 1,
    '旧 bug：ref_id 参与去重 → 「第一次被鼓掌」会变成「每帖第一次被鼓掌」');
});

// ════════════════════════════════════════════════════════════════
// 3. L3 独立即时推 + 同日合并
// ════════════════════════════════════════════════════════════════
test('L3 独立推：单独的 rare 通知，且不占掉每日聚合（digest）的名额', async () => {
  const rare = await waitFor(() => {
    const r = socialNotifs(owner1, 'rare');
    return r.length ? r : null;
  });
  assert.ok(rare, 'owner1 应收到 action=rare 的通知');
  assert.equal(rare.length, 1, '同一天的所有 L3 必须合并成一条（拍板 P1）');

  const kinds = rare[0].x.items.map((i) => i.kind);
  assert.ok(kinds.includes('first_reply') && kinds.includes('first_guest'),
    `items 应含 first_reply/first_guest，实际：${JSON.stringify(kinds)}`);
  assert.ok(rare[0].x.items.every((i) => Number.isInteger(i.agentId) && i.agentId > 0),
    'items 要带 agentId —— 前端「XX 的社交档案 →」靠它定位');
  // ⚠️ 这里**不能**断言「digest 条数为 0」（2026-09-15 N5 修正）：
  //    N5 把 `badges` / `agent_badges` 补进了两个 schema 文件，于是测试库第一次真的建了这两张表，
  //    勋章链路随之在测试里真正跑起来 —— 而 `badge` 是**合法 L2**（RARITY 里就这么定的），
  //    必然聚进 digest。于是「此刻还没有任何 L2 事件」这个**前提**不再成立。
  //    判据要从「有没有 digest」收紧成「digest 里有没有 L3」—— 这才是本用例真正要钉的东西，
  //    且不依赖「环境里没有别的 L2」这种脆弱假设。
  const digKinds = socialNotifs(owner1, 'digest').flatMap((n) => n.x.items.map((i) => i.kind));
  assert.ok(!digKinds.some((k) => RARE_KINDS.includes(k)),
    `L3 不许顺手把 L2 的名额占掉（闸门按 action 拆开）；digest 实含：${JSON.stringify(digKinds)}`);
});

test('L3 同日合并：再来一个「第一次」，追加进同一条而不是再弹一条', async () => {
  const beforeRare = socialNotifs(owner1, 'rare');
  assert.equal(beforeRare.length, 1);
  const beforeItems = beforeRare[0].x.items.length;

  await befriend(A, tA, B, tB, `想认识一下，读你的东西很久了。${uniq}`);

  const after = await waitFor(() => {
    const r = socialNotifs(owner1, 'rare');
    return r.length === 1 && r[0].x.items.length > beforeItems ? r : null;
  });
  assert.ok(after, 'first_friend 应追加进今天那条 rare，而不是新弹一条');
  assert.equal(after.length, 1, '一天只许一条 rare 通知');
  assert.equal(Number(after[0].id), Number(beforeRare[0].id), '合并＝更新同一条通知，id 不该变');
  assert.ok(after[0].x.items.some((i) => i.kind === 'first_friend'));
  assert.ok(/\d/.test(after[0].x.title), `多于一小时标题要说清「N 个第一次」，实际：${after[0].x.title}`);
  // 同 187：digest 可以因为合法 L2（勋章）存在，但 `first_friend` 是 L3，绝不许落进 digest。
  // 判据按分级表泛判（而不是只查 first_friend 这一个 kind）—— digest 的候选窗口是
  // `LIMIT 5`，写死单个 kind 的话，闸门破了但那条恰好没进窗口时会漏报。
  const digKinds2 = socialNotifs(owner1, 'digest').flatMap((n) => n.x.items.map((i) => i.kind));
  assert.ok(!digKinds2.some((k) => RARE_KINDS.includes(k)),
    `L3 不许被聚合进 digest（first_friend 也是 L3）；digest 实含：${JSON.stringify(digKinds2)}`);
});

// ════════════════════════════════════════════════════════════════
// 4. L1 只归档：绝不进任何推送
// ════════════════════════════════════════════════════════════════
test('L1 只归档：拍一拍进事件流，但不给主人产生任何社交推送（E5）', async () => {
  const r = await request(app).post('/api/agents/me/nudge').set(auth(tA)).send({ agentId: E });
  assert.ok(r.status < 400, `拍一拍失败: ${JSON.stringify(r.body)}`);

  assert.ok(await waitFor(() => events(E, 'nudged').length === 1 && 'ok'),
    'E 应有一条 nudged 事件（主人主动翻归档能看见）');
  await sleep(250);
  assert.equal(socialNotifs(owner3).length, 0,
    '拍一拍是 L1：主人不该因为这个收到任何 social_report 通知');
});

// ════════════════════════════════════════════════════════════════
// 5. 主人的「主动来过」探针 + 《教子周报》
// ════════════════════════════════════════════════════════════════
test('POST /api/owners/social/seen 写 users.social_seen_at（纯心跳）', async () => {
  const r = await request(app).post('/api/owners/social/seen').set(auth(tOwner1)).send({});
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true }, '心跳不该回传任何内容');
  const row = getDb().prepare('SELECT social_seen_at FROM users WHERE id = ?').get(owner1);
  assert.ok(row?.social_seen_at, 'social_seen_at 应被 touch');
});

test('教子周报：7 天没主动来过 → 把存货（**含 L1**）一次交给主人，且不报数量', async () => {
  F = newAgent(`阿庚${uniq}`, owner4); tF = signAgentToken({ id: F, is_external: 1 });
  G = newAgent(`阿辛${uniq}`, owner5); tG = signAgentToken({ id: G, is_external: 1 });

  // 让 A 去 F 家串一次门 → F 记一条 visited（L1，永不 reported）
  const pF = newTopic(F, `N4庚的帖子 ${uniq}`);
  assert.ok((await comment(tA, pF, `路过看看，写得有意思。${uniq}`)).status < 400);
  assert.ok(await waitFor(() => events(F, 'visited').length === 1 && 'ok'));

  // G 家也一样来一条（但它的主人「刚来过」）
  const pG = newTopic(G, `N4辛的帖子 ${uniq}`);
  assert.ok((await comment(tA, pG, `也路过看看。${uniq}`)).status < 400);
  assert.ok(await waitFor(() => events(G, 'visited').length === 1 && 'ok'));

  const dbx = getDb();
  const daysAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
  dbx.prepare('UPDATE users SET social_seen_at = ? WHERE id = ?').run(daysAgo(8), owner4);
  dbx.prepare('UPDATE users SET social_seen_at = ? WHERE id = ?').run(daysAgo(0), owner5);

  await flushWeeklyReports();

  const wk = socialNotifs(owner4, 'weekly');
  assert.equal(wk.length, 1, 'owner4 连续 8 天没来过 → 应收到一封周报');
  assert.equal(wk[0].x.title, '它这几天的日子', '标题是固定的 —— 给内容，不报数量');
  assert.ok(!/\d/.test(wk[0].x.title), `标题里不许出现数字（一出现就是「你错过了 N 条」那种内疚口径）：${wk[0].x.title}`);
  assert.ok(wk[0].x.items.some((i) => i.kind === 'visited'),
    '周报**含 L1** —— 这正是它与日常摘要最大的不同（主人没来，就把存货全交给他）');

  // 措辞红线（E2 细则③）
  const blob = JSON.stringify(wk[0].x);
  for (const bad of ['错过', '未读', '未看', '没告诉你', '你有多久', '催']) {
    assert.ok(!blob.includes(bad), `周报数据里出现了内疚口径「${bad}」：${blob}`);
  }

  assert.equal(socialNotifs(owner5, 'weekly').length, 0, '主人刚来过就不该给他发周报');

  await flushWeeklyReports();
  assert.equal(socialNotifs(owner4, 'weekly').length, 1, '周报一周最多一封（它是兜底，不是日常推送口）');
});

// ════════════════════════════════════════════════════════════════
// 6. 第五动作「让它介绍认识一下」+ first_introduce 的兑现
// ════════════════════════════════════════════════════════════════
test('第五动作 introduce：好友才许约、7 天冷却、便签落私域、递条子不算兑现', async () => {
  await befriend(A, tA, C, tC, `想认识一下，你的材料我读过。${uniq}`);

  // 非好友（D）：409 not_friends，且要说人话
  const bad = await request(app).post(`/api/owners/agents/${A}/introduce`)
    .set(auth(tOwner1)).send({ counterAgentId: D });
  assert.equal(bad.status, 409, `非好友应 409，实际 ${bad.status} ${JSON.stringify(bad.body)}`);
  assert.equal(bad.body.error, 'not_friends');
  assert.ok(bad.body.message, '409 要给能读懂的 message，而不是只丢一个 error code');

  const ok = await request(app).post(`/api/owners/agents/${A}/introduce`)
    .set(auth(tOwner1)).send({ counterAgentId: C });
  assert.equal(ok.status, 201, `递条子失败: ${JSON.stringify(ok.body)}`);
  assert.equal(ok.body.kind, 'introduce');

  const notes = getDb().prepare(
    `SELECT * FROM agent_notes WHERE agent_id = ? AND kind = 'introduce' ORDER BY id ASC`).all(A);
  assert.equal(notes.length, 1);
  const payload = JSON.parse(notes[0].payload);
  assert.equal(Number(payload.counterAgentId), C);
  assert.ok(/要不要/.test(payload.brief), '便签是**邀约**不是指令：措辞里要有「要不要」');

  const again = await request(app).post(`/api/owners/agents/${A}/introduce`)
    .set(auth(tOwner1)).send({ counterAgentId: C });
  assert.equal(again.status, 409, '同一对 7 天内只许递一次');

  assert.equal(events(A, 'first_introduce').length, 0,
    '递条子只是改它的「所知」——它还没动作就不该记账（便签从来不构成指令）');

  const list = await listOwnerNotes(A, owner1);
  assert.ok(list.some((n) => n.kind === 'introduce' && Number(n.counterAgentId) === C),
    'listOwnerNotes 必须能读回 introduce，否则「你递过的条子」会漏掉 N4 的两种');
});

test('first_introduce 的兑现：它真的去了（被介绍那位收到它的第一个社交痕迹）才记', async () => {
  const pC = newTopic(C, `N4丙的帖子 ${uniq}`);
  assert.ok((await comment(tA, pC, `看到你写的这段，想聊两句。${uniq}`)).status < 400);

  assert.ok(await waitFor(() => events(A, 'first_introduce').length === 1 && 'ok'),
    'A 真去了 C 那儿 → 应兑现 first_introduce（redeemIntroduceNote 必须被接线，不能只定义不调用）');
  assert.equal(Number(events(A, 'first_introduce')[0].counter_agent_id), C, '要记清「是去见了谁」');

  await comment(tA, pC, `再补一句。${uniq}`);
  await sleep(250);
  assert.equal(events(A, 'first_introduce').length, 1, '一生一次，再访不翻倍');
});

// ════════════════════════════════════════════════════════════════
// 7. spoken_of：只扫附议，绝不扫信使/私信正文（§12.2 红线）
// ════════════════════════════════════════════════════════════════
async function courierSend(toId, content) {
  await ensureFriends(A, tA, B, tB);   // 信使有好友门 —— 别靠用例顺序来喂这个前置
  const r = await request(app).post('/api/agents/me/courier').set(auth(tA)).send({ to: toId, content });
  assert.ok(r.status < 400, `发信失败: ${JSON.stringify(r.body)}`);
  const dmId = r.body.message?.id ?? r.body.id;
  assert.ok(dmId, `拿不到 dmId：${JSON.stringify(r.body)}`);
  return dmId;
}
const courierDiary = (t, body) => request(app).post('/api/agents/me/courier/diary').set(auth(t)).send(body);

test('spoken_of 只认附议：信使正文里提到、附议里没提 → 不记', async () => {
  const dmId = await courierSend(B, `今天和「${nick[C]}」聊了几句，它挺有意思。${uniq}`);
  // B 写附议，但正文里**没有**提任何人
  const d = await courierDiary(tB, { dmId, probeResult: '打探了一句，对方态度不错。', endorsement: '读过了，记在心里。' });
  assert.ok(d.status < 400, `写附议失败: ${JSON.stringify(d.body)}`);
  await sleep(300);

  assert.equal(events(C, 'spoken_of').length, 0,
    '🔴 红线：信使**正文**里的名字不算 —— 只扫附议；扫正文就是越界');
  assert.ok(events(B, 'courier_exchanged').length >= 1,
    '但 courier_exchanged 该记 —— 这证明附议确实落库了，负例不是因为没写进去');
});

test('spoken_of 正例：附议里提到谁，就记给谁', async () => {
  const dmId = await courierSend(B, `第二封信，随便聊聊。${uniq}`);
  const d = await courierDiary(tB, { dmId, endorsement: `这事我拿不准，回头问问「${nick[C]}」怎么看。` });
  assert.ok(d.status < 400, `写附议失败: ${JSON.stringify(d.body)}`);

  assert.ok(await waitFor(() => events(C, 'spoken_of').length === 1 && 'ok'),
    '附议里提到 C → C 名下应记一条 spoken_of');
  assert.equal(Number(events(C, 'spoken_of')[0].counter_agent_id), B,
    '记录里要说清「是谁在背后提到它」');
});

test('spoken_of 门槛：单字昵称不参与匹配（防误命中）', async () => {
  const dmId = await courierSend(B, `第三封信。${uniq}`);
  const d = await courierDiary(tB, { dmId, endorsement: '单纯从材料看，单独这一条不能下定论。' });
  assert.ok(d.status < 400);
  await sleep(300);
  assert.equal(events(DAN, 'spoken_of').length, 0,
    '昵称长度 < 2 不参与子串匹配 —— 否则每个单字名都会被无关文本命中');
});

// ════════════════════════════════════════════════════════════════
// 8. first_apology 的三道过滤（各自可隔离）
// ════════════════════════════════════════════════════════════════
test('first_apology：三道过滤全过才记，缺任一道都不记', async () => {
  // ── 正例：B 在 pApology 里反驳过、帖里另有 AI（C）说过话 ──
  const pApology = newTopic(A, `N4甲用于道歉的帖 ${uniq}`);
  assert.ok((await comment(tB, pApology, `我不同意这个判断，史料上站不住。${uniq}`)).status < 400);  // ②
  assert.ok((await comment(tC, pApology, `我倒觉得可以再商量。${uniq}`)).status < 400);              // ③
  assert.ok((await comment(tB, pApology, `上一条我太急了——是我没说清，你说得对。${uniq}`)).status < 400);
  assert.ok(await waitFor(() => events(B, 'first_apology').length === 1 && 'ok'),
    '三道全过 → 应记 first_apology');

  // ── 缺 ②：C 只认错，此前没在这帖较过真 ──
  const pNoRebuttal = newTopic(D, `N4丁的帖子 ${uniq}`);
  assert.ok((await comment(tB, pNoRebuttal, `写得不错。${uniq}`)).status < 400);                      // ③
  await comment(tC, pNoRebuttal, `抱歉，这条我收回，是我改口了。${uniq}`);                            // ①
  // ── 缺 ③：C 在 pLonely 里先反驳后认错，但整帖只有它自己说过话 ──
  const pLonely = newTopic(A, `N4甲无人应答的帖 ${uniq}`);
  await comment(tC, pLonely, `我不这么看，这个论断太急。${uniq}`);                                     // ②
  await comment(tC, pLonely, `……想想是我错了，你说得对。${uniq}`);                                    // ①

  await sleep(350);
  assert.equal(events(C, 'first_apology').length, 0,
    '缺 ②「没较过真」或缺 ③「帖里没有别的 AI」都不许记 ——「你说得对」很可能只是礼貌寒暄');

  // 正则口径先钉住（免得有人把白名单改宽了还说测试没覆盖）
  assert.ok(APOLOGY_RE.test('是我没说清') && APOLOGY_RE.test('你说得对'));
  assert.ok(REBUT_RE.test('我不同意') && !REBUT_RE.test('抱歉，我改口了'));
});

// ════════════════════════════════════════════════════════════════
// 9. 归档页读口：抽屉里的动作要靠 counterAgentId 定位对手
// ════════════════════════════════════════════════════════════════
test('审计抽屉的每条事件都带 counterAgentId（抽屉里的「相认 / 走动走动」靠它定位对手）', async () => {
  const a = await listAgentEventsForOwner(A, { limit: 200 });
  assert.ok(a.events.length > 0);
  assert.ok(a.events.some((e) => e.counterAgentId != null),
    '至少 first_guest / first_reply / first_introduce 这类该带上 counterAgentId');
  assert.ok(a.events.every((e) => e.counterAgentId === null || Number.isInteger(e.counterAgentId)),
    'counterAgentId 要么是 null，要么是整数');
});

// ════════════════════════════════════════════════════════════════
// 10. A3 红线：公开时间线不许泄露主人的私域命名
// ════════════════════════════════════════════════════════════════
// 这条是 N4 **上线当天**发现并补的：`first_nickname` 的 line 里**含外号原文**
// （「你给「小沃」的朋友起了第一个外号——「小壮」往后就叫「壮壮」了。」），
// 而 `GET /api/agents/:id/milestones` 是**公开**读口、`social_events` 又没有可见性维度 ——
// 不拦就是把它主人的私域命名泄给全站，正好踩中 A3（外号只对「主人 + 自己 Agent」可见）。
//
// ⚠️ 它**不是不发**：主人侧归档照旧读得到（主人本来就该看见自己起的外号），只是不上公开主页。
//    所以下面两组断言必须**同时**成立 —— 只测「公开读不到」会被"干脆不发"糊弄过去。
test('A3：first_nickname 记在案、主人读得到，但不进公开里程碑', async () => {
  const dbx = getDb();
  const host = A, friend = B;
  const nickText = `壮壮${uniq.slice(-4)}`;
  const owner = dbx.prepare('SELECT owner_id FROM users WHERE id = ?').get(host)?.owner_id;
  assert.ok(owner, 'A 得有主人，否则这条测不到主人侧读口');
  dbx.prepare(
    `INSERT INTO social_events (agent_id, owner_id, kind, ref_key, ref_type, ref_id, counter_agent_id, facts, created_at)
     VALUES (?, ?, 'first_nickname', 'global', 'agent', ?, ?, ?, ?)`
  ).run(host, owner, friend, friend, JSON.stringify({
    line: `你给「${nick[host]}」的朋友起了第一个外号——「${nick[friend]}」往后就叫「${nickText}」了。`,
    otherAgentId: friend, nickname: nickText,
  }), new Date().toISOString());

  // ① 公开读口：滤掉，且外号原文一个字都不许露
  const published = await listMilestones(host, 30);
  assert.equal(published.filter((m) => m.kind === 'first_nickname').length, 0,
    'A3：外号事件不许出现在公开时间线');
  assert.equal(published.some((m) => String(m.line || '').includes(nickText)), false,
    'A3：公开数据里不许出现外号原文');

  // ② 主人读口：照旧读得到 —— 修的是「不公开」，不是「不发」
  const drawer = await listAgentEventsForOwner(host, { limit: 200 });
  assert.ok(drawer.events.some((e) => e.kind === 'first_nickname'),
    '主人侧归档必须照旧读得到（主人本来就该看见自己起的外号）');
});
