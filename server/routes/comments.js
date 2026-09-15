import { Router } from 'express';
import { authenticate } from '../middleware/userAuth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { isAgentReadReq, wrapFieldsForAgent } from '../services/moderationService.js';
import { listComments, addComment, likeComment } from '../services/commentService.js';

const router = Router();

/**
 * 第四红线（读侧）：文章评论是**他人正文**，Agent 读取时包数据标记。
 *
 * ⚠️ 两个坑都在这里：
 *   ① `commentService.listComments` 返回的是**楼中楼**：回复挂在父评论的 `replies` 上
 *      （服务内部的 `_replies` 经 `shape()` 改名成 `replies` 才出库）。
 *      只包顶层会把整棵子树漏掉 —— 比完全不包更危险，因为看起来"已经做过了"。
 *      两个名字都认，是因为将来谁改了命名，这道守卫不该跟着失效（它守的是红线，不是字段名）。
 *   ② 连接器的 `list_comments` 从 0.13 起就带 `X-Agent-Read: 1`，此前服务端从没兑现。
 */
function wrapCommentTreeForAgent(c) {
  if (!c || typeof c !== 'object') return c;
  wrapFieldsForAgent(c, ['content']);
  for (const k of ['replies', '_replies']) {
    if (Array.isArray(c[k])) c[k].forEach(wrapCommentTreeForAgent);
  }
  return c;
}

// GET /api/posts/:id/comments
router.get(
  '/posts/:id/comments',
  asyncHandler(async (req, res) => {
    const comments = await listComments(Number(req.params.id), { userId: req.userId });
    if (isAgentReadReq(req)) comments.forEach(wrapCommentTreeForAgent);
    res.json({ comments });
  })
);

// POST /api/posts/:id/comments  （需 Bearer）
// body: { content, parentId?, replyToId? }
router.post(
  '/posts/:id/comments',
  authenticate,
  asyncHandler(async (req, res) => {
    const { content, parentId, replyToId } = req.body || {};
    const comment = await addComment({
      postId: Number(req.params.id),
      authorId: req.userId,
      content,
      parentId: parentId ? Number(parentId) : null,
      replyToId: replyToId ? Number(replyToId) : null,
    });
    res.status(201).json({ comment });
  })
);

// POST /api/comments/:id/like  （需 Bearer）
router.post(
  '/comments/:id/like',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json(await likeComment(Number(req.params.id), req.userId));
  })
);

export default router;
