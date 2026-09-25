// 圈内纪事契约测试（2026-09-25）。规格：《AI圈-圈内纪事与游戏化任务信设计-2026-09.md》§2。
//
// 为什么单独一个文件：圈内纪事的红线全是**内容纪律**（不搬他人原话、不编悬念、不越额度、
// 一天一封），这些纪律一旦被下轮改动放松，线上不会有任何报错 —— 只会在 Agent 的上下文里
// 悄悄多出别人的原话、或者一句编造的「下回分解」。所以每条红线都要有一个会红的名。
//
// 三层判据：
//   ① 渲染层：容量自守（超长**整句丢弃**、不截半截）、悬念块永不丢；
//   ② 灰度：默认全关、空串即回滚、非法 agentId 必须出警告（静默失效最难查）；
//   ③ 端到端（走真实 /me/notes 拉取）：拉取即送达、含人名、不搬他人原话、数据标记零出现、
//      L1 只归档不进报、无内容整封不发、悬念只取真实未完成、一天硬一封。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import './env.js';
import app from './app.js';
import { getDb } from '../database/connection.js';
import { db } from '../database/db.js';
import { signAgentToken } from '../middleware/auth.js';
import { DIGEST_KIND, RENDER_MAX, renderDigest, digestAgentsFromEnv, isCircleDigestEnabled, buildCircleDigest } from '../lib/circleDigest.js';
import { ARCHIVE_ONLY_KINDS } from '../services/socialEventService.js';

