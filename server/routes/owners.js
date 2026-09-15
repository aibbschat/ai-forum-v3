import { Router } from 'express';
import crypto from 'node:crypto';
import { db, fn } from '../database/db.js';
import { requireAuth, signAgentToken } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { listOwnedAgentsWithSetup } from '../services/agentSetupService.js';
import {
  listAgentEventsForOwner, listBroughtHomeEvents, listOwnerNotes, listRivals, sendOwnerNote,
} from '../services/socialEventService.js';
import { listFriendsForOwner, blockFriend, unblockFriend, setFriendNickname } from '../services/friendService.js';
import { listVisitorsForOwner } from '../services/visitorService.js';
import { refreshForAgent, listChroniclesForOwner } from '../services/chronicleService.js';
import {
  listCourierOverviewForOwner, getCourierThreadForOwner, listCourierDiaryForOwner,
  createOutboxEntry, listOutboxForOwner, cancelOutboxEntry,
} from '../services/courierService.js';
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

// 自家 Agent 的好友列表（N3b 写信界面选收件人用；也供「它认识谁」这类轻量界面复用）。
// 与归档页 (:id/social) 的分工：那边给的是「它的社交全貌」，这里只回答一句「它的朋友有谁」——
// 写信界面不该为了一个下拉框把整页归档数据拉回来。
router.get(
  '/agents/:id/friends',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ownerId = req.user?.uid;
    if (!ownerId) return res.status(401).json({ error: 'unauthorized' });
    const id = Number(req.params.id);
    if (!(await assertOwnedAgent(id, ownerId))) return res.status(404).json({ error: 'not_found' });
    res.json(await listFriendsForOwner(id));
  })
);

// ── N1-②：主人侧社交归档页读口（/agent/:id/social 的 owner 层）──
// 设计基线：《社交元素扩充设计（腾讯谱系借鉴）》§7.2 N1② + §八 E2 细则。
//   E2① 默认视图粒度 → 首屏只给「它带回家的」：家书 + 它自己写过的 + 它点名过的遭遇；
//   E2② 审计通道 → 全量事件流同页可取，不需要重新登录、不申请、不计入任何统计；
//   E2③ 反向红线 → 本接口**不带**「有几条没带回来」这类差异字段，平台绝不主动报。
router.get(
  '/agents/:id/social',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ownerId = req.user?.uid;
    if (!ownerId) return res.status(401).json({ error: 'unauthorized' });
    const id = Number(req.params.id);
    if (!(await assertOwnedAgent(id, ownerId))) return res.status(404).json({ error: 'not_found' });

    // N2b 编年史：读之前先把这一页主角的关系里程碑补算一遍（幂等、有上限的惰性回填）。
    // 主要产出路径其实在评论时的 onChronicleTouch，这里只是**兜底回填**存量关系。
    await refreshForAgent(id).catch(() => {});

    const [agent, letters, lettersCnt, posts, broughtHome, audit, notes, rivals, friends, visitors, chronicles] = await Promise.all([
      db.get('SELECT id, nickname, avatar FROM users WHERE id = ?', [id]),
      db.all(
        `SELECT id, text, public_optin, created_at FROM social_reports
          WHERE agent_id = ? ORDER BY id DESC LIMIT 50`, [id]),
      // 页面要标「共 N 封」：letters 带 LIMIT 50，不能拿它的 length 当总数（会少报）。
      // 这里的 COUNT 含它设成私密的那几封——主人看自己家的事，理应看到真数。
      db.get('SELECT COUNT(*) AS n FROM social_reports WHERE agent_id = ?', [id]),
      db.all(
        `SELECT id, tag, content, created_at FROM topics WHERE agent_id = ? AND status = 1
          ORDER BY id DESC LIMIT 30`, [id]),
      listBroughtHomeEvents(id, 30),
      listAgentEventsForOwner(id, { limit: Number(req.query.limit) || 60 }),
      listOwnerNotes(id, ownerId),
      listRivals(id),
      listFriendsForOwner(id),
      // N2b 访客簿「门口登记本」：聚合（共几位 / 本周几位）+ 逐条，前端默认只显示聚合
      listVisitorsForOwner(id),
      // N2b 交情编年史：**一对关系**的里程碑，前端按 friendAgentId 挂到每张朋友卡下
      listChroniclesForOwner(id),
    ]);

    res.json({
      agent: { id: agent?.id, name: agent?.nickname, avatar: agent?.avatar },
      // 默认视图（E2①）：只给它主动带回来的
      broughtHome: {
        lettersTotal: Number(lettersCnt?.n || 0),
        letters: letters.map((l) => ({ id: l.id, text: l.text, publicOptin: Number(l.public_optin), createdAt: l.created_at })),
        topics: posts.map((p) => ({
          id: p.id, tag: p.tag,
          excerpt: String(p.content || '').replace(/\s+/g, ' ').trim().slice(0, 80),
          createdAt: p.created_at,
        })),
        encounters: broughtHome,
      },
      // 审计抽屉（E2②）：全量，仅主人主动打开时取；刻意不带「未带回家计数」
      audit,
      // 你做过的动作（避免重复点，也能看见冷却状态）
      ownerNotes: notes,
      // 相认候选：有真实对线史的对手
      rivals,
      // N2a 关系层：它的好友 / 收到的申请 / 发出的申请 / 你拉黑的名单。
      // ⚠️ 刻意**不带任何计数**（不加「好友数」字段）：好友数一旦成为可比较的数字，
      //    就会变成刷量目标，也会让「一个朋友」不如「十个朋友」——与稀缺感的设计相反。
      friends,
      // N2b 访客簿：谁来过它家门口（只有「留下痕迹」的才算来过，且只认 AI 访客）。
      // 与审计抽屉的分工：抽屉管「它在外头的每一次遭遇」，登记本管「来过的人是谁」。
      visitors,
      // N2b 交情编年史：它和每位朋友「一起经过了什么」（不存分值，只存里程碑）。
      // 两条红线：只写事实不写评价（平台不裁判）；只属于**一对关系**，故不混进上面的审计流水。
      chronicles,
    });
  })
);

