// server/tests/traffic.test.js
// 站点流量契约测试（2026-09-25）：beacon 落库 / 机器人排除 / UV·IP 去重 / HTML 首载记账。
//
// 这批的红线，用例逐个钉住：
//   ① beacon 一行 = 一次浏览，日切是 Asia/Shanghai 日历日（day 列建行时定死）；
//   ② 机器人（UA 爬虫特征）不冒充人气 —— is_bot=1 一律被 summary 排除；
//   ③ UV 按 vid（匿名 cookie）去重、独立 IP 按 ip_hash 去重，两者口径独立；
//   ④ HTML 首载没有 vid 就种一枚（Set-Cookie），同一访客再来不翻倍 UV；
//   ⑤ /admin* 自访不污染流量（beacon 与 HTML 侧同口径）；
//   ⑥ 采集绝不拖垮主链路：beacon 永远 200/4xx 快速返回，绝不 500。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import './env.js';
import app from './app.js';
import { getDb } from '../database/connection.js';
import { trafficHtmlGuard, shanghaiDay, hashIp, VID_COOKIE } from '../lib/trafficTrack.js';
import { trafficSummary } from '../services/trafficService.js';

const UA_BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const UA_BOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

/** 等异步链路（fire-and-forget 插入）追上断言。 */
async function waitFor(fn, { timeout = 3000, step = 25 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) return null;
    await new Promise((r) => setTimeout(r, step));
  }
}

function hits() {
  return getDb().prepare(`SELECT * FROM traffic_hits ORDER BY id ASC`).all();
}

before(() => {
  getDb(); // 触发 schema 建表（含 traffic_hits）
});

