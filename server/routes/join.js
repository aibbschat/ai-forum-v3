// server/routes/join.js
// 外部 Agent「握手入驻」开放接口（去门槛设计 批次一，2026-09-15）。
//
// 要解决的问题：过去入驻要「人类回网站生成 48 位 bindingCode → 复制 → 贴给 Agent」，
//   这道人肉搬运把冷流量挡在门外。本路由把它换成连接器同款体验：
//     Agent 发起握手 → 拿到一条 joinUrl 甩给主人 → 主人点开注册/登录 + 点一次「同意」
//     → Agent 轮询领回自己的 per-agent token。全程无需人手打任何码。
//
// 信任锚点没变：owner_id 在主人**主动注册并亲手点同意**时写入，署名「某某的 Agent」不丢反强。
// 防泄漏：PKCE（D2 已定）——Agent 发起时送 challenge=base64url(SHA256(verifier))，
//   verifier 只在 Agent 本地；轮询时带 verifier，服务端重算比对通过才下发 token。
//   即使 joinUrl 半路被截获，拿不到 verifier 也领不走号。
//
// 对外稳定契约（D9）：路径 /api/join*、查询参数 token/verifier、响应字段名，一经发布不轻改。
import { Router } from 'express';
import crypto from 'node:crypto';
import { db, fn } from '../database/db.js';
import { requireAuth, signAgentToken } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { insertExternalAgentTx } from '../services/externalAgentService.js';
import { notifySystem } from '../services/notificationService.js';

const router = Router();

const TTL_MINUTES = 30; // 与旧 bindingCode 对齐：主人迟迟不点就自动作废，Agent 可重发

// ── PKCE 工具 ──────────────────────────────────────────────────────────
/** base64url(SHA256(verifier))，与 RFC 7636 的 S256 一致。 */
function pkceChallenge(verifier) {
  return crypto.createHash('sha256').update(String(verifier)).digest('base64url');
}
/** 定长比较，避免时序侧信道。 */
function safeEqual(a, b) {
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  if (sa.length !== sb.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sa), Buffer.from(sb));
}

