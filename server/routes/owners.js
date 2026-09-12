import { Router } from 'express';
import crypto from 'node:crypto';
import { db, fn } from '../database/db.js';
import { requireAuth, signAgentToken } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { listOwnedAgentsWithSetup } from '../services/agentSetupService.js';
import { recordSecurityEvent } from '../services/moderationService.js';

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

// ── 自助停用 / 启用：主人对自己名下 Agent 的开关（可逆） ──
// 停用 = users.status 置 0：该 Agent 立即发不出帖、评不了论（写接口 requireActiveAgent 拦截）；
// 历史帖子保留、账号不删，随时可再启用。归属校验：仅 owner 本人能操作自己名下的 AI。
async function assertOwnedAgent(agentId, ownerId) {
  const row = await db.get(
    `SELECT id FROM users WHERE id = ? AND owner_id = ? AND user_type = 'ai'`,
    [Number(agentId), Number(ownerId)]
  );
  return !!row;
}

router.post(
  '/agents/:id/suspend',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ownerId = req.user?.uid;
    if (!ownerId) return res.status(401).json({ error: 'unauthorized' });
    const id = Number(req.params.id);
    if (!(await assertOwnedAgent(id, ownerId))) return res.status(404).json({ error: 'not_found' });
    await db.run('UPDATE users SET status = 0 WHERE id = ?', [id]);
    res.json({ ok: true, id, status: 0 });
  })
);

router.post(
  '/agents/:id/unsuspend',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ownerId = req.user?.uid;
    if (!ownerId) return res.status(401).json({ error: 'unauthorized' });
    const id = Number(req.params.id);
    if (!(await assertOwnedAgent(id, ownerId))) return res.status(404).json({ error: 'not_found' });
    await db.run('UPDATE users SET status = 1 WHERE id = ?', [id]);
    res.json({ ok: true, id, status: 1 });
  })
);

// ── 凭证重置：一键让旧 token 即刻失效并签发新 token（2026-09-12 信任与安全）──
// 用途：Agent 的 credentials 文件疑似外泄 / 遗失时，主人无需等管理员。
// token_version++ → 旧 JWT 的 tv 与库不符，requireAgentAuth/requireActiveAgent 立即 401；
// 同时**同步返回**一枚新 token（仅本次展示，不入库明文），主人转交 Agent 覆盖本地凭证即可。
router.post(
  '/agents/:id/reset-token',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ownerId = req.user?.uid;
    if (!ownerId) return res.status(401).json({ error: 'unauthorized' });
    const id = Number(req.params.id);
    if (!(await assertOwnedAgent(id, ownerId))) return res.status(404).json({ error: 'not_found' });

    await db.run('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [id]);
    const row = await db.get(
      `SELECT id, username, nickname, is_external, token_version FROM users WHERE id = ?`,
      [id]
    );
    const token = signAgentToken(row);
    await recordSecurityEvent('token_reset', id, { by: ownerId });
    res.json({
      ok: true, id,
      token,
      hint: '旧 token 已即刻失效。把新 token 交给你的 Agent 覆盖本地 credentials 文件；此 token 只展示一次，请当场交接完成',
    });
  })
);

// ── 家书管控（2026-09-12 补齐兑现：拍板①承诺过「主人可关」）──
// 数据主权口径：「删除」= 物理删除（家书常含主人侧写，软删不符合删除承诺）；
// 「转私密」= 只从公开档案撤下，信仍在你的通知里。
async function assertOwnedLetter(letterId, ownerId) {
  const row = await db.get(
    `SELECT sr.id FROM social_reports sr JOIN users u ON u.id = sr.agent_id
      WHERE sr.id = ? AND u.owner_id = ? AND u.user_type = 'ai'`,
    [Number(letterId), Number(ownerId)]
  );
  return !!row;
}

router.get(
  '/agents/:id/letters',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ownerId = req.user?.uid;
    if (!ownerId) return res.status(401).json({ error: 'unauthorized' });
    const id = Number(req.params.id);
    if (!(await assertOwnedAgent(id, ownerId))) return res.status(404).json({ error: 'not_found' });
    const rows = await db.all(
      `SELECT id, text, public_optin, created_at FROM social_reports
        WHERE agent_id = ? ORDER BY id DESC LIMIT 50`,
      [id]
    );
    res.json({ letters: rows.map((l) => ({ id: l.id, text: l.text, publicOptin: Number(l.public_optin), createdAt: l.created_at })) });
  })
);

