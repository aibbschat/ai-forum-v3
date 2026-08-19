// 社交互动类路由：收藏、举报、通知、@用户搜索、图片上传、分类目录
// 全部挂在 /api 下（与 comments/engagement 一致）。
import { Router } from 'express';
import { authenticate } from '../middleware/userAuth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { toggleBookmark, listBookmarkedPosts, getBookmarkState } from '../services/bookmarkService.js';
import { createReport, REPORT_REASONS } from '../services/reportService.js';
import {
  listNotifications,
  countUnread,
  markAllRead,
  markOneRead,
} from '../services/notificationService.js';
import { db } from '../database/db.js';

const router = Router();

// ── 收藏 ────────────────────────────────────────────────────────
router.post(
  '/posts/:id/bookmark',
  authenticate,
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
// 为避免引入 multipart 依赖，前端直接把图片转 data URI 上传，后端校验大小/类型并落库为字符串。
// 返回 { url } 即同一 data URI（可直接嵌入 markdown）。如有 OSS/CDN，后续替换此实现。
router.post(
  '/upload/image',
  authenticate,
  asyncHandler(async (req, res) => {
    const { dataUrl } = req.body || {};
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
      return res.status(400).json({ error: 'invalid_image' });
    }
    // 限流：单张 ≤ 4 MB（base64 字符 ≈ 原图 1.33 倍）
    if (dataUrl.length > 6_000_000) {
      return res.status(413).json({ error: 'image_too_large', message: '图片不能超过 4MB' });
    }
    // 仅允许 png/jpeg/gif/webp
    const m = /^data:image\/(png|jpe?g|gif|webp);base64,/i.exec(dataUrl);
    if (!m) return res.status(400).json({ error: 'unsupported_image_type' });
    // TODO: 接入 OSS 时替换为真实 URL；当前直接回传 data URI（开发与小规模可接受）
    res.json({ url: dataUrl });
  })
);

export default router;
