// 记忆层测试（node:test）：覆盖 TECH-SPEC v2.3 §7.6.8 验收清单前 3 条。
// 隔离临时 DB（env.js 把 DB_PATH 指到 os.tmpdir()），不触碰 data/aiforum.db；可重复运行。
// 三张 memory 表由 getDb() 执行 schema.sql 自动建出——顺带验证 §7.6.6 建表 SQL 本身可用。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, unlinkSync } from 'node:fs';

import './env.js';
import { TEST_DB_PATH } from './env.js';
import { getDb, closeDb } from '../database/connection.js';
import {
  writeEpisodic,
  writeSemantic,
  writeProcedural,
  readMemory,
  sweepForgetting,
  consolidate,
  summarizeEpisodics,
  SUSPECT_THRESHOLD,
} from '../services/memory/index.js';

// 各用例用不同 agentId 互相隔离（memory 三表无 FK，无需真实 Agent 账号）
const AGENT_CONSOLIDATE = 9001; // 历史考据官
const AGENT_TTL = 9002;
const AGENT_SUSPECT = 9003;
const AGENT_MISC = 9004;

const DOMAIN = '宋代市舶司';

before(() => {
  getDb(); // 触发 schema.sql 建表（含三张 memory 表）
});

after(() => {
  try {
    closeDb();
  } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    const p = TEST_DB_PATH + suffix;
    if (existsSync(p)) unlinkSync(p);
  }
});

// ── §7.6.6 建表落地自检 ────────────────────────────────────────────
test('三张 memory 表与索引按 §7.6.6 落地（SQLite 方言）', () => {
  const db = getDb();
  for (const t of ['memory_episodic', 'memory_semantic', 'memory_procedural']) {
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(t);
    assert.ok(row, `${t} 应存在`);
  }
  for (const idx of ['idx_episodic_agent', 'idx_semantic_agent', 'idx_procedural_agent']) {
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
      .get(idx);
    assert.ok(row, `${idx} 应存在`);
  }
  // episodic 列齐全
  const cols = db.prepare(`PRAGMA table_info(memory_episodic)`).all().map((c) => c.name);
  for (const c of ['id', 'agent_id', 'content', 'source', 'importance', 'created_at', 'expires_at']) {
    assert.ok(cols.includes(c), `memory_episodic 应有列 ${c}`);
  }
});

// ── 验收 1：100 条 episodic → 巩固出 semantic，且出处不丢 ───────────
test('§7.6.8-1 写入 100 条 episodic → consolidate 产出 semantic，出处不丢', () => {
  const ids = [];
  for (let i = 1; i <= 100; i++) {
    const { id } = writeEpisodic({
      agentId: AGENT_CONSOLIDATE,
      // 前缀 [领域] 约定，供 consolidate 分组
      content: `[${DOMAIN}] 第 ${i} 条史料：《宋会要》市舶条记载第 ${i} 则细节。`,
      source: 'perceive',
      importance: 0.3 + (i % 7) / 10,
    });
    ids.push(id);
  }
  assert.equal(ids.length, 100);

  // expires_at 应由写入逻辑算出（SQLite DEFAULT 不能写表达式）
  const sample = getDb()
    .prepare(`SELECT expires_at, created_at FROM memory_episodic WHERE id = ?`)
    .get(ids[0]);
  assert.ok(sample.expires_at, 'expires_at 应被写入');
  assert.ok(sample.expires_at > sample.created_at, 'expires_at 应晚于 created_at（+90 天）');

  const res = consolidate(AGENT_CONSOLIDATE, { days: 7 });
  assert.equal(res.scanned, 100, '应扫描到 100 条 episodic');
  const hit = res.written.find((w) => w.domain === DOMAIN);
  assert.ok(hit, `应沉淀出 domain=${DOMAIN} 的 semantic`);
  assert.equal(hit.count, 100);
  assert.equal(hit.created, true, '首次巩固应为新建');

  // 出处不丢：evidence_ids 全量保留 100 条 episodic id
  const { semantic } = readMemory(AGENT_CONSOLIDATE, { domain: DOMAIN });
  assert.equal(semantic.length, 1);
  const s = semantic[0];
  assert.ok(s.understanding.length > 0, 'understanding 不应为空');
  assert.equal(s.evidenceIds.length, 100, 'evidence_ids 应保留全部 100 条出处');
  assert.deepEqual(s.evidenceIds, ids, 'evidence_ids 应与写入的 episodic id 一致');
  assert.equal(s.status, 'verified');
  assert.ok(s.lastVerifiedAt, 'last_verified_at 应写入');
  assert.equal(s.confidence, 0.6);

  // 再次巩固 → upsert 同一行（不产生重复 domain）
  const again = consolidate(AGENT_CONSOLIDATE, { days: 7 });
  assert.equal(again.written.find((w) => w.domain === DOMAIN).created, false, '第二次应为更新');
  const after2 = readMemory(AGENT_CONSOLIDATE, { domain: DOMAIN });
  assert.equal(after2.semantic.length, 1, 'upsert 不应产生重复 semantic');
});

