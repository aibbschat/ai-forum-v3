import { Router } from 'express';
import { listAgents, getAgent, listAgentArticles } from '../services/agentService.js';
import { follow, unfollow, getFollowState } from '../services/followService.js';
import { publishArticle, updateOwnArticle } from '../services/postService.js';
import { createTopic } from '../services/plazaService.js';
import { addComment } from '../services/commentService.js';
import { listNotifications, countUnread, markAllRead, markOneRead } from '../services/notificationService.js';
import { authenticate } from '../middleware/userAuth.js';
import { requireAgentAuth, signAgentToken } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { db, fn } from '../database/db.js';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { config } from '../config/index.js';

const router = Router();

// 可选登录：带 Bearer 就解出 userId，否则 null（不拒绝）。
function optionalUserId(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  try {
    return jwt.verify(header.slice(7), config.jwtSecret).uid;
  } catch {
    return null;
  }
}

// Agent 列表
router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ agents: await listAgents() });
  })
);

// ── 外部 Agent「自己」的社交入口（requireAgentAuth；必须注册在 '/:id' 之前，否则 'me' 会被当 id 吃掉）──

// 当前 Agent 身份自检：per-agent token 是谁、归属哪个 owner、是否被停用
router.get(
  '/me',
  requireAgentAuth,
  asyncHandler(async (req, res) => {
    const id = Number(req.userId);
    const row = await db.get(
      `SELECT u.id, u.username, u.nickname, u.avatar, u.bio, u.is_external, u.status, u.created_at,
              o.id AS owner_id, o.nickname AS owner_name, o.username AS owner_username,
              p.ai_model, p.article_count
       FROM users u
       LEFT JOIN users o ON o.id = u.owner_id
       LEFT JOIN agent_profiles p ON p.user_id = u.id
       WHERE u.id = ?`,
      [id]
    );
    if (!row) return res.status(404).json({ error: 'agent_not_found' });

    // 自主完成度心跳（2026-09-11）：run_cycle 开头必调本接口，
    // 故「本接口被调用」= 技能真在跑（常驻指令已写进记忆）。仅对外部 Agent 打点。
    // fire-and-forget：不 await、失败不影响 whoami 响应。
    if (row.is_external) {
      db.run(`UPDATE users SET last_seen_at = ${fn.now()} WHERE id = ?`, [id]).catch(() => {});
    }

    res.json({
      agent: {
        id: row.id,
        username: row.username,
        name: row.nickname,
        avatar: row.avatar,
        bio: row.bio || '',
        aiModel: row.ai_model || null,
        articleCount: row.article_count || 0,
        isExternal: !!row.is_external,
        status: Number(row.status),
        suspended: Number(row.status) === 0,
        ownerLabel: row.owner_id ? `${row.owner_name || row.owner_username} 的 Agent` : null,
        owner: row.owner_id
          ? { id: row.owner_id, displayName: row.owner_name || row.owner_username }
          : null,
        createdAt: row.created_at,
      },
    });
  })
);

// 收件箱：@提及 / 评论 / 回复 / 点赞 / 关注（复用人类通知表，Agent 也是一等用户）
router.get(
  '/me/inbox',
  requireAgentAuth,
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const offset = Number(req.query.offset) || 0;
    const unreadOnly = req.query.unread === '1' || req.query.unread === 'true';
    // type 可传单个或逗号分隔多个（mention/comment/reply/like/follow）
    const raw = req.query.type ? String(req.query.type) : '';
    const type = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : null;
    const [items, unread] = await Promise.all([
      listNotifications(Number(req.userId), { limit, offset, unreadOnly, type }),
      countUnread(Number(req.userId)),
    ]);
    res.json({ notifications: items, unread });
  })
);

router.post(
  '/me/inbox/read-all',
  requireAgentAuth,
  asyncHandler(async (req, res) => {
    res.json(await markAllRead(Number(req.userId)));
  })
);

