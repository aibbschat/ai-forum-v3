// server/services/memory/index.js
// 记忆层服务：三层记忆（情景 / 语义 / 程序）的写入、检索分级、遗忘、巩固。
// 依据：TECH-SPEC.md v2.3 §7.6（记忆生命周期管理）；ROADMAP P0-3。
//
// 设计要点：
// - 所有 DB 访问统一走 db.js（异步 DAO），时间/分数方言 SQL 一律经 fn.* 收口。
// - 时间统一用当前时间（UTC），与建表默认值 CURRENT_TIMESTAMP 同口径。
// - 检索加权 = importance × recency，recency = 1 / (1 + 距今天数)（Ebbinghaus 简化，§7.6.4）。
// - 巩固（consolidate）由 LLM 驱动（§7.6.3）：按 domain 分组 → 每组一次 /chat/completions 总结
//   成结构化 JSON（要点 + 置信度自评 + 存疑点）→ writeSemantic 沉淀，evidence_ids 全量保留出处。
//   无 DEEPSEEK_API_KEY 或 LLM 调用/解析失败 → 自动回退 summarizeEpisodics 纯函数聚合（降级铁律）。

import { db, fn, isMaria } from '../../database/db.js';

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

// ── LLM 巩固（§7.6.3）配置 ─────────────────────────────────────────
// 巩固总结一律走 server/llm 统一路由层（chat()），不再直接 fetch /chat/completions，
// 也不再读 DEEPSEEK_* 变量——供应商/模型/密钥全部由 llm/config.js 统一决定，
// 换模型（火山/小米/DeepSeek）只需改一处配置或 LLM_MODEL_MEMORY 环境变量。
// 仅为单测保留 createLlmSummarizer 的可注入签名（apiKey/fetchImpl），生产路径不用。
import { chat as llmChat } from '../../llm/client.js';

const LLM_TIMEOUT_MS = 120_000; // 与 llm/client.js 的 purpose=memory 超时一致

/** 检索加权表达式：importance × recency，recency = 1/(1+距今天数)。 */
const SCORE_SQL = `importance * ${fn.recencyScore('created_at')}`;

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

