// server/lib/ownerImpressions.js
// 档2 主人印象卡（2026-09-27）——**它自己**写下的「关于主人的一句话」。
//
// 一句话：这是小桔本机 USER.md 的线上对物，但**平台只保管、不代写**。
//   · 写口只认 agent_token，平台没有任何代码路径替它生成内容（零代写红线，§2）。
//   · 主人不需要做任何动作：它每轮 run_cycle 自己从 7 天留行里提炼、自己写进来。
//   · 这些卡只回传给它自己（§4.6 取数第 1 顺位），永不外泄给别的 Agent、不进任何公共流。
//
// ── 「记忆越来越多怎么解决」的正面回答（这是本文件存在的头号理由）────
// 小桔本地能靠 LLM 压缩 + 归档，线上必须先把「谁判、怎么判、删不删」钉死。四道防线：
//   ① 近重复指纹：同 Agent 同 kind 同内容，30 天内不重复入库（防复读冲量）。
//   ② kind 分级 TTL：preference|correction = 主人这个人的内核，**永不衰减**；
//      work = 时效性的项目进展，超 WORK_TTL_DAYS 自动转 archived（不删、可回查、不再回灌）。
//   ③ 活跃上限 ACTIVE_MAX：写入口满了先归档最旧的 work 腾位，
//      且 preference/correction **永不因上限被挤掉**（核心记忆优先于总量整洁）。
//   ④ 回流限量：每封纪事最多带 RECALL_MAX 条（靠最近+内核优先挑），
//      完整记忆靠它自己用读口去翻（档1 的过滤口）——上下文不会被记忆撑爆。
//
// 关键取舍：**归档不是删除**。archived 的行还在库里、还能查、还能被它自己恢复；
//   这与日记的「只追加」同源——判断差来自时间跨度，静默删掉就断了。
import crypto from 'node:crypto';
import { db, isMaria, fn } from '../database/db.js';
// 档3 主人自述：合读两本账时把他交的料也递过来（source='owner_self'）
import { listSelfNotesForAgent, markReading } from './ownerSelfNotes.js';

/** kind 取值域：决定这条记忆的寿命与它在回流里的优先级。 */
export const IMPRESSION_KINDS = new Set(['preference', 'correction', 'work']);
/** 🔴 永不衰减的两类——主人这个人的内核（照抄小桔 decay_memory 的分类哲学）。 */
export const IMMORTAL_KINDS = new Set(['preference', 'correction']);
/** work（项目进展）的寿命：超期转归档，不删。 */
export const WORK_TTL_DAYS = 30;
/** 近重复判定窗：同 kind 同内容 30 天内不重复入库。 */
export const DUP_WINDOW_DAYS = 30;
/** 每只 Agent 的活跃记忆上限：超过先归档最旧的 work 腾位（内核永不挤掉）。 */
export const ACTIVE_MAX = 60;
/** 每封纪事最多回灌几条（上下文预算纪律）。 */
export const RECALL_MAX = 8;

export const IMPRESSION_MAX = 300;
export const IMPRESSION_MIN = 1;

const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const fail = (status, code, message, extra) => {
  const e = new Error(code); e.status = status; e.code = code; e.message = message;
  if (extra) e.payload = extra;
  return e;
};

const fpOf = (kind, body) => crypto.createHash('sha256')
  .update(`${kind}|${clip(body, IMPRESSION_MAX)}`).digest('hex').slice(0, 64);

/**
 * 写一条「关于主人的话」。**只给 Agent 自己调**（路由层用 requireActiveAgent 兜）。
 *
 * ⚠️ 这里的纪律与日记写口同源，但更严一档：
 *   · 平台不代笔——本函数只**存**调用方给的字符串，平台不会「帮她想一句」；
 *   · kind 决定寿命，所以它得自己判断这是偏好/纠正/进展，不确定就别写（宁可少抽不可错抽）。
 */
export async function writeImpression({ agentId, kind, body, sourceEntryId = null, now = new Date() }) {
  const aid = Number(agentId);
  const k = String(kind || '');
  if (!aid) throw fail(400, 'invalid_agent', '缺少 Agent');
  if (!IMPRESSION_KINDS.has(k)) throw fail(400, 'invalid_kind', 'kind 只能是 preference|correction|work');
  const text = clip(body, IMPRESSION_MAX);
  if (text.length < IMPRESSION_MIN) throw fail(400, 'empty_body', '不能是空的');

  // 防线①：近重复（30 天窗）。这是防复读，不是省空间——它挡的是「同一句被写 20 遍」。
  const fp = fpOf(k, text);
  const dupExpr = isMaria
    ? `created_at >= DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ${DUP_WINDOW_DAYS} DAY)`
    : `created_at >= datetime('now', '-${DUP_WINDOW_DAYS} days')`;
  const dup = await db.get(
    `SELECT id FROM owner_impressions WHERE agent_id = ? AND kind = ? AND fingerprint = ? AND ${dupExpr} LIMIT 1`,
    [aid, k, fp]
  ).catch(() => null);
  if (dup) return { ok: true, id: Number(dup.id), deduped: true };

  // 防线②：work 超龄归档（preference/correction 永不衰减）——写之前顺手做，
  //   免得单独跑一次清理任务。
  await archiveAgedWork(aid, now);

  // 防线③：活跃上限——满了先归档最旧的 work 腾位；内核永不因上限被挤掉。
  await evictForCapacity(aid);

  const ins = await db.run(
    `INSERT INTO owner_impressions (agent_id, kind, body, source_entry_id, fingerprint, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'active', ${fn.now()})`,
    [aid, k, text, sourceEntryId == null ? null : Number(sourceEntryId) || null, fp]
  );
  return { ok: true, id: Number(ins.lastInsertRowid ?? ins.insertId) };
}

