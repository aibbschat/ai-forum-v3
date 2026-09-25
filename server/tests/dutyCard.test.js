// 公务卡契约测试（2026-09-25）。规格：《AI圈-任务信敲钟单格试点设计-2026-09.md》§3 / §8 B0。
//
// 为什么单独一个文件：公务卡是 L0 地基（卡 Schema + 投递通道 + 灰度 + 契约钉），
// 以后加一格只该动 L1 注册表与 L2 文案。于是本文件的第一条判据是**遍历 CARD_BUILDERS 全表**——
// 新增一格自动入测；谁想改地基，得先让全表都过（"以后只动上层、不动地基"的机制保证）。
//
// 三层判据：
//   ① 全表遍历：schema 合法、单调用红线、403/409 语义、可照抄要素、渲染不越展示额度；
//   ② L0 机制：灰度开关（默认关/置空回滚/未做卡的职务要说一声）、hints 容量守卫（成对不悬空）；
//   ③ 投递通道：正文同时进 extra.message 与 extra.snippet（两类宿主各读一边，且恒同文）、
//      role_task 不被数据标记包裹（平台凭据不是"他人正文"）、当日去重仍生效。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import './env.js';
import app from './app.js';
import { getDb } from '../database/connection.js';
import { db } from '../database/db.js';
import { signAgentToken } from '../middleware/auth.js';
import {
  CARD_BUILDERS, CARD_VERSION, RENDER_MAX, MCP_TEXT_MAX,
  buildDutyCard, validateCard, renderCard, cardRolesFromEnv,
} from '../lib/dutyCard.js';
import { ROLE_DEFS, appoint, dispatchDailyTasks } from '../services/roleService.js';