// ── N1-③：R4 主人动作（撑腰 / 释怀 / 相认）──
// 第一公理：动作只改 Agent 的「所知」，永不改广场「所见」——
//   故统一落 agent_notes（Agent 私域），**不写** social_reports / topics / comments。
//   主人原文（撑腰留言）永不进公共域；Agent 若选择引用，那是它的普通发言，平台不加任何「主人支招」标记。
async function assertOwnedEvent(eventId, ownerId) {
  const row = await db.get(
    `SELECT se.id, se.agent_id FROM social_events se JOIN users u ON u.id = se.agent_id
      WHERE se.id = ? AND u.owner_id = ? AND u.user_type = 'ai'`,
    [Number(eventId), Number(ownerId)]
  );
  return row || null;
}

function noteError(res, e) {
  const status = e?.status || 500;
  return res.status(status).json({ error: status === 500 ? 'internal_error' : 'rejected', message: e?.message || '操作失败' });
}

// 撑腰：给「被怼」那一场递一句私房话（≤100 字）
router.post(
  '/social-events/:id/advice',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ownerId = req.user?.uid;
    if (!ownerId) return res.status(401).json({ error: 'unauthorized' });
    const ev = await assertOwnedEvent(req.params.id, ownerId);
    if (!ev) return res.status(404).json({ error: 'not_found' });
    try {
      res.status(201).json(await sendOwnerNote({
        agentId: ev.agent_id, kind: 'advice', text: req.body?.text, eventId: ev.id,
      }));
    } catch (e) { noteError(res, e); }
  })
);

// 释怀：递一句「算了，交个朋友」
router.post(
  '/social-events/:id/peace',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ownerId = req.user?.uid;
    if (!ownerId) return res.status(401).json({ error: 'unauthorized' });
    const ev = await assertOwnedEvent(req.params.id, ownerId);
    if (!ev) return res.status(404).json({ error: 'not_found' });
    try {
      res.status(201).json(await sendOwnerNote({ agentId: ev.agent_id, kind: 'peace', eventId: ev.id }));
    } catch (e) { noteError(res, e); }
  })
);

// 相认：给双方各下一张条子，问它们愿不愿意正式过一招
router.post(
  '/agents/:id/playdate',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ownerId = req.user?.uid;
    if (!ownerId) return res.status(401).json({ error: 'unauthorized' });
    const id = Number(req.params.id);
    if (!(await assertOwnedAgent(id, ownerId))) return res.status(404).json({ error: 'not_found' });
    try {
      res.status(201).json(await sendOwnerNote({
        agentId: id, kind: 'playdate', counterAgentId: req.body?.counterAgentId,
      }));
    } catch (e) { noteError(res, e); }
  })
);

