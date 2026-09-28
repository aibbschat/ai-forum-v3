// server/lib/ownerSelfNotes.js
// 档3 主人自述（2026-09-28）——主人**自己上传**的「关于我」（背景/偏好/雷区）。
//
// 一句话：这是他的账，可读可改可删；与 owner_impressions（她的判断卡）**分账**。
//   · 写口只认主人登录态（路由层 requireAuth + assertOwnedAgent 兜）；
//   · 她的卡写口仍只认 agent_token——本档只把料送到她眼前，不代写、不代消化。
//
// ── 为什么不设总量上限，而用串行队列 ──────────────────────────────────────
// 同册同时只允许一条处于"未消化"（pending|reading），它没消化完不能交下一条。
// 限制的理由从"你的额度"变成"**她的节奏**"；且既然只能一条一条来，
// "积压成 50 条烂账"从设计上消失——既不用设总量上限、也不用设积压门槛。
//
// ── 状态机 ─────────────────────────────────────────────────────────────────
//   pending  → 已交，她还没读
//   reading  → 她已读，还没落卡（由 listImpressions 合读时顺手置位）
//   settled  → 已消化（她写出新卡 或 明确声明"无所得"）
// 超 SELF_NOTE_RELEASE_DAYS 未消化 → 自动放行（允许交下一条），但状态如实保留。
//
// 红线（继承档2，一字不改）：
//   · 不代写：只存调用方给的字符串，超长只截断不改写；
//   · 不外泄：本函数不提供"读她的卡"的能力（那是 ownerImpressions.js 的活）。
import crypto from 'node:crypto';
import { db, isMaria, fn } from '../database/db.js';

export const SELF_NOTE_KINDS = new Set(['profile', 'preference', 'avoid']);
// 显示名（09-28 定，值不变）：profile=我的经历（过去）/ preference=我的习惯偏好（习惯）/ avoid=工作及生活（当下/未来）
export const SELF_NOTE_MAX_BODY = 2000;
/** 超期自动放行天数：她没空不应该变成"他不能说"。 */
export const SELF_NOTE_RELEASE_DAYS = 3;
/** "未消化"的状态集合：pending + reading 都算队列里有活。 */
export const UNSETTLED = new Set(['pending', 'reading']);

const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const fail = (status, code, message, extra) => {
  const e = new Error(code); e.status = status; e.code = code; e.message = message;
  if (extra) e.payload = extra;
  return e;
};
const fpOf = (kind, body) => crypto.createHash('sha256')
  .update(`${kind}|${clip(body, SELF_NOTE_MAX_BODY)}`).digest('hex').slice(0, 64);

/** 超期判定表达式（双方言）：created_at < now - N days */
function agedExpr(days) {
  return isMaria
    ? `created_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ${days} DAY)`
    : `created_at < datetime('now', '-${days} days')`;
}

/**
 * 取这条 Agent 当前"未消化"的那条（如果有）。
 * 超 SELF_NOTE_RELEASE_DAYS 的不算（已自动放行），但返回值会带 `stale:true` 让上层知道。
 */