/** UTC 时间字符串（与 SQLite datetime('now') 同格式）。fn 无负偏移助手，窗口起点在此计算，避免裸方言。 */
function utcNowOffsetDays(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
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
export async function writeEpisodic({ agentId, content, source = 'perceive', importance = 0.5, status = 'pending' }) {
  const id = requireAgentId(agentId);
  const text = requireText(content, 'content');
  const src = normalizeSource(source);
  const imp = clamp01(importance, 0.5);
  const st = ['pending', 'locked', 'used', 'void'].includes(status) ? status : 'pending';

  const info = await db.run(
    `INSERT INTO memory_episodic (agent_id, content, source, importance, status, expires_at)
     VALUES (?, ?, ?, ?, ?, ${fn.nowOffsetDays(EPISODIC_TTL_DAYS)})`,
    [id, text, src, imp, st]
  );

  return { id: Number(info.lastInsertRowid), agentId: id, source: src, importance: imp, status: st };
}

// ════════════════════════════════════════════════════════════════
// 素材库生命周期（P1-16，2026-08-15）
// 素材（source='perceive'）不是"用完即弃"，而是进入素材池：
//   pending（感知积累）→ locked（写作锁定）→ used（发布已用，防重复）
// 配合一周整理（consolidate + sweep）：已用素材提炼进 semantic，未用素材按 TTL 淘汰。
// ════════════════════════════════════════════════════════════════

/**
 * 查询素材池（感知素材，status 可按需过滤）。
 * 默认只取待用（pending）素材——写作前"有把握"的依据。
 * @param {number} agentId
 * @param {{status?:string, limit?:number}} [opts]
 */
export async function listMaterialPool(agentId, { status = 'pending', limit = 50 } = {}) {
  const id = requireAgentId(agentId);
  const k = Math.max(1, Math.min(200, Number(limit) || 50));
  const rows = await db.all(
    `SELECT id, content, source, importance, status, created_at
       FROM memory_episodic
      WHERE agent_id = ? AND source = 'perceive'
        AND status = ?
        AND (expires_at IS NULL OR expires_at > ${fn.now()})
      ORDER BY importance DESC, created_at DESC
      LIMIT ?`,
    [id, status, k]
  );
  return rows;
}

/**
 * 判断某条感知素材是否已在该 Agent 的素材池中（任意状态：pending/locked/used）。
 *
 * 用于防止静态 seed 主题 / 重复 web_search 结果每轮被当作"新素材"反复入库，
 * 进而导致同一选题被反复写作（历史考据官曾把"古罗马道路"写了两次、"龙凤"写了三次）。
 *
 * 匹配策略：取素材文本前 N 字做包含匹配。perceive 入库的 content 形如
 *   "[seed] 古罗马道路网……：<摘要>（url）"
 * 标题部分稳定，用前 40 字 LIKE 即可拦住同一条 seed 的重复入库，
 * 又不会因摘要微调而误判为全新素材。
 *
 * @param {number} agentId
 * @param {string} content
 * @param {{withinDays?:number}} [opts] 只查最近 N 天（TTL 内），默认 30
 * @returns {Promise<boolean>}
 */
export async function materialExists(agentId, content, { withinDays = 30 } = {}) {
  const id = requireAgentId(agentId);
  const text = String(content || '').trim();
  if (!text) return false;
  // 用前 40 个字符作为指纹（够覆盖"[source] 标题"部分）。
  // ESCAPE 用 '!' 而非反斜杠：MariaDB 默认把反斜杠当字符串转义符，
  // 会把 ESCAPE '\' 的闭合引号吞掉导致语法错误（SQLite 不报错，线上 MariaDB 崩）。
  const fingerprint = text.slice(0, 40).replace(/[%_!]/g, (m) => '!' + m);
  // 窗口起点在 JS 侧算成 UTC 字符串，避免 SQLite/MariaDB 时间方言差异
  const since = new Date(Date.now() - withinDays * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const row = await db.get(
    `SELECT 1 AS hit FROM memory_episodic
      WHERE agent_id = ? AND source = 'perceive'
        AND content LIKE ? ESCAPE '!'
        AND created_at >= ?
      LIMIT 1`,
    [id, `%${fingerprint}%`, since]
  );
  return !!row;
}

/**
 * 素材饱和判断：待用素材（pending）按 importance 加权累计，达到阈值即"有把握可写"。
 * @param {number} agentId
 * @param {{minCount?:number, minScore?:number}} [opts]
 * @returns {{saturated:boolean, count:number, score:number}}
 */
export async function materialSaturation(agentId, { minCount = 3, minScore = 1.5 } = {}) {
  const pool = await listMaterialPool(agentId, { status: 'pending', limit: 100 });
  const count = pool.length;
  const score = pool.reduce((s, m) => s + (m.importance || 0.5), 0);
  return {
    saturated: count >= minCount && score >= minScore,
    count,
    score,
  };
}

/**
 * 把中文文本拆成检索词（去标点 + 中文二元组 + 空格分词），用于素材相关性匹配。
 * 与 chatService.toTerms 同思路：OR 检索比整句 LIKE 更可能命中。
 */
function toMatchTerms(text) {
  const cleaned = (text || '').replace(/[？?！!，,。.、：:；;""''（）()【】\[\]《》<>/\\|+\-_*=~`@#$%^&]/g, ' ').trim();
  const terms = new Set();
  cleaned.split(/\s+/).forEach((t) => {
    if (t.length >= 2) terms.add(t);
  });
  const cjk = cleaned.replace(/[a-zA-Z0-9\s]/g, '');
  for (let i = 0; i + 2 <= cjk.length; i++) {
    const bg = cjk.slice(i, i + 2);
    if (/[一-龥]{2}/.test(bg)) terms.add(bg);
  }
  return Array.from(terms);
}

/**
 * 锁定素材为写作依据（pending → locked）。
 * 发布成功后调用 markMaterialUsed 把同一批标为 used（防重复）。
 * @param {number} agentId
 * @param {{count?:number, topics?:string[]}} [opts]
 *   topics：本次选题关键词（来自当次感知），传入后只锁定与选题【同主题】的素材，
 *   避免把跨话题的历史 pending 素材（如上周百花奖）串进这篇文章。
 *   不传 topics → 保持旧行为（按 importance 锁前 count 条）。
 * @returns {Promise<number[]>} 锁定的素材 id 列表
 */
export async function lockMaterial(agentId, { count = 5, topics = null } = {}) {
  const id = requireAgentId(agentId);
  // 相关主题锁定：拉取更多候选，用选题关键词打分筛出同主题簇
  if (Array.isArray(topics) && topics.length > 0) {
    const terms = new Set();
    for (const t of topics) toMatchTerms(t).forEach((w) => terms.add(w));
    const termList = Array.from(terms);
    if (termList.length) {
      const pool = await listMaterialPool(id, { status: 'pending', limit: 20 });
      if (pool.length === 0) return [];
      // 按「命中词数」打分；命中多词者优先（主题更贴合）
      const scored = pool
        .map((m) => {
          const text = m.content || '';
          let hit = 0;
          for (const w of termList) if (text.includes(w)) hit += 1;
          return { m, hit };
        })
        .filter((x) => x.hit > 0)
        .sort((a, b) => b.hit - a.hit || b.m.importance - a.m.importance);
      if (scored.length === 0) {
        console.log(`[memory] lockMaterial(${id}) 池中无与选题「${topics.join(' / ')}」相关的素材，本轮不锁（素材继续积累）`);
        return [];
      }
      const picked = scored.slice(0, count).map((x) => x.m.id);
      await db.run(
        `UPDATE memory_episodic SET status = 'locked' WHERE agent_id = ? AND id IN (${picked.map(() => '?').join(',')})`,
        [id, ...picked]
      );
      return picked;
    }
  }

  // 旧行为：无 topics / 无词，按 importance 锁前 count 条
  const pool = await listMaterialPool(id, { status: 'pending', limit: count });
  if (pool.length === 0) return [];
  const ids = pool.map((m) => m.id);
  await db.run(
    `UPDATE memory_episodic SET status = 'locked' WHERE agent_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
    [id, ...ids]
  );
  return ids;
}

/**
 * 标记素材已用（locked → used，发布成功后调用，防下篇重复引用）。
 * @param {number} agentId
 * @param {number[]} ids
 */
export async function markMaterialUsed(agentId, ids) {
  const id = requireAgentId(agentId);
  const list = Array.isArray(ids) ? ids.map(Number).filter(Number.isFinite) : [];
  if (list.length === 0) return;
  await db.run(
    `UPDATE memory_episodic SET status = 'used' WHERE agent_id = ? AND id IN (${list.map(() => '?').join(',')})`,
    [id, ...list]
  );
}

/**
 * 素材池一周整理（配合 consolidate/sweep，P1-16）：
 *   - 已用素材（used）→ 原文保留给 consolidate 提炼（episodic 原文由 TTL 淘汰）
 *   - 过期未用（pending/locked 超 TTL）→ 由 sweepForgetting 统一清理
 * 本函数返回池状态统计，供调度/日志观察。
 */
export async function materialPoolStats(agentId) {
  const id = requireAgentId(agentId);
  const rows = await db.all(
    `SELECT status, COUNT(*) AS c FROM memory_episodic
      WHERE agent_id = ? AND source = 'perceive' GROUP BY status`,
    [id]
  );
  const stats = { pending: 0, locked: 0, used: 0, void: 0 };
  for (const r of rows) stats[r.status] = r.c;
  return stats;
}

/**
 * 写入/更新一条语义记忆（upsert on (agent_id, domain)）。
 * 已存在 → 更新 understanding / confidence / evidence_ids / updated_at / last_verified_at；
 * 不存在 → 插入，status='verified'，last_verified_at=now。
 * @param {{agentId:number, domain?:string, understanding:string, confidence?:number, evidenceIds?:number[]}} input
 * @returns {{id:number, agentId:number, domain:string, confidence:number, created:boolean}}
 */
export async function writeSemantic({ agentId, domain, understanding, confidence = 0.6, evidenceIds = [] }) {
  const id = requireAgentId(agentId);
  const dom = normalizeDomain(domain);
  const text = requireText(understanding, 'understanding');
  const conf = clamp01(confidence, 0.6);
  const evidence = JSON.stringify(toIdArray(evidenceIds));

  const existed = await db.get(
    `SELECT id FROM memory_semantic WHERE agent_id = ? AND domain = ?`,
    [id, dom]
  );

  // 复核成功（重新沉淀）即视为再次验证：status 回到 verified，last_verified_at 刷新。
  // upsert 方言：SQLite ON CONFLICT ... excluded / MariaDB ON DUPLICATE KEY UPDATE ... VALUES()
  const upsert = isMaria
    ? `ON DUPLICATE KEY UPDATE
         understanding    = VALUES(understanding),
         confidence       = VALUES(confidence),
         evidence_ids     = VALUES(evidence_ids),
         status           = 'verified',
         last_verified_at = VALUES(last_verified_at),
         updated_at       = VALUES(updated_at)`
    : `ON CONFLICT(agent_id, domain) DO UPDATE SET
         understanding    = excluded.understanding,
         confidence       = excluded.confidence,
         evidence_ids     = excluded.evidence_ids,
         status           = 'verified',
         last_verified_at = ${fn.now()},
         updated_at       = ${fn.now()}`;
  await db.run(
    `INSERT INTO memory_semantic
       (agent_id, domain, understanding, confidence, evidence_ids, status, last_verified_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'verified', ${fn.now()}, ${fn.now()})
     ${upsert}`,
    [id, dom, text, conf, evidence]
  );

  const row = await db.get(
    `SELECT id FROM memory_semantic WHERE agent_id = ? AND domain = ?`,
    [id, dom]
  );

  return { id: row.id, agentId: id, domain: dom, confidence: conf, created: !existed };
}

/**
 * 写入/更新一条程序记忆（upsert on (agent_id, skill)）。已存在则 version + 1。
 * @param {{agentId:number, skill:string, procedure:string}} input
 * @returns {{id:number, agentId:number, skill:string, version:number}}
 */
export async function writeProcedural({ agentId, skill, procedure }) {
  const id = requireAgentId(agentId);
  const skillName = requireText(skill, 'skill');
  const text = requireText(procedure, 'procedure');

  const upsert = isMaria
    ? `ON DUPLICATE KEY UPDATE
         \`procedure\` = VALUES(\`procedure\`),
         version    = memory_procedural.version + 1,
         updated_at = ${fn.now()}`
    : `ON CONFLICT(agent_id, skill) DO UPDATE SET
         \`procedure\` = excluded.\`procedure\`,
         version    = memory_procedural.version + 1,
         updated_at = ${fn.now()}`;
  await db.run(
    `INSERT INTO memory_procedural (agent_id, skill, \`procedure\`, version, updated_at)
     VALUES (?, ?, ?, 1, ${fn.now()})
     ${upsert}`,
    [id, skillName, text]
  );

  const row = await db.get(
    `SELECT id, version FROM memory_procedural WHERE agent_id = ? AND skill = ?`,
    [id, skillName]
  );

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
export async function readMemory(agentId, { domain, limit = 20 } = {}) {
  const id = requireAgentId(agentId);
  const k = Math.max(1, Math.min(500, Number(limit) || 20));

  // ① semantic：作废（void）的不再供给大脑；suspect 保留但带 status，由调用方按 confidence 决策。
  const semanticRows = domain
    ? await db.all(
        `SELECT id, agent_id, domain, understanding, confidence, evidence_ids, status,
                last_verified_at, updated_at
           FROM memory_semantic
          WHERE agent_id = ? AND domain = ? AND status != 'void'
          ORDER BY confidence DESC, updated_at DESC
          LIMIT ?`,
        [id, normalizeDomain(domain), k]
      )
    : await db.all(
        `SELECT id, agent_id, domain, understanding, confidence, evidence_ids, status,
                last_verified_at, updated_at
           FROM memory_semantic
          WHERE agent_id = ? AND status != 'void'
          ORDER BY confidence DESC, updated_at DESC
          LIMIT ?`,
        [id, k]
      );

  // ② episodic：过期未清扫的直接排除（sweep 之前也不该被读到）。
  const episodicRows = await db.all(
    `SELECT id, agent_id, content, source, importance, created_at, expires_at,
            ${SCORE_SQL} AS score
       FROM memory_episodic
      WHERE agent_id = ?
        AND (expires_at IS NULL OR expires_at > ${fn.now()})
      ORDER BY score DESC, created_at DESC
      LIMIT ?`,
    [id, k]
  );

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
export async function sweepForgetting(agentId) {
  const id = requireAgentId(agentId);

  // 1) TTL 过期
  const expired = (
    await db.run(
      `DELETE FROM memory_episodic
        WHERE agent_id = ? AND expires_at IS NOT NULL AND expires_at < ${fn.now()}`,
      [id]
    )
  ).changes;

  // 2) 容量淘汰（LRU 变体：加权分最低者先走）
  let evicted = 0;
  let remaining = (
    await db.get(`SELECT COUNT(*) AS n FROM memory_episodic WHERE agent_id = ?`, [id])
  ).n;

  while (remaining > MEMORY_LIMITS.episodic) {
    const batch = Math.min(EVICT_BATCH, remaining - MEMORY_LIMITS.episodic);
    const changes = (
      await db.run(
        `DELETE FROM memory_episodic
          WHERE id IN (
            SELECT id FROM memory_episodic
             WHERE agent_id = ?
             ORDER BY ${SCORE_SQL} ASC, created_at ASC
             LIMIT ?
          )`,
        [id, batch]
      )
    ).changes;
    if (!changes) break; // 防御：删不动就退出，避免死循环
    evicted += changes;
    remaining = (
      await db.get(`SELECT COUNT(*) AS n FROM memory_episodic WHERE agent_id = ?`, [id])
    ).n;
  }

  // 3) 低置信标疑（不删，保留审计与复核入口）
  const suspected = (
    await db.run(
      `UPDATE memory_semantic
          SET status = 'suspect', updated_at = ${fn.now()}
        WHERE agent_id = ? AND confidence < ? AND status = 'verified'`,
      [id, SUSPECT_THRESHOLD]
    )
  ).changes;

  const result = { expired, evicted, suspected, episodicRemaining: remaining };
  console.log(
    `[memory] sweep agent=${id} 过期删除=${expired} 容量淘汰=${evicted} 标疑=${suspected} 剩余episodic=${remaining}`
  );
  return result;
}

// ── 巩固（consolidation，§7.6.3） ───────────────────────────────────

/**
 * 查询某 Agent 最近一次 semantic 巩固的时间（无则 null）。
 * 用于巩固节流：判断"上次把 episodic 炼成 semantic 是什么时候"。
 */
export async function getLastConsolidatedAt(agentId) {
  const id = requireAgentId(agentId);
  const row = await db.get(
    `SELECT MAX(updated_at) AS t FROM memory_semantic WHERE agent_id = ?`,
    [id]
  );
  return row?.t || null;
}

/**
 * 节流巩固（供 agentCycle 周期调用）：距离上次巩固 >= consolidateEveryDays 天，
 * 且本周期有新的 episodic 可巩固，才执行 consolidate（LLM 驱动，失败自动回退纯函数）。
 * 返回 null 表示本次跳过（未到周期或无素材）。
 *
 * @param {number} agentId
 * @param {{consolidateEveryDays?:number, days?:number, confidence?:number}} [opts]
 * @returns {Promise<object|null>} consolidate 结果，或 null（跳过）
 */
export async function maybeConsolidate(
  agentId,
  { consolidateEveryDays = 7, days = 7, confidence = 0.6 } = {}
) {
  const id = requireAgentId(agentId);
  const interval = Math.max(1, Math.trunc(Number(consolidateEveryDays) || 7));

  // 节流：距上次巩固不足 interval 天则跳过
  const last = await getLastConsolidatedAt(id);
  if (last) {
    const lastTs = new Date(String(last).replace(' ', 'T') + (String(last).includes('Z') ? '' : 'Z')).getTime();
    if (Number.isFinite(lastTs)) {
      const elapsedDays = (Date.now() - lastTs) / 86400000;
      if (elapsedDays < interval) {
        return null; // 未到巩固周期
      }
    }
  }

  // 有新的 episodic 才巩固（避免空转）
  const recentCount = (
    await db.get(
      `SELECT COUNT(*) AS c FROM memory_episodic
        WHERE agent_id = ? AND created_at >= ${fn.nowOffsetDays(-interval)}
              AND (expires_at IS NULL OR expires_at > ${fn.now()})`,
      [id]
    )
  ).c;
  if (recentCount === 0) return null;

  return consolidate(id, { days, confidence });
}

/**
 * 纯函数：把同一 domain 的 episodic 聚合成「理解草稿」。
 * 无 IO、无外部 API，可单测。
 *
 * 现在它是 consolidate 的**降级基线**（§7.6.3 降级铁律）：
 *   无 DEEPSEEK_API_KEY 或 LLM 调用/解析失败时，consolidate 自动回退到这里，
 *   产出机械聚合草稿，保证巩固闭环绝不中断。LLM 版本见 createLlmSummarizer()。
 * 返回结构（understanding / evidenceIds / sources / confidence）与 LLM 版本保持一致，
 * 使 consolidate() 对两种路径的消费方式完全相同。
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

/**
 * 容错解析 LLM 返回的 JSON：剥掉 ```json 围栏，截取首个 {…} 块。
 * 解析失败抛错（由调用方触发降级，绝不静默吞掉结构问题）。
 */
function parseLlmJson(raw) {
  let s = String(raw ?? '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('LLM 返回中未找到 JSON 对象');
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch (e) {
    throw new Error(`LLM 返回 JSON 解析失败: ${e.message}`);
  }
}

/**
 * 创建 LLM 巩固总结器（§7.6.3 契约的 LLM 实现）。
 *
 * 返回 async (rows) => draft，draft 结构：
 *   { understanding, evidenceIds, sources, count, avgImportance, confidence, doubts }
 * 与 summarizeEpisodics 返回结构对齐（额外带 confidence 自评与 doubts 存疑点），
 * 使 consolidate() 对 LLM / 纯函数两条路径的消费方式一致。
 *
 * 生产路径（无注入参数）一律走 server/llm 统一层 chat({purpose:'memory'})，
 * 供应商/模型/密钥/降级全部由 llm/config.js 决定，本模块不再直连端点或读 DEEPSEEK_*。
 *
 * 仅为单测保留可注入参数（apiKey + fetchImpl）：传入 fetchImpl 时走注入的直连路径，
 * 以便断言请求体/鉴权头而不依赖真实供应商。
 *
 * @param {{apiKey?:string, model?:string, endpoint?:string, timeoutMs?:number,
 *          fetchImpl?:typeof fetch}} [opts]
 * @returns {(rows:Array<object>) => Promise<object>}
 */
export function createLlmSummarizer({
  apiKey,
  model,
  endpoint,
  timeoutMs = LLM_TIMEOUT_MS,
  fetchImpl,
} = {}) {
  return async function llmSummarizer(rows = []) {
    const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
    if (!list.length) return summarizeEpisodics([]);

    // domain 从组内第一条 content 推断，仅用于 prompt 上下文提示，不做分组依据。
    const domain = inferDomain(list[0].content);
    const evidences = list.map((r) => `#${r.id} [imp=${clamp01(r.importance, 0.5).toFixed(2)}] ${oneLine(r.content, 160)}`);

    const messages = [
      {
        role: 'system',
        content:
          '你是记忆巩固引擎。把同一领域的一组情景记忆归纳为一条结构化理解，输出 JSON：' +
          '{"understanding": "要点理解（1~3 句，可含关键结论）", "confidence": 0~1 的自评置信度, ' +
          '"doubts": ["存疑点数组，可为空"], "evidenceIds": [支撑证据的 episodic id 数组]}。' +
          '不要编造原文没有的信息；证据不足时降低 confidence 并在 doubts 里说明。',
      },
      {
        role: 'user',
        content: `领域：${domain}\n共 ${list.length} 条情景记忆：\n${evidences.join('\n')}`,
      },
    ];

    // ── 测试注入路径：直连 fetch，断言请求体/鉴权头，不依赖统一层 ──
    if (typeof fetchImpl === 'function') {
      if (!apiKey) throw new Error('测试注入需要 apiKey');
      const target = endpoint || 'https://invalid.test/chat/completions';
      const resp = await fetchImpl(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: model || 'test-model',
          messages,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`LLM HTTP ${resp.status}: ${text.slice(0, 200)}`);
      }
      const payload = await resp.json().catch(() => {
        throw new Error('LLM 响应不是合法 JSON');
      });
      return buildDraft(list, payload?.choices?.[0]?.message?.content);
    }

    // ── 生产路径：统一层（自动供应商选择 + 降级 + 超时）──
    const res = await llmChat({ purpose: 'memory', messages, json: true, timeout: timeoutMs });
    if (!res || !res.content) throw new Error('LLM 统一层无可用响应（回退纯函数聚合）');
    return buildDraft(list, res.content);
  };
}

/** 把 LLM 返回的 JSON 文本解析成 draft（统一层与注入路径共用）。 */
function buildDraft(list, content) {
  if (typeof content !== 'string' || !content.trim()) throw new Error('LLM 返回内容为空');
  const parsed = parseLlmJson(content);
  const understanding = typeof parsed.understanding === 'string' ? parsed.understanding.trim() : '';
  if (!understanding) throw new Error('LLM 返回缺少 understanding 字段');
  return {
    understanding,
    evidenceIds: toIdArray(parsed.evidenceIds),
    sources: [...new Set(list.map((r) => r.source).filter(Boolean))],
    count: list.length,
    avgImportance: list.reduce((sum, r) => sum + clamp01(r.importance, 0.5), 0) / list.length,
    confidence: clamp01(parsed.confidence, undefined), // 缺失时留给 consolidate 用 confidence 参数兜底
    doubts: Array.isArray(parsed.doubts) ? parsed.doubts.map(String).filter(Boolean) : [],
  };
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
 * 巩固：扫描近 days 天 episodic → 按 domain 分组 → 每组一次 LLM 总结（§7.6.3）
 * → writeSemantic 沉淀（understanding=LLM 总结、confidence=LLM 自评夹 0~1、
 *   evidence_ids=该组全部 episodic id，出处不丢）。
 * 这是「Agent 越来越懂世界」的物理动作。
 *
 * 降级铁律：无 DEEPSEEK_API_KEY 或 LLM 调用/解析失败 → 该组自动回退
 * summarizeEpisodics 纯函数聚合并 console.warn，绝不中断、不抛错。
 *
 * 可测性：llmSummarizer(rows) 可注入（默认 createLlmSummarizer() 调 DeepSeek），
 * 测试注入 mock / 抛出故障的 mock，不真调 API。
 *
 * @param {number} agentId
 * @param {{days?:number, confidence?:number,
 *          llmSummarizer?: (rows:Array<object>) => Promise<object>}} [opts]
 * @returns {Promise<{agentId:number, days:number, scanned:number, domains:number,
 *            written:Array<{domain:string, semanticId:number, count:number,
 *                           created:boolean, llm:boolean}>}>}
 */
export async function consolidate(
  agentId,
  { days = 7, confidence = 0.6, llmSummarizer } = {}
) {
  const id = requireAgentId(agentId);
  const win = Math.max(1, Math.min(3650, Math.trunc(Number(days) || 7)));
  const conf = clamp01(confidence, 0.6);
  // 默认 LLM 总结器；未注入时每次调用现取（apiKey 读自 process.env，可测试无 key 场景）。
  const summarizer = llmSummarizer ?? createLlmSummarizer();

  const rows = await db.all(
    `SELECT id, content, source, importance, created_at
       FROM memory_episodic
      WHERE agent_id = ?
        AND created_at >= ?
        AND (expires_at IS NULL OR expires_at > ${fn.now()})
      ORDER BY created_at ASC, id ASC`,
    [id, utcNowOffsetDays(-win)]
  );

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
    let draft;
    let usedLlm = false;
    try {
      draft = await summarizer(group);
      if (!draft || typeof draft.understanding !== 'string' || !draft.understanding.trim()) {
        throw new Error('总结器返回空 understanding');
      }
      usedLlm = true;
    } catch (err) {
      // 降级铁律：LLM 不可用/故障 → 纯函数聚合兜底，绝不让巩固环节中断。
      console.warn(
        `[memory] consolidate agent=${id} domain=${domain} LLM 总结失败，回退纯函数聚合：${err.message}`
      );
      draft = summarizeEpisodics(group);
    }

    if (!draft.understanding) continue;

    // 出处不丢（§7.6.8）：evidence_ids 恒为该组全部 episodic id，不依赖 LLM 是否返回。
    const evidenceIds = group.map((r) => Number(r.id)).filter(Number.isFinite);
    // confidence：LLM 路径用自评（夹 0~1，缺失回落参数）；纯函数路径用参数。
    const finalConf = usedLlm ? clamp01(draft.confidence, conf) : conf;

    const res = await writeSemantic({
      agentId: id,
      domain,
      understanding: draft.understanding,
      confidence: finalConf,
      evidenceIds,
    });
    written.push({
      domain,
      semanticId: res.id,
      count: group.length,
      created: res.created,
      llm: usedLlm,
    });
  }

  const llmCount = written.filter((w) => w.llm).length;
  console.log(
    `[memory] consolidate agent=${id} 窗口=${win}天 扫描=${rows.length} 领域=${groups.size} ` +
      `沉淀=${written.length}（LLM=${llmCount}，回退=${written.length - llmCount}）`
  );
  return { agentId: id, days: win, scanned: rows.length, domains: groups.size, written };
}
