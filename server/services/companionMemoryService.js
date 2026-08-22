// server/services/companionMemoryService.js
// 记忆面板后端（M5）—— 见 docs/companion/AI_COMPANION_SPEC.md §7。
// 红线（§7.3）：companion_memory_* 只对主人可见，owner 隔离硬校验。
// 面板能力（§7.4）：按层查看 / 显式添加 / 删单条 / 清空某层 / 全清 / pending 确认。
// 巩固（§7.6）：episodic(pending/verified) → LLM 归纳 → upsert semantic（UNIQUE companion+owner+domain）。
import { db } from '../database/db.js';
import { chat as llmChat } from '../llm/client.js';
import { getOwnedCompanion } from './companionService.js';

const EPISODIC_LIMIT = 200;
const SEMANTIC_LIMIT = 100;
const PROCEDURAL_LIMIT = 100;

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// 测试接缝（与 companionChatService 一致）
let llmChatImpl = llmChat;
export function _setLlmForTest(fn) {
  llmChatImpl = fn || llmChat;
}

async function guard(ownerId, companionId) {
  return getOwnedCompanion(ownerId, companionId);
}

// ── 查询 ─────────────────────────────────────────────────────
export async function listMemories(ownerId, companionId) {
  await guard(ownerId, companionId);
  const [episodic, semantic, procedural] = await Promise.all([
    db.all(
      `SELECT * FROM companion_memory_episodic WHERE companion_id = ? AND owner_id = ?
        ORDER BY status DESC, importance DESC, created_at DESC LIMIT ${EPISODIC_LIMIT}`,
      [companionId, ownerId]
    ),
    db.all(
      `SELECT * FROM companion_memory_semantic WHERE companion_id = ? AND owner_id = ?
        ORDER BY updated_at DESC LIMIT ${SEMANTIC_LIMIT}`,
      [companionId, ownerId]
    ),
    db.all(
      `SELECT * FROM companion_memory_procedural WHERE companion_id = ? AND owner_id = ?
        ORDER BY updated_at DESC LIMIT ${PROCEDURAL_LIMIT}`,
      [companionId, ownerId]
    ),
  ]);
  return { episodic, semantic, procedural };
}

