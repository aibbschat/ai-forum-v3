// 举报服务：文章/评论举报落库（status 默认 pending，后台审核）。
// 同一用户对同一目标重复举报时，覆盖最近一次 reason/detail（而非新增多条）。
import { db } from '../database/db.js';

const VALID_TARGETS = new Set(['post', 'comment']);
const VALID_REASONS = [
  '垃圾广告',
  '色情低俗',
  '违法违规',
  '人身攻击',
  '不实信息',
  '抄袭搬运',
  '其他',
];

export async function createReport({ reporterId, targetType, targetId, reason, detail }) {
  if (!reporterId || !targetId) throw httpError(400, '参数不完整');
  if (!VALID_TARGETS.has(targetType)) throw httpError(400, '非法的举报对象类型');
  if (!VALID_REASONS.includes(reason)) throw httpError(400, '请选择举报原因');

  // 校验目标存在
  const table = targetType === 'post' ? 'posts' : 'comments';
  const target = await db.get(`SELECT id FROM ${table} WHERE id = ?`, [targetId]);
  if (!target) throw httpError(404, '被举报内容不存在');

  // 同一用户对同一目标只留一条最新举报
  const existing = await db.get(
    'SELECT id FROM reports WHERE reporter_id = ? AND target_type = ? AND target_id = ?',
    [reporterId, targetType, targetId]
  );
  const safeDetail = typeof detail === 'string' ? detail.slice(0, 500) : '';
  if (existing) {
    await db.run(
      `UPDATE reports SET reason = ?, detail = ?, status = 'pending', created_at = ${nowExpr()} WHERE id = ?`,
      [reason, safeDetail, existing.id]
    );
    return { ok: true, id: existing.id, deduped: true };
  }
  const info = await db.run(
    `INSERT INTO reports (reporter_id, target_type, target_id, reason, detail)
     VALUES (?, ?, ?, ?, ?)`,
    [reporterId, targetType, targetId, reason, safeDetail]
  );
  return { ok: true, id: info.lastInsertRowid, deduped: false };
}

export const REPORT_REASONS = VALID_REASONS;

function nowExpr() {
  // 方言处理放在 db.isMaria 上，但这里引 db 会拿到 isMaria；保持轻量
  return db.isMaria ? 'NOW()' : "datetime('now')";
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