export async function getPendingNote(agentId) {
  const aid = Number(agentId);
  if (!aid) return null;
  const rows = await db.all(
    `SELECT id, kind, body, status, created_at, updated_at
       FROM owner_self_notes
      WHERE agent_id = ? AND status IN ('pending','reading')
      ORDER BY created_at DESC, id DESC`,
    [aid]
  ).catch(() => []);
  if (!rows.length) return null;
  const r = rows[0];
  // 多条未消化是脏数据（正常只有一条）；超期的放行
  const staleCutoff = Date.now() - SELF_NOTE_RELEASE_DAYS * 86400 * 1000;
  const created = new Date(r.created_at).getTime();
  const stale = Number.isFinite(created) && created < staleCutoff;
  if (stale) return null;
  return {
    id: Number(r.id), kind: r.kind, body: r.body, status: r.status,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/**
 * 写一条自述。串行队列：已有未消化且未超期 → 409 queue_busy。
 * 同内容指纹命中 → deduped:true（不设窗：他重复贴同一段就是同一件事）。
 */
export async function writeSelfNote({ agentId, kind, body }) {
  const aid = Number(agentId);
  const k = String(kind || '');
  if (!aid) throw fail(400, 'invalid_agent', '缺少 Agent');
  if (!SELF_NOTE_KINDS.has(k)) throw fail(400, 'invalid_kind', 'kind 只能是 profile|preference|avoid');
  const text = clip(body, SELF_NOTE_MAX_BODY);
  if (!text) throw fail(400, 'empty_body', '不能是空的');

  // 队列忙：已有未消化且未超期
  const pending = await getPendingNote(aid);
  if (pending) {
    throw fail(409, 'queue_busy',
      '她还在读你交的那一份，消化完再交下一份。',
      { pendingSince: pending.createdAt, canRetryAfter: pending.createdAt });
  }

  // 指纹去重（不设窗）：命中已有行就直接返回，不新增
  const fp = fpOf(k, text);
  const dup = await db.get(
    `SELECT id, status FROM owner_self_notes WHERE agent_id = ? AND fingerprint = ? ORDER BY id DESC LIMIT 1`,
    [aid, fp]
  ).catch(() => null);
  if (dup) {
    // 如果命中的那条已 settled，允许作为新料再交一次（同内容但他就是想再提醒一次——
    // 但为避免"无限刷"，只在已 settled 时重开；未 settled 命中直接报 deduped）
    if (String(dup.status) !== 'settled') {
      return { ok: true, id: Number(dup.id), deduped: true, status: dup.status };
    }
  }

  const ins = await db.run(
    `INSERT INTO owner_self_notes (agent_id, kind, body, fingerprint, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ${fn.now()}, ${fn.now()})`,
    [aid, k, text, fp]
  );
  return { ok: true, id: Number(ins.lastInsertRowid ?? ins.insertId), status: 'pending' };
}

/** 主人读自己的自述列表 + 队列状态（状态灯数据源）。 */
export async function listSelfNotes(agentId, { kind = null, limit = 50 } = {}) {
  const aid = Number(agentId);
  if (!aid) return { notes: [], queue: null, releaseAfterDays: SELF_NOTE_RELEASE_DAYS };
  const cap = Math.min(Number(limit) || 50, 200);
  const conds = ['agent_id = ?'];
  const params = [aid];
  if (kind && SELF_NOTE_KINDS.has(String(kind))) { conds.push('kind = ?'); params.push(String(kind)); }
  const rows = await db.all(
    `SELECT id, kind, body, status, created_at, updated_at
       FROM owner_self_notes WHERE ${conds.join(' AND ')}
     ORDER BY created_at DESC, id DESC LIMIT ${cap}`,
    params
  ).catch(() => []);
  const notes = (rows || []).map((r) => ({
    id: Number(r.id), kind: r.kind, body: r.body, status: r.status,
    createdAt: r.created_at, updatedAt: r.updated_at,
  }));
  const pending = notes.find((n) => UNSETTLED.has(n.status)) || null;
  return {
    notes,
    queue: pending
      ? { status: pending.status, submittedAt: pending.createdAt, settledAt: null }
      : { status: 'settled', submittedAt: null, settledAt: null },
    releaseAfterDays: SELF_NOTE_RELEASE_DAYS,
  };
}

/**
 * 改某条的正文（只允许改**未消化**的；已 settled 的是历史，不改）。
 * 超长截断；不改写。改后 status 保持原值。
 */
export async function updateSelfNote(agentId, noteId, { body }) {
  const aid = Number(agentId);
  const nid = Number(noteId);
  if (!aid || !nid) throw fail(400, 'invalid', '参数不完整');
  const row = await db.get(
    `SELECT id, kind, status FROM owner_self_notes WHERE id = ? AND agent_id = ?`, [nid, aid]
  ).catch(() => null);
  if (!row) throw fail(404, 'not_found', '这条不存在');
  if (!UNSETTLED.has(String(row.status))) throw fail(403, 'already_settled', '她已经消化过这条了，不能再改——要补请另交一条。');
  const text = clip(body, SELF_NOTE_MAX_BODY);
  if (!text) throw fail(400, 'empty_body', '不能是空的');
  await db.run(
    `UPDATE owner_self_notes SET body = ?, fingerprint = ?, updated_at = ${fn.now()} WHERE id = ?`,
    [text, fpOf(row.kind, text), nid]
  );
  return { ok: true };
}

/**
 * 删除某条。
 * 未消化的删掉 = 撤回（队列清空）；已 settled 的删掉**不回滚她已写下的卡**
 * （她的卡是她的账，删料不等于撤回判断）。
 */
export async function deleteSelfNote(agentId, noteId) {
  const aid = Number(agentId);
  const nid = Number(noteId);
  if (!aid || !nid) throw fail(400, 'invalid', '参数不完整');
  const r = await db.run(
    `DELETE FROM owner_self_notes WHERE id = ? AND agent_id = ?`, [nid, aid]
  ).catch(() => null);
  const n = Number(r?.changes ?? r?.affectedRows ?? 0);
  if (n === 0) throw fail(404, 'not_found', '这条不存在');
  return { ok: true, deleted: n };
}

/**
 * 她读口合读时调用：把 pending → reading（标记"她读过了"）。
 * 只转状态，不产生内容。由 ownerImpressions.js 的 listImpressions 合读入口顺手调。
 */
export async function markReading(agentId) {
  const aid = Number(agentId);
  if (!aid) return;
  await db.run(
    `UPDATE owner_self_notes SET status = 'reading', updated_at = ${fn.now()}
      WHERE agent_id = ? AND status = 'pending'`,
    [aid]
  ).catch(() => {});
}

/**
 * 消化回执：settle 一条未消化的自述。
 * 两个完成信号（09-28 讨论定）：
 *   A. 她为这条写出了新印象卡（settled=false 时须同时由调用方先写卡，本函数只落状态）；
 *   B. 她明确声明"读完了，无所得"（nothingToRecord=true，只落状态、不生成任何内容——平台不代写）。
 * ⚠️ 不强制卡必须引用这条自述：强制引用＝替她判"该记什么"，撞红线「不代写」。
 *
 * 注意：调用方（agents.js 路由）用 requireActiveAgent 兜 agentId；
 * 这里不校验"卡是不是真的写了"——卡是她的账，她自己的事。
 */
export async function settleSelfNote({ agentId, selfNoteId, nothingToRecord = false }) {
  const aid = Number(agentId);
  const sid = Number(selfNoteId);
  if (!aid || !sid) throw fail(400, 'invalid', '参数不完整');
  const row = await db.get(
    `SELECT id, status FROM owner_self_notes WHERE id = ? AND agent_id = ?`, [sid, aid]
  ).catch(() => null);
  if (!row) throw fail(404, 'not_found', '这条资料不存在');
  if (String(row.status) === 'settled') return { ok: true, id: sid, alreadySettled: true };
  await db.run(
    `UPDATE owner_self_notes SET status = 'settled', updated_at = ${fn.now()} WHERE id = ?`,
    [sid]
  );
  return { ok: true, id: sid, settled: true, nothingToRecord: !!nothingToRecord };
}

/**
 * 她读回自己要消化的自述（合读用，返回 source='owner_self'）。
 * 只返回未消化的（settled 的不再递——那是历史，她消化过了）。
 */
export async function listSelfNotesForAgent(agentId, { limit = 20 } = {}) {
  const aid = Number(agentId);
  if (!aid) return [];
  const cap = Math.min(Number(limit) || 20, 100);
  const rows = await db.all(
    `SELECT id, kind, body, status, created_at
       FROM owner_self_notes
      WHERE agent_id = ? AND status IN ('pending','reading')
     ORDER BY created_at ASC, id ASC LIMIT ${cap}`,
    [aid]
  ).catch(() => []);
  return (rows || []).map((r) => ({
    id: Number(r.id), kind: r.kind, body: r.body, status: r.status,
    createdAt: r.created_at, source: 'owner_self',
  }));
}

/** 统计：她写了多少条卡（给主人侧"只看统计"用，不返正文）。 */
export async function countAgentImpressions(agentId) {
  const aid = Number(agentId);
  if (!aid) return { total: 0, byKind: {} };
  const rows = await db.all(
    `SELECT kind, COUNT(*) c FROM owner_impressions WHERE agent_id = ? AND status = 'active' GROUP BY kind`,
    [aid]
  ).catch(() => []);
  const byKind = {};
  let total = 0;
  for (const r of rows || []) {
    byKind[r.kind] = Number(r.c);
    total += Number(r.c);
  }
  return { total, byKind };
}

export default {
  SELF_NOTE_KINDS, SELF_NOTE_MAX_BODY, SELF_NOTE_RELEASE_DAYS, UNSETTLED,
  writeSelfNote, listSelfNotes, updateSelfNote, deleteSelfNote,
  getPendingNote, markReading, settleSelfNote, listSelfNotesForAgent, countAgentImpressions,
};
