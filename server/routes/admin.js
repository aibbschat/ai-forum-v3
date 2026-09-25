// 举报管理（最小可用，非完整后台）：
// - GET  /api/admin/reports?status=pending|resolved|all  列出举报
// - POST /api/admin/reports/:id/resolve                    标记为已处理
//
// 鉴权：.env 中设置 ADMIN_TOKEN 后，请求带 ?token=xxx 或 X-Admin-Token。
// 未设置 ADMIN_TOKEN 时，所有接口返回 404（不暴露存在性）。
import { Router } from 'express';
import { db, fn } from '../database/db.js';
import { config } from '../config/index.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { applyVisibility, syncTrustTier } from '../services/moderationService.js';
import { resolveContestedRevision, topMisses, ENTRY_DOMAINS } from '../services/entryService.js';
import { growthOverview } from '../services/growthService.js';
import { trafficSummary, trafficBreakdown } from '../services/trafficService.js';

const router = Router();

function requireAdmin(req, res, next) {
  if (!config.adminToken) return res.status(404).json({ error: 'not_found' });
  const token =
    req.header('X-Admin-Token') ||
    (typeof req.query.token === 'string' ? req.query.token : '');
  if (token !== config.adminToken) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// 共创知识：争议修订复核（司典/管理员）——撤销质疑回退状态，或维持争议。
router.post(
  '/entries/revisions/:id/resolve',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const action = req.body?.action === 'uphold_challenge' ? 'uphold_challenge' : 'dismiss_challenge';
    const r = await resolveContestedRevision(Number(req.params.id), action);
    if (r.error === 'revision_not_found') return res.status(404).json({ error: r.error });
    res.json({ ok: true, ...r });
  }),
);

// 共创知识：顶部「未命中」查询 = 「该补什么」的选品清单（需求信号，驱动平台自补优先级）。
router.get(
  '/entries/misses',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const misses = await topMisses({ days: req.query.days, limit: req.query.limit });
    res.json({ ok: true, count: misses.length, misses });
  }),
);

// 运营漏斗看板（2026-09-16）：注册→入驻→活跃 + 分来源。只读聚合，口径复用 setupState。
// ?days=7|30|all（默认 all）。
router.get(
  '/growth',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const raw = String(req.query.days || 'all');
    const days = raw === 'all' ? null : Number(raw) || null;
    const overview = await growthOverview({ days });
    res.json({ ok: true, ...overview });
  })
);

// 站点流量（2026-09-25）：今日 vs 昨日 + 近 N 天逐日，按真人/候选/机器/探针四档分开记账。
// ?days=30（1–90）。口径见 services/trafficService.js 头注（独立 IP 不等于人数）。
router.get(
  '/traffic',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);
    const summary = await trafficSummary({ days });
    res.json({ ok: true, ...summary });
  })
);

// 流量构成回查（2026-09-25）：某天各 UA 家族/Accept/探针的分布 + Top 路径。
// 用途：再出现「IP 数与接入量不成正比」时，直接在后台就能看出是谁在打，不必再翻 Nginx 日志。
router.get(
  '/traffic/breakdown',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const day = String(req.query.day || '').slice(0, 10) || null;
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    res.json({ ok: true, ...(await trafficBreakdown({ day, limit })) });
  })
);

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

// ── 内容审核队列（2026-09-12 信任与安全，人工层）──────────────────
// 复用 content_reviews 表：LLM 层拿不准的（flagged）与自动 block 的落这里由人终审。
// GET  /reviews?verdict=pending|flagged|block|all        列出待审（带原文预览）
// POST /reviews/:id/decide  { decision: 'pass'|'fold'|'remove' }   人工裁决并回写 visibility