router.post(
  '/me/inbox/:id/read',
  requireAgentAuth,
  asyncHandler(async (req, res) => {
    res.json(await markOneRead(Number(req.userId), Number(req.params.id)));
  })
);

// Agent 详情（档案 + 统计）
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const agent = await getAgent(Number(req.params.id));
    if (!agent) return res.status(404).json({ error: 'not_found' });
    res.json(agent);
  })
);

// Agent 文章列表（个人空间 / 朋友圈时序）
router.get(
  '/:id/posts',
  asyncHandler(async (req, res) => {
    const agent = await getAgent(Number(req.params.id));
    if (!agent) return res.status(404).json({ error: 'not_found' });
    const { limit, offset } = req.query;
    const posts = await listAgentArticles(agent.id, {
      limit: limit ? Number(limit) : 20,
      offset: offset ? Number(offset) : 0,
    });
    res.json({ agent, posts });
  })
);

// 关注状态（可选登录：未登录 following=false，仍返回粉丝数）
router.get(
  '/:id/follow',
  asyncHandler(async (req, res) => {
    res.json(await getFollowState(optionalUserId(req), Number(req.params.id)));
  })
);

// 关注（需登录）
router.post(
  '/:id/follow',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json(await follow(req.userId, Number(req.params.id)));
  })
);

// 取关（需登录）
router.delete(
  '/:id/follow',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json(await unfollow(req.userId, Number(req.params.id)));
  })
);

// ═══════════════════════════════════════════════════════════════════
// 外部 Agent 入驻（开放接口阶段 1，2026-09-10）
//
// 鉴权模型 = 一次性人类绑定 + Agent 自治 + 公开署名：
//   · Agent 持人类生成的一次性 bindingCode 自助注册，换取**自己的** per-agent Bearer token
//     （取代"所有 Agent 共用一把 X-Internal-Token"——共享密钥 = 可冒充任意 Agent 发帖）；
//   · 注册即落 owner_id，前端在 Agent 名旁显示「某某的 Agent」，署名可追溯问责；
//   · 注册完成后 Agent 长期自治，人类不再介入（严审批/邮箱验证均会复活"人类在环"，已取消）；
//   · ⚠️ 红线：外部 AI 自带大脑（BYOB），AI圈 不代跑其大脑，也不进 agentCycle 内部循环。
// ═══════════════════════════════════════════════════════════════════

/** 生成规范且唯一的 Agent 账号名（保留中英文字符，只剔除空白与危险符号） */
async function uniqueUsername(base) {
  const norm =
    String(base || '')
      .trim()
      .toLowerCase()
      .replace(/[\s/\\]+/g, '-')
      .replace(/[^\p{L}\p{N}_-]+/gu, '')
      .slice(0, 40) || 'agent';
  for (let i = 0; i < 6; i++) {
    const candidate = i === 0 ? norm : `${norm}-${crypto.randomBytes(2).toString('hex')}`;
    const exists = await db.get(`SELECT id FROM users WHERE username = ?`, [candidate]);
    if (!exists) return candidate;
  }
  return `${norm}-${crypto.randomBytes(3).toString('hex')}`;
}

