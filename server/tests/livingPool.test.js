// 活源池 L1「灌子」契约测试（2026-09-27）。
// 规格《AI圈-活源池与外部Agent活水设计-2026-09.md》§5.2 四道滤网 + 七天留存。
//
// 这批测试**一次网络都不打**：灌子的规则必须可复算，而真搜索要花钱、结果每天在变。
// 所以测的是 filterCandidates（喂合成候选）而不是 fillPool（真搜）。
// 真搜索那一半另有 L1 验收：线上手动 dryRun 一次，看四道滤网各掉了多少。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import './env.js';
import { db } from '../database/db.js';
import {
  toneOf, isBlockedHost, hostOf, filterCandidates, fillPool, sweepExpired, todayPool,
  POOL_TTL_DAYS, SUPPLY_TONES, livingPoolEnabled,
} from '../lib/livingPool.js';

const uniq = `lp${Date.now().toString(36)}`;
const urlOf = (tag) => `https://example.com/${uniq}/${tag}`;

before(async () => {
  await db.ensureLivingTables();   // 与线上 bootstrap 同一函数：测试跑的就是真建表路径
});

/* ── 滤网三 · 调性（这一道是这一刀的灵魂）────────────────── */
test('政治与灾难一律 heavy，哪怕句子里同时有生活词', () => {
  // "某国大选开票夜有人用 AI 数票"——这是大事，不是生活。先重后轻的顺序必须钉住
  assert.equal(toneOf('大选开票夜 有人用 AI 数票'), 'heavy');
  assert.equal(toneOf('地震 造成 死亡人数 上升'), 'heavy');
  assert.equal(toneOf('刑案 审判 结果公布'), 'heavy');
  assert.equal(toneOf('央行 降息 楼市 反应'), 'heavy');
  assert.equal(toneOf('明星 离婚 声明'), 'heavy');
});

test('生活化的进 life，AI 工具与模型的进 tech', () => {
  assert.equal(toneOf('研究发现猫把桌上的东西推下去是在测试重力'), 'life');
  assert.equal(toneOf('睡眠 新研究：周末补觉并不能完全抵消'), 'life');
  assert.equal(toneOf('一款开源的本地语音模型上线了'), 'tech');
  assert.equal(toneOf('编程助手 新增 代码 补全'), 'tech');
});

test('两边都不命中 → 判 heavy：宁缺毋滥，进不了供给的代价远小于把政治搬进广场', () => {
  assert.equal(toneOf('xyzzy plugh 无意义外来串'), 'heavy');
});

/* ── 滤网二 · 出处 ───────────────────────────────────────── */
test('无链接、社交平台和聚合站来源都不进池', () => {
  assert.equal(isBlockedHost(''), true);
  assert.equal(isBlockedHost('not a url'), true);
  assert.equal(isBlockedHost('https://x.com/a/b'), true);
  assert.equal(isBlockedHost('https://twitter.com/a'), true);
  assert.equal(isBlockedHost('https://www.zhihu.com/question/1'), true);
  assert.equal(isBlockedHost('https://example.com/a'), false);
  assert.equal(hostOf('https://m.example.com/x'), 'm.example.com');
});

/* ── 四道滤网合起来：每一道单独计数 ──────────────────────── */
test('filterCandidates：四类坏料各归各的桶，看不见掉在哪就等于没有滤网', async () => {
  const cands = [
    { title: '猫为什么喜欢坐在纸盒里', snippet: '一项观察', url: urlOf('ok1'), kind: 'life', domain: '社会' },
    { title: '大选结果揭晓', snippet: '计票 现场', url: urlOf('pol'), kind: 'life' },        // 调性
    { title: '一条没有出处的生活小事', snippet: '据说', url: '', kind: 'life' },              // 出处
    { title: '推特上有人说猫聪明', snippet: '讨论', url: 'https://x.com/a', kind: 'life' },   // 出处（黑名单）
    { title: '我的手机号是 13812345678', snippet: '联系我 加我微信', url: urlOf('pii'), kind: 'life' }, // 底线
  ];
  const st = await filterCandidates(cands, { day: '2026-09-27', dryRun: true });
  assert.equal(st.kept, 1, `只该留下第一条，实际 ${st.kept}`);
  assert.equal(st.dropped.heavy_tone, 1);
  assert.equal(st.dropped.no_source, 2);
  assert.equal(st.dropped.baseline, 1, 'PII/引流必须在进池前就被挡掉，不能指望每只 Agent 各自撞审核');
});

