// server/tests/dongai-migrate.test.js — v0.22「懂AI知识迁移 + 悬赏认领」端到端契约。
// 盯三条红线（设计稿 §6）：
//   1. 萃取零背书：迁移 stub 落库必须停在 state='stub'、cur_rev=NULL——平台预置的内容永远不可被引用；
//      scope=answer 读不到它，悬赏池读得到它。
//   2. 跃迁只归 Agent：首个带可核验官方来源的 propose_revision 触发「空 stub sourced 自证」，
//      点亮 sourced 且署名（curator）随合并落到提交者。
//   3. 降级路径确定性：feed 不可达 / LLM 不可用都只记台账、绝不抛错、绝不产出条目。
process.env.DB_DRIVER = 'sqlite';

import './env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import request from 'supertest';

import db from '../database/db.js';
import { config } from '../config/index.js';
import { signAgentToken } from '../middleware/auth.js';
import ownersRouter from '../routes/owners.js';
import agentsRouter from '../routes/agents.js';
import entriesRouter from '../routes/entries.js';
import { createCuratedStub, listBounties, dongaiPoolFullToday } from '../services/entryService.js';
import { runDongaiCurate, recentCurateJobs } from '../services/dongaiCurator.js';

const OFFICIAL = 'https://support.microsoft.com/office/pivot-table'; // 官方域白名单：写时可信、免网络探测
const humanToken = (uid) => jwt.sign({ uid, username: 'owner' }, config.jwtSecret, { expiresIn: '1d' });

const app = express();
app.use(express.json({ limit: '6mb' }));
app.use('/api/owners', ownersRouter);
app.use('/api/agents', agentsRouter);
app.use('/api/entries', entriesRouter);

async function registerAgent(name, aiModel) {
  const username = `owner_${crypto.randomBytes(4).toString('hex')}`;
  const o = await db.run(
    `INSERT INTO users (username, password_hash, nickname, user_type) VALUES (?, '', ?, 'human')`,
    [username, '萧盛'],
  );
  const ownerId = Number(o.lastInsertRowid);
  const codeRes = await request(app)
    .post('/api/owners/binding-code')
    .set('Authorization', `Bearer ${humanToken(ownerId)}`)
    .expect(201);
  const res = await request(app)
    .post('/api/agents/register')
    .send({ bindingCode: codeRes.body.code, name, aiModel })
    .expect(201);
  return res.body;
}

let agentA; // {token, agentId}
let stubId; // 迁移造的悬赏 stub

test('setup：建表 + 注册认领者 Agent', async () => {
  await db.ensureEntriesTables();
  agentA = await registerAgent('甲之Agent', 'lineageA');
  assert.ok(agentA.token);
});

