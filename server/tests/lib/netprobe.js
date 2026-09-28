/*
 * server/tests/lib/netprobe.js — 给 supertest 包一层，红的时候把**应答方的 socket 地址**打出来。
 *
 * 为什么需要：2026-09-28 排查全量套件的随机红时撞到两例——
 *   ① `read ECONNRESET`（socket 层，不是断言层）；
 *   ② 一个 401，响应体是 `{"detail":"Unauthorized"}`，而**本仓库任何代码都不产出这个形状**。
 * ② 意味着那次请求可能压根不是被测 app 答的（本机常驻着好几个别的服务）。但 supertest 的报错
 * 只有 `expected 201 "Created", got 401 "Unauthorized"`，看不出是谁答的——线索当场就断。
 * 这个包装把「应答方 addr:port / 本机侧 addr:port / Server 头 / 该 app 首次应答的基准端口」
 * 拼进报错，红一次就能直接判断是不是被别的监听者接走了。
 *
 * 用法（与原写法同形，逐字替换即可）：
 *   - const request = require('supertest')      →  import { probe } from './lib/netprobe.js';
 *   - request(app).post('/x')                  →  probe(app).post('/x')
 * 手工断言里想带上诊断：assert.equal(res.status, 201, diag(res))
 *
 * ⚠️ 只做观测，不改语义：不改状态码、不改响应体、不吞错误。原 error 对象**原地**加一行 message
 *    并挂 `netInfo`，栈与身份都保留，`.rejects`/`instanceof` 之类断言不受影响。
 */
import request from 'supertest';

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];

/** 每个 app 第一次成功应答的端口＝基准。之后若出现别的端口，几乎一定是别人答的。
 *  ⚠️ supertest 也接受 URL 字符串（request('http://…')），而 WeakMap 只收对象——
 *    字符串 key 落到这张普通 Map，别让"想看是谁答的"本身把测试炸了。 */
const baseline = new WeakMap();
const urlBaseline = new Map();
const baseOf = (app) => (typeof app === 'object' && app !== null ? baseline.get(app) : urlBaseline.get(app));
const setBase = (app, port) => {
  if (typeof app === 'object' && app !== null) baseline.set(app, port);
  else urlBaseline.set(app, port);
};

function socketOf(res) {
  const s = (res && (res.socket || (res.req && res.req.socket))) || null;
  if (!s) return null;
  return {
    remote: s.remoteAddress != null ? `${s.remoteAddress}:${s.remotePort}` : null,
    local: s.localAddress != null ? `${s.localAddress}:${s.localPort}` : null,
    remotePort: s.remotePort,
  };
}

function fmt(info) {
  const base = info.baselinePort == null ? '未知' : info.baselinePort;
  const flag = info.mismatch
    ? `\n  🔴 应答端口 ${info.remote ?? '?'} 与该 app 的基准端口 ${base} 不一致`
      + ` —— 这次很可能**不是被测 app 答的**，是本机另一个监听者接走了`
    : '';
  return [
    `  [netprobe] ${info.method} ${info.path}`,
    `  [netprobe] 应答方=${info.remote ?? '无 socket（进程内/直调）'}`,
    `  [netprobe] 本机侧=${info.local ?? '-'}  该 app 基准端口=${base}`,
    `  [netprobe] status=${info.status ?? '-'} Server头=${info.serverHeader ?? '-'}${flag}`,
  ].join('\n');
}

function capture(info, res, app) {
  if (!res) { info.status = info.status ?? null; return; }
  info.status = res.status ?? res.statusCode ?? null;
  info.serverHeader = (res.headers && res.headers.server) || null;
  const sk = socketOf(res);
  if (sk) {
    info.remote = sk.remote;
    info.local = sk.local;
    info.remotePort = sk.remotePort;
    let base = baseOf(app);
    if (base == null && sk.remotePort != null) { base = sk.remotePort; setBase(app, base); }
    info.baselinePort = base ?? null;
    info.mismatch = base != null && sk.remotePort != null && sk.remotePort !== base;
  }
}

function wrap(t, method, path, app, label) {
  const info = { method, path, label, status: null, remote: null, local: null,
    serverHeader: null, baselinePort: null, mismatch: false };
  const origEnd = t.end.bind(t);
  t.end = (fn) => origEnd((err, res) => {
    capture(info, res, app);
    if (res) res.__net = info;
    if (err && typeof err === 'object') {
      // 原地改 message + 挂属性：保留原 error 身份与栈，别换成新 Error
      err.message = `${err.message}\n${fmt(info)}`;
      err.netInfo = info;
    }
    if (fn) return fn(err, res);
    if (err) throw err;
    return res;
  });
  t.netInfo = info;
  return t;
}

/**
 * 与 `request(app)` 同形的入口。
 * @param {import('express').Express} app
 * @param {string} [label] 报错里带的标签，多 app 的文件用它区分
 */
export function probe(app, label = 'app') {
  const out = {};
  for (const m of METHODS) {
    out[m] = (path) => wrap(request(app)[m](path), m.toUpperCase(), path, app, label);
  }
  /** 与 supertest 一致地支持 agent 式链：probe(app).auth(t).get(...) */
  out.auth = (token) => {
    const a = request(app);
    // supertest 的 agent 也暴露同名方法；这里退化成"每个请求都带这个 header"
    const wrapped = {};
    for (const m of METHODS) {
      wrapped[m] = (path) => {
        const t = request(app)[m](path).set('Authorization', `Bearer ${token}`);
        return wrap(t, m.toUpperCase(), path, app, label);
      };
    }
    return wrapped;
  };
  return out;
}

/** 手工断言用：`assert.equal(res.status, 201, diag(res))` —— 红时把网络诊断打进断言消息。 */
export function diag(resOrInfo) {
  if (!resOrInfo) return '[netprobe] 没有响应（请求没回来）';
  const info = resOrInfo.__net || resOrInfo.netInfo || resOrInfo;
  return fmt(info);
}

export default { probe, diag };