// ── 验收 2：episodic 超 TTL 删除原文，semantic 保留理解 ─────────────
test('§7.6.8-2 超 TTL 的 episodic 被 sweepForgetting 删除，semantic 保留', () => {
  const db = getDb();

  const stale = writeEpisodic({
    agentId: AGENT_TTL,
    content: `[${DOMAIN}] 一条 91 天前的旧史料摘录。`,
    importance: 0.9,
  });
  const fresh = writeEpisodic({
    agentId: AGENT_TTL,
    content: `[${DOMAIN}] 一条刚读到的新史料摘录。`,
    importance: 0.5,
  });

  // 制造过期：把 expires_at 推到过去（模拟 90 天 TTL 到期）
  db.prepare(`UPDATE memory_episodic SET expires_at = datetime('now', '-1 day') WHERE id = ?`).run(
    stale.id
  );

  // 原文已被巩固成理解（先 consolidate 再 sweep 是规定顺序）
  writeSemantic({
    agentId: AGENT_TTL,
    domain: DOMAIN,
    understanding: '市舶司抽解与博买要点（已从情景记忆炼成）。',
    confidence: 0.7,
    evidenceIds: [stale.id, fresh.id],
  });

  const sweep = sweepForgetting(AGENT_TTL);
  assert.equal(sweep.expired, 1, '应删除 1 条过期 episodic');

  const staleRow = db.prepare(`SELECT id FROM memory_episodic WHERE id = ?`).get(stale.id);
  assert.equal(staleRow, undefined, '过期 episodic 原文应被删除');
  const freshRow = db.prepare(`SELECT id FROM memory_episodic WHERE id = ?`).get(fresh.id);
  assert.ok(freshRow, '未过期 episodic 应保留');

  const { semantic, episodic } = readMemory(AGENT_TTL);
  assert.equal(semantic.length, 1, 'semantic 理解应保留');
  assert.equal(semantic[0].confidence, 0.7);
  assert.deepEqual(semantic[0].evidenceIds, [stale.id, fresh.id], '出处链条应保留');
  assert.equal(episodic.length, 1, '只剩未过期的那条 episodic');
});

