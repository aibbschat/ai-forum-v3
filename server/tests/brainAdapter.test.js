// 发布标记解析测试（MCP 直连模式）：
// 钉住"模型用 Markdown 装饰包住标记时不能误判失败"——线上实测误报 37 次，文章其实已发出。
// 依据：DSH 线上大脑硬规则 + 2026-09-30 线上只读勘察记录。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import './env.js';
import { parseDshPublishOutcome, readLogSince } from '../dsh/brainAdapter.js';

test('标准格式：MCP server 返回的 "发布成功：post id=109"', () => {
  const r = parseDshPublishOutcome('✅ 发布成功：post id=109');
  assert.equal(r.postId, 109);
  assert.equal(r.success, true);
});

test('Agent 复述："已发布成功，文章 ID：109"', () => {
  const r = parseDshPublishOutcome('已发布成功，文章 ID：109');
  assert.equal(r.postId, 109);
  assert.equal(r.success, true);
});

// ── 回归：加粗/代码装饰打断正则（线上误报 37 次的根因） ──
test('加粗标记 "**post id**：1526" 仍能解析出 postId（且判定成功）', () => {
  const r = parseDshPublishOutcome('已发布\n**post id**：1526\n**标题**：某标题');
  assert.equal(r.postId, 1526);
  assert.equal(r.success, true);
});

test('反引号包裹 "post id=`1526`" 仍能解析', () => {
  const r = parseDshPublishOutcome('发布完成，post id=`1526`。');
  assert.equal(r.postId, 1526);
  assert.equal(r.success, true);
});

test('加粗 + 全角冒号 + 空格混排 "Post **ID** : 1526"', () => {
  const r = parseDshPublishOutcome('Post ID : 1526');
  assert.equal(r.postId, 1526);
  assert.equal(r.success, true);
});

// ── 幂等命中：没拿到新 id 也算成功 ──
test('幂等命中且带 id：命中 id 并判成功', () => {
  const r = parseDshPublishOutcome('24h 内已发布过，未重复发帖。post id=88');
  assert.equal(r.postId, 88);
  assert.equal(r.success, true);
});

test('幂等命中但不带 id：postId 为 null，仍然算成功', () => {
  const r = parseDshPublishOutcome('content_hash 命中，本次跳过。');
  assert.equal(r.postId, null);
  assert.equal(r.idempotent, true);
  assert.equal(r.success, true);
});

// ── 真失败必须照样判失败，不能被"宽容"成假成功 ──
test('失败叙述（提到 post id 但无数字）判为失败', () => {
  const r = parseDshPublishOutcome('发布失败：契约校验不通过，未生成 post id。');
  assert.equal(r.postId, null);
  assert.equal(r.success, false);
});

test('空日志判为失败', () => {
  const r = parseDshPublishOutcome('');
  assert.equal(r.postId, null);
  assert.equal(r.success, false);
});

// ── 回归：本轮只认"新增的那一段日志"（2026-09-30 finance 线上实录） ──
// 当天 09:30 那轮把 Agent 自己的复述写进了日志（含 post id=1595），15:30 那轮真发了 1606；
// 旧实现扫整天日志取首条命中 → 报成 1595，postId 与标题双双张冠李戴。
test('readLogSince 只取偏移之后的新增段，不把早先的旧 id 带出来', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-log-'));
  const p = join(dir, 'finance-20260930.log');
  writeFileSync(p, '上午：文章之前已经发过，返回的是幂等结果（post id=1595）。');
  const offset = statSync(p).size; // ← 跑之前记下的位置
  appendFileSync(p, '\n下午：发布完成 ✅ **post id=1606**');

  const seg = readLogSince(p, offset);
  assert.ok(seg.includes('1606'), `新增段应含本轮 id，实际: ${seg}`);
  assert.ok(!seg.includes('1595'), '新增段不能带出上午的旧 id');
  assert.equal(parseDshPublishOutcome(seg).postId, 1606);

  // 对照：整份日志照旧解析会取到上午的 1595 —— 这就是旧实现的病根
  assert.equal(parseDshPublishOutcome(readLogSince(p, 0)).postId, 1595);

  rmSync(dir, { recursive: true, force: true });
});

test('readLogSince 容错：文件不存在、偏移越界都不抛错', () => {
  assert.equal(readLogSince(join(tmpdir(), 'dsh-log-not-exist.log'), 0), '');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-log-'));
  const p = join(dir, 'x.log');
  writeFileSync(p, 'abc');
  assert.equal(readLogSince(p, 999), ''); // 偏移超出长度 → 空，不是乱码
  rmSync(dir, { recursive: true, force: true });
});