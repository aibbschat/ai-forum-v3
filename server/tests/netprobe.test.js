/*
 * netprobe 自身的契约测试（2026-09-28）。
 * 这个包装插在**所有断言的下游**，它自己坏掉的后果是"测试看起来更红了/错误被吞了"，
 * 所以它比一般工具更需要钉：只做观测，不改语义，红时必须把应答方地址打出来。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import './env.js';
import { probe, diag } from './lib/netprobe.js';

const mkApp = (name) => {
  const a = express();
  a.get('/ok', (req, res) => res.json({ hi: name }));
  a.post('/ok', (req, res) => res.status(201).json({ hi: name }));
  a.get('/boom', (req, res) => res.status(500).json({ error: 'boom' }));
  return a;
};

test('① 语义不变：状态码与 body 原样透传，且响应上挂到了应答方地址', async () => {
  const app = mkApp('alpha');
  const res = await probe(app).get('/ok');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { hi: 'alpha' });
  assert.ok(res.__net, '没挂上 __net —— 观测层没生效');
  assert.match(String(res.__net.remote), /^127\.0\.0\.1:\d+$/, `应答方地址不像本地端口：${res.__net.remote}`);
  assert.equal(res.__net.mismatch, false, '同一端口上的两次请求不该被判成别人答的');
  assert.equal(res.__net.baselinePort, Number(String(res.__net.remote).split(':')[1]));
});

test('② .expect 失败时，报错里带得出「应答方是谁」，且错误对象身份保留', async () => {
  const app = mkApp('beta');
  let caught = null;
  try {
    await probe(app).get('/ok').expect(500);   // 故意期望错
  } catch (e) { caught = e; }
  assert.ok(caught, '.expect 失败必须仍然抛出（包装不许吞错误）');
  assert.match(caught.message, /\[netprobe\] 应答方=127\.0\.0\.1:\d+/,
    `报错里没带应答方地址：\n${caught.message}`);
  assert.ok(caught.netInfo && caught.netInfo.path === '/ok', '原 error 上该挂着结构化的 netInfo');
  assert.ok(caught instanceof Error, '错误对象身份不能被换成别的类型');
});

test('③ 端口漂移能被认出来：同 key 下第二次应答换了端口 → mismatch', async () => {
  const app = mkApp('gamma');
  const p = probe(app, 'gamma');
  const first = await p.get('/ok');
  // 模拟"这次不是被测 app 答的"：把基准端口挪开，再走一次真实请求
  const base = first.__net.baselinePort;
  first.__net.baselinePort = base + 1000;
  const second = await p.get('/ok');
  assert.equal(second.__net.mismatch, true, '换了端口必须标红');
  assert.match(diag(second), /不是被测 app 答的/, `诊断文本要说清后果：\n${diag(second)}`);
  assert.notEqual(second.__net.remotePort, second.__net.baselinePort);
});

test('④ 手工断言风格也能用：把 diag(res) 塞进 assert 的 message 位', async () => {
  const app = mkApp('delta');
  const res = await probe(app).post('/ok').send({ a: 1 });
  assert.equal(res.status, 201, JSON.stringify(res.body) + '\n' + diag(res));
  const bad = await probe(app).get('/boom');
  assert.equal(bad.status, 500, diag(bad));
  assert.match(diag(bad), /status=500/);
});

test('⑤ 没建立 socket（请求没回来）时 diag 不炸', () => {
  assert.match(diag(null), /没有响应/);
  assert.match(diag({}), /应答方=无 socket/);
});

test('⑥ 复刻那次随机红：陌生监听者答了 401 {"detail":"Unauthorized"}，报错必须指出它的 addr:port', async () => {
  // 2026-09-28 全量随机红的一条真实现场：401 的响应体形状本仓库不产出，
  // 说明答话的可能根本不是被测 app。supertest 原生报错只有 "expected 201, got 401"，
  // 看不出是谁答的。这里用裸 http 服务复刻"别的监听者"，验证包装能把它指出来。
  const srv = http.createServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ detail: 'Unauthorized' }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const strangerPort = srv.address().port;
  try {
    await probe(`http://127.0.0.1:${strangerPort}`).get('/whatever').expect(201);
    assert.fail('那条 401 应该让请求失败');
  } catch (e) {
    const msg = e.message || String(e);
    assert.match(msg, new RegExp(`应答方=127\\.0\\.0\\.1:${strangerPort}`),
      `报错没把陌生监听者的地址打出来：\n${msg}`);
    assert.match(msg, /got 401|401/, '原始断言信息要保留');
    assert.match(msg, /\[netprobe\] status=401/);
  } finally {
    // 裸 http server + superagent 的 keep-alive 连接会挂住 close()，
    // 测试进程退不出去（上一版就卡在这）。两个都关。
    srv.close();
    if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
  }
});
