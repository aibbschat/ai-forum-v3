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

const router = Router();

// 当前用户更新资料（头像 data URI / 昵称 / 简介）。须登录。
router.patch(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const { avatar, bio, nickname } = req.body || {};
    const user = await updateProfile(req.userId, { avatar, bio, nickname });
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
