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
  toneOf, isBlockedHost, hostOf, stripBreadcrumb, isJunkTitle,
  filterCandidates, fillPool, sweepExpired, todayPool, searchBudget,
  blindboxEligible, pickBlindbox, todayBlindbox, isStale,
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

test('词表三个洞（线上池子里真看出来的）：单字"信""书"太宽、党务职务词缺失、机构系统名当标题', () => {
  // 洞一：'书记' 里含 '书'，旧词表会把党务新闻判成生活——先重后轻必须先把这类词收进 HEAVY
  assert.equal(toneOf('市委书记调研基层文化生活'), 'heavy');
  // 洞二：'信息' 里含 '信'、'证书' 里含 '书'，单字不能当生活词
  assert.equal(toneOf('信息提示 与 证书 打印 服务'), 'heavy', '两边都不命中时保守判 heavy');
  // 单字'家'更危险：'国家''专家''科学家'全命中，一条时政稿会被当成生活话题
  assert.equal(toneOf('国家卫健委邀请专家座谈'), 'heavy');
  assert.equal(toneOf('晚上给自己写封信，读读书'), 'life', '收成双字之后，真生话的还得认得出来');
  // 洞三：机构/系统名不是话题（实跑混进过「中国疾病预防控制中心科技文献服务系统」）
  assert.equal(isJunkTitle('中国疾病预防控制中心科技文献服务系统'), true);
  assert.equal(isJunkTitle('某市政务数据管理平台入口'), true);
});

/* ── 滤网二 · 出处与标题质量（线上实跑抓到的三类脏东西）────── */
test('站名不是内容：面包屑里的"政府"不得把一篇生活文误杀成政治', () => {
  const real = '被嫌弃的7个懒人行为 原来一直在悄悄保护你!_信息提示_首都之窗_北京市人民政府门户网站';
  assert.equal(toneOf(real), 'heavy', '不剥面包屑时它确实被误杀——这就是当初线上跑出来的结果');
  assert.equal(stripBreadcrumb(real).includes('政府'), false, '站名段必须被剥掉');
  assert.equal(toneOf(`${stripBreadcrumb(real)} 这些懒人动作其实一直在保护你的身体`), 'life');
});

test('垃圾标题不进池：占位、changelog 碎片、SEO 农场', () => {
  assert.equal(isJunkTitle('Untitled'), true);
  assert.equal(isJunkTitle('Best AI Tools'), true);              // 没有可聊的信息量
  assert.equal(isJunkTitle('九州下载安装创世全面升级'), true);        // 农场特征词
  assert.equal(isJunkTitle('健康知识科普宣传'), true);
  assert.equal(isJunkTitle(''), true);
  assert.equal(isJunkTitle('研究发现猫把桌上的东西推下去是在测试重力'), false);
});

test('每个主题词封顶两条：池子肥了不会更好聊（宁保命不保量）', async () => {
  const same = (n) => Array.from({ length: n }, (_, i) => ({
    title: `阳台上的番茄熟了 第${i}篇观察记录`, snippet: '生活记录', url: urlOf(`cap${i}`), kind: 'life', qi: 0,
  }));
  const st = await filterCandidates(same(5), { day: '2026-09-27', dryRun: true, maxPerQuery: 2 });
  assert.equal(st.kept, 2, `一个主题词最多留 2 条，实得 ${st.kept}`);
  assert.equal(st.dropped.over_cap, 3);
});

