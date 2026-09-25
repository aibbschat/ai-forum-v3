// server/tests/traffic.test.js
// 站点流量契约测试（2026-09-25）：beacon 落库 / 真人与机器分档 / HTML 响应记账 / IP 归并口径。
//
// 这批的红线，用例逐个钉住：
//   ① beacon 一行 = 一次浏览，日切是 Asia/Shanghai 日历日（day 列建行时定死）；
//   ② 「独立 IP ≠ 人数」：伪装成 Chrome 的一发即走抓取器必须落进 machine/cand，不得计入 real；
//   ③ real 的唯一硬证据是**执行过 JS**（同日同 ip 发过 beacon），光有浏览器 UA 不算；
//   ④ 攻击面探针（/phpinfo、/wp-admin…）从所有真人档位剔除，只留 probe 计数；
//   ⑤ IPv6 按 /64 归并 —— 同一个 /64 换尾址不得算成两个独立 IP；
//   ⑥ 机器人 UA / 自访 /admin* 不落库；beacon 有每 IP 限流；采集永不 500。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import './env.js';
import app from './app.js';
import { getDb } from '../database/connection.js';
import { trafficHtmlGuard, shanghaiDay, hashIp, VID_COOKIE } from '../lib/trafficTrack.js';
import { uaFamily, acceptHasHtml, isProbePath, ipScope } from '../lib/trafficClassify.js';
import { trafficSummary } from '../services/trafficService.js';

const UA_BROWSER = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const UA_FAKE_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';
const UA_BOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const ACCEPT_HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8';

function hits() {
  return getDb().prepare(`SELECT * FROM traffic_hits ORDER BY id ASC`).all();
}
function clear() {
  getDb().prepare(`DELETE FROM traffic_hits`).run();
}

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

before(() => {
  getDb(); // 触发建表（含 traffic_hits 与二批三列）
});

// ────────── 分类器本身（判据不能只靠调用点保证） ──────────

test('uaFamily：自称浏览器只记家族、不下真人结论；脚本与爬虫家族可辨识', () => {
  assert.equal(uaFamily(UA_FAKE_CHROME), 'selfclaim:chrome');
  assert.equal(uaFamily('Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'), 'selfclaim:safari');
  assert.equal(uaFamily('Mozilla/5.0 (Linux; Android 11; GAR-AN60) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126 Mobile Safari/537.36 MMWEBID/1 MicroMessenger/8.0'), 'wechat');
  assert.equal(uaFamily('Go-http-client/2.0'), 'go-http');
  assert.equal(uaFamily('python-requests/2.31.0'), 'python');
  assert.equal(uaFamily('curl/8.7.1'), 'cmdline');
  assert.equal(uaFamily('node'), 'node');
  assert.equal(uaFamily('Mozilla/5.0 (compatible; GPTBot/1.4; +https://openai.com/gptbot)'), 'ai-crawler');
  assert.equal(uaFamily('Mozilla/5.0 (compatible; Baiduspider/2.0)'), 'search-crawler');
  assert.equal(uaFamily(''), 'empty');
  assert.equal(uaFamily(undefined), 'empty');
  assert.equal(uaFamily('Dalvik/2.1.0 (Linux; U; Android 9; ZTE Build/PPR)'), 'other');
});

test('acceptHasHtml：真浏览器导航必带 text/html，裸客户端通常不带', () => {
  assert.equal(acceptHasHtml({ headers: { accept: ACCEPT_HTML } }), 1);
  assert.equal(acceptHasHtml({ headers: { accept: '*/*' } }), 0);
  assert.equal(acceptHasHtml({ headers: {} }), 0);
});

test('isProbePath：攻击面路径命中，正常前端路由不误伤', () => {
  assert.equal(isProbePath('/phpinfo'), 1);
  assert.equal(isProbePath('/_profiler/phpinfo'), 1);
  assert.equal(isProbePath('/wp-login.php'), 1);
  assert.equal(isProbePath('/.env'), 1);
  assert.equal(isProbePath('/actuator/health'), 1);
  assert.equal(isProbePath('/'), 0);
  assert.equal(isProbePath('/article/977'), 0);
  assert.equal(isProbePath('/agent/1849/journal'), 0);
  assert.equal(isProbePath('/start#clients'), 0);
});

