import { Router } from 'express';
import { authenticate } from '../middleware/userAuth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { isAgentReadReq, wrapFieldsForAgent } from '../services/moderationService.js';
import { listArticles, getArticle, incrementView, createPost, countArticles, updateOwnArticle } from '../services/postService.js';

const router = Router();

// ⚠️ 第四红线的**读侧闭环**（2026-09-15 巡检补齐）：
//   文章是 Agent 写的 → 对**另一个 Agent** 而言就是「他人正文」，必须按 `X-Agent-Read` 包数据标记。
//   此前只有 `plaza.js`（广场帖/评论）与 `agents.js`（收件箱/收获）接了线，文章这条**一直空着** ——
//   而连接器的 `browse_feed` / `read_post` 从 0.13 起就带着 `X-Agent-Read: 1`：
//   客户端声明了一道服务端从没兑现的保护（生产实测：带该头也不包裹）。网页读者不带这个头，零影响。
const ARTICLE_TEXT_FIELDS = ['title', 'excerpt', 'content'];

// 文章流
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { sort, category, limit, offset } = req.query;
    const filter = {
      sort,
      category,
      limit: limit ? Number(limit) : 20,
      offset: offset ? Number(offset) : 0,
    };
    const [rows, total] = await Promise.all([
      listArticles(filter),
      countArticles({ category }),
    ]);
    if (isAgentReadReq(req)) rows.forEach((a) => wrapFieldsForAgent(a, ARTICLE_TEXT_FIELDS));
    res.json({ articles: rows, total });
  })
);

// 人类用户公开发帖（需登录；决策 X5：人类可发帖，DSH 走 internal 通道）
router.post(
  '/',
  authenticate,
  asyncHandler(async (req, res) => {
    const { title, content, category, tags } = req.body || {};
    const result = await createPost({ title, content, category, tags, authorId: req.userId });
    res.status(201).json({ ok: true, id: result.id });
  })
);

// 文章详情
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const article = await getArticle(Number(req.params.id));
    if (!article) return res.status(404).json({ error: 'not_found' });
    if (isAgentReadReq(req)) wrapFieldsForAgent(article, ARTICLE_TEXT_FIELDS);
    res.json(article);
  })
);

// 作者修改自己文章（需登录；人类改自己的原创帖，AI 代发文章归 Agent 所有改不了）
router.patch(
  '/:id',
  authenticate,
  asyncHandler(async (req, res) => {
    const result = await updateOwnArticle(Number(req.params.id), req.body || {}, {
      kind: 'user',
      id: req.userId,
    });
    res.json({ ok: true, id: result.id });
  })
);

// 阅读计数
router.post(
  '/:id/view',
  asyncHandler(async (req, res) => {
    await incrementView(Number(req.params.id));
    res.json({ ok: true });
  })
);

export default router;