test('不变量①：createCuratedStub 落库为 stub 且 cur_rev=NULL（平台侧永不产出可引用态）', async () => {
  const r = await createCuratedStub({
    domain: 'office',
    title: 'Excel 数据透视表怎么做（懂AI迁移样例）',
    summaryMd: '选中数据源 → 插入 → 数据透视表。',
    originUrl: 'https://dong.xs91.com/archives/9999.html',
    candidateUrls: [OFFICIAL, 'javascript:alert(1)'], // 第二条必须被兜底滤掉
  });
  assert.ok(!r.error && r.id, '正常入池');
  stubId = r.id;
  const row = await db.get(`SELECT * FROM entries WHERE id = ?`, [stubId]);
  assert.equal(row.state, 'stub');
  assert.equal(row.source, 'dongai');
  assert.equal(row.cur_rev, null, '迁移 stub 绝不预置 revision——否则 sourced 自证会被平台自己触发');
  assert.equal(row.origin_url, 'https://dong.xs91.com/archives/9999.html');
  assert.ok(String(row.body_md).includes(OFFICIAL) && !String(row.body_md).includes('javascript:'), '候选链接进正文导语且非 http(s) 被滤');

  // 读侧：可引用检索拿不到它；悬赏池拿得到
  const ans = await request(app).get('/api/entries?scope=answer&q=懂AI迁移样例').expect(200);
  assert.ok(!ans.body.entries.some((e) => e.id === stubId), 'stub 不可被答题引用');
  const bs = await request(app).get('/api/entries/bounties?source=dongai').expect(200);
  const hit = bs.body.bounties.find((b) => b.id === stubId);
  assert.ok(hit, 'GET /bounties 路由不被 /:idOrSlug 吞、按 source 过滤可命中');
  assert.equal(hit.originUrl, 'https://dong.xs91.com/archives/9999.html');

  // ai_gap 也进池（raiseGap 现在带 source 标记）
  await request(app)
    .post('/api/entries/gap')
    .set('Authorization', `Bearer ${agentA.token}`)
    .send({ domain: 'office', question: 'WPS 演示怎么导出 GIF（缺口样例）' })
    .expect(201);
  const all = await request(app).get('/api/entries/bounties').expect(200);
  assert.ok(all.body.bounties.some((b) => b.source === 'dongai' && b.state === 'stub'));
  assert.ok(all.body.bounties.some((b) => b.source === 'ai_gap' && b.state === 'stub'));

  // 2026-09-21 实测修正：懂AI 正文常无外链——「无候选链接」的悬赏也必须合法入池（降级形态，红线不变）
  const bare = await createCuratedStub({
    domain: 'agents', title: 'MiniMax CLI 终端装法（无链接样例）',
    summaryMd: 'curl 安装脚本 → 配置 key → 直接开聊。',
    originUrl: 'https://dong.xs91.com/archives/10692.html', candidateUrls: [],
  });
  assert.ok(!bare.error && bare.id, '无候选链接不再拒收（no_candidate_url 已废除）');
  const bareRow = await db.get(`SELECT body_md FROM entries WHERE id = ?`, [bare.id]);
  assert.ok(String(bareRow.body_md).includes('未预置候选来源'), '导语改为「自行找一手官方来源」');
});

test('不变量②：Agent 核验后 propose_revision → sourced 自证合并、署名归 Agent', async () => {
  const res = await request(app)
    .post(`/api/entries/${stubId}/revisions`)
    .set('Authorization', `Bearer ${agentA.token}`)
    .send({
      bodyMd: '选中数据源 →「插入」→「数据透视表」→ 字段拖入行/列/值。改源数据后右键刷新。',
      claims: [{ text: '微软官方：插入数据透视表', verified_against: { url: OFFICIAL } }],
    })
    .expect(201);
  assert.equal(res.body.merged, true, '空 stub + 官方域白名单来源应即时自证合并');
  const e = await request(app).get(`/api/entries/${stubId}`).expect(200);
  assert.equal(e.body.entry.state, 'sourced');
  assert.equal(e.body.entry.curatorAgentId, agentA.agentId, '署名随合并落到补全者，不是平台');
  assert.equal(e.body.entry.source, 'dongai', '素材回链属性保留');
  const bs = await request(app).get('/api/entries/bounties').expect(200);
  assert.ok(!bs.body.bounties.some((b) => b.id === stubId), '补全后自动离开悬赏池');

  // 0.22.x 待印证队列：state=sourced 专查能命中、state=corroborated 不含；署名随读口直出（JOIN users）
  const sq = await request(app).get('/api/entries?scope=answer&state=sourced&q=懂AI迁移样例').expect(200);
  const hit = sq.body.entries.find((e) => e.id === stubId);
  assert.ok(hit, 'state=sourced 应命中待印证条目');
  assert.equal(hit.curatorName, '甲之Agent', '读口直接带出补全者名，AI 不必反查');
  assert.ok(hit.curRev, 'curRev 随行（endorse 的 revisionId 参数照抄即用）');
  const cq = await request(app).get('/api/entries?scope=answer&state=corroborated&q=懂AI迁移样例').expect(200);
  assert.ok(!cq.body.entries.some((e) => e.id === stubId), 'corroborated 过滤不应含 sourced 条目');
});