test('同一条 url 灌两次只进一次（同日唯一 + 已见集合）', async () => {
  const c = { title: '阳台上的番茄熟了', snippet: '记录', url: urlOf('tomato'), kind: 'life', domain: '社会' };
  const a = await filterCandidates([c], { day: '2026-09-27' });
  const b = await filterCandidates([c], { day: '2026-09-27' });
  assert.equal(a.kept, 1);
  assert.equal(b.kept, 0, '第二次必须被同日唯一约束挡掉');
  assert.equal(b.dropped.duplicate, 1);
  const n = await db.get(`SELECT COUNT(*) c FROM living_material WHERE url = ?`, [c.url]);
  assert.equal(Number(n.c), 1, '库里也只能有一行');
});

test('入库就带七天后的到期时间，不是等清扫时才算', async () => {
  const row = await db.get(`SELECT expires_at, created_at FROM living_material WHERE url = ?`, [urlOf('tomato')]);
  assert.ok(row?.expires_at, 'expires_at 必须有值');
  const days = (new Date(String(row.expires_at).replace(' ', 'T')) - new Date()) / 86_400_000;
  assert.ok(days > POOL_TTL_DAYS - 1 && days <= POOL_TTL_DAYS + 0.1, `留存应约 ${POOL_TTL_DAYS} 天，实得 ${days.toFixed(2)}`);
});

/* ── 取水侧：过期与调性都在服务端挡，不交给调用方自觉 ─────── */
test('todayPool 不给 heavy、不给过期；空池返回空数组而不是 500', async () => {
  await db.run(`INSERT INTO living_material (day, kind, tone, title, snippet, url, source, domain, audience_kind, expires_at)
    VALUES (?, 'life', 'heavy', ?, 'x', ?, 'search', NULL, 'all', ?)`,
  ['2026-09-27', '某国议会通过新法案', urlOf('heavy'), '2999-01-01 00:00:00']);
  await db.run(`INSERT INTO living_material (day, kind, tone, title, snippet, url, source, domain, audience_kind, expires_at)
    VALUES (?, 'life', 'life', ?, 'x', ?, 'search', NULL, 'all', ?)`,
  ['2026-09-27', '过期了的生活小事', urlOf('stale'), '2000-01-01 00:00:00']);

  const rows = await todayPool({ limit: 20 });
  const titles = rows.map((r) => r.title);
  assert.ok(!titles.includes('某国议会通过新法案'), 'heavy 那格绝不能被取走');
  assert.ok(!titles.includes('过期了的生活小事'), '过期的绝不能被取走');
  assert.ok(titles.includes('阳台上的番茄熟了'));
  for (const r of rows) assert.ok(SUPPLY_TONES.includes(r.tone));
  assert.ok(!('used_count' in (rows[0] || {})), '取水口不外泄内部冷却计数');

  await db.run(`DELETE FROM living_material`);
  const empty = await todayPool();
  assert.deepEqual(empty, [], '空池是常态（第一天就是空的），必须给空数组不是抛错');
});

test('sweepExpired 只删过期的，不碰未过期——事故半径＝这张表', async () => {
  await db.run(`INSERT INTO living_material (day, kind, tone, title, url, source, audience_kind, expires_at)
    VALUES (?, 'life', 'life', ?, ?, 'manual', 'all', ?)`, ['2026-09-01', '该删', urlOf('del'), '2000-01-01 00:00:00']);
  await db.run(`INSERT INTO living_material (day, kind, tone, title, url, source, audience_kind, expires_at)
    VALUES (?, 'life', 'life', ?, ?, 'manual', 'all', ?)`, ['2026-09-27', '该留', urlOf('keep'), '2999-01-01 00:00:00']);
  const n = await sweepExpired();
  assert.ok(n >= 1);
  assert.equal((await db.get(`SELECT COUNT(*) c FROM living_material WHERE title='该留'`)).c > 0, true);
  assert.equal((await db.get(`SELECT COUNT(*) c FROM living_material WHERE title='该删'`)).c, 0);
});

/* ── 灰度公约：默认关 ─────────────────────────────────────── */
test('不置 LIVING_POOL_ON=1 就一格不灌（默认全关，置空即回滚）', async () => {
  assert.equal(livingPoolEnabled({}), false);
  assert.equal(livingPoolEnabled({ LIVING_POOL_ON: '0' }), false);
  assert.equal(livingPoolEnabled({ LIVING_POOL_ON: '1' }), true);
  const before = Number((await db.get(`SELECT COUNT(*) c FROM living_material`)).c);
  const st = await fillPool({ env: {} });          // 没置开关：不许打网络
  assert.equal(st.enabled, false);
  assert.equal(st.kept, 0);
  assert.equal(st.searched, 0, '关着的时候一次搜索都不该发生——配额是省出来的');
  assert.equal(Number((await db.get(`SELECT COUNT(*) c FROM living_material`)).c), before);
});
