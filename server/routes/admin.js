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

// ── 软件定制询盘管理（从旧站 aibbs.chat 迁入，2026-08-21）─────────
// 路径与旧站保持一致：/api/admin/software-orders
// GET  /stats                        状态计数
// GET  /?page&limit&status&search    列表
// GET  /:id                          详情（conversation 自动解析）
// PUT  /:id                          更新 status / admin_notes
// DELETE /:id                        归档（软删除）

const SO_STATUSES = [
  'pending', 'reviewing', 'quoted', 'accepted',
  'developing', 'delivered', 'rejected', 'archived',
];

// 统计
router.get(
  '/software-orders/stats',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const rows = await db.all(`SELECT status, COUNT(*) AS count FROM software_orders GROUP BY status`);
    const stats = Object.fromEntries(SO_STATUSES.map((s) => [s, 0]));
    let total = 0;
    for (const r of rows) {
      if (r.status in stats) stats[r.status] = Number(r.count);
      total += Number(r.count);
    }
    stats.total = total;
    res.json({ success: true, data: stats });
  })
);

// 列表
router.get(
  '/software-orders',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const status = String(req.query.status || '');
    const search = String(req.query.search || '').trim();

    const where = ['1=1'];
    const params = [];
    if (status && SO_STATUSES.includes(status)) {
      where.push('status = ?');
      params.push(status);
    }
    if (search) {
      where.push('(title LIKE ? OR description LIKE ? OR customer_name LIKE ? OR contact_info LIKE ? OR order_no LIKE ?)');
      const kw = `%${search}%`;
      for (let i = 0; i < 5; i++) params.push(kw);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;

    const rows = await db.all(
      `SELECT * FROM software_orders ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const total = await db.get(`SELECT COUNT(*) AS n FROM software_orders ${whereSql}`, params);

    res.json({
      success: true,
      data: rows.map((r) => ({
        id: r.id,
        orderNo: r.order_no,
        customerName: r.customer_name,
        contactInfo: r.contact_info,
        companyName: r.company_name,
        projectType: r.project_type,
        title: r.title,
        description: r.description,
        techStack: r.tech_stack,
        timeline: r.timeline,
        budgetRange: r.budget_range,
        designRequirements: r.design_requirements,
        deploymentNeeds: r.deployment_needs,
        userScale: r.user_scale,
        maintenanceNeeds: r.maintenance_needs,
        taobaoOrderNo: r.taobao_order_no,
        status: r.status,
        source: r.source,
        conversation: r.conversation,
        adminNotes: r.admin_notes,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        reviewedAt: r.reviewed_at,
      })),
      pagination: {
        page,
        limit,
        total: Number(total?.n ?? 0),
        totalPages: Math.ceil(Number(total?.n ?? 0) / limit),
      },
    });
  })
);

// 详情
router.get(
  '/software-orders/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const r = await db.get('SELECT * FROM software_orders WHERE id = ?', [id]);
    if (!r) return res.status(404).json({ success: false, error: '订单不存在' });
    let conv = r.conversation;
    if (typeof conv === 'string') {
      try { conv = JSON.parse(conv); } catch { /* 保留原始字符串 */ }
    }
    res.json({
      success: true,
      data: {
        id: r.id,
        orderNo: r.order_no,
        customerName: r.customer_name,
        contactInfo: r.contact_info,
        companyName: r.company_name,
        projectType: r.project_type,
        title: r.title,
        description: r.description,
        techStack: r.tech_stack,
        timeline: r.timeline,
        budgetRange: r.budget_range,
        designRequirements: r.design_requirements,
        deploymentNeeds: r.deployment_needs,
        userScale: r.user_scale,
        maintenanceNeeds: r.maintenance_needs,
        taobaoOrderNo: r.taobao_order_no,
        status: r.status,
        source: r.source,
        conversation: conv,
        adminNotes: r.admin_notes,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        reviewedAt: r.reviewed_at,
      },
    });
  })
);

// 更新（status / admin_notes）
router.put(
  '/software-orders/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const { status, adminNotes } = req.body || {};
    const existing = await db.get('SELECT id, reviewed_at FROM software_orders WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ success: false, error: '订单不存在' });

    const sets = [];
    const params = [];
    if (status !== undefined) {
      if (!SO_STATUSES.includes(status)) return res.status(400).json({ success: false, error: 'invalid_status' });
      sets.push('status = ?');
      params.push(status);
      if (status === 'reviewing' && !existing.reviewed_at) {
        sets.push('reviewed_at = NOW()');
      }
    }
    if (adminNotes !== undefined) {
      sets.push('admin_notes = ?');
      params.push(typeof adminNotes === 'string' ? adminNotes : String(adminNotes ?? ''));
    }
    if (!sets.length) return res.json({ success: false, error: '没有需要更新的字段' });
    params.push(id);
    await db.run(`UPDATE software_orders SET ${sets.join(', ')} WHERE id = ?`, params);

    const r = await db.get('SELECT * FROM software_orders WHERE id = ?', [id]);
    res.json({ success: true, data: { id: r.id, status: r.status, adminNotes: r.admin_notes } });
  })
);

// 归档（软删除）
router.delete(
  '/software-orders/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    await db.run(`UPDATE software_orders SET status = 'archived' WHERE id = ?`, [id]);
    res.json({ success: true, message: '订单已归档' });
  })
);

export default router;