test('ipScope：IPv6 折到 /64，同一前缀换尾址归并；v4 原样', () => {
  assert.equal(ipScope('203.0.113.7'), '203.0.113.7');
  // 同一 /64 内换接口标识 → 必须同一个哈希（否则一个移动用户会被数成多个独立 IP）
  const a = hashIp('240e:384:83c8:6200:6096:14f3:8ace:e43e');
  const b = hashIp('240e:384:83c8:6200:11a4:5c22:9f01:beef');
  assert.equal(a, b, '同 /64 应归并');
  const c = hashIp('240e:384:83c9:6200:6096:14f3:8ace:e43e');
  assert.notEqual(a, c, '不同 /64 不该归并');
  // :: 缩写形态也要正确展开
  assert.equal(ipScope('2001:db8::1234'), ipScope('2001:0db8:0000:0000:0000:0000:0000:1234'));
  assert.equal(ipScope('::ffff:198.51.100.9'), '198.51.100.9');
  assert.equal(ipScope('fe80::1%eth0').endsWith('::/64'), true);
});

// ────────── beacon 端点 ──────────

test('beacon：真浏览器上报 → 落 kind=beacon 行并带上 ua_family/accept_html', async () => {
  clear();
  const r = await request(app).post('/api/track')
    .set('User-Agent', UA_BROWSER).set('Accept', ACCEPT_HTML)
    .set('X-Forwarded-For', '203.0.113.10')
    .send({ path: '/article/1' });
  assert.equal(r.status, 200);
  const row = await waitFor(() => hits().find((h) => h.path === '/article/1') || null);
  assert.ok(row, 'beacon 应落一行');
  assert.equal(row.kind, 'beacon');
  assert.equal(row.day, shanghaiDay());
  assert.equal(row.ua_family, 'selfclaim:chrome');
  assert.equal(row.accept_html, 1);
  assert.equal(row.is_probe, 0);
  assert.equal(row.ip_hash, hashIp('203.0.113.10'));
});

test('beacon：机器人 UA 与 /admin 自访都不落库；非法 path 拒 400', async () => {
  clear();
  const n0 = hits().length;
  for (const [ua, path] of [[UA_BOT, '/'], [UA_BROWSER, '/admin/growth']]) {
    const r = await request(app).post('/api/track').set('User-Agent', ua).send({ path });
    assert.equal(r.status, 200, '对外一律 200，不让它探测出差异');
  }
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(hits().length, n0, '机器人/自访不落库');
  for (const bad of ['', 'https://evil.example/x', '//evil', null]) {
    const r = await request(app).post('/api/track').set('User-Agent', UA_BROWSER).send({ path: bad });
    assert.equal(r.status, 400, `path=${JSON.stringify(bad)} 应 400`);
  }
});

// ────────── HTML 响应记账 ──────────

test('HTML 响应记账：只有 text/html 的 GET 记一行，且首访即种 vid', async () => {
  clear();
  const fakeRes = () => {
    const res = { cookies: [], headers: {}, finishCb: null };
    res.cookie = (n, v) => res.cookies.push([n, v]);
    res.on = (_e, cb) => { res.finishCb = cb; };
    res.getHeader = (k) => res.headers[k];
    res.emitFinish = (ct) => { res.headers['content-type'] = ct; res.finishCb(); };
    return res;
  };
  const fakeReq = (path, { method = 'GET', cookie, accept = ACCEPT_HTML, ua = UA_BROWSER } = {}) => ({
    method, path,
    headers: { 'user-agent': ua, accept, 'x-forwarded-for': '198.51.100.7', ...(cookie ? { cookie } : {}) },
    ip: '127.0.0.1',
  });

  const res1 = fakeRes();
  trafficHtmlGuard(fakeReq('/'), res1, () => {});
  res1.emitFinish('text/html; charset=utf-8');
  await waitFor(() => hits().find((h) => h.path === '/') || null);
  assert.ok(res1.cookies.some(([n]) => n === VID_COOKIE), '首访应种 vid');
  const first = hits().find((h) => h.path === '/');
  assert.ok(first?.vid, '首载行应带 vid');
  assert.equal(first.accept_html, 1);
  assert.equal(first.ua_family, 'selfclaim:chrome');

  for (const [req, ct] of [
    [fakeReq('/api/plaza/topics'), 'application/json'],
    [fakeReq('/sw.js'), 'text/html'],       // 资源路径兜底成 HTML → 不算浏览
    [fakeReq('/', { method: 'HEAD' }), 'text/html'],
  ]) {
    const r = fakeRes();
    trafficHtmlGuard(req, r, () => {});
    r.emitFinish(ct);
  }
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(hits().length, 1, 'JSON / 资源路径 / HEAD 都不记');
});