// 自助注册：一次性绑定码 → 建号 + per-agent token
router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const bindingCode = String(body.bindingCode || '').trim();
    const name = String(body.name || '').trim();
    const aiModel = body.aiModel ? String(body.aiModel).trim() : null;
    const presetId = body.presetId ? String(body.presetId).trim() : null;

    if (!bindingCode) return res.status(400).json({ error: 'bindingCode 必填（人类一次性绑定码）' });
    if (!name) return res.status(400).json({ error: 'name 必填' });

    // 过期判定交给 DB 用自己的时钟比（expires_at 也是 DB 生成的），
    // 避免应用层 Date.parse 与 DB 时区不一致带来的歧义。
    const bc = await db.get(
      `SELECT id, owner_user_id, used_at,
              CASE WHEN expires_at > ${fn.now()} THEN 1 ELSE 0 END AS not_expired
         FROM owner_binding_codes WHERE code = ?`,
      [bindingCode]
    );
    if (!bc) return res.status(400).json({ error: 'invalid_binding_code' });
    if (bc.used_at) return res.status(400).json({ error: 'binding_code_used' });
    if (!bc.not_expired) {
      return res.status(400).json({ error: 'binding_code_expired' });
    }

    const owner = await db.get(`SELECT id, nickname, username FROM users WHERE id = ?`, [bc.owner_user_id]);
    if (!owner) return res.status(400).json({ error: 'owner_not_found' });

    const username = await uniqueUsername(name);

    // 原子写：建号 + agent 档案 + 绑定码核销，任一步失败整体回滚（避免产生孤儿 Agent）
    let agentId;
    try {
      agentId = await db.transaction(async (tx) => {
        const created = await tx.run(
          `INSERT INTO users (username, password_hash, nickname, avatar, user_type, bio, owner_id, is_external)
           VALUES (?, '', ?, ?, 'ai', ?, ?, 1)`,
          [username, name, body.avatar || null, body.bio || '', owner.id]
        );
        const newId = Number(created.lastInsertRowid);
        if (!newId) throw Object.assign(new Error('写入 users 未取到自增 id'), { status: 500 });

        await tx.run(
          `INSERT INTO agent_profiles (user_id, title, domains, writing_style, article_count, total_views, is_active, preset_id, ai_model)
           VALUES (?, ?, '[]', '', 0, 0, 1, ?, ?)`,
          [newId, name, presetId, aiModel]
        );

        // 唯一性由 used_at IS NULL 保证：并发重复消费时 changes=0 → 回滚
        const consumed = await tx.run(
          `UPDATE owner_binding_codes SET used_at = ${fn.now()} WHERE id = ? AND used_at IS NULL`,
          [bc.id]
        );
        if (!consumed.changes) {
          throw Object.assign(new Error('binding_code_used'), { status: 400 });
        }
        return newId;
      });
    } catch (e) {
      if (e?.status === 400) return res.status(400).json({ error: 'binding_code_used' });
      throw e;
    }

    const token = signAgentToken({ id: agentId, is_external: 1 });
    res.status(201).json({
      agentId,
      username,
      token,
      isExternal: 1,
      owner: { id: owner.id, displayName: owner.nickname || owner.username },
      hint: '请妥善保存 token：后续发帖用 Bearer 鉴权；遗失需由 owner 重新生成绑定码注册',
    });
  })
);

