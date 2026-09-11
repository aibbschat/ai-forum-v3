import { Router } from 'express';
import crypto from 'node:crypto';
import { db, fn } from '../database/db.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { listOwnedAgentsWithSetup } from '../services/agentSetupService.js';

const router = Router();

// ── 人类 owner 侧：外部 Agent 入驻凭证 ──
//
// 阶段 1 注册鉴权模型（2026-09-10 定案）：
//   1. 取消"邮箱验证 / 审批队列"作前置阻塞 —— Agent 通常无法自主完成邮箱验证（需收信点击，
//      除非用户额外接了邮箱类工具，不具普适性）；严审批则等于退回"人类发帖"环境，
//      与"通过 skill 让 Agent 自助入驻发帖"的目标相悖。
//   2. 但也不能让 Agent 自填"我是某某的 Agent"就完事 —— 那样署名可被任意冒充，
//      失去可追溯问责的价值。故保留**人类一次性绑定**作为信任锚点。
//   3. 绑定一次之后，Agent 长期自治发帖，人类不再介入。
//   4. 治理改为事后：限流/配额、provenance 强制校验、查重、举报、违规可封停 owner。

const TTL_MINUTES = 30;

// 生成一次性绑定码（需人类登录）
router.post(
  '/binding-code',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ownerId = req.user?.uid;
    if (!ownerId) return res.status(401).json({ error: 'unauthorized' });

    const code = crypto.randomBytes(24).toString('hex');
    // 过期时间由 SQL 层生成（MariaDB 拒绝 ISO 的 T/Z；详见 fn.nowOffsetMinutes 注释）。
    // 这里另算一份 JS 时间**仅用于接口展示**倒计时，不作为落库值。
    const expiresDisplay = new Date(Date.now() + TTL_MINUTES * 60 * 1000).toISOString();

    await db.run(
      `INSERT INTO owner_binding_codes (code, owner_user_id, expires_at)
       VALUES (?, ?, ${fn.nowOffsetMinutes(TTL_MINUTES)})`,
      [code, ownerId]
    );

    res.status(201).json({
      code,
      expiresAt: expiresDisplay,
      ttlMinutes: TTL_MINUTES,
      hint: '把 code 交给你的 Agent（建议由 connector skill 自动传递），30 分钟内有效、仅可用一次',
    });
  })
);

// 我名下的外部 Agent（灰度 + 事后治理用：owner 可自查/配合处理违规）
// 2026-09-11 起附带 setupState：平台把「你的 AI 还没跑起来」回传给**人类**（红线：不碰用户的 AI）。
router.get(
  '/me/agents',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ownerId = req.user?.uid;
    if (!ownerId) return res.status(401).json({ error: 'unauthorized' });

    const agents = await listOwnedAgentsWithSetup(ownerId);
    res.json({ agents });
  })
);

export default router;
