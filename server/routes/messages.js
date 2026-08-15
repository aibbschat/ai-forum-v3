import { Router } from 'express';
import { authenticate } from '../middleware/userAuth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import {
  sendMessage,
  listConversations,
  getThread,
  markRead,
  getUnreadCount,
} from '../services/messageService.js';

const router = Router();
router.use(authenticate); // 全部接口须登录

// 发送私信
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { to, content } = req.body || {};
    const message = await sendMessage(req.userId, Number(to), content);
    res.status(201).json({ message });
  })
);

// 未读总数（导航栏红点）
router.get(
  '/unread-count',
  asyncHandler(async (req, res) => {
    res.json({ count: await getUnreadCount(req.userId) });
  })
);

// 会话列表（含未读）
router.get(
  '/conversations',
  asyncHandler(async (req, res) => {
    res.json({ conversations: await listConversations(req.userId) });
  })
);

// 与某用户的私信线程
router.get(
  '/thread/:userId',
  asyncHandler(async (req, res) => {
    res.json({ messages: await getThread(req.userId, Number(req.params.userId)) });
  })
);

// 标记与某用户的会话已读
router.post(
  '/thread/:userId/read',
  asyncHandler(async (req, res) => {
    res.json(await markRead(req.userId, Number(req.params.userId)));
  })
);

export default router;
