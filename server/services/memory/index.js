// server/services/memory/index.js
// 记忆层服务：三层记忆（情景 / 语义 / 程序）的写入、检索分级、遗忘、巩固。
// 依据：TECH-SPEC.md v2.3 §7.6（记忆生命周期管理）；ROADMAP P0-3。
//
// 设计要点：
// - 所有 DB 访问统一走 getDb()，本文件不持有连接、不改动 connection.js。
// - 时间统一用 SQLite 的 datetime('now')（UTC），与建表默认值 CURRENT_TIMESTAMP 同口径。
// - 检索加权 = importance × recency，recency = 1 / (1 + 距今天数)（Ebbinghaus 简化，§7.6.4）。
// - 巩固（consolidate）只做结构与聚合，LLM 总结留作插件接入点（见 summarizeEpisodics 的 TODO）。

import { getDb } from '../../database/connection.js';

/** 容量上限（每 Agent，§7.6.2）。 */
export const MEMORY_LIMITS = {
  episodic: 100_000,
  semantic: 10_000,
  procedural: 1_000,
};

/** episodic 写入来源枚举（§7.6.6）。 */
export const EPISODIC_SOURCES = ['perceive', 'publish', 'feedback', 'consolidate'];

/** semantic 置信度低于此值 → 标疑（§7.6.4 证伪作废）。 */
export const SUSPECT_THRESHOLD = 0.4;

/** episodic TTL（天，§7.6.2）。 */
export const EPISODIC_TTL_DAYS = 90;

/** 容量淘汰每轮删除的批量大小，避免单条 DELETE 循环打满 CPU。 */
const EVICT_BATCH = 1_000;

/** 检索加权表达式：importance × recency，recency = 1/(1+距今天数)。 */
const SCORE_SQL = `importance * (1.0 / (1.0 + MAX(0, julianday('now') - julianday(created_at))))`;

// ── 内部工具 ────────────────────────────────────────────────────────

function requireAgentId(agentId) {
  const id = Number(agentId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`memory: agentId 非法（收到 ${JSON.stringify(agentId)}）`);
  }
  return id;
}

function requireText(value, field) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) throw new Error(`memory: ${field} 不能为空`);
  return s;
}

/** 把 0~1 之外的分值夹回区间，非数字回退默认值。 */
function clamp01(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function normalizeSource(source) {
  return EPISODIC_SOURCES.includes(source) ? source : 'perceive';
}

/** domain 允许缺省，统一落到 'general'，否则 UNIQUE(agent_id, domain) 对 NULL 不生效（SQLite 语义）。 */
function normalizeDomain(domain) {
  const s = typeof domain === 'string' ? domain.trim() : '';
  return s || 'general';
}

function toIdArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map(Number).filter(Number.isFinite);
}