// ── 显式添加（§7.2 路径 1：人设卡/偏好 → 直接写 semantic）─────
export async function addSemanticMemory(ownerId, companionId, { domain, understanding, confidence } = {}) {
  await guard(ownerId, companionId);
  const d = (domain || '').trim();
  const u = (understanding || '').trim();
  if (!d || !u) throw httpError(400, 'domain 与 understanding 必填');
  if (d.length > 50 || u.length > 1000) throw httpError(400, '内容过长');
  const existing = await db.get(
    'SELECT id FROM companion_memory_semantic WHERE companion_id = ? AND owner_id = ? AND domain = ?',
    [companionId, ownerId, d]
  );
  if (existing) {
    await db.run(
      `UPDATE companion_memory_semantic
          SET understanding = ?, confidence = ?, status = 'verified', last_verified_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
      [u, Math.min(1, Math.max(0, Number(confidence) || 0.9)), existing.id]
    );
    return db.get('SELECT * FROM companion_memory_semantic WHERE id = ?', [existing.id]);
  }
  await db.run(
    `INSERT INTO companion_memory_semantic
       (companion_id, owner_id, domain, understanding, confidence, status, last_verified_at)
     VALUES (?, ?, ?, ?, ?, 'verified', CURRENT_TIMESTAMP)`,
    [companionId, ownerId, d, u, Math.min(1, Math.max(0, Number(confidence) || 0.9))]
  );
  const row = await db.get(
    'SELECT * FROM companion_memory_semantic WHERE companion_id = ? AND owner_id = ? AND domain = ?',
    [companionId, ownerId, d]
  );
  return row;
}

// ── 删除 / 清空 ──────────────────────────────────────────────
const LAYERS = {
  episodic: 'companion_memory_episodic',
  semantic: 'companion_memory_semantic',
  procedural: 'companion_memory_procedural',
};

export async function deleteMemory(ownerId, companionId, layer, id) {
  const table = LAYERS[layer];
  if (!table) throw httpError(400, 'layer 须为 episodic/semantic/procedural');
  await guard(ownerId, companionId);
  const row = await db.get(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  if (!row) throw httpError(404, '记忆不存在');
  if (row.owner_id !== ownerId || row.companion_id !== Number(companionId)) {
    throw httpError(403, '无权操作该记忆');
  }
  await db.run(`DELETE FROM ${table} WHERE id = ?`, [id]);
  return { ok: true };
}

/** 清空：layer 缺省 = 全清（§7.4「清空某域 / 全清」）。 */
export async function clearMemories(ownerId, companionId, layer) {
  await guard(ownerId, companionId);
  if (layer) {
    const table = LAYERS[layer];
    if (!table) throw httpError(400, 'layer 须为 episodic/semantic/procedural');
    await db.run(`DELETE FROM ${table} WHERE companion_id = ? AND owner_id = ?`, [companionId, ownerId]);
    return { ok: true, cleared: layer };
  }
  for (const table of Object.values(LAYERS)) {
    await db.run(`DELETE FROM ${table} WHERE companion_id = ? AND owner_id = ?`, [companionId, ownerId]);
  }
  return { ok: true, cleared: 'all' };
}

// ── episodic 状态管理（pending → verified / rejected → 过期）──
export async function setEpisodicStatus(ownerId, companionId, id, status) {
  await guard(ownerId, companionId);
  if (!['pending', 'verified', 'rejected', 'expired'].includes(status)) {
    throw httpError(400, '非法状态');
  }
  const row = await db.get('SELECT * FROM companion_memory_episodic WHERE id = ?', [id]);
  if (!row) throw httpError(404, '记忆不存在');
  if (row.owner_id !== ownerId || row.companion_id !== Number(companionId)) {
    throw httpError(403, '无权操作该记忆');
  }
  await db.run('UPDATE companion_memory_episodic SET status = ? WHERE id = ?', [status, id]);
  return db.get('SELECT * FROM companion_memory_episodic WHERE id = ?', [id]);
}

// ── 巩固（§7.6）：episodic → LLM 归纳 → upsert semantic ──────
/** 把 pending/verified 的情景记忆归纳成语义记忆（域=归纳出的主题）。 */
export async function consolidate(ownerId, companionId) {
  await guard(ownerId, companionId);
  const episodic = await db.all(
    `SELECT * FROM companion_memory_episodic
      WHERE companion_id = ? AND owner_id = ? AND status IN ('pending', 'verified')
      ORDER BY importance DESC, created_at DESC LIMIT 40`,
    [companionId, ownerId]
  );
  if (episodic.length === 0) return { consolidated: 0, semantic: [] };

  const existingSemantic = await db.all(
    'SELECT domain, understanding FROM companion_memory_semantic WHERE companion_id = ? AND owner_id = ?',
    [companionId, ownerId]
  );

  const r = await llmChatImpl({
    purpose: 'memory',
    json: true,
    temperature: 0.2,
    maxTokens: 1500,
    messages: [
      {
        role: 'system',
        content: [
          '你是记忆巩固器。把"情景记忆"（零散事实）归纳成"语义记忆"（稳定特征），供 AI 搭档长期了解主人。',
          '已有语义记忆（不要重复，可在其上深化）：',
          existingSemantic.length
            ? existingSemantic.map((s) => `- ${s.domain}：${s.understanding}`).join('\n')
            : '（暂无）',
          '',
          '输出 JSON：{"memories":[{"domain":"主题词（≤10字，如 文风/兴趣/称呼/习惯）","understanding":"一句话归纳（≤100字）","evidence":"依据的情景记忆编号，如 3,7"}]}',
          '只归纳有跨条目规律的稳定特征，孤立的琐碎事实不要硬归纳；最多 5 条。没有就 {"memories":[]}。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: episodic
          .map((e, i) => `#${i + 1} [${e.status}] ${e.content}`)
          .join('\n'),
      },
    ],
  });
  if (!r?.content) throw httpError(503, '巩固暂时失败，请稍后再试');

  let parsed;
  try {
    parsed = JSON.parse(r.content);
  } catch {
    throw httpError(503, '巩固结果解析失败，请稍后再试');
  }
  const items = Array.isArray(parsed?.memories) ? parsed.memories.slice(0, 5) : [];

  const out = [];
  for (const m of items) {
    if (!m?.domain || !m?.understanding) continue;
    const added = await addSemanticMemory(ownerId, companionId, {
      domain: String(m.domain).slice(0, 50),
      understanding: String(m.understanding).slice(0, 1000),
      confidence: 0.7,
    });
    out.push(added);
  }
  return { consolidated: out.length, semantic: out, considered: episodic.length };
}

export default {
  listMemories,
  addSemanticMemory,
  deleteMemory,
  clearMemories,
  setEpisodicStatus,
  consolidate,
};