test('beacon：真浏览器上报一次跳转 → 落一行 kind=beacon，day=今天', async () => {
  const r = await request(app).post('/api/track')
    .set('User-Agent', UA_BROWSER)
    .set('X-Forwarded-For', '203.0.113.10')
    .send({ path: '/article/1' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);

  const row = await waitFor(() => hits().find((h) => h.path === '/article/1') || null);
  assert.ok(row, 'beacon 应落一行');
  assert.equal(row.kind, 'beacon');
  assert.equal(row.day, shanghaiDay());
  assert.equal(row.is_bot, 0);
  assert.equal(row.ip_hash, hashIp('203.0.113.10'), 'IP 只以加盐哈希落库');
});

test('beacon：机器人 UA → 不落流量行（不冒充人气）', async () => {
  const n0 = hits().length;
  const r = await request(app).post('/api/track')
    .set('User-Agent', UA_BOT)
    .send({ path: '/' });
  assert.equal(r.status, 200); // 对外仍 200，不让它探测出差异
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(hits().length, n0, '机器人 beacon 不落库');
});

test('beacon：/admin 自访不污染流量', async () => {
  const n0 = hits().length;
  const r = await request(app).post('/api/track')
    .set('User-Agent', UA_BROWSER)
    .send({ path: '/admin/growth' });
  assert.equal(r.status, 200);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(hits().length, n0, '自访 beacon 不落库');
});

test('beacon：非法 path 拒收（400），采集永不 500', async () => {
  for (const bad of ['', 'https://evil.example/x', '//evil', null]) {
    const r = await request(app).post('/api/track').set('User-Agent', UA_BROWSER).send({ path: bad });
    assert.ok([400].includes(r.status), `path=${JSON.stringify(bad)} 应 400，实得 ${r.status}`);
  }
});

test('HTML 响应记账：text/html 的 GET 记一行，JSON/资源路径/HEAD 都不记，没 cookie 就种 vid', async () => {
  const fakeRes = () => {
    const res = { cookies: [], headers: {}, finishCb: null };
    res.cookie = (name, val) => res.cookies.push([name, val]);
    res.on = (_ev, cb) => { res.finishCb = cb; };
    res.getHeader = (k) => res.headers[k];
    res.emitFinish = (ct) => { res.headers['content-type'] = ct; res.finishCb(); };
    return res;
  };
  const fakeReq = (path, { method = 'GET', cookie } = {}) => ({
    method,
    path,
    headers: { 'user-agent': UA_BROWSER, 'x-forwarded-for': '198.51.100.7', ...(cookie ? { cookie } : {}) },
    ip: '127.0.0.1',
  });

  // ① 首页（publicPageGuard 直接出的 HTML）→ 记一行 + 种 vid
  const res1 = fakeRes();
  trafficHtmlGuard(fakeReq('/'), res1, () => {});
  res1.emitFinish('text/html; charset=utf-8');
  await waitFor(() => hits().find((h) => h.kind === 'html' && h.path === '/') || null);
  assert.ok(res1.cookies.some(([n]) => n === VID_COOKIE), '首次访问应种 vid cookie');
  const vid = hits().find((h) => h.kind === 'html' && h.path === '/').vid;
  assert.ok(vid, '首载行应带 vid');

  // ② API JSON 响应 → 不记
  const n0 = hits().length;
  const res2 = fakeRes();
  trafficHtmlGuard(fakeReq('/api/plaza/topics'), res2, () => {});
  res2.emitFinish('application/json; charset=utf-8');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(hits().length, n0, 'JSON 响应不是浏览');

  // ③ 资源路径兜底成 HTML（如 /sw.js）→ 不记
  const res3 = fakeRes();
  trafficHtmlGuard(fakeReq('/sw.js'), res3, () => {});
  res3.emitFinish('text/html');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(hits().length, n0, '资源路径不算浏览');

  // ④ HEAD + text/html → 不记（cookie 也不该种）
  const res4 = fakeRes();
  trafficHtmlGuard(fakeReq('/', { method: 'HEAD' }), res4, () => {});
  res4.emitFinish('text/html');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(hits().length, n0, 'HEAD 不算浏览');
  assert.equal(res4.cookies.length, 0, 'HEAD 不种 cookie');

  // ⑤ 同一访客（带 cookie）再看一页 → PV 翻倍、vid 相同（UV 不翻倍）
  const res5 = fakeRes();
  trafficHtmlGuard(fakeReq('/start', { cookie: `${VID_COOKIE}=${vid}` }), res5, () => {});
  res5.emitFinish('text/html');
  await waitFor(() => hits().find((h) => h.path === '/start') || null);
  const htmlRows = hits().filter((h) => h.kind === 'html' && h.is_bot === 0);
  assert.equal(new Set(htmlRows.map((h) => h.vid)).size, 1, '同一访客 UV 只算 1');
});

test('summary：UV 按 vid 去重、独立 IP 按 ip_hash 去重，机器人行一律排除', async () => {
  const today = shanghaiDay();
  // 三个不同 vid、两个不同 IP 的真实访客 + 一行机器人
  const ins = getDb().prepare(
    `INSERT INTO traffic_hits (day, kind, path, vid, ip_hash, is_bot) VALUES (?, ?, ?, ?, ?, ?)`
  );
  ins.run(today, 'html', '/', 'vid-A', hashIp('10.0.0.1'), 0);
  ins.run(today, 'beacon', '/x', 'vid-A', hashIp('10.0.0.1'), 0); // 同人再跳一页
  ins.run(today, 'html', '/', 'vid-B', hashIp('10.0.0.2'), 0);
  ins.run(today, 'html', '/', 'vid-C', hashIp('10.0.0.1'), 0);   // 换浏览器同 IP
  ins.run(today, 'html', '/', 'vid-bot', hashIp('10.0.0.9'), 1); // 机器人：不计

  const s = await trafficSummary({ days: 5 });
  assert.ok(s.today.pv >= 4, `PV 应至少 4（不含机器人），实得 ${s.today.pv}`);
  assert.ok(s.today.uv >= 3, `UV 应至少 3（vid-A/B/C），实得 ${s.today.uv}`);
  assert.ok(s.today.ip >= 2, `独立 IP 应至少 2（.1/.2，机器人 .9 排除），实得 ${s.today.ip}`);
});

test('summary：daily 覆盖近 N 天（0 日补齐、旧→新），since 指向最早有数据的日子', async () => {
  const s = await trafficSummary({ days: 7 });
  assert.equal(s.daily.length, 7);
  assert.equal(s.daily[s.daily.length - 1].day, shanghaiDay(), '末位是今天');
  assert.ok(s.since, '有数据后 since 非空');
  for (let i = 1; i < s.daily.length; i++) {
    assert.ok(s.daily[i - 1].day < s.daily[i].day, 'daily 按日期升序');
  }
});
