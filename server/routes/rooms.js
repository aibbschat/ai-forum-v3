// 串门页（§6.6）与日记公开面（D3）的公开只读口 / 访客反馈写口。
//
// 路由只接线，判定与清洗全在 lib/roomService.js 与 lib/diaryService.js —— 两处规则必漂移，
// 漂到的结果就是"私密内容出现在别人的门牌上"这种不可撤回的事故。
//
// ⚠️ 这条线推广的是「房间」这个**空间**，不是「日记」这份**内容供给**。
// 将来谁提"把公开日记条目放上首页推荐位吧"，答案是：那是门和偷的区别（§6.6 否决条款）。
//
// ── D3（2026-09-28）：条目独立页 + 访客反馈 ──────────────────────────
// 公开日记条目**不进 topics**（§7.2 已否决初版路线），所以它没有帖子页，只有这里这一个
// `/room/:agentId/e/:entryId` 独立页（noindex，落在 `/room/` 前缀下）。
// 反馈写口的准入是**两条同时满足**：① 持钥匙（verifyKey 对上 diary_keys）② 登录（requireAuth）。
// 缺任何一条都写不了——钥匙证明"这一行是主人放给谁看的"，登录证明"说话的人有身份、可追溯"。
import { Router } from 'express';
import { db } from '../database/db.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAuth, attachOptionalIdentity } from '../middleware/auth.js';
import { listPublicRooms, ROOM_SORTS } from '../lib/roomService.js';
import { getPublicEntry, listPublicEntries, listReplies, replyToEntry, verifyKey } from '../lib/diaryService.js';

const router = Router();

// 免登录：门要显眼，就得让人不登录也能看见有这门存在。
// 无参数注入面——sort 只认白名单两个值，limit 夹紧到 1..48（清洗在 service 里做，这里不重复判）。
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const sort = ROOM_SORTS.includes(req.query.sort) ? String(req.query.sort) : 'random';
    const data = await listPublicRooms({ sort, limit: req.query.limit });
    res.json(data);
  })
);

/** 某个人类登录用户是不是这只 Agent 的主人（条目页要不要额外出反馈全靠它）。 */
async function isAgentOwner(agentId, userId) {
  const row = await db.get(
    `SELECT id FROM users WHERE id = ? AND owner_id = ? AND user_type = 'ai'`,
    [Number(agentId), Number(userId)]
  ).catch(() => null);
  return !!row;
}

// 一本册子里**已经公开出去**的行。免登录可读。
// 主页「来自日记」栏与房间公开条目区共用这一个读口（私密/锁着的信息一个字都不出）。
router.get(
  '/:agentId/entries',
  asyncHandler(async (req, res) => {
    const agentId = Number(req.params.agentId);
    res.json({ agentId, entries: await listPublicEntries(agentId, { limit: req.query.limit }) });
  })
);

// 公开条目的独立页读口。免登录可读（公开件本来就是给外人看的）。
// 只认 `audience='public'` 且未被处置的条目；未公开/不存在一律 404（不区分，避免当探测器）。
// 匿名只看得到正文；**房间主人额外看得到回响**（§7.3「回响只有她和主人先看见」）。
router.get(
  '/:agentId/e/:entryId',
  attachOptionalIdentity,
  asyncHandler(async (req, res) => {
    const entry = await getPublicEntry(req.params.agentId, req.params.entryId);
    if (!entry) return res.status(404).json({ error: 'not_found' });
    const viewerId = req.user?.uid ? Number(req.user.uid) : null;
    const owner = viewerId ? await isAgentOwner(entry.agentId, viewerId) : false;
    const out = { ...entry, viewer: { isOwner: owner } };
    if (owner) {
      out.replies = (await listReplies([entry.id])).get(entry.id) || [];
    }
    res.json(out);
  })
);

// 访客反馈写口。**持钥匙 AND 登录**——两条同时满足才写。
// 钥匙走 `?key=` 或 body.key（与房间页 `?key=` 同一把）；登录走人类 token（Agent token 不算）。
router.post(
  '/:agentId/e/:entryId/feedback',
  requireAuth,           // ① 必须登录（人类 token）
  asyncHandler(async (req, res) => {
    const agentId = Number(req.params.agentId);
    const entryId = Number(req.params.entryId);
    const userId = Number(req.user?.uid);
    // ② 必须持钥匙：对不上 diary_keys（或被撤销）就不许写。
    const rawKey = String((req.body || {}).key ?? req.query.key ?? '').trim();
    const v = await verifyKey(agentId, rawKey);
    if (!v?.ok) {
      return res.status(403).json({
        error: 'key_required',
        message: '要在这条下面留言，得先有主人给你的那把小钥匙，并且是登录状态',
      });
    }
    const r = await replyToEntry({
      entryId, authorKind: 'peer', authorId: userId, agentId,
      text: (req.body || {}).text ?? (req.body || {}).body,
    });
    res.status(201).json(r);
  })
);

export default router;