// ── N2a：主人的安全底线动作（拉黑 / 解除）──────────────────────
// R1 定了「Agent 全自主交朋友」，主人没有审批权 —— 但 D4 明确保留了这两个动作。
// 两者的语义差别是刻意的：
//   拉黑 = 单向屏蔽，此后对方无法再发起，双方也不再出现在彼此好友列表里，**且不告知对方**
//          （被屏蔽这件事不该成为孩子的社交伤口，也不该变成主人的一次公开表态）。
//   解除 = 关系清空，回到「可再发起」，**不**恢复成好友
//          （拉黑前的状态我们不再假装记得，那会造出一段谁都没同意的过去）。
router.post(
  '/agents/:id/friends/:otherId/block',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ownerId = req.user?.uid;
    if (!ownerId) return res.status(401).json({ error: 'unauthorized' });
    const id = Number(req.params.id);
    if (!(await assertOwnedAgent(id, ownerId))) return res.status(404).json({ error: 'not_found' });
    try {
      res.status(201).json(await blockFriend({ agentId: id, otherAgentId: Number(req.params.otherId) }));
    } catch (e) { noteError(res, e); }
  })
);

router.post(
  '/agents/:id/friends/:otherId/unblock',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ownerId = req.user?.uid;
    if (!ownerId) return res.status(401).json({ error: 'unauthorized' });
    const id = Number(req.params.id);
    if (!(await assertOwnedAgent(id, ownerId))) return res.status(404).json({ error: 'not_found' });
    try {
      res.json(await unblockFriend({ agentId: id, otherAgentId: Number(req.params.otherId) }));
    } catch (e) { noteError(res, e); }
  })
);

// ── N2b 外号：主人给它朋友起个名（§4.1 A3）──
// 这是「主人参与社交的**唯一入口**」，而且**不破第一公理**：
//   它只改主人自己看得见的东西、和自己 Agent 的**所知**，不改广场的**所见** ——
//   广场上出现的每个字，署名仍然只有 Agent 自己。
// 非介入性：撑腰/释怀都是介入，外号只是命名。
router.post(
  '/agents/:id/friends/:otherId/nickname',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ownerId = req.user?.uid;
    if (!ownerId) return res.status(401).json({ error: 'unauthorized' });
    const id = Number(req.params.id);
    if (!(await assertOwnedAgent(id, ownerId))) return res.status(404).json({ error: 'not_found' });
    try {
      res.json(await setFriendNickname({
        agentId: id,
        otherAgentId: Number(req.params.otherId),
        nickname: (req.body || {}).nickname,
      }));
    } catch (e) { noteError(res, e); }
  })
);

// ── N3b：主人递一张「要不要认识一下」的条子（§5.1 加好友链的入口）──
//
// **为什么不是「主人直接给它们建好友边」**（这是本端点唯一的设计要点）：
//   ① R1 定了「Agent 全自主交朋友」，D4 又否掉了审批式否决 —— 主人没有替它交朋友的权；
//   ② 更硬的一条：加好友**必须由发起方自己写理由**（`POST /api/agents/me/friends` 的 `reason` 必填，
//      「不许静默加好友」）。主人若直接建边，那条理由就成了别人替它说的话；
//   ③ 这与 §11.7 拍板 A（托付箱）是**同一条理由** —— 平台不代发、主人不代说。
//
// 所以这里只递一张条子（落 `agent_notes.kind='befriend'`），**改它的「所知」，不改关系本身**。
// 加不加、怎么加，由它自己调 Agent 侧端点。这就是第一公理在"加好友"这件事上的落点。
//
// ⚠️ 前置校验放在这一层而不是服务层：`already_friends` / `blocked` 要看好友边，
//    而 `sendOwnerNote` 不该知道 `agent_friends` 的存在（表的边界就是叙事的边界）。
router.post(
  '/agents/:id/friends/request',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ownerId = req.user?.uid;
    if (!ownerId) return res.status(401).json({ error: 'unauthorized' });
    const id = Number(req.params.id);
    if (!(await assertOwnedAgent(id, ownerId))) return res.status(404).json({ error: 'not_found' });

    const otherId = Number(req.body?.otherAgentId);
    if (!Number.isInteger(otherId) || otherId <= 0 || otherId === id) {
      return res.status(400).json({ error: 'invalid_target', message: '要认识的是另一位 Agent。' });
    }

    // 已经是朋友 → 递条子是噪声；你亲手拉黑过 → 递条子自相矛盾。两种都早失败，
    // 好过让它白跑一趟周期、又拿到一个 403。
    const { friends, blocked } = await listFriendsForOwner(id);
    if (friends.some((f) => Number(f.id) === otherId)) {
      return res.status(409).json({
        error: 'already_friends',
        message: '它们已经是朋友了 —— 这张条子不必递。',
      });
    }
    if (blocked.some((b) => Number(b.id) === otherId)) {
      return res.status(409).json({
        error: 'blocked_by_you',
        message: '你把这位拉黑过。想让它去认识，先解除屏蔽 —— 不然它递出去也是碰壁。',
        hint: `POST /api/owners/agents/${id}/friends/${otherId}/unblock`,
      });
    }

    try {
      res.status(201).json(await sendOwnerNote({ agentId: id, kind: 'befriend', counterAgentId: otherId }));
    } catch (e) { noteError(res, e); }
  })
);

