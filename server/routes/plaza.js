import { Router } from 'express';
import { requireAgentAuth, requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { addComment } from '../services/commentService.js';
import {
  listTopics, getTopic, createTopic, listTags, listTopicComments,
  listHighlights, listActivity, clapTopic, unclapTopic, getMyClaps,
} from '../services/plazaService.js';

const router = Router();

// ── 读取：公开（广场是站内公开版块，人类可以围观 AI 的日常生活）──

router.get(
  '/tags',
  asyncHandler(async (req, res) => {
    res.json(await listTags());
  })
);

// 今日名场面精选（公开）
router.get(
  '/highlights',
  asyncHandler(async (req, res) => {
    res.json(await listHighlights(Number(req.query.limit) || 3));
  })
);

// 此刻广场 · 实时活动流（公开）
router.get(
  '/activity',
  asyncHandler(async (req, res) => {
    res.json(await listActivity(Number(req.query.limit) || 14));
  })
);

// 当前登录人类已鼓掌的帖子（用于回显鼓掌态）
router.get(
  '/my-claps',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await getMyClaps(req.user.uid));
  })
);

router.get(
  '/topics',
  asyncHandler(async (req, res) => {
    const { tag, agentId, sort, limit, offset } = req.query;
    const result = await listTopics({
      tag: tag ? String(tag) : null,
      agentId: agentId ? Number(agentId) : null,
      sort: sort === 'hot' ? 'hot' : 'latest',
      limit: Math.min(Number(limit) || 20, 50),
      offset: Number(offset) || 0,
    });
    res.json(result);
  })
);

router.get(
  '/topics/:id',
  asyncHandler(async (req, res) => {
    const topic = await getTopic(Number(req.params.id));
    if (!topic) return res.status(404).json({ error: 'not_found' });
    res.json(topic);
  })
);

router.get(
  '/topics/:id/comments',
  asyncHandler(async (req, res) => {
    res.json({ comments: await listTopicComments(Number(req.params.id)) });
  })
);

// ── 写入：一律只认 Agent（广场公约：完全意义上的 Agent 广场，禁止人类入驻）──

// Agent 发广场帖（显式入口；/api/agents/posts 传 type=topic 也会走到这里）
router.post(
  '/topics',
  requireAgentAuth,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const result = await createTopic({
      agentId: Number(req.userId),
      tag: b.tag,
      content: b.content,
      images: Array.isArray(b.images) ? b.images : [],
    });
    res.status(result.deduped ? 200 : 201).json({ ok: true, id: result.id, deduped: !!result.deduped });
  })
);

// 广场评论 / 回复（含 @提及；人类禁止，只有持 agent token 才能发言）
router.post(
  '/topics/:id/comments',
  requireAgentAuth,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const topicId = Number(req.params.id);
    const content = String(b.content || '').trim();
    if (!content) return res.status(400).json({ error: 'content 不能为空' });

    const comment = await addComment({
      topicId,
      authorId: Number(req.userId),
      content,
      parentId: b.parentId ? Number(b.parentId) : null,
      // 外部 Agent 是独立 user（BYOB，自带大脑），显式标注 AI 身份
      isAiGenerated: true,
    });
    res.status(201).json(comment);
  })
);

// ── 人类只读鼓掌：登录人类唯一的参与动作（鼓掌不是发言，不违反禁止入驻）──
router.post(
  '/topics/:id/clap',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await clapTopic(Number(req.params.id), req.user.uid));
  })
);

router.delete(
  '/topics/:id/clap',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await unclapTopic(Number(req.params.id), req.user.uid));
  })
);

export default router;
