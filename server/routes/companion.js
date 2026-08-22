// server/routes/companion.js
// AI 伴侣档案 CRUD 路由（owner 隔离）—— 见 docs/companion/AI_COMPANION_SPEC.md §4。
import { Router } from 'express';
import { authenticate } from '../middleware/userAuth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import {
  createCompanion,
  listCompanions,
  getOwnedCompanion,
  updateCompanion,
  deleteCompanion,
  getCompanionByUsername,
} from '../services/companionService.js';
import {
  listSessions,
  createSession,
  getMessages,
  deleteSession,
  sendMessage,
} from '../services/companionChatService.js';
import {
  listDrafts,
  createDraft,
  getDraft,
  updateDraft,
  deleteDraft,
  setDraftStatus,
  assistDraft,
} from '../services/companionWritingService.js';
import {
  listMemories,
  addSemanticMemory,
  deleteMemory,
  clearMemories,
  setEpisodicStatus,
  consolidate,
} from '../services/companionMemoryService.js';
import { commentAsCompanion } from '../services/companionPublicService.js';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

const router = Router();

// ── 公开接口（无需登录，M7 公开开关 C）────────────────────────
// 微主页取档：公开态任何人可看（含未登录）；私域仅主人。
// 手动做可选鉴权（有 token 就解析 uid，没有不拦），因为 router 级 authenticate 在后面。
router.get(
  '/u/:username',
  asyncHandler(async (req, res) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    let viewerId = null;
    if (token) {
      try {
        viewerId = jwt.verify(token, config.jwtSecret).uid;
      } catch { /* 无效 token 按未登录处理 */ }
    }
    const c = await getCompanionByUsername(req.params.username);
    const isOwner = c.owner_id === viewerId;
    if (!isOwner && !c.is_public) {
      return res.status(404).json({ error: 'companion_not_found' });
    }
    const out = { ...c };
    if (!isOwner) delete out.intro_prompt; // 仅主人可见系统前缀
    res.json({ companion: out });
  })
);

router.use(authenticate); // 以下全部接口须登录

// 创建搭档（一期每人 1 个，服务内校验）
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const c = await createCompanion(req.userId, req.body || {});
    res.status(201).json({ companion: c });
  })
);

// 我的搭档列表
router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ companions: await listCompanions(req.userId) });
  })
);

// 我的单个搭档（含 persona）
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json({ companion: await getOwnedCompanion(req.userId, Number(req.params.id)) });
  })
);

// 更新搭档（名称/头像/形像/人设/简介/公开开关）
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const c = await updateCompanion(req.userId, Number(req.params.id), req.body || {});
    res.json({ companion: c });
  })
);

// ── M3 伴侣聊天（§5）：会话 + 消息 ────────────────────────────
// 全部 owner 隔离（服务内校验 companion/session 归属）。

// 会话列表
router.get(
  '/:id/sessions',
  asyncHandler(async (req, res) => {
    res.json({ sessions: await listSessions(req.userId, Number(req.params.id)) });
  })
);

// 新建会话
router.post(
  '/:id/sessions',
  asyncHandler(async (req, res) => {
    res.status(201).json({
      session: await createSession(req.userId, Number(req.params.id), req.body?.title),
    });
  })
);

// 会话消息（拉全量，前端本地渲染）
router.get(
  '/sessions/:sessionId/messages',
  asyncHandler(async (req, res) => {
    res.json({ messages: await getMessages(req.userId, Number(req.params.sessionId)) });
  })
);

// 删除会话（连带消息）
router.delete(
  '/sessions/:sessionId',
  asyncHandler(async (req, res) => {
    res.json(await deleteSession(req.userId, Number(req.params.sessionId)));
  })
);

// 发消息 → 搭档回复（非流式；§5.3 无任何「发布到社区」入口）
router.post(
  '/:id/sessions/:sessionId/messages',
  asyncHandler(async (req, res) => {
    const r = await sendMessage(
      req.userId,
      Number(req.params.id),
      Number(req.params.sessionId),
      req.body?.content
    );
    res.json(r);
  })
);

// ── M4 辅助写作（§6）：草稿 + 搭档辅助 ────────────────────────
// 全部 owner 隔离；无任何发布接口（发布永远走现有 /api/posts 人类通道）。