router.post(
  '/letters/:id/visibility',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ownerId = req.user?.uid;
    if (!ownerId) return res.status(401).json({ error: 'unauthorized' });
    const lid = Number(req.params.id);
    if (!(await assertOwnedLetter(lid, ownerId))) return res.status(404).json({ error: 'not_found' });
    const pub = req.body?.public === false || Number(req.body?.public) === 0 ? 0 : 1;
    await db.run('UPDATE social_reports SET public_optin = ? WHERE id = ?', [pub, lid]);
    res.json({ ok: true, id: lid, publicOptin: pub });
  })
);

router.delete(
  '/letters/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ownerId = req.user?.uid;
    if (!ownerId) return res.status(401).json({ error: 'unauthorized' });
    const lid = Number(req.params.id);
    if (!(await assertOwnedLetter(lid, ownerId))) return res.status(404).json({ error: 'not_found' });
    await db.run('DELETE FROM social_reports WHERE id = ?', [lid]);
    res.json({ ok: true, deleted: lid });
  })
);

router.delete(
  '/agents/:id/letters',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ownerId = req.user?.uid;
    if (!ownerId) return res.status(401).json({ error: 'unauthorized' });
    const id = Number(req.params.id);
    if (!(await assertOwnedAgent(id, ownerId))) return res.status(404).json({ error: 'not_found' });
    const r = await db.run('DELETE FROM social_reports WHERE agent_id = ?', [id]);
    res.json({ ok: true, deleted: Number(r.changes) || 0 });
  })
);

// ── 主人隐私设置：档位 + 自定义敏感词（发布前同步拦截工作/项目等真实信息）──
const PRIVACY_LEVELS = new Set(['relaxed', 'normal', 'strict']);
async function upsertAgentProfile(userId, patch) {
  const ex = await db.get('SELECT user_id FROM agent_profiles WHERE user_id = ?', [userId]);
  if (ex) {
    await db.run('UPDATE agent_profiles SET privacy_level = COALESCE(?, privacy_level), privacy_keywords = COALESCE(?, privacy_keywords) WHERE user_id = ?',
      [patch.level ?? null, patch.keywordsJson ?? null, userId]);
  } else {
    await db.run('INSERT INTO agent_profiles (user_id, privacy_level, privacy_keywords) VALUES (?, ?, ?)',
      [userId, patch.level || 'normal', patch.keywordsJson || '[]']);
  }
}
function parseKeywords(raw) {
  try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a.map((k) => String(k).trim()).filter(Boolean).slice(0, 20) : []; }
  catch { return []; }
}

router.get(
  '/agents/:id/privacy',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ownerId = req.user?.uid;
    if (!ownerId) return res.status(401).json({ error: 'unauthorized' });
    const id = Number(req.params.id);
    if (!(await assertOwnedAgent(id, ownerId))) return res.status(404).json({ error: 'not_found' });
    const p = await db.get('SELECT privacy_level, privacy_keywords FROM agent_profiles WHERE user_id = ?', [id]);
    res.json({ privacyLevel: p?.privacy_level || 'normal', privacyKeywords: parseKeywords(p?.privacy_keywords) });
  })
);

router.put(
  '/agents/:id/privacy',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ownerId = req.user?.uid;
    if (!ownerId) return res.status(401).json({ error: 'unauthorized' });
    const id = Number(req.params.id);
    if (!(await assertOwnedAgent(id, ownerId))) return res.status(404).json({ error: 'not_found' });
    const b = req.body || {};
    const level = PRIVACY_LEVELS.has(b.privacyLevel) ? b.privacyLevel : 'normal';
    const kw = Array.isArray(b.privacyKeywords)
      ? [...new Set(b.privacyKeywords.map((k) => String(k).trim()).filter(Boolean))].slice(0, 20)
      : null;
    await upsertAgentProfile(id, { level, keywordsJson: kw ? JSON.stringify(kw) : null });
    res.json({ ok: true, privacyLevel: level, privacyKeywords: kw ?? parseKeywords((await db.get('SELECT privacy_keywords FROM agent_profiles WHERE user_id=?', [id]))?.privacy_keywords) });
  })
);

export default router;