/** 防线②的独立入口：work 超 WORK_TTL_DAYS 转 archived（不删、可回查）。 */
export async function archiveAgedWork(agentId, now = new Date()) {
  const aid = Number(agentId);
  if (!aid) return { archived: 0 };
  const expr = isMaria
    ? `DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ${WORK_TTL_DAYS} DAY)`
    : `datetime('now', '-${WORK_TTL_DAYS} days')`;
  const r = await db.run(
    `UPDATE owner_impressions SET status = 'archived', archived_at = ${fn.now()}
     WHERE agent_id = ? AND kind = 'work' AND status = 'active' AND created_at < ${expr}`,
    [aid]
  ).catch(() => null);
  return { archived: Number(r?.affectedRows ?? r?.changes ?? 0) };
}

/** 防线③：活跃满 ACTIVE_MAX 时，归档最旧的 work 腾位（内核永不挤掉）。 */
export async function evictForCapacity(agentId) {
  const aid = Number(agentId);
  if (!aid) return { evicted: 0 };
  const cnt = await db.get(
    `SELECT COUNT(*) c FROM owner_impressions WHERE agent_id = ? AND status = 'active'`, [aid]
  ).catch(() => null);
  let over = Number(cnt?.c || 0) - ACTIVE_MAX;
  if (over <= 0) return { evicted: 0 };
  // 优先归档最旧的 work；work 不够才动（理论上不该发生，因为上限就是留给内核的余量）
  const rows = await db.all(
    `SELECT id FROM owner_impressions WHERE agent_id = ? AND status = 'active' AND kind = 'work'
     ORDER BY created_at ASC, id ASC LIMIT ?`, [aid, Math.max(over, 0)]
  ).catch(() => []);
  let n = 0;
  for (const row of rows || []) {
    await db.run(
      `UPDATE owner_impressions SET status = 'archived', archived_at = ${fn.now()} WHERE id = ?`,
      [Number(row.id)]
    ).catch(() => {});
    n += 1;
  }
  return { evicted: n };
}

/**
 * 它自己读回自己的印象卡（可只看某类 / 含归档）。
 * ⚠️ 档3（09-28）：合读两本账——**同时**返回主人交的自述（source='owner_self'）。
 *   两本账的 id 空间独立：impressions 用 impressionIds、self notes 用 selfNoteIds，
 *   串号会误判"报过"（档2 的教训）。
 *   调用顺手把 pending 的自述置为 reading（标记"她读过了"，供主人侧状态灯）。
 */
export async function listImpressions(agentId, { kind = null, includeArchived = false, limit = 50 } = {}) {
  const aid = Number(agentId);
  if (!aid) return [];
  const cap = Math.min(Number(limit) || 50, 200);
  const conds = ['agent_id = ?'];
  const params = [aid];
  if (kind && IMPRESSION_KINDS.has(String(kind))) { conds.push('kind = ?'); params.push(String(kind)); }
  if (!includeArchived) conds.push("status = 'active'");
  const rows = await db.all(
    `SELECT id, kind, body, source_entry_id, status, created_at, archived_at
       FROM owner_impressions WHERE ${conds.join(' AND ')}
     ORDER BY created_at DESC, id DESC LIMIT ${cap}`,
    params
  ).catch(() => []);
  const impressions = (rows || []).map((r) => ({
    id: Number(r.id), kind: r.kind, body: r.body,
    sourceEntryId: r.source_entry_id == null ? null : Number(r.source_entry_id),
    status: r.status, createdAt: r.created_at, archivedAt: r.archived_at || null,
    source: 'agent_impression',
  }));
  // 合读：她未消化的自述（不混进 kind 过滤——自述的 kind 域与印象卡不同）
  await markReading(aid);
  const selfNotes = await listSelfNotesForAgent(aid, { limit: 20 });
  return [...impressions, ...selfNotes];
}

/**
 * 回流用（档2b）：挑**要递回给它自己**的那几条（防线④）。
 * 挑法：内核（preference/correction）优先且按最近在前，其次 work；最多 RECALL_MAX 条。
 * 已经在上一封纪事里报过的 id 不重复报（由调用方传 excludeIds）。
 */
export async function pickForRecall(agentId, { excludeIds = [], limit = RECALL_MAX } = {}) {
  const aid = Number(agentId);
  if (!aid) return [];
  await archiveAgedWork(aid);
  const rows = await db.all(
    `SELECT id, kind, body FROM owner_impressions
     WHERE agent_id = ? AND status = 'active' ORDER BY created_at DESC, id DESC`,
    [aid]
  ).catch(() => []);
  const ex = new Set((excludeIds || []).map(Number));
  const inner = [], work = [];
  for (const r of rows || []) {
    if (ex.has(Number(r.id))) continue;
    (IMMORTAL_KINDS.has(String(r.kind)) ? inner : work).push(r);
  }
  const cap = Math.min(Number(limit) || RECALL_MAX, RECALL_MAX);
  return [...inner, ...work].slice(0, cap).map((r) => ({
    id: Number(r.id), kind: r.kind, body: String(r.body || ''),
  }));
}

export default {
  writeImpression, listImpressions, pickForRecall,
  archiveAgedWork, evictForCapacity,
  IMPRESSION_KINDS, IMMORTAL_KINDS, WORK_TTL_DAYS, ACTIVE_MAX, RECALL_MAX, IMPRESSION_MAX,
};