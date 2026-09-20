import { Router } from 'express';
import { authenticate } from '../middleware/userAuth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import {
  getUserProfile,
  getUserPosts,
  getUserFollows,
  updateProfile,
} from '../services/userService.js';
import {
  followUser,
  unfollowUser,
  userFollowState,
  getUserFollowers,
} from '../services/followService.js';
import { saveDataUrlImage } from '../lib/dataUrlImage.js';

const router = Router();

// @用户搜索（必须在 /:id 之前，否则 'search' 会被当作 :id）
router.get(
  '/search',
  authenticate,
  asyncHandler(async (req, res) => {
    const { db } = await import('../database/db.js');
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ users: [] });
    const like = `%${q.slice(0, 30)}%`;
    const rows = await db.all(
      `SELECT id, username, nickname, avatar, user_type AS userType, is_verified AS isVerified
       FROM users
       WHERE (nickname LIKE ? OR username LIKE ?) AND status = 1
       ORDER BY user_type = 'ai' DESC, is_verified DESC, nickname ASC
       LIMIT 10`,
      [like, like]
    );
    res.json({ users: rows });
  })
);

// 当前用户更新资料（头像 / 昵称 / 简介）。须登录。
// 头像：前端传 data URI（已 canvas 缩到 256²）。这里解码落盘到 /covers/ 后只把短 URL 入库，
// 与 Agent 头像同一机制——绝不再把整条 data URI 塞进 users.avatar（历史上超长被截 → 显示不出来）。
// 若 avatar 已是 URL 字符串（非 data:image/）则原样透传。
router.patch(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const { avatar, bio, nickname } = req.body || {};
    let avatarVal = avatar;
    if (typeof avatar === 'string' && avatar.startsWith('data:image/')) {
      try {
        avatarVal = await saveDataUrlImage(avatar, {
          prefix: `avatar-me-${req.userId}`,
          maxChars: 2_000_000,
        });
      } catch (e) {
        const status = e.status || 400;
        return res.status(status).json({
          error: e.code || 'invalid_image',
          message: status === 413 ? '头像过大，请先压缩到 512×512 以内' : '头像格式不支持',
        });
      }
    }
    const user = await updateProfile(req.userId, { avatar: avatarVal, bio, nickname });
    res.json({ user });
  })
);

// 真人↔真人：关注 / 取关 / 关注状态
router.post(
  '/:id/follow',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json(await followUser(req.userId, Number(req.params.id)));
  })
);
router.delete(
  '/:id/follow',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json(await unfollowUser(req.userId, Number(req.params.id)));
  })
);
router.get(
  '/:id/follow',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json(await userFollowState(req.userId, Number(req.params.id)));
  })
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const profile = await getUserProfile(Number(req.params.id));
    if (!profile) return res.status(404).json({ error: 'user_not_found' });
    res.json({ user: profile });
  })
);

router.get(
  '/:id/posts',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const offset = Number(req.query.offset) || 0;
    res.json({ posts: await getUserPosts(Number(req.params.id), { limit, offset }) });
  })
);

router.get(
  '/:id/follows',
  asyncHandler(async (req, res) => {
    res.json({ agents: await getUserFollows(Number(req.params.id)) });
  })
);

router.get(
  '/:id/followers',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    res.json({ users: await getUserFollowers(Number(req.params.id), { limit }) });
  })
);

export default router;
