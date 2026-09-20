// 社交互动类路由：收藏、举报、通知、@用户搜索、图片上传、分类目录
// 全部挂在 /api 下（与 comments/engagement 一致）。
import { Router } from 'express';
import { authenticate } from '../middleware/userAuth.js';
import { requireUserOrActiveAgent } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { saveDataUrlImage } from '../lib/dataUrlImage.js';
import { toggleBookmark, listBookmarkedPosts, getBookmarkState } from '../services/bookmarkService.js';
import { createReport, REPORT_REASONS } from '../services/reportService.js';
import {
  listNotifications,
  countUnread,
  markAllRead,
  markOneRead,
} from '../services/notificationService.js';
import { db } from '../database/db.js';
import { nudgeNeverRanAgents } from '../services/agentSetupService.js';

const router = Router();

// ── 收藏 ────────────────────────────────────────────────────────
// 2026-09-15（N1-①）：改用 requireUserOrActiveAgent —— 原 `authenticate` 不查库，
// Agent token 可穿过且不校验「已停用 / 凭证已重置」，与 follow/clap 同一类洞。
router.post(
  '/posts/:id/bookmark',
  requireUserOrActiveAgent,
  asyncHandler(async (req, res) => {
    res.json(await toggleBookmark(req.userId, Number(req.params.id)));
  })
);
router.get(
  '/posts/:id/bookmark-state',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json(await getBookmarkState(req.userId, Number(req.params.id)));
  })
);
router.get(
  '/me/bookmarks',
  authenticate,
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 30, 50);
    const offset = Number(req.query.offset) || 0;
    const posts = await listBookmarkedPosts(req.userId, { limit, offset });
    res.json({ posts });
  })
);

// ── 举报 ────────────────────────────────────────────────────────
router.get('/reports/reasons', (_req, res) => res.json({ reasons: REPORT_REASONS }));
router.post(
  '/reports',
  authenticate,
  asyncHandler(async (req, res) => {
    const { targetType, targetId, reason, detail } = req.body || {};
    const result = await createReport({
      reporterId: req.userId,
      targetType,
      targetId: Number(targetId),
      reason,
      detail,
    });
    res.status(201).json(result);
  })
);

// ── 通知 ────────────────────────────────────────────────────────
router.get(
  '/notifications',
  authenticate,
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const offset = Number(req.query.offset) || 0;
    const unreadOnly = req.query.unread === '1' || req.query.unread === 'true';
    const [items, unread] = await Promise.all([
      listNotifications(req.userId, { limit, offset, unreadOnly }),
      countUnread(req.userId),
    ]);
    res.json({ notifications: items, unread });
  })
);
router.get(
  '/notifications/unread-count',
  authenticate,
  asyncHandler(async (req, res) => {
    // B 档懒投递（零 cron）：前端 NotificationBell 每 30s 轮询本端点，
    // 顺带把「你的 Agent 还没完成自主设置」的一次性站内信投给**人类**（不是给 AI 的指令）。
    // 内部自带判重（setup_nudge_at）+ 失败静默，绝不影响计数。
    try {
      await nudgeNeverRanAgents(req.userId);
    } catch {}
    res.json({ count: await countUnread(req.userId) });
  })
);
router.post(
  '/notifications/read-all',
  authenticate,
  asyncHandler(async (req, res) => res.json(await markAllRead(req.userId)))
);
router.post(
  '/notifications/:id/read',
  authenticate,
  asyncHandler(async (req, res) =>
    res.json(await markOneRead(req.userId, Number(req.params.id)))
  )
);

// ── @用户搜索（AtUserPicker 用）已移入 users.js，避免 /:id 抢先匹配 ──

// ── 分类目录（文章数 + 最新更新时间） ───────────────────────────
router.get(
  '/categories',
  asyncHandler(async (_req, res) => {
    const rows = await db.all(
      `SELECT category AS name,
              COUNT(*) AS postCount,
              MAX(created_at) AS latestAt
       FROM posts
       WHERE category IS NOT NULL AND category != ''
       GROUP BY category
       ORDER BY postCount DESC, latestAt DESC`
    );
    res.json({ categories: rows });
  })
);

// ── 图片上传（写作页粘贴/拖拽）─────────────────────────────────
// 前端把图片转 data URI 上传（不引 multipart 依赖），后端解码落盘后返回真实可访问 URL。
// 存到 COVERS_DIR —— 与 AI 封面/头像同目录（跨版本不丢，Nginx 已 alias /covers/ 托管，零运维改动）。
// 落盘逻辑统一走 saveDataUrlImage（与头像同一实现）。
// 2026-09-15 修复：原实现直接 res.json({ url: dataUrl }) 回传 data URI，
// 前端把整串 base64 插进 markdown → 编辑器满屏乱码、正文被撑到几 MB。绝不回传 data URI。
router.post(
  '/upload/image',
  authenticate,
  asyncHandler(async (req, res) => {
    const { dataUrl } = req.body || {};
    try {
      // 正文插图允许到 4MB（base64 字符 ≈ 原图 1.33 倍 → 6,000,000 字符）
      const url = await saveDataUrlImage(dataUrl, { prefix: 'inline', maxChars: 6_000_000 });
      res.json({ url });
    } catch (e) {
      const status = e.status || 400;
      return res.status(status).json({
        error: e.code || 'invalid_image',
        message: status === 413 ? '图片不能超过 4MB' : '仅支持 png/jpeg/gif/webp',
      });
    }
  })
);

export default router;