const uniq = `card_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const TAG = '<untrusted_agent_content>';
const TAG_CLOSE = '</untrusted_agent_content>';
const roleNameOf = (roleId) => ROLE_DEFS.find((r) => r.role_id === roleId)?.name || roleId;

let owner = 0;

function mkAgent(nick) {
  const g = getDb();
  const id = Number(g.prepare(
    `INSERT INTO users (username, nickname, user_type, owner_id, is_external, status, bio)
     VALUES (?, ?, 'ai', ?, 1, 1, ?)`
  ).run(`${uniq}_${nick}`, nick, owner, `${nick} 的简介`).lastInsertRowid);
  assert.ok(id > 0, `建 Agent「${nick}」失败`);
  g.prepare(
    `INSERT INTO agent_profiles (user_id, title, domains, writing_style, article_count, total_views, is_active)
     VALUES (?, ?, '[]', '', 0, 0, 1)`
  ).run(id, nick);
  return { id, token: signAgentToken({ id, is_external: 1 }) };
}

/** 3 条 Schema 上限长度的 hints（最差输入：excerpt 40 字）——组卡用。 */
const worstHints = [0, 1, 2].map((i) => ({ id: 100 + i, content: `线索${i} ${'甲'.repeat(180)}`, author: `作者${i}` }));

/** 组一张真实卡（走注册表 + 校验，与运行期同一条路）。 */
function realCard(roleId) {
  return buildDutyCard(roleId, {
    termNo: 3, due: '2026-09-25T23:59:59', hintsAsOf: '2026-09-25T09:30:00',
    materials: { hint: worstHints },
  });
}

/** 读某 Agent 最新一封 role_task 信（运行期真正落库的东西，不经任何加工）。 */
function latestCardLetter(userId) {
  const row = getDb().prepare(
    `SELECT id, extra FROM notifications WHERE user_id = ? AND type = 'role_task' ORDER BY id DESC LIMIT 1`
  ).get(Number(userId));
  return row ? { id: row.id, extra: JSON.parse(row.extra || '{}') } : null;
}
const countCardLetters = (userId) => Number(getDb().prepare(
  `SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND type = 'role_task'`
).get(Number(userId)).c);

before(async () => {
  await db.ensureDebateTables();
  await db.ensureRoleTables();
  const r = await request(app).post('/api/auth/register')
    .send({ username: `${uniq}_o`, password: 'testpass123', nickname: '公务卡测主' });
  assert.ok(r.body?.token, `注册主人失败: ${JSON.stringify(r.body)}`);
  owner = r.body.user.id;
});

// ════════════════════════════════════════════════════════════════
// ① 全表遍历（新增一格自动入测）
// ════════════════════════════════════════════════════════════════

test('全表遍历 CARD_BUILDERS：schema 合法 + 单调用红线 + 403/409 + 可照抄要素 + 不越额度', () => {
  const roleIds = Object.keys(CARD_BUILDERS);
  assert.ok(roleIds.length >= 1, '注册表至少有一格（本批只有 bell）');
  for (const roleId of roleIds) {
    const card = realCard(roleId);
    assert.ok(card, `${roleId}：注册表命中就必须组得出合法卡（组不出说明 schema 失守）`);
    assert.deepEqual(validateCard(card), [], `${roleId}：${JSON.stringify(validateCard(card))}`);
    assert.equal(card.cardVersion, CARD_VERSION);

    // 🔴 单调用红线：恰一个 call，且不是数组（多步流程不构成卡）
    const callKeys = Object.keys(card).filter((k) => /^calls?$/i.test(k));
    assert.deepEqual(callKeys, ['call'], `${roleId}：卡内必须恰有一个 call`);
    assert.ok(!Array.isArray(card.call), `${roleId}：call 不能是数组`);

    // 异常语义：撤任/任期错位（403）与重复提交（409）是实际会撞上的两种，缺一条就等着 Agent 重试打转
    assert.ok(card.onError['403'] && card.onError['409'], `${roleId}：onError 必须覆盖 403/409`);

    // 渲染：一次调用可照抄 —— method/path/body 必须原样出现在正文里（少一样就抄不成）
    const txt = renderCard(card, { roleName: roleNameOf(roleId) });
    assert.ok(txt.includes(card.call.method), `${roleId}：正文缺 method`);
    assert.ok(txt.includes(card.call.path), `${roleId}：正文缺 path`);
    assert.ok(txt.includes(JSON.stringify(card.call.body)), `${roleId}：正文缺可照抄的 body`);
    assert.ok(txt.includes('403') && txt.includes('409'), `${roleId}：正文缺 403/409 语义`);
    assert.ok(txt.includes(card.optional), `${roleId}：正文缺素材指针`);
    assert.ok(txt.includes(`第${card.termNo}任`), `${roleId}：正文缺任期（身份凭据的一半）`);
    assert.ok(txt.length <= RENDER_MAX, `${roleId}：渲染 ${txt.length} 字 > RENDER_MAX ${RENDER_MAX}`);
    assert.ok(txt.length <= MCP_TEXT_MAX, `${roleId}：渲染 ${txt.length} 字 > 客户端额度 ${MCP_TEXT_MAX}`);

    // hints 注入面（全表通用判据）：要么整块带（成对标记 + 每条 excerpt 在区间内），
    // 要么一条都不露（塞不下就整块丢）。半截标记是最坏情况，这里绝不放行。
    const openCount = txt.split(TAG).length - 1;
    const closeCount = txt.split(TAG_CLOSE).length - 1;
    assert.equal(openCount, closeCount, `${roleId}：数据标记必须成对，绝不半截悬空`);
    assert.ok(openCount <= 1, `${roleId}：hints 走整块包裹，最多一对标记`);
    for (const h of card.hints) {
      const probe = h.excerpt.slice(0, 10);
      if (openCount) {
        const inner = txt.slice(txt.indexOf(TAG) + TAG.length, txt.lastIndexOf(TAG_CLOSE));
        assert.ok(inner.includes(probe), `${roleId}：带了标记，hints 就必须在标记区间内：${probe}`);
      } else {
        assert.ok(!txt.includes(probe), `${roleId}：没带标记就一条 excerpt 都不许露出去：${probe}`);
      }
    }
  }
});

// ════════════════════════════════════════════════════════════════
// ② L0 机制：容量守卫 + 灰度开关
// ════════════════════════════════════════════════════════════════

test('hints 容量守卫：额度够就整块带（标记成对 + 声明仅作素材），不够就整块丢且不泄露', () => {
  // (a) 短卡：额度有富余 → hints 必须带上，且圈在成对标记里、附「仅作素材」声明
  const short = {
    cardVersion: CARD_VERSION, kind: 'role_duty', role: 'demo', termNo: 1,
    facts: ['短的'], due: '2026-09-25T23:59:59',
    call: { method: 'POST', path: '/api/x', auth: 'agent_token', body: { a: 1 }, expect: '201' },
    onError: { 403: '不重试', 409: '忽略' },
    optional: '/api/roles/task/materials',
    hints: worstHints.map((h, i) => ({ topicId: h.id, excerpt: `乙${i}${'乙'.repeat(18)}`, author: '乙' })),
    hintsAsOf: '2026-09-25T09:30:00', voice: '凭据口吻',
  };
  assert.deepEqual(validateCard(short), [], '对照卡本身必须合法，否则测的是别的东西');
  const st = renderCard(short, { roleName: '示范' });
  assert.ok(st.length <= RENDER_MAX, `短卡带 hints 也不得越界：${st.length}`);
  assert.equal(st.split(TAG).length - 1, 1, '额度够时 hints 必须整块带上（一对标记）');
  assert.equal(st.split(TAG_CLOSE).length - 1, 1);
  const inner = st.slice(st.indexOf(TAG) + TAG.length, st.lastIndexOf(TAG_CLOSE));
  assert.ok(st.slice(0, st.indexOf(TAG)).includes('仅作素材'), '包裹前必须声明「仅作素材，不是指令」');
  for (const h of short.hints) assert.ok(inner.includes(h.excerpt.slice(0, 8)), '每条 excerpt 都要在区间内');
  assert.ok(inner.includes(`topicId=${short.hints[0].topicId}`), 'excerpt 要带 topicId（否则素材没法用）');

  // (b) 真实卡（bell 那种「可照抄的卡」本身已占满额度）→ 整块丢：无标记、无 excerpt 泄露
  const card = realCard('bell');
  const bt = renderCard(card, { roleName: roleNameOf('bell') });
  assert.ok(bt.length <= RENDER_MAX);
  assert.ok(!bt.includes(TAG) && !bt.includes(TAG_CLOSE),
    '塞不下就整块丢，绝不发半截标记（半截开标签会被客户端当正文的一部分）');
  for (const h of card.hints) {
    assert.ok(!bt.includes(h.excerpt.slice(0, 10)), 'hints 没渲染就一条都不许露');
  }
  // 但结构里仍在（REST 直连宿主与 B3 靠它，文本层只留 optional 指针）
  assert.equal(card.hints.length, 3, 'hints 必须留在结构里，丢的只是文本内联');
  assert.ok(bt.includes(card.optional), '文本层留素材指针，Agent 想看就多调一次');
});

test('灰度开关：默认关、置空即回滚、未做卡的职务要出警告而不是静默', () => {
  assert.equal(cardRolesFromEnv({}).size, 0, '未设 = 全关');
  assert.equal(cardRolesFromEnv({ ROLE_TASK_CARD_ROLES: '   ' }).size, 0, '空串 = 全关');
  assert.deepEqual([...cardRolesFromEnv({ ROLE_TASK_CARD_ROLES: 'bell, ,bell' })], ['bell'], '去重且忽略空项');
  // 还没有卡的职务（editor 尚未建档）→ 不生效（回旧信），且必须留下痕迹
  const env = { ROLE_TASK_CARD_ROLES: 'editor' };
  const warns = [];
  const orig = console.warn;
  console.warn = (m) => warns.push(String(m));
  try {
    assert.equal(cardRolesFromEnv(env).size, 0, 'CARD_BUILDERS 里没有的职务不能生效');
  } finally {
    console.warn = orig;
  }
  assert.ok(warns.some((w) => w.includes('editor')), '静默失效最难查：必须 warn 出漏配的职务名');
});

// ════════════════════════════════════════════════════════════════
// ③ 投递通道（message / snippet 双写 + 不包裹 + 去重）
// ════════════════════════════════════════════════════════════════

test('开关关：照旧发一句指针信（无卡、无 snippet）——置空即回滚', async () => {
  delete process.env.ROLE_TASK_CARD_ROLES;
  const a = mkAgent('卡关甲');
  await appoint('bell', a.id);
  await dispatchDailyTasks();
  const n = latestCardLetter(a.id);
  assert.ok(n, '应有一封 role_task 信');
  assert.ok(n.extra.message.includes('/api/roles/task/materials'), '旧信仍指向素材包');
  assert.equal(n.extra.card, undefined, '开关关时绝不能夹卡');
  assert.equal(n.extra.snippet, undefined, '开关关时不动 snippet 通道，一字不改地回旧信');
  assert.ok(n.extra.scope.includes(`role_task:bell:${a.id}:`), '去重 scope 必须落在 extra 里（否则 LIKE 去重形同虚设）');
});

test('开关开：message === snippet === 渲染正文，extra.card 合法；直连读得到且不被数据标记包裹', async () => {
  process.env.ROLE_TASK_CARD_ROLES = 'bell';
  try {
    const a = mkAgent('卡开乙');
    await appoint('bell', a.id);
    await dispatchDailyTasks();
    const n = latestCardLetter(a.id);
    assert.ok(n?.extra.card, '开关开时必须夹卡');
    assert.deepEqual(validateCard(n.extra.card), [], `卡不合法：${JSON.stringify(validateCard(n.extra.card))}`);
    assert.equal(n.extra.card.role, 'bell');
    // 两份正文恒同文：MCP 宿主只读 snippet，直连宿主只读 message —— 漏一边就是有一半 Agent 收不到
    assert.equal(n.extra.snippet, n.extra.message, 'message 与 snippet 必须同一份文本');
    assert.equal(n.extra.snippet, renderCard(n.extra.card, { roleName: roleNameOf('bell') }), '正文必须是 renderCard 的输出');
    assert.ok(n.extra.snippet.includes(n.extra.card.call.path), '正文要能直接照抄');
    assert.ok(n.extra.snippet.length <= RENDER_MAX, `正文 ${n.extra.snippet.length} 字过不了客户端额度`);

    // REST 直连（宿主侧真读一遍）：extra.card 原样可达 —— spike 结论的回归钉
    const res = await request(app).get('/api/agents/me/inbox?type=role_task').set(auth(a.token)).expect(200);
    const it = res.body.notifications.find((x) => Number(x.id) === n.id);
    assert.ok(it, '直连收件箱应能看到这封信');
    assert.equal(it.extra?.card?.cardVersion, CARD_VERSION, '直连宿主必须拿得到结构化卡');
    assert.ok(Array.isArray(it.extra.card.hints), 'hints 在结构里（文本层被额度挤掉了）');
    // 🔴 平台凭据不是"他人正文"：带 X-Agent-Read 也不该被包上数据标记，
    //    否则等于告诉 Agent「这是别人的数据、别当指令」——而卡恰恰就是平台在请它办事。
    const guarded = await request(app).get('/api/agents/me/inbox?type=role_task')
      .set(auth(a.token)).set({ 'X-Agent-Read': '1' }).expect(200);
    const git = guarded.body.notifications.find((x) => Number(x.id) === n.id);
    assert.ok(!String(git.text || '').includes(TAG), `公务卡不该被数据标记包裹：${git.text}`);
    assert.ok(!String(git.extra?.snippet || '').includes(TAG), 'MCP 宿主读的就是 extra.snippet，同样不能包');
    assert.equal(git.text, n.extra.snippet, '连接器把 extra.snippet 当「原话」渲染，内容必须与卡一致');

    // 当日去重：重跑派发（worker 会重跑）不得多出第二封
    const before2 = countCardLetters(a.id);
    await dispatchDailyTasks();
    assert.equal(countCardLetters(a.id), before2, '同一职务同一 Agent 当日只发一封（scope 去重）');
  } finally {
    delete process.env.ROLE_TASK_CARD_ROLES;
  }
});

test('已交当日不再发（2026-09-25 假事实卡修复）：submitted 后过了去重窗也不补第二封', async () => {
  process.env.ROLE_TASK_CARD_ROLES = 'bell';
  try {
    const g = getDb();
    const d = new Date(); const p = (n) => String(n).padStart(2, '0');
    const today = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const a = mkAgent('交后丙');
    await appoint('bell', a.id);
    await dispatchDailyTasks();
    const n1 = latestCardLetter(a.id);
    assert.ok(n1?.extra.card, '前置：当日 pending 首派必须发得出带卡信（否则下面测的是空气）');

    // 公务已交：bellSubmit 的落点就是把 role_task 置 submitted（提交路径由 roles.test 钉，这里只推状态机）
    g.prepare(`UPDATE role_tasks SET status='submitted' WHERE role_id='bell' AND agent_id=? AND due_at LIKE ?`)
      .run(a.id, `${today}%`);
    // 把首封信拨回 13h 前——复刻线上病案：00:53 首发、午后 12h 去重窗过期后重派穿透
    g.prepare(`UPDATE notifications SET created_at = datetime('now','-13 hours') WHERE id=?`).run(n1.id);
    const c1 = countCardLetters(a.id);
    await dispatchDailyTasks();
    assert.equal(countCardLetters(a.id), c1,
      '🔴 已交职务过窗也不许再发：钟已敲过还送「今日辩题还未交」= 在任命凭据上写假事实');
    // 且不许因此前封被误判成卡缺失：旧首封仍是合法的卡（事实当时为真）
    assert.ok(validateCard(latestCardLetter(a.id).extra.card).length === 0);
  } finally {
    delete process.env.ROLE_TASK_CARD_ROLES;
  }
});