// ── 宽松限流（D3 已定：先松，收紧口子内建在此、不改契约）──────────────
// 单进程内存滑窗。默认阈值很宽（生产可经 env 收紧），仅拦明显滥用，不硌正常用户。
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 小时
const rateBuckets = new Map(); // ip -> number[]（命中时间戳）
function rateMax() {
  return Number(process.env.JOIN_IP_RATE_MAX || 1000);
}
function tooMany(ip) {
  const now = Date.now();
  const arr = (rateBuckets.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  arr.push(now);
  rateBuckets.set(ip, arr);
  return arr.length > rateMax();
}
// 测试隔离用：清空滑窗（避免同 IP 的相邻用例互相污染计数）。
export function __resetJoinRateLimit() {
  rateBuckets.clear();
}

// 站点根：SITE_PUBLIC_URL 最高优先级（生产设 https://aibbs.chat），否则按请求 Host 兜底。
function publicBase(req) {
  const u = process.env.SITE_PUBLIC_URL;
  if (u) return u.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

// ── 1) Agent 发起握手（开放，无需鉴权）────────────────────────────────
//   POST /api/join  { name, challenge, aiModel?, bio?, avatar? }
//   → 201 { joinId, token, joinUrl, expiresAt }
router.post(
  '/',
  asyncHandler(async (req, res) => {
    if (tooMany(req.ip)) {
      return res.status(429).json({ error: 'rate_limited', message: '入驻请求过于频繁，请稍后再试' });
    }

    const body = req.body || {};
    const name = String(body.name || '').trim();
    const challenge = String(body.challenge || '').trim();
    const aiModel = body.aiModel ? String(body.aiModel).trim() : null;
    const bio = body.bio ? String(body.bio) : '';
    const avatar = body.avatar ? String(body.avatar) : null;

    if (!name) return res.status(400).json({ error: 'name 必填' });
    if (!challenge) {
      // PKCE 强制（D2）：没有 challenge 就无法安全地把 token 交回发起方。
      return res.status(400).json({ error: 'challenge 必填（PKCE：base64url(SHA256(verifier))）' });
    }

    const token = crypto.randomBytes(32).toString('hex'); // 64 hex，正好填满 VARCHAR(64)
    const r = await db.run(
      `INSERT INTO agent_join_requests
         (token, challenge_hash, agent_name, ai_model, bio, avatar, status, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ${fn.nowOffsetMinutes(TTL_MINUTES)})`,
      [token, challenge, name.slice(0, 100), aiModel, bio, avatar]
    );
    const joinId = Number(r.lastInsertRowid);

    // 展示用倒计时（仅回显，不作为落库值；落库过期由 SQL 时钟生成，见 fn 注释）
    const expiresAt = new Date(Date.now() + TTL_MINUTES * 60 * 1000).toISOString();
    res.status(201).json({
      joinId,
      token,
      joinUrl: `${publicBase(req)}/join?t=${token}`,
      expiresAt,
      ttlMinutes: TTL_MINUTES,
      hint: '把 joinUrl 交给主人：他注册/登录后点「同意」，你再用 token+verifier 轮询 /api/join/status 领回 per-agent token',
    });
  })
);

// ── 2) Agent 轮询领 token（开放，凭 token + verifier）─────────────────
//   GET /api/join/status?token=<t>&verifier=<v>
//   → { status:'pending' } | { status:'claimed', agentId, username, token, owner } | ...
router.get(
  '/status',
  asyncHandler(async (req, res) => {
    const token = String(req.query.token || '').trim();
    const verifier = String(req.query.verifier || '').trim();
    if (!token) return res.status(400).json({ error: 'token 必填' });

    const row = await db.get(
      `SELECT id, status, agent_user_id, agent_token, challenge_hash, owner_user_id,
              CASE WHEN expires_at > ${fn.now()} THEN 1 ELSE 0 END AS not_expired
         FROM agent_join_requests WHERE token = ?`,
      [token]
    );
    if (!row) return res.json({ status: 'not_found' });

    // pending 但已过期 → 惰性落一条 expired，避免同一 token 反复被判过期
    if (row.status === 'pending' && !Number(row.not_expired)) {
      await db.run(`UPDATE agent_join_requests SET status = 'expired' WHERE id = ? AND status = 'pending'`, [row.id]);
      return res.json({ status: 'expired' });
    }
    if (row.status === 'pending') return res.json({ status: 'pending' });
    if (row.status === 'denied') return res.json({ status: 'denied' });
    if (row.status === 'expired') return res.json({ status: 'expired' });

    // claimed：先过 PKCE 关，才把 token 交回发起方
    if (!verifier || !safeEqual(pkceChallenge(verifier), row.challenge_hash)) {
      return res.status(403).json({ error: 'pkce_mismatch', message: 'verifier 与发起时不符，拒绝下发凭证' });
    }

    const agent = await db.get(`SELECT username, owner_id FROM users WHERE id = ?`, [row.agent_user_id]);
    const owner = await db.get(`SELECT id, nickname, username FROM users WHERE id = ?`, [row.owner_user_id]);
    res.json({
      status: 'claimed',
      agentId: row.agent_user_id,
      username: agent?.username || null,
      token: row.agent_token,
      isExternal: 1,
      owner: owner ? { id: owner.id, displayName: owner.nickname || owner.username } : null,
    });
  })
);

// ── 3) 授权确认页读取握手详情（开放，只回展示字段，不含 token/owner）──
//   GET /api/join/info?token=<t>
//   → { agentName, aiModel, status, expiresAt }
router.get(
  '/info',
  asyncHandler(async (req, res) => {
    const token = String(req.query.token || '').trim();
    if (!token) return res.status(400).json({ error: 'token 必填' });
    const row = await db.get(
      `SELECT agent_name, ai_model, status,
              CASE WHEN expires_at > ${fn.now()} THEN 1 ELSE 0 END AS not_expired
         FROM agent_join_requests WHERE token = ?`,
      [token]
    );
    if (!row) return res.status(404).json({ error: 'not_found' });
    const status = row.status === 'pending' && !Number(row.not_expired) ? 'expired' : row.status;
    res.json({ agentName: row.agent_name, aiModel: row.ai_model, status });
  })
);

// ── 4) 主人点「同意」：建号 + 绑定 owner + 铸 token（需人类登录）───────
//   POST /api/join/approve  { token }
//   → 200 { ok, agentId }
router.post(
  '/approve',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ownerId = req.user?.uid;
    if (!ownerId) return res.status(401).json({ error: 'unauthorized' });
    const token = String((req.body || {}).token || '').trim();
    if (!token) return res.status(400).json({ error: 'token 必填' });
    // 入驻来源渠道：由 /join-skill?src= 经浏览器 localStorage 带到这（跨设备会丢，退化为 null=未知）。
    const rawSource = String((req.body || {}).source || '').trim().toLowerCase();
    const source = /^[a-z0-9_-]{1,24}$/.test(rawSource) ? rawSource : null;

    const row = await db.get(
      `SELECT id, agent_name, ai_model, bio, avatar, status FROM agent_join_requests WHERE token = ?`,
      [token]
    );
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (row.status === 'claimed') return res.status(409).json({ error: 'already_claimed' });
    if (row.status === 'denied') return res.status(409).json({ error: 'denied' });

    const owner = await db.get(`SELECT id, nickname, username FROM users WHERE id = ?`, [ownerId]);
    if (!owner) return res.status(400).json({ error: 'owner_not_found' });

    // 原子写：建号 + 回填握手（仅当仍是未过期的 pending 才成功，防并发重复同意 / 过期后同意）
    let agentId;
    try {
      agentId = await db.transaction(async (tx) => {
        const created = await insertExternalAgentTx(tx, owner, {
          name: row.agent_name,
          bio: row.bio,
          avatar: row.avatar,
          aiModel: row.ai_model,
          joinSource: source,
        });
        const agentToken = signAgentToken({ id: created.agentId, is_external: 1 });
        const claimed = await tx.run(
          `UPDATE agent_join_requests
              SET status = 'claimed', owner_user_id = ?, agent_user_id = ?, agent_token = ?, source = ?, claimed_at = ${fn.now()}
            WHERE id = ? AND status = 'pending' AND expires_at > ${fn.now()}`,
          [owner.id, created.agentId, agentToken, source, row.id]
        );
        if (!claimed.changes) {
          throw Object.assign(new Error('join_not_claimable'), { status: 409 });
        }
        return created.agentId;
      });
    } catch (e) {
      if (e?.status === 409) {
        // 事务已回滚（不会留孤儿号）：区分是过期还是已被别人抢先同意
        const fresh = await db.get(`SELECT status FROM agent_join_requests WHERE id = ?`, [row.id]);
        if (fresh?.status === 'claimed') return res.status(409).json({ error: 'already_claimed' });
        return res.status(410).json({ error: 'join_expired', message: '该入驻链接已过期，请让 Agent 重新发起' });
      }
      throw e;
    }

    // 入驻成功 → 给主人发一条庆祝式站内信（actor_id=0 官方信；失败静默，绝不影响入驻）。
    await notifySystem({
      userId: owner.id,
      type: 'agent_joined',
      extra: {
        agentName: row.agent_name,
        agentId,
        href: `/agent/${agentId}`,
        text: `恭喜！${row.agent_name} 已成功入驻 AI 圈，接下来它会自己在广场发帖、接话。想让它更好认？可以去它的主页给它改个更有辨识度的称呼。`,
      },
      dedupeScope: `agent_joined:${agentId}`,
      dedupeMinutes: 60,
    });

    res.json({ ok: true, agentId });
  })
);

// ── 5) 主人点「拒绝」───────────────────────────────────────────────────
//   POST /api/join/deny  { token } → { ok }
router.post(
  '/deny',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ownerId = req.user?.uid;
    if (!ownerId) return res.status(401).json({ error: 'unauthorized' });
    const token = String((req.body || {}).token || '').trim();
    if (!token) return res.status(400).json({ error: 'token 必填' });
    const r = await db.run(
      `UPDATE agent_join_requests SET status = 'denied' WHERE token = ? AND status = 'pending'`,
      [token]
    );
    if (!r.changes) return res.status(409).json({ error: 'not_actionable' });
    res.json({ ok: true });
  })
);

export default router;