function parseEvidenceIds(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ── 写入（编码 encoding，§7.6.1） ───────────────────────────────────

/**
 * 写入一条情景记忆。expires_at = now + 90 天（SQLite DEFAULT 不能写表达式，故在此计算）。
 * @param {{agentId:number, content:string, source?:string, importance?:number}} input
 * @returns {{id:number, agentId:number, source:string, importance:number}}
 */
export function writeEpisodic({ agentId, content, source = 'perceive', importance = 0.5 }) {
  const id = requireAgentId(agentId);
  const text = requireText(content, 'content');
  const src = normalizeSource(source);
  const imp = clamp01(importance, 0.5);

  const info = getDb()
    .prepare(
      `INSERT INTO memory_episodic (agent_id, content, source, importance, expires_at)
       VALUES (?, ?, ?, ?, datetime('now', '+${EPISODIC_TTL_DAYS} days'))`
    )
    .run(id, text, src, imp);

  return { id: Number(info.lastInsertRowid), agentId: id, source: src, importance: imp };
}

/**
 * 写入/更新一条语义记忆（upsert on (agent_id, domain)）。
 * 已存在 → 更新 understanding / confidence / evidence_ids / updated_at / last_verified_at；
 * 不存在 → 插入，status='verified'，last_verified_at=now。
 * @param {{agentId:number, domain?:string, understanding:string, confidence?:number, evidenceIds?:number[]}} input
 * @returns {{id:number, agentId:number, domain:string, confidence:number, created:boolean}}
 */
export function writeSemantic({ agentId, domain, understanding, confidence = 0.6, evidenceIds = [] }) {
  const id = requireAgentId(agentId);
  const dom = normalizeDomain(domain);
  const text = requireText(understanding, 'understanding');
  const conf = clamp01(confidence, 0.6);
  const evidence = JSON.stringify(toIdArray(evidenceIds));

  const db = getDb();
  const existed = db
    .prepare(`SELECT id FROM memory_semantic WHERE agent_id = ? AND domain = ?`)
    .get(id, dom);

  // 复核成功（重新沉淀）即视为再次验证：status 回到 verified，last_verified_at 刷新。
  db.prepare(
    `INSERT INTO memory_semantic
       (agent_id, domain, understanding, confidence, evidence_ids, status, last_verified_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'verified', datetime('now'), datetime('now'))
     ON CONFLICT(agent_id, domain) DO UPDATE SET
       understanding    = excluded.understanding,
       confidence       = excluded.confidence,
       evidence_ids     = excluded.evidence_ids,
       status           = 'verified',
       last_verified_at = datetime('now'),
       updated_at       = datetime('now')`
  ).run(id, dom, text, conf, evidence);

  const row = db
    .prepare(`SELECT id FROM memory_semantic WHERE agent_id = ? AND domain = ?`)
    .get(id, dom);

  return { id: row.id, agentId: id, domain: dom, confidence: conf, created: !existed };
}

/**
 * 写入/更新一条程序记忆（upsert on (agent_id, skill)）。已存在则 version + 1。
 * @param {{agentId:number, skill:string, procedure:string}} input
 * @returns {{id:number, agentId:number, skill:string, version:number}}
 */
export function writeProcedural({ agentId, skill, procedure }) {
  const id = requireAgentId(agentId);
  const skillName = requireText(skill, 'skill');
  const text = requireText(procedure, 'procedure');

  const db = getDb();
  db.prepare(
    `INSERT INTO memory_procedural (agent_id, skill, procedure, version, updated_at)
     VALUES (?, ?, ?, 1, datetime('now'))
     ON CONFLICT(agent_id, skill) DO UPDATE SET
       procedure  = excluded.procedure,
       version    = memory_procedural.version + 1,
       updated_at = datetime('now')`
  ).run(id, skillName, text);

  const row = db
    .prepare(`SELECT id, version FROM memory_procedural WHERE agent_id = ? AND skill = ?`)
    .get(id, skillName);

  return { id: row.id, agentId: id, skill: skillName, version: row.version };
}

// ── 检索分级（提取 retrieval，§7.6.5） ──────────────────────────────

/**
 * 分级检索：① 先查 semantic（稳定、量小、快）② 再查 episodic 按 importance×recency 取 top-K。
 * 第三级「仍不满足 → 触发新感知 perceive_world」由调用方（BrainAdapter）决定，本层只给素材。
 * @param {number} agentId
 * @param {{domain?:string, limit?:number}} [opts]
 * @returns {{semantic:Array<object>, episodic:Array<object>}}
 */
export function readMemory(agentId, { domain, limit = 20 } = {}) {
  const id = requireAgentId(agentId);
  const k = Math.max(1, Math.min(500, Number(limit) || 20));
  const db = getDb();

  // ① semantic：作废（void）的不再供给大脑；suspect 保留但带 status，由调用方按 confidence 决策。
  const semanticRows = domain
    ? db
        .prepare(
          `SELECT id, agent_id, domain, understanding, confidence, evidence_ids, status,
                  last_verified_at, updated_at
             FROM memory_semantic
            WHERE agent_id = ? AND domain = ? AND status != 'void'
            ORDER BY confidence DESC, updated_at DESC
            LIMIT ?`
        )
        .all(id, normalizeDomain(domain), k)
    : db
        .prepare(
          `SELECT id, agent_id, domain, understanding, confidence, evidence_ids, status,
                  last_verified_at, updated_at
             FROM memory_semantic
            WHERE agent_id = ? AND status != 'void'
            ORDER BY confidence DESC, updated_at DESC
            LIMIT ?`
        )
        .all(id, k);

  // ② episodic：过期未清扫的直接排除（sweep 之前也不该被读到）。
  const episodicRows = db
    .prepare(
      `SELECT id, agent_id, content, source, importance, created_at, expires_at,
              ${SCORE_SQL} AS score
         FROM memory_episodic
        WHERE agent_id = ?
          AND (expires_at IS NULL OR expires_at > datetime('now'))
        ORDER BY score DESC, created_at DESC
        LIMIT ?`
    )
    .all(id, k);

  return {
    semantic: semanticRows.map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      domain: r.domain,
      understanding: r.understanding,
      confidence: r.confidence,
      evidenceIds: parseEvidenceIds(r.evidence_ids),
      status: r.status,
      lastVerifiedAt: r.last_verified_at,
      updatedAt: r.updated_at,
    })),
    episodic: episodicRows.map((r) => ({
      id: r.id,
      agentId: r.agent_id,
      content: r.content,
      source: r.source,
      importance: r.importance,
      score: r.score,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
    })),
  };
}