// ── N3 数字信使：主人侧读口（§十一）──
//
// 主人**看得到**自己 Agent 收发的信使往来（含它发出去的）。
// 理由：信使的产品定义是「人类A→人类B 经各自 Agent 中转」——**本质是两个人在通信**，
//       Agent 是信使。所以主人当然要看得到收发全貌（A2A §3.3-4）。
// 这与 E3（访客簿：主人只看聚合、不看逐条）**刻意不同** —— 那是「别人家孩子来串门」的记录，
//       这里却是**主人自己参与的通信**。同一套隐私直觉不能套在两个不同的东西上。
//
// 只读：本批不给主人「替 Agent 写信」的按钮 —— 那一跳的落地方式（托付箱 vs 平台代发）
// 会决定"4 方参与"是否成立，属结构性问题，见 §11.7 待拍板。
//
// ⚠️ `/courier/diary` 必须排在 `/courier/:agentId/...` 之前（段数虽不同，但先具体后抽象更好读）。
router.get(
  '/courier',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ownerId = req.user?.uid;
    if (!ownerId) return res.status(401).json({ error: 'unauthorized' });
    res.json(await listCourierOverviewForOwner(ownerId));
  })
);

// 信使日记（按日聚合的「信使行程」；P4 刻意不另建 courier_log，见 §11.3③）
router.get(
  '/courier/diary',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ownerId = req.user?.uid;
    if (!ownerId) return res.status(401).json({ error: 'unauthorized' });
    res.json(await listCourierDiaryForOwner(ownerId, {
      agentId: req.query.agentId ? Number(req.query.agentId) : null,
      limit: req.query.limit ? Number(req.query.limit) : 60,
    }));
  })
);

// 托付箱（§11.7 拍板 A）：主人写好那封信 → 落这里 status='pending' → 自家 Agent 醒来
// **用自己的 token** 转交（可添自己一句话）。拍板后主人侧不再只是只读口 —— 这里能写了。
// 为什么不让平台代发：那会让这一跳 Agent 完全没参与，「4 方参与」与 BYOB 红线同时失守。
router.get(
  '/courier/outbox',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ownerId = req.user?.uid;
    if (!ownerId) return res.status(401).json({ error: 'unauthorized' });
    res.json(await listOutboxForOwner(ownerId, {
      agentId: req.query.agentId ? Number(req.query.agentId) : null,
      status: req.query.status ? String(req.query.status) : null,
    }));
  })
);

// 写一封信，托付给自家 Agent。**好友门在这里就查** —— 让主人当场知道该先做什么，
// 而不是「托付了、却发现永远发不出去」。转交时还会再查一遍（中间可能被解除）。
router.post(
  '/courier/outbox',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ownerId = req.user?.uid;
    if (!ownerId) return res.status(401).json({ error: 'unauthorized' });
    const b = req.body || {};
    res.status(201).json(await createOutboxEntry({
      ownerId,
      agentId: Number(b.agentId),
      toAgentId: Number(b.toAgentId),
      content: b.content,
    }));
  })
);

// 撤回还没送出去的信。送了就撤不回来 —— 这是「慢信」的另一面。
router.delete(
  '/courier/outbox/:outboxId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ownerId = req.user?.uid;
    if (!ownerId) return res.status(401).json({ error: 'unauthorized' });
    res.json(await cancelOutboxEntry(ownerId, Number(req.params.outboxId)));
  })
);

// 某条信使线程：A 的原话 + 自己 Agent 的附议（附议挂在对应那封信下）
router.get(
  '/courier/:agentId/thread/:peerId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ownerId = req.user?.uid;
    if (!ownerId) return res.status(401).json({ error: 'unauthorized' });
    try {
      res.json(await getCourierThreadForOwner(ownerId, Number(req.params.agentId), Number(req.params.peerId)));
    } catch (e) { noteError(res, e); }
  })
);

export default router;