test('四道滤网各自计数：一条坏料只进它该进的那个桶', async () => {
  const cands = [
    { title: '猫为什么喜欢坐在纸盒里', snippet: '一项观察', url: urlOf('ok1'), kind: 'life', domain: '社会' },
    { title: '大选结果揭晓', snippet: '计票 现场', url: urlOf('pol'), kind: 'life' },        // 调性
    { title: '一条没有出处的生活小事', snippet: '据说', url: '', kind: 'life' },              // 出处
    { title: '推特上有人说猫聪明', snippet: '讨论', url: 'https://x.com/a', kind: 'life' },   // 出处（黑名单）
    { title: 'Untitled', snippet: '生活', url: urlOf('junk'), kind: 'life' },                 // 出处（垃圾标题）
    { title: '我的手机号是 13812345678', snippet: '联系我 加我微信', url: urlOf('pii'), kind: 'life' }, // 底线
  ];
  const st = await filterCandidates(cands, { day: '2026-09-27', dryRun: true });
  assert.equal(st.kept, 1, `只该留下第一条，实际 ${st.kept}`);
  assert.equal(st.dropped.heavy_tone, 1);
  assert.equal(st.dropped.no_source, 3, '无链接 / 黑名单站 / 垃圾标题都归出处这一道');
  assert.equal(st.dropped.baseline, 1, 'PII 与引流必须在进池前就被挡掉，不能指望每只 Agent 各自撞审核');
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

test('存进池子的标题必须是剥过站名的——Agent 会把标题原样接进她的帖子', async () => {
  const dirty = '烟火伴月圆 秦安城乡共享团圆美好_五彩秦安';
  await filterCandidates([{ title: dirty, snippet: '中秋假期 城市 街道 挂满灯笼', url: urlOf('bc'), kind: 'life', domain: '文化' }], { day: '2026-09-27' });
  const row = await db.get(`SELECT title FROM living_material WHERE url = ?`, [urlOf('bc')]);
  assert.equal(row.title, '烟火伴月圆 秦安城乡共享团圆美好', `站名尾巴没剥掉：「${row.title}」`);
  // 真副标题不能被误砍：' - ' 后面超过 12 字的当副标题保留
  assert.equal(stripBreadcrumb('小度发布超能小度 - 全系全量全生态上线重塑人机交互新体验'), '小度发布超能小度 - 全系全量全生态上线重塑人机交互新体验');
  assert.equal(stripBreadcrumb('某篇稿子 - 中国日报网'), '某篇稿子');
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

test('引号整对删、不留空洞也不留半边：线上真出现过「花馍中“揉 出石榴籽情」', () => {
  assert.equal(stripBreadcrumb('多民族邻里在花馍中“揉出石榴籽情”_庆春社区'), '多民族邻里在花馍中揉出石榴籽情');
  assert.equal(stripBreadcrumb('它说「明天见」 - 一个很短的站名'), '它说明天见');
  assert.equal(stripBreadcrumb('“左引号没配对'), '左引号没配对');
});

test('🔴 七天留存只管我们存多久，不管内容本身几年前——旧闻不进池（线上真灌进过 2025-07 与端午稿）', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');
  assert.equal(isStale('2025-07-30T08:00:00+08:00', now), true, '两年前的稿必须判旧');
  assert.equal(isStale('2026-06-17T00:00:00+08:00', now), true, '端午的稿子九月不该当活水');
  assert.equal(isStale('2026-09-25T00:00:00+08:00', now), false, '两天内的算新');
  assert.equal(isStale('', now), false, '上游没给日期就放行——不能因为字段缺失把整池子饿死');
  assert.equal(isStale('不是个日期', now), false, '坏值同样放行，不炸');
  assert.equal(isStale('2027-01-01T00:00:00Z', now), false, '未来时间戳不按"旧"处理');
});

test('旧闻在滤网里单独记一格 stale，不许混进 no_source 或 heavy', async () => {
  const st = await filterCandidates([
    { title: '中秋夜 城乡共享团圆美好', snippet: '城市 街道 挂满灯笼', url: urlOf('old'), publishedAt: '2024-01-01T00:00:00Z' },
  ], { day: '2026-09-27', dryRun: true });
  assert.equal(st.kept, 0);
  assert.equal(st.dropped.stale, 1, `旧闻该记进 stale 桶：${JSON.stringify(st.dropped)}`);
});

/* ── L2.5 盲盒：一件、人人同一件、一天一换 ─────────────────── */
test('能当盲盒的只有"轻、一句话能接"的生活小事：发布稿与 AI 动态都不进盒', () => {
  assert.equal(blindboxEligible('猫为什么喜欢坐在纸盒里', '一项关于宠物行为的观察'), true);
  assert.equal(blindboxEligible('某平台正式发布新一代多模态系统', '官方公告'), false);   // 硬词
  assert.equal(blindboxEligible('周末在家煮一壶茶', '秋天的第一壶'), true);
  assert.equal(blindboxEligible('一款开源语音模型上线了', '支持中文'), false);           // AI 动态归 ai_news
  assert.equal(blindboxEligible('很长很长很长很长很长很长很长很长很长很长很长很长很长的一个标题超过二十四个汉字就不适合当盲盒了', '生活'), false);
});

test('今日一件必须是**确定性**选取：同一 day 谁算都同一件，打乱候选顺序也不变', () => {
  const rows = [
    { id: 11, title: '甲' }, { id: 12, title: '乙' }, { id: 13, title: '丙' },
    { id: 14, title: '丁' }, { id: 15, title: '戊' },
  ];
  const first = pickBlindbox(rows, '2026-09-27');
  assert.ok(first, '有候选时必须给出一件');
  for (let i = 0; i < 8; i++) {
    const shuffled = [...rows].sort(() => Math.random() - 0.5);
    assert.equal(pickBlindbox(shuffled, '2026-09-27').id, first.id, '顺序一变就换件=每只 Agent 抽到不同的');
  }
  assert.equal(pickBlindbox(rows, '2026-09-27').id, first.id, '同一天重算必须同一件（一天一换，不是刷新重试）');
  assert.notEqual(pickBlindbox(rows, '2026-09-28').id, undefined, '换一天也该给出一件');
  assert.equal(pickBlindbox([], '2026-09-27'), null, '池子空时不硬造');
});

test('todayBlindbox 只给标了 blindbox 且没过七天的那几格', async () => {
  await db.run(`DELETE FROM living_material`);
  // 必须 await：db.run 是异步的，不 await 就会在测试结束后才落库，
  // 撞了 UNIQUE 也只以 unhandledRejection 冒出来——报的是"上一个测试"，最难查的那种假错。
  const put = (tag, title, kind, expires) => db.run(
    `INSERT INTO living_material (day, kind, tone, title, snippet, url, source, domain, audience_kind, expires_at)
     VALUES ('2026-09-27', ?, 'life', ?, '生活', ?, 'search', '社会', 'all', ?)`,
    [kind, title, `https://example.com/${uniq}/bx-${tag}`, expires]);
  await put('hit', '该被抽到的那件小事', 'blindbox', '2999-01-01 00:00:00');
  await put('stale', '过期的那件', 'blindbox', '2000-01-01 00:00:00');
  await put('plain', '没升标的普通水', 'life', '2999-01-01 00:00:00');
  const one = await todayBlindbox({ day: '2026-09-27' });
  assert.equal(one.title, '该被抽到的那件小事');
});

/* ── 搜索记账：共享配额的唯一依据 ─────────────────────────── */
test('searchBudget 数得清这个月烧了几次；额度将尽时 fillPool 自己收手，不打网络', async () => {
  await db.run(`DELETE FROM search_calls`);
  const b0 = await searchBudget();
  assert.equal(b0.used, 0);
  assert.equal(b0.left, b0.budget);
  await db.run(`INSERT INTO search_calls (day, month, purpose, query, hits, kept, ms, ok)
    VALUES ('2026-09-27', '2026-09', 'pool', 'q', 8, 2, 120, 1)`);
  const b1 = await searchBudget();
  assert.equal(b1.used, 1, '记了一笔却没数到');

  // 把额度压到比一轮还少：必须整轮不灌（真烧光会连带挂掉问答与大脑），且一次搜索都不发
  process.env.SEARCH_MONTH_BUDGET = '2';
  process.env.LIVING_POOL_ON = '1';
  try {
    const st = await fillPool({ day: '2026-09-27' });
    assert.equal(st.kept, 0, '额度不够还照灌');
    assert.equal(st.searched, 0, '额度不够时一次搜索都不该发出去');
    assert.ok((st.notes || []).some((n) => n.includes('额度')), `没收手的理由没写进 notes：${JSON.stringify(st.notes)}`);
  } finally {
    delete process.env.SEARCH_MONTH_BUDGET;
    delete process.env.LIVING_POOL_ON;
  }
});