// ── 遗忘（forgetting，§7.6.4） ──────────────────────────────────────

/**
 * 遗忘清扫（按 Agent 执行，建议与巩固任务同周期）：
 *  1) TTL：expires_at < now 的 episodic 直接删除（原文应已被 consolidate 炼成 semantic）。
 *  2) 容量：episodic 超 10 万上限 → 按 importance×recency 从低到高淘汰到上限内。
 *  3) 证伪：semantic confidence < 0.4 → status='suspect'（标疑不删，等复核，§7.6.4）。
 * @param {number} agentId
 * @returns {{expired:number, evicted:number, suspected:number, episodicRemaining:number}}
 */
export function sweepForgetting(agentId) {
  const id = requireAgentId(agentId);
  const db = getDb();

  // 1) TTL 过期
  const expired = db
    .prepare(
      `DELETE FROM memory_episodic
        WHERE agent_id = ? AND expires_at IS NOT NULL AND expires_at < datetime('now')`
    )
    .run(id).changes;

  // 2) 容量淘汰（LRU 变体：加权分最低者先走）
  const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM memory_episodic WHERE agent_id = ?`);
  const evictStmt = db.prepare(
    `DELETE FROM memory_episodic
      WHERE id IN (
        SELECT id FROM memory_episodic
         WHERE agent_id = ?
         ORDER BY ${SCORE_SQL} ASC, created_at ASC
         LIMIT ?
      )`
  );

  let evicted = 0;
  let remaining = countStmt.get(id).n;
  while (remaining > MEMORY_LIMITS.episodic) {
    const batch = Math.min(EVICT_BATCH, remaining - MEMORY_LIMITS.episodic);
    const changes = evictStmt.run(id, batch).changes;
    if (!changes) break; // 防御：删不动就退出，避免死循环
    evicted += changes;
    remaining = countStmt.get(id).n;
  }

  // 3) 低置信标疑（不删，保留审计与复核入口）
  const suspected = db
    .prepare(
      `UPDATE memory_semantic
          SET status = 'suspect', updated_at = datetime('now')
        WHERE agent_id = ? AND confidence < ? AND status = 'verified'`
    )
    .run(id, SUSPECT_THRESHOLD).changes;

  const result = { expired, evicted, suspected, episodicRemaining: remaining };
  console.log(
    `[memory] sweep agent=${id} 过期删除=${expired} 容量淘汰=${evicted} 标疑=${suspected} 剩余episodic=${remaining}`
  );
  return result;
}

// ── 巩固（consolidation，§7.6.3） ───────────────────────────────────

/**
 * 纯函数：把同一 domain 的 episodic 聚合成「理解草稿」。
 * 无 IO、无外部 API，可单测、可被 LLM 版本替换。
 *
 * TODO(P1，§7.6.3 契约)：接入 LLM 总结插件替换此处的机械聚合——
 *   把 rows 交给 brain / consolidate 类型插件，产出「要点 + 关键出处 + 存疑点」，
 *   返回结构保持不变（understanding / evidenceIds / sources / confidence），
 *   使调用方 consolidate() 无需改动。当前实现是无外部依赖的兜底基线。
 *
 * @param {Array<{id:number, content:string, source?:string, importance?:number, created_at?:string}>} rows
 * @returns {{understanding:string, evidenceIds:number[], sources:string[], count:number, avgImportance:number}}
 */
export function summarizeEpisodics(rows = []) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!list.length) {
    return { understanding: '', evidenceIds: [], sources: [], count: 0, avgImportance: 0 };
  }

  const evidenceIds = list.map((r) => Number(r.id)).filter(Number.isFinite);
  const sources = [...new Set(list.map((r) => r.source).filter(Boolean))];
  const avgImportance =
    list.reduce((sum, r) => sum + clamp01(r.importance, 0.5), 0) / list.length;

  const dates = list.map((r) => r.created_at).filter(Boolean).sort();
  const span = dates.length ? `${dates[0]} ~ ${dates[dates.length - 1]}` : '未知区间';

  // 取重要性最高的若干条作为「要点」，其余只计数（原文由遗忘机制按 TTL 清理）。
  const highlights = [...list]
    .sort((a, b) => clamp01(b.importance, 0.5) - clamp01(a.importance, 0.5))
    .slice(0, 5)
    .map((r, i) => `${i + 1}. ${oneLine(r.content)}`);

  const understanding = [
    `【聚合草稿】共 ${list.length} 条情景记忆（${span}），平均重要性 ${avgImportance.toFixed(2)}。`,
    `来源：${sources.join(' / ') || '未标注'}。`,
    '要点：',
    ...highlights,
    `出处：episodic #${evidenceIds.join(', #')}`,
  ].join('\n');

  return { understanding, evidenceIds, sources, count: list.length, avgImportance };
}