// ── 验收 3：semantic 置信度 < 0.4 → 自动标疑 ────────────────────────
test('§7.6.8-3 semantic confidence < 0.4 → sweep 后 status=suspect', () => {
  // 读者纠错导致置信度跌到 0.3
  const low = writeSemantic({
    agentId: AGENT_SUSPECT,
    domain: '存疑领域',
    understanding: '一条被读者纠错、置信度已跌破阈值的理解。',
    confidence: 0.3,
  });
  const high = writeSemantic({
    agentId: AGENT_SUSPECT,
    domain: '稳固领域',
    understanding: '一条证据充分的理解。',
    confidence: 0.8,
  });
  assert.ok(low.confidence < SUSPECT_THRESHOLD);

  const db = getDb();
  assert.equal(
    db.prepare(`SELECT status FROM memory_semantic WHERE id = ?`).get(low.id).status,
    'verified',
    'sweep 之前应仍是 verified'
  );

  const sweep = sweepForgetting(AGENT_SUSPECT);
  assert.equal(sweep.suspected, 1, '应标疑 1 条');

  assert.equal(
    db.prepare(`SELECT status FROM memory_semantic WHERE id = ?`).get(low.id).status,
    'suspect',
    '低置信 semantic 应被标为 suspect'
  );
  assert.equal(
    db.prepare(`SELECT status FROM memory_semantic WHERE id = ?`).get(high.id).status,
    'verified',
    '高置信 semantic 不应被动'
  );
  // 标疑不删：理解仍在库、仍可被检索到（带 status 供调用方决策）
  const { semantic } = readMemory(AGENT_SUSPECT, { domain: '存疑领域' });
  assert.equal(semantic.length, 1, 'suspect 记录不应被删除');
  assert.equal(semantic[0].status, 'suspect');

  // 复核通过 → 重新沉淀，status 回 verified（§7.6.4 证伪作废闭环的正向分支）
  writeSemantic({
    agentId: AGENT_SUSPECT,
    domain: '存疑领域',
    understanding: '复核后修正的理解。',
    confidence: 0.65,
  });
  const recheck = readMemory(AGENT_SUSPECT, { domain: '存疑领域' });
  assert.equal(recheck.semantic[0].status, 'verified');
});

// ── 辅助能力自检（不属验收清单，但保障上面三条的地基） ──────────────
test('readMemory 按 importance × recency 加权排序 episodic', () => {
  writeEpisodic({ agentId: AGENT_MISC, content: '低重要性', importance: 0.1 });
  writeEpisodic({ agentId: AGENT_MISC, content: '高重要性', importance: 0.95 });
  writeEpisodic({ agentId: AGENT_MISC, content: '中重要性', importance: 0.5 });

  const { episodic } = readMemory(AGENT_MISC, { limit: 10 });
  assert.equal(episodic.length, 3);
  assert.equal(episodic[0].content, '高重要性');
  assert.equal(episodic[2].content, '低重要性');
  assert.ok(episodic[0].score > episodic[2].score, 'score 应递减');
});

test('writeProcedural 同 (agent, skill) 重复写入 → version 递增', () => {
  const v1 = writeProcedural({
    agentId: AGENT_MISC,
    skill: 'how_to_cite',
    procedure: '引用必带出处。',
  });
  assert.equal(v1.version, 1);
  const v2 = writeProcedural({
    agentId: AGENT_MISC,
    skill: 'how_to_cite',
    procedure: '引用必带出处；存疑必明说；优先 chtxt 精校。',
  });
  assert.equal(v2.version, 2);
  assert.equal(v2.id, v1.id, 'upsert 应更新同一行');

  const row = getDb()
    .prepare(`SELECT procedure FROM memory_procedural WHERE id = ?`)
    .get(v1.id);
  assert.match(row.procedure, /存疑必明说/);
});

test('summarizeEpisodics 是纯函数：空输入安全，输出含出处', () => {
  const empty = summarizeEpisodics([]);
  assert.equal(empty.understanding, '');
  assert.deepEqual(empty.evidenceIds, []);

  const draft = summarizeEpisodics([
    { id: 7, content: '史料 A', source: 'perceive', importance: 0.9, created_at: '2026-08-01 10:00:00' },
    { id: 8, content: '史料 B', source: 'feedback', importance: 0.4, created_at: '2026-08-02 10:00:00' },
  ]);
  assert.equal(draft.count, 2);
  assert.deepEqual(draft.evidenceIds, [7, 8]);
  assert.deepEqual(draft.sources, ['perceive', 'feedback']);
  assert.match(draft.understanding, /史料 A/);
  assert.match(draft.understanding, /#7/);
});

test('非法入参被拒（agentId / 空内容）', () => {
  assert.throws(() => writeEpisodic({ agentId: 0, content: 'x' }), /agentId/);
  assert.throws(() => writeEpisodic({ agentId: AGENT_MISC, content: '   ' }), /content/);
  assert.throws(
    () => writeSemantic({ agentId: AGENT_MISC, domain: 'd', understanding: '' }),
    /understanding/
  );
});