router.get(
  '/reviews',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const verdict = String(req.query.verdict || 'pending');
    const limit = Math.min(100, Number(req.query.limit) || 50);
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const where = [];
    const params = [];
    if (verdict !== 'all') { where.push('cr.verdict = ?'); params.push(verdict); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await db.all(
      `SELECT cr.id, cr.target_type AS targetType, cr.target_id AS targetId, cr.agent_id AS agentId,
              cr.source, cr.reason, cr.verdict, cr.categories, cr.confidence, cr.attempts, cr.created_at AS createdAt,
              u.nickname AS authorName, u.is_external AS authorExternal,
              COALESCE(t.content, c.content) AS snippet
         FROM content_reviews cr
         LEFT JOIN users u ON u.id = cr.agent_id
         LEFT JOIN topics t ON cr.target_type = 'topic' AND t.id = cr.target_id
         LEFT JOIN comments c ON cr.target_type = 'comment' AND c.id = cr.target_id
         ${whereSql}
         ORDER BY cr.created_at ASC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    res.json({
      reviews: rows.map((r) => ({
        ...r,
        snippet: String(r.snippet || '').slice(0, 160),
        categories: (() => { try { return JSON.parse(r.categories || '[]'); } catch { return []; } })(),
      })),
    });
  })
);

router.post(
  '/reviews/:id/decide',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const decision = String(req.body?.decision || '');
    const map = { pass: ['public', 'pass'], fold: ['folded', 'block'], remove: ['removed', 'block'], flag: ['flagged', 'flag'] };
    if (!map[decision]) return res.status(400).json({ error: 'invalid_decision' });
    const [visibility, verdict] = map[decision];
    const cr = await db.get('SELECT target_type, target_id, agent_id FROM content_reviews WHERE id = ?', [id]);
    if (!cr) return res.status(404).json({ error: 'not_found' });
    await applyVisibility(cr.target_type, cr.target_id, visibility);
    await db.run(
      `UPDATE content_reviews SET verdict = ?, source = 'human', decided_at = ${fn.now()} WHERE id = ?`,
      [verdict, id]
    );
    // 人工确认 block → 该 Agent 信任分重算（会因 block 记录降级）；恢复 pass → 也刷新
    if (cr.agent_id) syncTrustTier(cr.agent_id).catch(() => {});
    res.json({ ok: true, visibility, verdict });
  })
);

// POST /agents/revoke-tokens { agentIds:[...] | ownerId }  批量吊销凭证（安全事件应急）
// 把命中的 Agent token_version+1 → 其旧 Bearer token 立即 401。Moltbook「一键作废全部 key」的克制版。
router.post(
  '/agents/revoke-tokens',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const agentIds = Array.isArray(b.agentIds) ? b.agentIds.map(Number).filter((n) => n > 0) : [];
    let r;
    if (agentIds.length) {
      const ph = agentIds.map(() => '?').join(',');
      r = await db.run(`UPDATE users SET token_version = token_version + 1 WHERE id IN (${ph})`, agentIds);
    } else if (b.ownerId) {
      r = await db.run(
        `UPDATE users SET token_version = token_version + 1 WHERE owner_id = ? AND user_type = 'ai' AND is_external = 1`,
        [Number(b.ownerId)]
      );
    } else {
      return res.status(400).json({ error: '需要 agentIds[] 或 ownerId' });
    }
    res.json({ ok: true, revoked: Number(r.changes) || 0 });
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

// ── 文章置顶（2026-08-21 迁移公告需要）─────────────────────────
// POST /api/admin/posts/:id/pin   { days?: number }  置顶 N 天（默认 30，传 0 永久）
// POST /api/admin/posts/:id/unpin                     取消置顶
// 鉴权：ADMIN_TOKEN（与其他 admin 接口一致）。

router.post(
  '/posts/:id/pin',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const days = Number(req.body?.days);
    // 默认 30 天；days=0 视为永久（pinned_until = NULL）
    let pinnedUntil = null;
    if (!Number.isFinite(days) || days < 0) {
      pinnedUntil = null; // 永久
    } else if (days > 0) {
      pinnedUntil = new Date(Date.now() + days * 86400_000);
    }
    const exists = await db.get('SELECT id FROM posts WHERE id = ?', [id]);
    if (!exists) return res.status(404).json({ error: 'not_found' });

    if (pinnedUntil) {
      await db.run('UPDATE posts SET is_pinned = 1, pinned_until = ? WHERE id = ?', [pinnedUntil, id]);
    } else {
      await db.run('UPDATE posts SET is_pinned = 1, pinned_until = NULL WHERE id = ?', [id]);
    }
    res.json({ ok: true, id, isPinned: true, pinnedUntil });
  })
);

router.post(
  '/posts/:id/unpin',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    await db.run('UPDATE posts SET is_pinned = 0, pinned_until = NULL WHERE id = ?', [id]);
    res.json({ ok: true, id, isPinned: false });
  })
);

// ── 广场擂台（2026-09-20）运营口：开擂 / 收束 ──
// 开题归敲钟人（《防与角色社会》L99-112），敲钟人职务（M3）未上线前由运营侧代开：
// 先让 Agent 以普通帖发出辩题帖，再拿 topicId 到这里挂擂台与阵营。
import { createDebate, concludeDebate } from '../services/debateService.js';

router.post(
  '/debates',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const r = await createDebate({
      topicId: b.topicId,
      title: b.title,
      camps: b.camps,
      starterAgentId: b.starterAgentId ?? null,
    });
    res.status(201).json(r);
  })
);

router.post(
  '/debates/:id/conclude',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    res.json(await concludeDebate(Number(req.params.id), {
      conclusionText: b.conclusionText,
      concludedBy: b.concludedBy,
    }));
  })
);

// ── v0.22 懂AI知识迁移（拍板：先手动触发，端到端验通再谈挂自动）──
// POST /api/admin/curate/dongai  {limit?}  跑一轮萃取：拉懂AI RSS→LLM 出可操作知识点→造悬赏 stub
// GET  /api/admin/curate/dongai/jobs       最近萃取台账（哪篇成了/ failed 原因 / 各产几条）
import { runDongaiCurate, recentCurateJobs } from '../services/dongaiCurator.js';

router.post(
  '/curate/dongai',
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await runDongaiCurate({ limit: req.body?.limit }));
  })
);

router.get(
  '/curate/dongai/jobs',
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await recentCurateJobs({ limit: req.query.limit }));
  })
);

// ── M3 角色社会（2026-09-20）运营口：冷启动任命 / 撤职 ──
// 冷启动剧本（§2.4）：第 1-4 周四职务由内部人设扮演 → 运营在这里 appoint。
import { appoint as appointRole, revokeTerm, listRoles } from '../services/roleService.js';

router.post(
  '/roles/appoint',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    res.json(await appointRole(String(b.roleId || ''), Number(b.agentId), { by: 'admin' }));
  })
);

router.post(
  '/roles/:termId/revoke',
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json(await revokeTerm(Number(req.params.termId)));
  })
);

router.get(
  '/roles',
  requireAdmin,
  asyncHandler(async (req, res) => {
    res.json({ roles: await listRoles() });
  })
);

// ── wiki 化目录树管理（2026-09-23）：站点主导的组织骨架，admin 维护。──
// GET 全部目录（含直接挂载条目数）→ 支持前端目录管理面板预览。
router.get(
  '/entry-categories',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const [cats, counts] = await Promise.all([
      db.all(`SELECT c.* FROM entry_categories c ORDER BY c.domain ASC, c.ord ASC, c.id ASC`),
      db.all(`SELECT category_id AS c, COUNT(*) AS n FROM entries WHERE status = 1 AND category_id IS NOT NULL GROUP BY category_id`),
    ]);
    const countMap = new Map(counts.map((r) => [Number(r.c), Number(r.n)]));
    res.json({ categories: cats.map((r) => ({ ...r, count: countMap.get(Number(r.id)) || 0 })) });
  })
);

// 创建目录节点。校验：domain 白名单、name 必填、parent 必须同域存在、slug 同域同级唯一。
router.post(
  '/entry-categories',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const domain = String(b.domain || '').trim();
    const name = String(b.name || '').trim();
    const slug = String(b.slug || '').trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 120);
    const parentId = b.parentId ? Number(b.parentId) : null;
    const ord = Number(b.ord) || 0;
    if (ENTRY_DOMAINS && !ENTRY_DOMAINS.has(domain)) {
      return res.status(400).json({ error: 'bad_domain' });
    }
    if (!name) return res.status(400).json({ error: 'name_required' });
    if (!slug) return res.status(400).json({ error: 'slug_required' });
    if (parentId) {
      const p = await db.get(`SELECT 1 FROM entry_categories WHERE id = ? AND domain = ? AND status = 1`, [parentId, domain]);
      if (!p) return res.status(400).json({ error: 'bad_parent' });
    }
    const dup = await db.get(`SELECT 1 FROM entry_categories WHERE domain = ? AND parent_id ${parentId ? '= ?' : 'IS NULL'} AND slug = ?`, parentId ? [domain, parentId, slug] : [domain, slug]);
    if (dup) return res.status(409).json({ error: 'duplicate_slug' });
    const r = await db.run(
      `INSERT INTO entry_categories (domain, parent_id, name, slug, ord, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ${fn.now()}, ${fn.now()})`,
      [domain, parentId, name, slug, ord],
    );
    res.status(201).json({ ok: true, id: r.lastInsertRowid });
  })
);

// 更新目录：重命名 / 改排序 / 挂新父 / 上下架。status=0 下架后 GET tree 不再返回该节点。
router.patch(
  '/entry-categories/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    const sets = [];
    const params = [];
    if (b.name !== undefined) { sets.push('name = ?'); params.push(String(b.name).slice(0, 100)); }
    if (b.ord !== undefined) { sets.push('ord = ?'); params.push(Number(b.ord) || 0); }
    if (b.status !== undefined) { sets.push('status = ?'); params.push(b.status === 0 || b.status === '0' ? 0 : 1); }
    if (b.parentId !== undefined) {
      const pid = b.parentId ? Number(b.parentId) : null;
      sets.push('parent_id = ?'); params.push(pid);
    }
    if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
    params.push(id);
    await db.run(`UPDATE entry_categories SET ${sets.join(', ')}, updated_at = ${fn.now()} WHERE id = ?`, params);
    res.json({ ok: true });
  })
);

// 删除目录：仅当无条目挂载且无子节点时可物理删除；否则报 409（避免产生孤儿条目）。
router.delete(
  '/entry-categories/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const kids = await db.get(`SELECT COUNT(*) AS n FROM entry_categories WHERE parent_id = ?`, [id]);
    const entries = await db.get(`SELECT COUNT(*) AS n FROM entries WHERE category_id = ?`, [id]);
    if (Number(kids?.n) > 0) return res.status(409).json({ error: 'has_children' });
    if (Number(entries?.n) > 0) return res.status(409).json({ error: 'has_entries' });
    await db.run(`DELETE FROM entry_categories WHERE id = ?`, [id]);
    res.json({ ok: true });
  })
);

export default router;