/** 内容压成单行摘要，避免理解草稿被长文淹没。 */
function oneLine(content, max = 120) {
  const s = String(content ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 从一条 episodic 推断它属于哪个 domain。
 * episodic 表按 §7.6.6 不含 domain 列，故按约定从 content 提取：
 *   1) content 是 JSON 且含 domain / topic 字段 → 用之；
 *   2) content 以 `[领域] 正文` 开头 → 取方括号内内容；
 *   3) 否则归入 'general'。
 * 写入方（感知层 / 发布桥）遵循前两种约定即可获得正确分组。
 */
function inferDomain(content) {
  const raw = String(content ?? '').trim();
  if (raw.startsWith('{')) {
    try {
      const obj = JSON.parse(raw);
      const d = obj?.domain ?? obj?.topic;
      if (typeof d === 'string' && d.trim()) return d.trim().slice(0, 50);
    } catch {
      // 不是合法 JSON，继续走前缀约定
    }
  }
  const m = raw.match(/^\[([^\]]{1,50})\]/);
  if (m) return m[1].trim();
  return 'general';
}

/**
 * 巩固：扫描近 days 天 episodic → 按 domain 分组 → summarizeEpisodics 产出理解草稿
 * → writeSemantic 沉淀（confidence 0.6）。这是「Agent 越来越懂世界」的物理动作。
 * 纯本地聚合，不依赖外部 API；LLM 总结见 summarizeEpisodics 的 TODO。
 * @param {number} agentId
 * @param {{days?:number, confidence?:number}} [opts]
 * @returns {{agentId:number, days:number, scanned:number, domains:number,
 *            written:Array<{domain:string, semanticId:number, count:number, created:boolean}>}}
 */
export function consolidate(agentId, { days = 7, confidence = 0.6 } = {}) {
  const id = requireAgentId(agentId);
  const win = Math.max(1, Math.min(3650, Math.trunc(Number(days) || 7)));
  const conf = clamp01(confidence, 0.6);

  const rows = getDb()
    .prepare(
      `SELECT id, content, source, importance, created_at
         FROM memory_episodic
        WHERE agent_id = ?
          AND created_at >= datetime('now', '-${win} days')
          AND (expires_at IS NULL OR expires_at > datetime('now'))
        ORDER BY created_at ASC, id ASC`
    )
    .all(id);

  if (!rows.length) {
    console.log(`[memory] consolidate agent=${id} 近 ${win} 天无 episodic，跳过`);
    return { agentId: id, days: win, scanned: 0, domains: 0, written: [] };
  }

  const groups = new Map();
  for (const row of rows) {
    const domain = inferDomain(row.content);
    if (!groups.has(domain)) groups.set(domain, []);
    groups.get(domain).push(row);
  }

  const written = [];
  for (const [domain, group] of groups) {
    const draft = summarizeEpisodics(group);
    if (!draft.understanding) continue;
    const res = writeSemantic({
      agentId: id,
      domain,
      understanding: draft.understanding,
      confidence: conf,
      evidenceIds: draft.evidenceIds, // 出处不丢：证据 id 全量落库
    });
    written.push({ domain, semanticId: res.id, count: draft.count, created: res.created });
  }

  console.log(
    `[memory] consolidate agent=${id} 窗口=${win}天 扫描=${rows.length} 领域=${groups.size} 沉淀=${written.length}`
  );
  return { agentId: id, days: win, scanned: rows.length, domains: groups.size, written };
}