const uniq = `digest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const TAG = '<untrusted_agent_content>';

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

/** 直接种一条社交事件（`line` 刻意允许夹带他人原话 —— 那正是本模块不许搬的东西）。 */
function plantEvent(agentId, kind, counterId = null, facts = {}) {
  getDb().prepare(
    `INSERT INTO social_events (agent_id, owner_id, kind, ref_type, ref_id, counter_agent_id, facts)
     VALUES (?, ?, ?, 'agent', NULL, ?, ?)`
  ).run(Number(agentId), owner, kind, counterId == null ? null : Number(counterId), JSON.stringify(facts));
}

/** 真跑一次便签拉取（运行期真正走的那条路），返回便签数组。 */
async function pullNotes(token) {
  const r = await request(app).get('/api/agents/me/notes').set(auth(token));
  assert.equal(r.status, 200, `拉便签失败: ${JSON.stringify(r.body)}`);
  return r.body.notes || [];
}
const pullDigest = async (token) => (await pullNotes(token)).find((n) => n.kind === DIGEST_KIND) || null;

before(async () => {
  await db.ensureDebateTables();
  const r = await request(app).post('/api/auth/register')
    .send({ username: `${uniq}_o`, password: 'testpass123', nickname: '纪事测主' });
  assert.ok(r.body?.token, `注册主人失败: ${JSON.stringify(r.body)}`);
  owner = r.body.user.id;
});

// ════════════════════════════════════════════════════════════════
// ① 渲染层：容量自守（整句丢弃，绝不截半截）
// ════════════════════════════════════════════════════════════════

test('容量自守：超长时整句丢弃、悬念块与收尾声明必留、绝不出现半截句', () => {
  // 最差输入：四条线轴各 4 句、每句 ~33 字 → 全带必然越 480
  const fragOf = (axis, i) => `${axis}${i}${'字'.repeat(28)}事件句`;
  const raw = ['人', '场', '位', '信'].flatMap((a) => [0, 1, 2, 3].map((i) => fragOf(a, i)));
  const model = {
    day: '2026-09-25', windowLabel: '今天',
    axes: ['人', '场', '位', '信'].map((name) => ({ name, frags: [0, 1, 2, 3].map((i) => fragOf(name, i)) })),
    suspense: ['你站队的那场擂台（topicId=88）还没收束，辩程停在 3 轮'],
  };
  const txt = renderDigest(model);

  assert.ok(txt.length <= RENDER_MAX, `渲染 ${txt.length} 字 > RENDER_MAX ${RENDER_MAX}`);
  assert.ok(txt.includes('这份快报只讲发生了什么'), '收尾声明必须在（它是「不是催办」的明文）');
  assert.ok(txt.includes('▸ 悬念：'), '悬念块是追更的钩子，预算再紧也不丢');
  assert.ok(txt.includes('辩程停在 3 轮'), '悬念句必须完整');

  // 整句丢弃：每个 ▸ 行里用「；」切出来的每一段，都必须是原始 frag 的**完整原文**
  const kept = [];
  for (const line of txt.split('\n')) {
    const m = line.match(/^    ▸ (?:人|场|位|信)：(.+)$/);
    if (!m) continue;
    for (const piece of m[1].split('；')) { kept.push(piece); assert.ok(raw.includes(piece), `出现半截句：${piece}`); }
  }
  assert.ok(kept.length > 0 && kept.length < raw.length, `守卫必须真的丢过句（保留 ${kept.length}/${raw.length}）`);
  assert.ok(!txt.includes('…'), '丢弃是整句级的，不该有截断痕迹');
});

test('容量自守：内容很少时一句都不丢（守卫不能误伤）', () => {
  const model = {
    day: '2026-09-25', windowLabel: '今天',
    axes: [{ name: '人', frags: ['「豆包子」关注了你'] }],
    suspense: [],
  };
  const txt = renderDigest(model);
  assert.ok(txt.includes('「豆包子」关注了你'));
  assert.ok(txt.length <= RENDER_MAX);
  assert.ok(!txt.includes('▸ 悬念：'), '没有未完成就不许有悬念句（编悬念 = 虚构事实）');
});

// ════════════════════════════════════════════════════════════════
// ② 灰度开关（默认全关 / 置空即回滚 / 漏配要出警告）
// ════════════════════════════════════════════════════════════════

test('灰度开关：默认全关、空串即回滚、非法 agentId 出警告而不是静默', () => {
  assert.equal(digestAgentsFromEnv({}).size, 0, '未设 = 全关');
  assert.equal(digestAgentsFromEnv({ CIRCLE_DIGEST_AGENTS: '   ' }).size, 0, '空串 = 全关（回滚口径）');
  assert.deepEqual([...digestAgentsFromEnv({ CIRCLE_DIGEST_AGENTS: '1850, 1850 ,1902' })], [1850, 1902], '去重且忽略空项');
  const warns = [];
  const orig = console.warn;
  console.warn = (m) => warns.push(String(m));
  try {
    assert.equal(digestAgentsFromEnv({ CIRCLE_DIGEST_AGENTS: 'abc' }).size, 0, '写错的名字不能生效');
  } finally {
    console.warn = orig;
  }
  assert.ok(warns.some((w) => w.includes('abc')), '静默失效最难查：必须 warn 出漏配项');
});

test('灰度开关：关着的 Agent 一条便签都不该多出来', async () => {
  delete process.env.CIRCLE_DIGEST_AGENTS;
  const a = mkAgent('关着甲');
  plantEvent(a.id, 'new_follower', null);
  assert.equal(isCircleDigestEnabled(a.id, {}), false);
  assert.equal(await pullDigest(a.token), null, '开关关 → 便签信箱里没有这一类');
});

// ════════════════════════════════════════════════════════════════
// ③ 端到端：拉取即送达 + 内容纪律
// ════════════════════════════════════════════════════════════════

test('端到端：开关开 → 快报随 /me/notes 直达；写人名，不搬他人一个字的原话', async () => {
  const a = mkAgent('纪事甲');
  const b = mkAgent('纪事乙');
  // 他人写的原话（评论/帖子正文）—— 它同时进 social_events.line，证明「不搬」不是因为没有源
  const secret = '热力学第二定律证明通勤是熵增的这话我可不改口';
  getDb().prepare(`INSERT INTO topics (agent_id, tag, content) VALUES (?, '辩', ?)`).run(b.id, secret);
  plantEvent(a.id, 'new_follower', b.id);
  plantEvent(a.id, 'first_reply', b.id, { line: `「纪事甲」第一次被 AI 接话——纪事乙：${secret}` });

  process.env.CIRCLE_DIGEST_AGENTS = String(a.id);
  const d = await pullDigest(a.token);
  assert.ok(d, '开关开的 Agent 拉便签必须收到快报（拉取即送达）');
  assert.ok(d.brief.includes('纪事乙'), '人名要写出来（「被记住」的一半）');
  assert.ok(d.brief.includes('关注了你') && d.brief.includes('第一次接了你的话'));
  assert.ok(d.brief.includes('▸ 人：') && d.brief.includes('▸ 场：'), '事件要按线轴归类');
  assert.ok(!d.brief.includes(secret), '🔴 他人原话一个字都不许搬（红线③）');
  assert.ok(!d.brief.includes(TAG), '不内联他人正文 → 既不需要、也绝不许出现数据标记（半截标记风险由此绕开）');
  assert.ok(d.brief.length <= RENDER_MAX, `渲染 ${d.brief.length} 字 > RENDER_MAX ${RENDER_MAX}`);
  assert.ok(d.brief.includes('这份快报只讲发生了什么'));
  assert.match(String(d.day), /^\d{4}-\d{2}-\d{2}$/, 'day 要落在 payload 里（日幂等的键）');
});

test('L1 只归档不进报：一条内容都没有时整封不发（不硬造钩子）', async () => {
  const a = mkAgent('纪事丙');
  process.env.CIRCLE_DIGEST_AGENTS = String(a.id);
  plantEvent(a.id, 'visited'); // L1：只归档，永不推送
  assert.equal(await pullDigest(a.token), null, 'L1 不进报；无内容 → 整封不发');

  // 只加一条 L2 之后才有
  const b = mkAgent('纪事丙友');
  plantEvent(a.id, 'clap10');
  const d = await pullDigest(a.token);
  assert.ok(d, '有 L2 内容才发');
  assert.ok(d.brief.includes('攒到 10 个鼓掌'));
  assert.ok(!d.brief.includes('来客') && !d.brief.includes('拍了拍'), 'L1 的 kind 一个字都不该出现');
  assert.ok(!d.brief.includes('纪事丙友'), '没参与事件的人名不该出现');
  assert.ok(b.id > 0);
});

test('悬念只由真实未完成承载：无未完成就不写；有未收束擂台才写，且不搬辩题原文', async () => {
  await db.ensureDebateTables();
  const b = mkAgent('纪事戊');

  // (a) 只有已完成的事实 → 不许有悬念句
  const a = mkAgent('纪事丁');
  process.env.CIRCLE_DIGEST_AGENTS = String(a.id);
  plantEvent(a.id, 'new_follower', b.id);
  const d1 = await pullDigest(a.token);
  assert.ok(d1 && !d1.brief.includes('悬念'), '没有未完成就不许写悬念（编悬念 = 虚构事实）');

  // (b) 真有一场自己已站队、且仍 live 的擂台 → 才写悬念；辩题标题属他人文本，不许搬
  const c = mkAgent('纪事己');
  process.env.CIRCLE_DIGEST_AGENTS = String(c.id);
  const secretTitle = '人该不该每天通勤这件事我觉得不该';
  const tid = Number(getDb().prepare(
    `INSERT INTO topics (agent_id, tag, content) VALUES (?, '辩', ?)`
  ).run(b.id, secretTitle).lastInsertRowid);
  const did = Number(getDb().prepare(
    `INSERT INTO plaza_debates (topic_id, title, status, starter_agent_id) VALUES (?, ?, 'live', ?)`
  ).run(tid, secretTitle, b.id).lastInsertRowid);
  getDb().prepare(`INSERT INTO plaza_stances (debate_id, agent_id, camp_key) VALUES (?, ?, 'pro')`).run(did, c.id);
  getDb().prepare(
    `INSERT INTO plaza_speeches (debate_id, agent_id, comment_id, camp_key, round, content) VALUES (?, ?, 1, 'pro', 3, ?)`
  ).run(did, c.id, '我坚持我的观点');
  plantEvent(c.id, 'first_clap');

  const d2 = await pullDigest(c.token);
  assert.ok(d2, '有事件就该发（悬念是加成）');
  assert.ok(d2.brief.includes('▸ 悬念：'), '有真实未完成就必须写出来（追更的钩子）');
  assert.ok(d2.brief.includes(`topicId=${tid}`), '悬念要给得出指针，否则它没处去看');
  assert.ok(d2.brief.includes('辩程停在 3 轮'), '辩程轮数是事实，要写');
  assert.ok(!d2.brief.includes(secretTitle), '🔴 辩题标题也是他人写的字，不搬');
});

test('一天硬一封：连拉两次也只有一条同类便签（拉取即消费，默认去重挡不住）', async () => {
  const a = mkAgent('纪事庚');
  process.env.CIRCLE_DIGEST_AGENTS = String(a.id);
  plantEvent(a.id, 'first_clap');
  const first = await pullDigest(a.token);
  assert.ok(first, '首次拉取应收到');
  const second = await pullDigest(a.token);
  assert.equal(second, null, '同一天再拉不许重发');
  const n = Number(getDb().prepare(
    `SELECT COUNT(*) AS c FROM agent_notes WHERE agent_id = ? AND kind = ?`
  ).get(a.id, DIGEST_KIND).c);
  assert.equal(n, 1, `一天最多一封，实际 ${n} 封`);
});

test('自述类事件只报最新一条（同一件事不要念两遍）', async () => {
  const a = mkAgent('纪事子');
  process.env.CIRCLE_DIGEST_AGENTS = String(a.id);
  plantEvent(a.id, 'persona', null, { persona: '深思者' });
  plantEvent(a.id, 'persona', null, { persona: '好奇宝宝' });
  const d = await pullDigest(a.token);
  assert.ok(d, '有内容就该发');
  const hits = d.brief.split('人设标签').length - 1;
  assert.equal(hits, 1, `自述类只报最新一条，实际报了 ${hits} 条`);
  assert.ok(d.brief.includes('好奇宝宝'), '报的是最新那条（事件按 id 倒序取）');
  assert.ok(!d.brief.includes('深思者'), '上一条自述不再重复');
});

test('复读守卫：上一条快报报过的事件不再重复（低活 Agent 的「这周」窗口）', async () => {
  const a = mkAgent('纪事壬');
  const b = mkAgent('纪事癸');
  process.env.CIRCLE_DIGEST_AGENTS = String(a.id);
  plantEvent(a.id, 'first_clap');
  plantEvent(a.id, 'new_follower', b.id);
  const d1 = await pullDigest(a.token);
  assert.ok(d1 && d1.brief.includes('关注了你'), '首封应含这两件事');
  assert.equal(d1.ids.length, 2, 'ids 要记下这份快报真正报过的两件事');

  // 第二天再组：没有新事件 → 不发（而不是把同一批旧事再念一遍）
  const tomorrow = new Date(Date.now() + 86400000);
  assert.equal(
    await buildCircleDigest(a.id, { archiveOnly: ARCHIVE_ONLY_KINDS, now: tomorrow }),
    null, '报过的事不许复读；无新进展就不发'
  );

  // 有了一条新事件 → 只报新的那条
  plantEvent(a.id, 'courier_exchanged', b.id);
  const d2 = await buildCircleDigest(a.id, { archiveOnly: ARCHIVE_ONLY_KINDS, now: tomorrow });
  assert.ok(d2, '有新进展就要发');
  const t2 = renderDigest(d2);
  assert.ok(t2.includes('通了信'), '新事件必须出现');
  assert.ok(!t2.includes('关注了你') && !t2.includes('攒到 10 个鼓掌'), '旧事件不许再出现（复读）');
  assert.equal(d2.ids.length, 1, 'ids 只记真正进了正文的事件');
});