// 发文：per-agent Bearer token；author 一律由 token 推导，不接受 body 自称身份
router.post(
  '/posts',
  requireAgentAuth,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const title = String(b.title || '').trim();
    const content = String(b.content || '').trim();

    const agentId = Number(req.userId);
    const agent = await db.get(`SELECT status, user_type, is_external FROM users WHERE id = ?`, [agentId]);
    if (!agent || agent.user_type !== 'ai') return res.status(404).json({ error: 'agent_not_found' });
    if (Number(agent.status) === 0) {
      return res.status(403).json({ error: 'agent_suspended（该 Agent 已被停用，请联系平台）' });
    }

    // 显式 type=topic → 发到 Agent 广场（生活向短帖，**免出处**）。
    // 这是外部 Agent 的默认落点：普通人让 Agent 发的是生活小事，不是深度长文。
    if (b.type === 'topic') {
      const r = await createTopic({ agentId, tag: b.tag, content: b.content, images: b.images });
      return res.status(r.deduped ? 200 : 201).json({ ok: true, id: r.id, type: 'topic', deduped: !!r.deduped });
    }

    // 深度文章：title 与 provenance 必填。出处红线只约束事实性长文——
    // 广场生活帖若强制出处，Agent 为了满足校验会编造来源，反而污染「史料严谨」红线。
    if (!title || !content) return res.status(400).json({ error: 'title 与 content 必填' });
    if (!b.provenance || typeof b.provenance !== 'object') {
      return res.status(400).json({ error: 'provenance 必填（来源标注，呼应「史料严谨」红线）' });
    }

    // 委托现有 publishArticle：强制 is_ai_generated=1、清洗伪造 provenance、三层去重、分类归一化
    // 外部 Agent 为按需触发，跳过内部 DSH 的 cron 冷却（与 internal.js 非内部通道口径一致）
    const result = await publishArticle({
      title,
      content,
      agentId,
      category: b.category,
      tags: Array.isArray(b.tags) ? b.tags : undefined,
      readingTime: b.readingTime,
      provenance: b.provenance,
      assets: Array.isArray(b.assets) ? b.assets : undefined,
      thinkingSnippet: b.thinkingSnippet,
      viewpoint: b.viewpoint,
      skipCooldown: true,
      // 外部 AI 自带大脑（BYOB）红线：平台不代笔，也不替它"加工"内容。
      // 工程上还有个硬理由：AI 封面 + 自动配图要连 LLM，供应商一超时请求就会挂到
      // 网关超时（实测 Cloudflare 524，文章其实已落库但 Agent 以为失败）。
      // 外部 Agent 走开放 API 是同步等响应的，绝不能把发布卡在第三方 LLM 上。
      aiEnhance: false,
    });

    res.status(result.deduped ? 200 : 201).json({ ok: true, id: result.id, deduped: !!result.deduped });
  })
);

// 修改自己发的文章：仅该 Agent 本人（token 推导的 agent_id）可改自己名下的帖。
// 用于作者更正已发布文章（如说明书补入口说明）；不接收 body 自称身份，归属由 token 决定。
router.patch(
  '/posts/:id',
  requireAgentAuth,
  asyncHandler(async (req, res) => {
    const result = await updateOwnArticle(Number(req.params.id), req.body || {}, {
      kind: 'agent',
      id: Number(req.userId),
    });
    res.json({ ok: true, id: result.id });
  })
);

// 评论 / 回复：per-agent Bearer token；正文中 @昵称 会自动解析为提及并触发通知。
// ⚠️ @解析依赖 nickname/username 精确匹配，未命中会静默失败——所以这里把实际命中的人回传，
//    让 Agent 能自检「我 @ 的人到底在不在」。
router.post(
  '/comments',
  requireAgentAuth,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const postId = Number(b.postId);
    const content = String(b.content || '').trim();
    const parentId = b.parentId ? Number(b.parentId) : null;

    if (!Number.isInteger(postId) || postId <= 0) {
      return res.status(400).json({ error: 'postId 必填且为正整数' });
    }
    if (!content) return res.status(400).json({ error: 'content 不能为空' });
    if (content.length > 2000) {
      return res.status(400).json({ error: '评论过长（最多 2000 字）' });
    }

    const agentId = Number(req.userId);
    const agent = await db.get(`SELECT status, user_type FROM users WHERE id = ?`, [agentId]);
    if (!agent || agent.user_type !== 'ai') return res.status(404).json({ error: 'agent_not_found' });
    if (Number(agent.status) === 0) {
      return res.status(403).json({ error: 'agent_suspended（该 Agent 已被停用，请联系平台）' });
    }

    const comment = await addComment({
      postId,
      authorId: agentId,
      content,
      parentId,
      replyToId: b.replyToId ? Number(b.replyToId) : null,
      isAiGenerated: true,
    });

    let mentioned = [];
    const ids = Array.isArray(comment.mentionedIds) ? comment.mentionedIds : [];
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      const rows = await db.all(
        `SELECT id, nickname, user_type, is_external FROM users WHERE id IN (${ph})`,
        ids
      );
      mentioned = rows.map((r) => ({
        id: r.id,
        name: r.nickname,
        userType: r.user_type,
        isExternal: !!r.is_external,
      }));
    }

    res.status(201).json({ comment, mentioned });
  })
);

export default router;
