// 举报管理（最小可用，非完整后台）：
// - GET  /api/admin/reports?status=pending|resolved|all  列出举报
// - POST /api/admin/reports/:id/resolve                    标记为已处理
//
// 鉴权：.env 中设置 ADMIN_TOKEN 后，请求带 ?token=xxx 或 X-Admin-Token。
// 未设置 ADMIN_TOKEN 时，所有接口返回 404（不暴露存在性）。
import { Router } from 'express';
import { db } from '../database/db.js';
import { config } from '../config/index.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = Router();

function requireAdmin(req, res, next) {
  if (!config.adminToken) return res.status(404).json({ error: 'not_found' });
  const token =
    req.header('X-Admin-Token') ||
    (typeof req.query.token === 'string' ? req.query.token : '');
  if (token !== config.adminToken) return res.status(401).json({ error: 'unauthorized' });
  next();
}

router.get(
  '/reports',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const status = String(req.query.status || 'pending');
    const limit = Math.min(100, Number(req.query.limit) || 50);
    const offset = Math.max(0, Number(req.query.offset) || 0);

    const where = [];
    const params = [];
    if (status === 'pending' || status === 'resolved' || status === 'rejected') {
      where.push('r.status = ?');
      params.push(status);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = await db.all(
      `SELECT r.id, r.target_type AS targetType, r.target_id AS targetId,
              r.reason, r.detail, r.status, r.created_at AS createdAt,
              ru.id AS reporterId, ru.nickname AS reporterName, ru.username AS reporterUsername,
              CASE WHEN r.target_type = 'post' THEN p.title ELSE SUBSTR(c.content, 1, 140) END AS targetText,
              CASE WHEN r.target_type = 'post' THEN p.author_id ELSE c.author_id END AS targetAuthorId
       FROM reports r
       LEFT JOIN users ru ON ru.id = r.reporter_id
       LEFT JOIN posts p ON r.target_type = 'post' AND p.id = r.target_id
       LEFT JOIN comments c ON r.target_type = 'comment' AND c.id = r.target_id
       ${whereSql}
       ORDER BY r.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const total = await db.get(
      `SELECT COUNT(*) AS n FROM reports r ${whereSql}`,
      params
    );

    res.json({ reports: rows, total: total?.n ?? rows.length });
  })
);

router.post(
  '/reports/:id/resolve',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const status = String(req.body?.status || 'resolved');
    if (!['resolved', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ error: 'invalid_status' });
    }
    await db.run('UPDATE reports SET status = ? WHERE id = ?', [status, id]);
    res.json({ ok: true });
  })
);

export default router;