// 草稿列表
router.get(
  '/:id/drafts',
  asyncHandler(async (req, res) => {
    res.json({ drafts: await listDrafts(req.userId, Number(req.params.id)) });
  })
);

// 新建草稿
router.post(
  '/:id/drafts',
  asyncHandler(async (req, res) => {
    res.status(201).json({
      draft: await createDraft(req.userId, Number(req.params.id), req.body || {}),
    });
  })
);

// 单个草稿
router.get(
  '/drafts/:draftId',
  asyncHandler(async (req, res) => {
    res.json({ draft: await getDraft(req.userId, Number(req.params.draftId)) });
  })
);

// 手动编辑草稿
router.put(
  '/drafts/:draftId',
  asyncHandler(async (req, res) => {
    res.json({ draft: await updateDraft(req.userId, Number(req.params.draftId), req.body || {}) });
  })
);

// 删除草稿
router.delete(
  '/drafts/:draftId',
  asyncHandler(async (req, res) => {
    res.json(await deleteDraft(req.userId, Number(req.params.draftId)));
  })
);

// 状态流转 draft ↔ polishing ↔ confirmed（主人确认/退回）
router.put(
  '/drafts/:draftId/status',
  asyncHandler(async (req, res) => {
    res.json({
      draft: await setDraftStatus(req.userId, Number(req.params.draftId), req.body?.status),
    });
  })
);

// 搭档辅助：润色/扩写/给角度/脑暴（只出稿子和建议，不代发）
router.post(
  '/:id/drafts/:draftId/assist',
  asyncHandler(async (req, res) => {
    res.json(
      await assistDraft(
        req.userId,
        Number(req.params.id),
        Number(req.params.draftId),
        req.body?.action,
        req.body?.instruction
      )
    );
  })
);

// ── M5 记忆面板（§7.4）：透明与控制权 ────────────────────────
// 只对主人可见（§7.3 隐私红线：owner 隔离硬校验）。

// 按层查看搭档记住了什么
router.get(
  '/:id/memories',
  asyncHandler(async (req, res) => {
    res.json(await listMemories(req.userId, Number(req.params.id)));
  })
);

// 显式添加语义记忆（人设卡/偏好，§7.2 路径 1）
router.post(
  '/:id/memories',
  asyncHandler(async (req, res) => {
    res.status(201).json({
      memory: await addSemanticMemory(req.userId, Number(req.params.id), req.body || {}),
    });
  })
);

// 删单条：/api/companions/:id/memories/:layer/:memId
router.delete(
  '/:id/memories/:layer/:memId',
  asyncHandler(async (req, res) => {
    res.json(await deleteMemory(req.userId, Number(req.params.id), req.params.layer, Number(req.params.memId)));
  })
);

// 清空：?layer=episodic|semantic|procedural（缺省全清）
router.delete(
  '/:id/memories',
  asyncHandler(async (req, res) => {
    res.json(await clearMemories(req.userId, Number(req.params.id), req.query.layer));
  })
);

// episodic 状态：pending → verified / rejected / expired
router.put(
  '/:id/memories/episodic/:memId/status',
  asyncHandler(async (req, res) => {
    res.json({
      memory: await setEpisodicStatus(req.userId, Number(req.params.id), Number(req.params.memId), req.body?.status),
    });
  })
);

// 巩固：episodic → semantic（§7.6）
router.post(
  '/:id/memories/consolidate',
  asyncHandler(async (req, res) => {
    res.json(await consolidate(req.userId, Number(req.params.id)));
  })
);

// ── M7 公开开关 C（§11）：搭档以自己身份在评论区互动 ──────────
// 仅评论（不可发文章）；主人触发、搭档身份落库；daily_used 限流；is_public=0 一键收回。
router.post(
  '/:id/comments',
  asyncHandler(async (req, res) => {
    const r = await commentAsCompanion(req.userId, Number(req.params.id), {
      postId: Number(req.body?.postId),
      content: req.body?.content,
      instruction: req.body?.instruction,
      parentId: req.body?.parentId ? Number(req.body.parentId) : null,
    });
    res.status(201).json(r);
  })
);

// 删除搭档
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await deleteCompanion(req.userId, Number(req.params.id)));
  })
);

export default router;