test('不变量③：内部居民 raise_gap 不外发广场帖（平台不制造自家广场噪音）', async () => {
  const u = await db.run(
    `INSERT INTO users (username, password_hash, nickname, user_type, owner_id, is_external)
     VALUES ('daopao', '', '大炮', 'ai', NULL, 0)`,
  );
  const agentId = Number(u.lastInsertRowid);
  await db.run(
    `INSERT INTO agent_profiles (user_id, title, domains, writing_style, article_count, total_views, is_active, preset_id)
     VALUES (?, '大炮', '[]', '', 0, 0, 1, NULL)`,
    [agentId],
  );
  const tok = signAgentToken({ id: agentId, token_version: 1 });
  const res = await request(app)
    .post('/api/entries/gap')
    .set('Authorization', `Bearer ${tok}`)
    .send({ domain: 'office', question: '大炮试补：某官方站目录缺口样例' })
    .expect(201);
  assert.equal(res.body.bountyPosted, false, '内部居民的缺口只入库，不去广场发帖');
  const bs = await request(app).get('/api/entries/bounties?source=ai_gap').expect(200);
  assert.ok(bs.body.bounties.some((b) => b.id === res.body.id), '但仍进悬赏池读口，正常可被认领');
});

test('不变量④：feed 不可达 / LLM 不可用 → 只记台账不抛错、0 产出，failed 可重跑', async () => {
  const origFetch = globalThis.fetch;
  const llmKeys = ['LLM_VOLCENGINE_API_KEY', 'DEEPSEEK_API_KEY', 'LLM_DEEPSEEK_API_KEY', 'LLM_XIAOMI_API_KEY', 'XIAOMI_TOKEN_PLAN_CN_API_KEY'];
  const saved = {};
  for (const k of llmKeys) { saved[k] = process.env[k]; delete process.env[k]; }
  const before = (await listBounties({ source: 'dongai', limit: 20 })).bounties.length;
  try {
    // ① feed 挂了
    globalThis.fetch = async () => ({ ok: false, text: async () => '' });
    const r1 = await runDongaiCurate({ limit: 3 });
    assert.equal(r1.error, 'feed_unreachable', '拉不到 RSS 如实报，不抛错');

    // ② feed 正常、LLM 无 key → 每篇 llm_unavailable，零产出
    let seq = 0; // 两篇链接必须互异：origin_url 是 UNIQUE，时间戳同毫秒会撞
    const feed = [
      '<rss><channel>',
      ...['透视表新编', '会议纪要模板'].map((t) =>
        `<item><title>${t}</title><link>https://dong.xs91.com/archives/${Date.now()}-${++seq}.html</link>` +
        `<category>工具教程</category><content:encoded><![CDATA[<p>用透视表汇总 <a href="${OFFICIAL}">微软官方说明</a></p>${'步骤'.repeat(600)}]]></content:encoded></item>`,
      ).join(''),
      '</channel></rss>',
    ].join('');
    globalThis.fetch = async () => ({ ok: true, text: async () => feed });
    const r2 = await runDongaiCurate({ limit: 3 });
    assert.equal(r2.checked, 2, '两个目标类目 item 都进了处理');
    assert.equal(r2.stubs, 0);
    assert.ok(r2.failed.every((f) => f.reason === 'llm_unavailable'), 'LLM 全供应商无 key → 各篇标 llm_unavailable');
    const after = (await listBounties({ source: 'dongai', limit: 20 })).bounties.length;
    assert.equal(after, before, '降级路径零产出');
    const jobs = await recentCurateJobs({ limit: 10 });
    assert.equal(jobs.jobs.length, 2);
    assert.equal(jobs.jobs[0].state, 'failed');

    // ③ failed 允许重试：再跑一遍仍是 llm_unavailable（不会被当成已处理跳过）
    const r3 = await runDongaiCurate({ limit: 3 });
    assert.equal(r3.failed.length, 2, 'failed 不在跳过名单');
    assert.ok(await dongaiPoolFullToday() === false, '本日入池 0 条，未触顶');
  } finally {
    globalThis.fetch = origFetch;
    for (const k of llmKeys) { if (saved[k] !== undefined) process.env[k] = saved[k]; }
  }
});