// ────────── 分档聚合（真口径的落点） ──────────

test('summary 分档：伪 Chrome 无 JS 证据不算真人；有 beacon 才算 real；探针单列', async () => {
  clear();
  const today = shanghaiDay();
  const ins = getDb().prepare(
    `INSERT INTO traffic_hits (day, kind, path, vid, ip_hash, is_bot, ua_family, accept_html, is_probe)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  // A：真人 —— 拿过 HTML，且同日发过 beacon（执行了 JS）
  ins.run(today, 'html', '/', 'vid-A', hashIp('10.1.0.1'), 0, 'selfclaim:chrome', 1, 0);
  ins.run(today, 'beacon', '/article/9', 'vid-A', hashIp('10.1.0.1'), 0, 'selfclaim:chrome', 1, 0);
  // B：自称 Chrome 但一次即走、无 beacon —— 就是那批伪装抓取器，不得算真人
  ins.run(today, 'html', '/article/837', 'vid-B', hashIp('10.1.0.2'), 0, 'selfclaim:chrome', 1, 0);
  // C：Accept 不带 HTML 的裸库 → 机器
  ins.run(today, 'html', '/article/838', null, hashIp('10.1.0.3'), 0, 'go-http', 0, 0);
  // D：UA 黑名单机器人 → 机器
  ins.run(today, 'html', '/', 'vid-D', hashIp('10.1.0.4'), 1, 'search-crawler', 1, 0);
  // E：攻击面探针 → 单列，不进任何真人档
  ins.run(today, 'html', '/phpinfo', null, hashIp('10.1.0.5'), 0, 'selfclaim:chrome', 1, 1);

  const s = await trafficSummary({ days: 5 });
  const t = s.today;
  assert.equal(t.all_pv, 6, '总请求 = 全部行');
  assert.equal(t.real_pv, 2, '真人浏览 = A 的 HTML + 其 beacon');
  assert.equal(t.real_uv, 1, '真人访客只有 A');
  assert.equal(t.real_ip, 1, '真人独立 IP 只有 A');
  assert.equal(t.cand_pv, 3, '浏览器候选 = A(2) + B(1)');
  assert.equal(t.cand_uv, 2, '候选访客 = A + B');
  assert.equal(t.machine_pv, 2, '机器 = C + D');
  assert.equal(t.probe_pv, 1, '探针 = E');
  assert.equal(t.probe_ip, 1);
  // 分档必须互斥：真人 ⊆ 候选，候选与机器/探针不重
  assert.ok(t.real_pv <= t.cand_pv && t.machine_pv + t.cand_pv + t.probe_pv === t.all_pv, '三档相加应等于总数');
});

test('summary 形状：daily 覆盖近 N 天（0 日补齐、升序），末位是今天，since 指最早日', async () => {
  const s = await trafficSummary({ days: 7 });
  assert.equal(s.windowDays, 7);
  assert.equal(s.daily.length, 7);
  assert.equal(s.daily[6].day, shanghaiDay());
  assert.ok(s.since);
  for (let i = 1; i < 7; i++) assert.ok(s.daily[i - 1].day < s.daily[i].day);
  clear();
});
