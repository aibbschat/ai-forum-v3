import { Router } from 'express';
import { verifyInternalToken } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { publishArticle } from '../services/postService.js';
import { listComments, addComment } from '../services/commentService.js';
import { db, isMaria } from '../database/db.js';
import { fillPool, sweepExpired, livingPoolEnabled, searchBudget } from '../lib/livingPool.js';

const router = Router();

// 健康检查（内部）
router.get('/health', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// DSH / 百家学院发布桥入口（仅内网 + X-Internal-Token 鉴权）
// 复用百家学院 share_to_aicircle 同一套 verifyInternalToken 方案。
router.post(
  '/publish',
  verifyInternalToken,
  asyncHandler(async (req, res) => {
    // 外部 Agent（知了/DeskMate 等，无 X-Internal-Channel: dsh header）是人工监督触发的正常发布，
    // 不受同 Agent 30 分钟 cron 防重复冷却限制；内部 DSH 通路（publish-article.js / MCP）带该 header，保留冷却。
    const isInternalDsh = req.headers['x-internal-channel'] === 'dsh';
    const result = await publishArticle({ ...(req.body || {}), skipCooldown: !isInternalDsh });
    res.status(result.deduped ? 200 : 201).json({ ok: true, id: result.id, deduped: !!result.deduped });
  })
);

// ── 评论互动桥（供 mcp-aiforum 的 list_comments / reply_comment 工具使用） ──

// 列出某 Agent 名下文章的近期评论（用于互动调度）。
// GET /api/internal/dsh/comments/pending?agentSlug=tech&since=ISO&limit=20
//   - agentSlug 必填，按 agent_profiles.preset_id 定位 Agent 账号
//   - since 可选，只返回该时间之后的评论（默认 24h 前）
//   - 只返回顶层评论（楼中楼在内容里以 parentId 标注，由 Agent 自行判断是否回复）
router.get(
  '/comments/pending',
  verifyInternalToken,
  asyncHandler(async (req, res) => {
    const agentSlug = String(req.query.agentSlug || '').trim();
    if (!agentSlug) return res.status(400).json({ error: 'agentSlug 必填' });

    const agent = await db.get(
      `SELECT u.id AS user_id, ap.preset_id
         FROM users u JOIN agent_profiles ap ON ap.user_id = u.id
        WHERE ap.preset_id = ? LIMIT 1`,
      [agentSlug]
    );
    if (!agent) return res.status(404).json({ error: `未知 Agent slug: ${agentSlug}` });

    const since = String(req.query.since || '').trim();
    const sinceExpr = since && !Number.isNaN(Date.parse(since))
      ? since
      : new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

    // 只取"该 Agent 名下文章下、最近 since 以来、由人类发表、顶层、尚未被该 Agent 回复过"的评论
    const rows = await db.all(
      `SELECT c.id, c.post_id, c.author_id, c.content, c.created_at, c.parent_id,
              p.title AS post_title,
              u.nickname AS author_name, u.user_type AS author_type
         FROM comments c
         JOIN posts p ON p.id = c.post_id
         JOIN users u ON u.id = c.author_id
        WHERE p.agent_id = ?
          AND c.created_at >= ?
          AND c.parent_id IS NULL
          AND c.author_id <> ?
          AND u.user_type = 'human'
          AND NOT EXISTS (
            SELECT 1 FROM replies r
             WHERE r.comment_id = c.id AND r.agent_id = ?
          )
        ORDER BY c.created_at DESC
        LIMIT ?`,
      [agent.user_id, sinceExpr, agent.user_id, agent.user_id, limit]
    );

    res.json({
      agent: { slug: agentSlug, userId: agent.user_id },
      since: sinceExpr,
      comments: rows.map((r) => ({
        id: r.id,
        postId: r.post_id,
        postTitle: r.post_title,
        authorId: r.author_id,
        authorName: r.author_name,
        authorType: r.author_type,
        content: r.content,
        createdAt: r.created_at,
      })),
    });
  })
);

// Agent 回复一条评论。
// POST /api/internal/dsh/comments/:id/reply
// body: { agentSlug, content }
// 行为：
//   - 以该 Agent 账号身份挂楼中楼回复（parent_id = 顶层评论 id）
//   - 在 replies 表登记 (comment_id, agent_id, reply_comment_id)，防止重复回复
//   - 复用 addComment（自动 @通知、comment_count 自增、读者反馈写记忆）
//   - Agent 只能回复自己名下文章的评论
router.post(
  '/comments/:id/reply',
  verifyInternalToken,
  asyncHandler(async (req, res) => {
    const commentId = Number(req.params.id);
    const agentSlug = String(req.body?.agentSlug || '').trim();
    const content = String(req.body?.content || '').trim();
    if (!commentId || !agentSlug || !content) {
      return res.status(400).json({ error: 'commentId / agentSlug / content 必填' });
    }
    if (content.length > 1000) {
      return res.status(400).json({ error: '回复过长（最多 1000 字）' });
    }

    const agent = await db.get(
      `SELECT u.id AS user_id, ap.preset_id
         FROM users u JOIN agent_profiles ap ON ap.user_id = u.id
        WHERE ap.preset_id = ? LIMIT 1`,
      [agentSlug]
    );
    if (!agent) return res.status(404).json({ error: `未知 Agent slug: ${agentSlug}` });

    const parent = await db.get(
      `SELECT c.id, c.post_id, c.author_id, p.agent_id
         FROM comments c JOIN posts p ON p.id = c.post_id
        WHERE c.id = ? AND c.parent_id IS NULL`,
      [commentId]
    );
    if (!parent) return res.status(404).json({ error: '顶层评论不存在或已被删除' });
    if (Number(parent.agent_id) !== Number(agent.user_id)) {
      return res.status(403).json({ error: 'Agent 只能回复自己名下文章的评论' });
    }
    if (Number(parent.author_id) === Number(agent.user_id)) {
      return res.status(400).json({ error: '不能回复自己的评论' });
    }

    const already = await db.get(
      `SELECT id FROM replies WHERE comment_id = ? AND agent_id = ? LIMIT 1`,
      [commentId, agent.user_id]
    );
    if (already) {
      return res.status(409).json({ error: '该 Agent 已回复过这条评论', existingReplyId: already.id });
    }

    const comment = await addComment({
      postId: parent.post_id,
      authorId: agent.user_id,
      content,
      parentId: parent.id,
      replyToId: parent.author_id,
    });

    // 登记去重（addComment 已插入评论，这里记录"哪个 Agent 回过哪条顶层评论"）
    await db.run(
      `INSERT INTO replies (comment_id, agent_id, reply_comment_id, created_at)
       VALUES (?, ?, ?, ${isMaria ? 'NOW()' : "datetime('now')"})`,
      [commentId, agent.user_id, comment.id]
    );

    res.status(201).json({ ok: true, comment });
  })
);

// ── 活源池（L1，2026-09-27）：灌池与看料，只走内网 + X-Internal-Token ──
// 为什么挂 internal 而不是 admin：cron 在服务器上跑，它手里的是内部 token，不是 ADMIN_TOKEN；
// 而这条路**绝不能公开**——它花的是平台每月 500 次的搜索配额。
// 开关在库里不在代码里：`LIVING_POOL_ON` 不置 1，fill 直接返回 kept=0 且一次搜索都不打。
router.post(
  '/living-pool/fill',
  verifyInternalToken,
  asyncHandler(async (req, res) => {
    const dryRun = !!(req.body || {}).dryRun;
    const stats = await fillPool({ dryRun });
    const swept = await sweepExpired();       // 顺手把七天前到期的清掉，省一个独立 cron 位
    res.json({ ok: true, swept, ...stats });
  })
);

router.get(
  '/living-pool/stats',
  verifyInternalToken,
  asyncHandler(async (req, res) => {
    const byDay = await db.all(
      `SELECT day, kind, tone, COUNT(*) c FROM living_material GROUP BY day, kind, tone ORDER BY day DESC LIMIT 40`
    ).catch(() => []);
    const ttl = await db.get(
      `SELECT COUNT(*) total, MIN(expires_at) oldest_expiry FROM living_material`
    ).catch(() => null);
    // 配额账放在同一屏：看池子的人必须同时看得见"这个月烧了多少、还剩多少"，
    // 否则又回到那个只 grep 日志数数、既不测也不拦的老状态。
    const budget = await searchBudget();
    res.json({ ok: true, enabled: livingPoolEnabled(), byDay, budget, ...(ttl || {}) });
  })
);

export default router;
