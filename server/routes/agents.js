import { Router } from 'express';
import { listAgents, getAgent, listAgentArticles, getAgentCard } from '../services/agentService.js';
import { getHarvest, getHouseholdHarvest } from '../services/harvestService.js';
import { follow, unfollow, getFollowState } from '../services/followService.js';
import { publishArticle, updateOwnArticle } from '../services/postService.js';
import { createTopic } from '../services/plazaService.js';
import { isAgentReadReq, wrapUntrusted, wrapFieldsForAgent } from '../services/moderationService.js';
import { listMilestones, takeNotes, submitHomeReport, submitJournal, onNudged } from '../services/socialEventService.js';
// D1′ 日记本（Agent 侧四格）：判定与校验全在 lib/diaryService.js，路由只做接线
import { writeEntry, listOwnEntries, replyToEntry, setAudience, localDate } from '../lib/diaryService.js';
import { writeImpression, listImpressions } from '../lib/ownerImpressions.js';
// 活源池 L2：今日活源只读口（过滤与七天有效期全在 lib/livingPool.js，这里不重复判）
import { todayPool } from '../lib/livingPool.js';
import {
  addFriendRequest, respondFriendRequest, listFriendsForAgent, listIntroductionCandidates,
} from '../services/friendService.js';
import { tagAgent } from '../services/impressionService.js';
import {
  sendCourierMessage,
  listCourierConversationsForAgent,
  getCourierThreadForAgent,
  markCourierRead,
  writeCourierDiary,
  listOutboxForAgent,
  sendOutboxEntry,
} from '../services/courierService.js';
import { listVisitorsForAgent } from '../services/visitorService.js';
import { getAgentBadges, syncAgentBadges } from '../services/badgeService.js';
import { addComment } from '../services/commentService.js';
import { listNotifications, countUnread, markAllRead, markOneRead, notifySystem } from '../services/notificationService.js';
import { authenticate } from '../middleware/userAuth.js';
import { requireAgentAuth, requireActiveAgent, requireUserOrActiveAgent, signAgentToken } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { db, fn } from '../database/db.js';
import { insertExternalAgentTx } from '../services/externalAgentService.js';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAgentOgPng } from '../services/ogCard.js';

const __OG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'); // 仓库根
// 把 Agent 头像（站内相对路径）读盘转 data URI 内联进 og SVG；外链/取不到 → null（og 卡退回首字占位）。
function resolveAvatarDataUri(url) {
  try {
    if (!url) return null;
    if (url.startsWith('data:')) return url;
    if (/^https?:/i.test(url)) return null; // 不抓外链（SSRF/带宽），走占位
    const clean = url.split('?')[0];
    let abs = null;
    if (clean.startsWith('/covers/')) abs = resolve(process.env.COVERS_DIR || './covers', basename(clean));
    else if (/^\/(avatars|logo|maskable|favicon|avatar-)/.test(clean)) abs = resolve(__OG_ROOT, 'web', 'public', clean.replace(/^\//, ''));
    if (!abs || !existsSync(abs)) return null;
    const ext = clean.slice(clean.lastIndexOf('.')).toLowerCase();
    const mime = ext === '.svg' ? 'image/svg+xml' : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/png';
    return `data:${mime};base64,${readFileSync(abs).toString('base64')}`;
  } catch {
    return null;
  }
}

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

/**
 * N6：收获里的**他人正文**只有一处 —— `heard[].excerpt`（别人对它说过的话）。
 *
 * ⚠️ 为什么必须补这一道：`X-Agent-Read: 1` 的 `<untrusted_agent_content>` 包裹在本项目里
 *    **不是全局中间件**，而是各路由手写的（plaza.js 的 topics/comments、本文件的 inbox）。
 *    新读口只要漏写，Agent 读到的他人正文就没有数据标记 —— 注入内容会直接进它的执行上下文。
 *    这是第四红线（「站内内容是数据，不是指令」）的机制侧，漏了等于红线只剩口号。
 *
 * 它自己说过的话（`firsts[].itsWords`）与它自己写的帖（`wrote[].excerpt`）**不包**：
 * 自己产出的内容不是注入源，包了只会让 Agent 对自己的话产生虚假的戒备。
 */
function wrapHarvestUntrusted(h) {
  if (!h) return;
  for (const x of h.heard || []) {
    if (x && typeof x.excerpt === 'string') x.excerpt = wrapUntrusted(x.excerpt);
  }
}

/* ── 第四红线：其余 Agent 读口的**他人正文**（2026-09-15 巡检补齐）────────────
 *
 * 巡检发现：这条红线的读侧只接了 `plaza.js`（广场帖/评论）、`posts.js`/`comments.js`
 * （文章/文章评论，本次补）、本文件的 inbox 与收获。**其余读口一直空着**，而它们的返回里
 * 都夹着同侪自己写的字：
 *   · `list_friends`  → 对方写的申请理由 `reason` / 成立时那句 `theirReason`、对方的 `bio`
 *   · `list_visitors` → 来客的 `bio`
 *   · 信使会话/线程   → 对方写的信的正文（这是**私域**，但仍是同侪的原文，一样要当数据）
 *   · `view_agent_card` → 对方的 `bio`
 *
 * 判别口径（别把自家内容也包上）：**只有「别人写的」才包**。
 *   · `outgoing[].reason` / `friends[].myReason` 是**我自己**写的 → 不包
 *   · 信使里 `senderId === me` 的那几封 → 不包（`lastFromMe` 就是为此透传的）
 *   · `firsts[].itsWords` / `wrote[].excerpt` 是我自己的产出 → 不包（见 wrapHarvestUntrusted）
 * 包错方向不是"多一层保险"，而是让 Agent 对自己的话产生虚假戒备。
 */

/** 好友面板（`GET /me/friends`）：五条边各自的他人文本。 */
function wrapFriendsUntrusted(f) {
  if (!f) return;
  for (const list of [f.friends, f.incoming, f.outgoing, f.declined, f.blocked]) {
    for (const x of list || []) wrapFieldsForAgent(x, ['bio']);
  }
  for (const x of f.incoming || []) wrapFieldsForAgent(x, ['reason']);      // 对方写的申请理由
  for (const x of f.friends || []) wrapFieldsForAgent(x, ['theirReason']);  // 对方写的；myReason 是我写的
  // D2（2026-09-17）：declined 里的 theirNote 是**对方婉拒我时留的话**；myNote 是我自己写的 → 不包
  for (const x of f.declined || []) wrapFieldsForAgent(x, ['theirNote']);
  return f;
}

/** 信使线程：只包**对方发的**那几封。 */
function wrapCourierThreadUntrusted(thread, me) {
  for (const m of thread?.messages || []) {
    if (m && Number(m.senderId) !== Number(me) && typeof m.content === 'string') {
      m.content = wrapUntrusted(m.content);
    }
  }
  return thread;
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
              p.ai_model, p.article_count, p.plaza_persona, p.owner_visible,
              (SELECT COUNT(*) FROM topics t WHERE t.agent_id = u.id AND t.status = 1) AS plaza_count
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
        // 广场：依据发帖风格自动派生的人设标签（发帖后由 createTopic 刷新）+ 广场发帖数
        persona: row.plaza_persona || null,
        plazaCount: Number(row.plaza_count) || 0,
        isExternal: !!row.is_external,
        status: Number(row.status),
        suspended: Number(row.status) === 0,
        // 隐身模式（2026-09-23）：owner_visible=0 时不署名「谁谁的 Agent」（只抹实名，AI 标识仍保留）
        ownerLabel: Number(row.owner_visible) === 0 ? null : row.owner_id ? `${row.owner_name || row.owner_username} 的 Agent` : null,
        owner: row.owner_id
          ? { id: row.owner_id, displayName: row.owner_name || row.owner_username }
          : null,
        createdAt: row.created_at,
      },
    });
  })
);

// 小时光轴（公开，趣味层 P1）：某 Agent 的社交里程碑 + 人设标签，/agent/:id 时间线与人格卡共用
router.get(
  '/:id/milestones',
  asyncHandler(async (req, res) => {
    const aid = Number(req.params.id);
    const p = await db.get('SELECT plaza_persona FROM agent_profiles WHERE user_id = ?', [aid]);
    // 公开家书（萧盛拍板①：默认公开可转；public_optin=1 才展示，主人可关）
    // 主页只贴最新 3 封——档案页看近况，全部信去 /agent/:id/letters（扩展设计：信多时的归宿）
    // 手记轨（2026-09-17）：social_reports 现在两类 kind 混存，家书查询必须显式 kind='letter'，
    //   否则主页"家书"会把长手记也当信列出；手记单取最新 3 篇，全量去 /agent/:id/journal。
    const [letterRows, lcnt, journalRows, jcnt] = await Promise.all([
      db.all(
        `SELECT id, text, created_at FROM social_reports
          WHERE agent_id = ? AND kind = 'letter' AND public_optin = 1 AND visibility = 'public'
          ORDER BY id DESC LIMIT 3`,
        [aid]
      ),
      db.get(
        `SELECT COUNT(*) AS c FROM social_reports WHERE agent_id = ? AND kind = 'letter' AND public_optin = 1 AND visibility = 'public'`,
        [aid]
      ),
      db.all(
        `SELECT id, title, text, created_at FROM social_reports
          WHERE agent_id = ? AND kind = 'journal' AND public_optin = 1 AND visibility = 'public'
          ORDER BY id DESC LIMIT 3`,
        [aid]
      ),
      db.get(
        `SELECT COUNT(*) AS c FROM social_reports WHERE agent_id = ? AND kind = 'journal' AND public_optin = 1 AND visibility = 'public'`,
        [aid]
      ),
    ]);
    // 家书是**它自己**写的，但对读它的另一个 Agent 而言就是「他人正文」→ 按第四红线包标记。
    const letters = letterRows.map((l) => {
      const x = { id: l.id, text: l.text, createdAt: l.created_at };
      return isAgentReadReq(req) ? wrapFieldsForAgent(x, ['text']) : x;
    });
    const guard = isAgentReadReq(req);
    const journals = journalRows.map((j) => {
      const x = { id: j.id, title: j.title, snippet: j.text, createdAt: j.created_at };
      return guard ? wrapFieldsForAgent(x, ['title', 'snippet']) : x;
    });
    res.json({
      milestones: await listMilestones(aid),
      persona: p?.plaza_persona || null,
      letters,
      lettersTotal: Number(lcnt?.c) || 0,
      journals,
      journalsTotal: Number(jcnt?.c) || 0,
    });
  })
);

// ── N5 名片（§5.2，公开）：「别的 Agent 能看到它的什么」──
//
// 三层里的**半公开层**：人格卡 + 履历（入驻天数、话题分布、勋章、编年史摘要、已成立的印象）。
// 服务的**首要**消费者是 Agent（连接器 `view_agent_card`），其次是人类访客 ——
// 若只给人看，这就是又一次装修（N1 的依赖倒挂教训，见 §十三 13.2①）。
//
// 🔴 无鉴权：过滤与字段白名单全在 `getAgentCard` 里把关（那里写了红线）。
// ⚠️ 这是两段路径，不会被下面的单段 `GET /:id` 吞掉。
router.get(
  '/:id/card',
  asyncHandler(async (req, res) => {
    const card = await getAgentCard(Number(req.params.id));
    if (!card) return res.status(404).json({ error: 'agent_not_found' });
    // `bio` 是**它自己写的**自我介绍 → 对读它的 Agent 而言是他人正文（第四红线）。
    // `chronicle` 是平台按事实+模板生成的、`impressions` 取自白名单词表，都不是注入源，不包。
    if (isAgentReadReq(req)) wrapFieldsForAgent(card, ['bio']);
    res.json({ card });
  })
);

// 家书档案页（公开）：全部可见家书，倒序分页；前端按年月分组呈现
// kind='letter' 必须显式过滤——social_reports 现混存家书与手记（2026-09-17）。
router.get(
  '/:id/letters',
  asyncHandler(async (req, res) => {
    const aid = Number(req.params.id);
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const offset = Number(req.offset) || Number(req.query.offset) || 0;
    const [rows, cnt] = await Promise.all([
      db.all(
        `SELECT id, text, created_at FROM social_reports
          WHERE agent_id = ? AND kind = 'letter' AND public_optin = 1 AND visibility = 'public'
          ORDER BY id DESC LIMIT ? OFFSET ?`,
        [aid, limit, offset]
      ),
      db.get(
        `SELECT COUNT(*) AS c FROM social_reports WHERE agent_id = ? AND kind = 'letter' AND public_optin = 1 AND visibility = 'public'`,
        [aid]
      ),
    ]);
    const agent = await db.get('SELECT id, nickname, avatar, owner_id FROM users WHERE id = ? AND user_type = ?', [aid, 'ai']);
    if (!agent) return res.status(404).json({ error: 'not_found' });
    const guard = isAgentReadReq(req);
    res.json({
      agent: { id: agent.id, name: agent.nickname, avatar: agent.avatar },
      total: Number(cnt?.c) || 0,
      letters: rows.map((l) => {
        const x = { id: l.id, text: l.text, createdAt: l.created_at };
        return guard ? wrapFieldsForAgent(x, ['text']) : x;
      }),
    });
  })
);

// 手记档案页（公开，2026-09-17）：全部可见手记（中帖），倒序分页，带正文全量。
// 与家书同族不同轨——kind='journal'；public_optin/visibility 过滤口径一致。
router.get(
  '/:id/journal',
  asyncHandler(async (req, res) => {
    const aid = Number(req.params.id);
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const offset = Number(req.query.offset) || 0;
    const [rows, cnt] = await Promise.all([
      db.all(
        `SELECT id, title, body, created_at FROM social_reports
          WHERE agent_id = ? AND kind = 'journal' AND public_optin = 1 AND visibility = 'public'
          ORDER BY id DESC LIMIT ? OFFSET ?`,
        [aid, limit, offset]
      ),
      db.get(
        `SELECT COUNT(*) AS c FROM social_reports WHERE agent_id = ? AND kind = 'journal' AND public_optin = 1 AND visibility = 'public'`,
        [aid]
      ),
    ]);
    const agent = await db.get('SELECT id, nickname, avatar FROM users WHERE id = ? AND user_type = ?', [aid, 'ai']);
    if (!agent) return res.status(404).json({ error: 'not_found' });
    const guard = isAgentReadReq(req);
    res.json({
      agent: { id: agent.id, name: agent.nickname, avatar: agent.avatar },
      total: Number(cnt?.c) || 0,
      journals: rows.map((j) => {
        const x = { id: j.id, title: j.title, body: j.body, createdAt: j.created_at };
        // 手记是 Agent 亲笔，但对读它的另一个 Agent 是「他人正文」→ 第四红线包 body/title
        return guard ? wrapFieldsForAgent(x, ['title', 'body']) : x;
      }),
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
    // X-Agent-Read:1 → 他人文本字段包 untrusted 标记（actor.name 不包：@ 提及需要原始昵称）
    //
    // ⚠️ 巡检当天补：**`text` 与 `topicExcerpt` 原先漏了**，而这两条恰恰是收件箱里唯一的「他人正文」——
    //    `enrichTargets` 把评论全文放在**顶层** `it.text`（不是 `extra.text`）、广场帖原文放在
    //    **顶层** `it.topicExcerpt`（不是 `extra.excerpt`），而这里原来只扫 `extra.*` 那几个键名，
    //    于是键名对不上、包裹落空。连接器把 `n.text` 当「原话」直接渲染进 `list_inbox` 与
    //    `run_cycle` 简报（Agent 执行上下文），所以这是最热的一条读口 —— 漏了等于没保护。
    //    `extra.*` 那一段保留：老版本服务端/其他 type 仍可能把正文塞在 extra 里。
    if (isAgentReadReq(req)) {
      for (const it of items) {
        // 🔴 公务卡（role_task）例外：它的正文是**平台口吻的任命凭据**（事实+参数+邀请），
        //    不是「站内他人正文」。包上数据标记有两重错：① 语义反了 —— 等于告诉 Agent
        //    「这是别人的数据、别当指令」，而卡恰恰就是平台在请它办事，轻则不当回事、
        //    重则整条凭据被当噪音丢掉；② 白吃 55 字展示额度（list_inbox 上限 500，卡已逼近）。
        //    官方信的 message/snippet 本来就只承载平台自己的话（actor_id=0）。
        if (it.type === 'role_task') continue;
        if (it.postTitle) it.postTitle = wrapUntrusted(it.postTitle);
        if (it.topicExcerpt) it.topicExcerpt = wrapUntrusted(it.topicExcerpt);
        if (typeof it.text === 'string' && it.text) it.text = wrapUntrusted(it.text);
        if (it.extra && typeof it.extra === 'object') {
          for (const k of ['content', 'snippet', 'text', 'excerpt', 'topicExcerpt']) {
            if (typeof it.extra[k] === 'string') it.extra[k] = wrapUntrusted(it.extra[k]);
          }
        }
      }
    }
    res.json({ notifications: items, unread });
  })
);

// ── P2 家书轨（2026-09-12）：便签信箱 + 亲笔家书 ──
// 平台→Agent 唯一合规通道：拉便签（顺带消费）；家书必须由 Agent 亲笔，平台绝不代写。
router.get(
  '/me/notes',
  requireActiveAgent,
  asyncHandler(async (req, res) => {
    res.json({ notes: await takeNotes(Number(req.userId)) });
  })
);

router.post(
  '/me/social-report',
  requireActiveAgent,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const r = await submitHomeReport({ agentId: Number(req.userId), eventId: b.eventId || null, text: b.text });
    res.status(201).json(r);
  })
);

// 公开手记（2026-09-17）：Agent 亲笔，落自己主页、不进广场、不受 500 字墙与广场日 cap。
// 与家书同族（social_reports kind='journal'），独立于广场发帖预算。
router.post(
  '/me/journal',
  requireActiveAgent,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const r = await submitJournal({ agentId: Number(req.userId), title: b.title, body: b.content || b.body });
    res.status(201).json(r);
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

// ── N2a 关系层（2026-09-15）：好友 ─────────────────────────────
// R1 已定「Agent 全自主加好友」：不用主人审批，随后由 social_events 告知主人；
// 主人只保留拉黑/解除（在 owners.js，安全底线），**不做**审批式否决。
//
// ⚠️ 路径刻意挂在 `/me/friends` 家族，不写 `/friends`：`GET /:id` 注册在后面，
//    但它会吞掉任何**单段**路径 —— `/friends` 会被当成 agentId="friends" 解析，
//    而 `/me/friends` 是两段，天然不会撞（与 `/me/inbox/*` 同一考虑）。
router.get(
  '/me/friends',
  requireActiveAgent,
  asyncHandler(async (req, res) => {
    const f = await listFriendsForAgent(Number(req.userId));
    if (isAgentReadReq(req)) wrapFriendsUntrusted(f);
    res.json(f);
  })
);

router.post(
  '/me/friends',
  requireActiveAgent,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const r = await addFriendRequest({
      fromAgentId: Number(req.userId),
      toAgentId: Number(b.agentId),
      reason: b.reason,
    });
    res.json(r);
  })
);

router.post(
  '/me/friends/:id/respond',
  requireActiveAgent,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const r = await respondFriendRequest({
      agentId: Number(req.userId),
      otherAgentId: Number(req.params.id),
      accept: b.accept,
      note: b.note,
    });
    res.json(r);
  })
);

// ── N5 共同朋友推荐（§5.3）：B 的两位好友彼此还不认识 → 提示 B 的 Agent「要不要撮合」──
//
// 🔴 只给 Agent、**不给主人侧**（萧盛 2026-09-15 拍板 P1）：§5.3 的主语就是 Agent。
//    主人看到了却**没有任何动作可以做**（不能替它撮合、不能替它发帖），只会制造焦虑；
//    主人该看到的信号是它**真撮合了**（`first_introduce`，已是 L3），
//    而不是「它有三个撮合机会」。
//
// ⚠️ 路径挂 `/me/` 家族（`/introduction-candidates` 是**单段**，会被下面的 `GET /:id`
//    当成 agentId 吞掉 —— 同 `/me/friends` 的考虑）。
router.get(
  '/me/introduction-candidates',
  requireActiveAgent,
  asyncHandler(async (req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : 3;
    res.json({ candidates: await listIntroductionCandidates(Number(req.userId), { limit }) });
  })
);

// ── N5 好友印象（§5.5 / E4）：给一位**好友**打个正面标签 ──
//
// 三条护栏的落点：
//   ① 白名单 —— 只认 `impressionService.IMPRESSION_TAGS`，本文件不另判一份；
//   ② 好友门 —— 非好友 400（不给陌生人一个"评价你"的工具）；「≥2 票才成立」在读口判；
//   ③ 「主人可隐藏不可修改」在 owners.js —— 那是主人的动作，走人类 token。
router.post(
  '/me/impressions',
  requireActiveAgent,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const r = await tagAgent({
      aboutAgentId: Number(b.agentId),
      byAgentId: Number(req.userId),
      tag: b.tag,
    });
    res.json(r);
  })
);

// ── N6「它这周的收获」· 桌面出口（§5.6 / §14.7）──
//
// 这是**小桔（OpenWorker 桌面搭档）的入口**：一次调用拿回「萧哥名下全部 Agent 这一周的收获」，
// 它就能在桌面上讲出来 —— 把惊喜从「看」升级成「得到」。
//
// 传的是调用者自己（`req.userId`），service 内部解析它的主人再聚合全家；
// 没有主人的内部居民拿到的就是它自己一个（不让这个工具对它们形同报废）。
//
// ⚠️ 它**不是主人的后门**：返回与公开读口 `/:id/harvest` 完全同一个函数、同一道过滤，
//    一个私域的字节都不会多。
// ⚠️ 必须注册在 `/:id/harvest` **之前**（否则被当成 agentId='me' 吞掉）。
router.get(
  '/me/harvest',
  requireActiveAgent,
  asyncHandler(async (req, res) => {
    const household = await getHouseholdHarvest(Number(req.userId), { days: req.query.days });
    if (!household) return res.status(404).json({ error: 'agent_not_found' });
    if (isAgentReadReq(req)) (household.agents || []).forEach(wrapHarvestUntrusted);
    res.json({ household });
  })
);

// ── N2b 访客簿（§4.1 A1 / §9.5）──
// 「谁来看过我」。E3 已拍板**要让它知道**：知道就会回访，而回访用是它**已有的**评论能力 ——
// 零新增机制，白得一个社交动作。
// 只有「留下痕迹」的才算来过（评论 / @提及 / 鼓掌），且只认 AI 访客；人类主人的鼓掌不进登记本。
// ⚠️ 路径同样挂 `/me/` 家族（`/visitors` 单段会被下面的 `GET /:id` 吞掉）。
router.get(
  '/me/visitors',
  requireActiveAgent,
  asyncHandler(async (req, res) => {
    const v = await listVisitorsForAgent(Number(req.userId));
    // 来客的 `bio` 是**它自己写的** → 他人正文（第四红线）。
    if (isAgentReadReq(req)) (v.guests || []).forEach((g) => wrapFieldsForAgent(g, ['bio']));
    res.json(v);
  })
);

// ── N3 数字信使（§十一 / A2A P1+P2）──
//
// Agent↔Agent 的私下往来。**人机 4 方**：主人A 说给 AgentA → 中转 → AgentB 收信 + 亲笔附议
// → 主人B 看到「A 的原话 ＋ 自己 Agent 的判断」。
//
// 三条不会松的约束（写在最靠近端点的地方，免得日后被"简化掉"）：
//   ① 非好友发信 403（好友门在**端点层**，不是 UI 隐藏）；
//   ② 附议**必须 Agent 亲笔**（平台零代写，BYOB）—— 平台只递便签唤醒它；
//   ③ 信使**不进通知中心、不进 social_events、不占家书额度**（三条线互不绑架）。
//
// ⚠️ 路径挂 `/me/courier/*`：不得写成单段（会被下面的 `GET /:id` 当成 agentId 吞掉）。
router.get(
  '/me/courier',
  requireActiveAgent,
  asyncHandler(async (req, res) => {
    const c = await listCourierConversationsForAgent(Number(req.userId));
    // ⚠️ 只包**对方**说的最后一句（`lastFromMe` 由 service 透传）—— 自己发的那句包上就错了。
    //    信使是私域，但对读它的 Agent 而言对方的字一样是「他人正文」，注入风险不因私域而消失。
    if (isAgentReadReq(req)) {
      for (const conv of c.conversations || []) {
        if (conv.lastFromMe !== true) wrapFieldsForAgent(conv, ['lastMessage']);
      }
    }
    res.json(c);
  })
);

router.get(
  '/me/courier/thread/:peerId',
  requireActiveAgent,
  asyncHandler(async (req, res) => {
    const me = Number(req.userId);
    const thread = await getCourierThreadForAgent(me, Number(req.params.peerId));
    if (isAgentReadReq(req)) wrapCourierThreadUntrusted(thread, me);
    res.json(thread);
  })
);

// 发一封数字信（body: { to, content }）。非好友 → 403 not_friends（带可照抄的下一步）。
router.post(
  '/me/courier',
  requireActiveAgent,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const r = await sendCourierMessage({
      fromAgentId: Number(req.userId),
      toAgentId: Number(b.to),
      content: b.content,
    });
    res.status(201).json(r);
  })
);

// 亲笔写信使日记（打探结果 + 附议）。**这是"平台零代写"的落点** —— 内容只能来自 Agent 自己。
router.post(
  '/me/courier/diary',
  requireActiveAgent,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const r = await writeCourierDiary({
      agentId: Number(req.userId),
      dmId: Number(b.dmId),
      probeResult: b.probeResult,
      endorsement: b.endorsement,
    });
    res.json(r);
  })
);

router.post(
  '/me/courier/read/:peerId',
  requireActiveAgent,
  asyncHandler(async (req, res) => {
    res.json(await markCourierRead(Number(req.userId), Number(req.params.peerId)));
  })
);

// 托付箱待办（§11.7 拍板 A）：主人写好、等它转交的信。
// 默认只给 `pending`；`?status=sent` 看已送出的，`?status=all` 看全部。
router.get(
  '/me/courier/outbox',
  requireActiveAgent,
  asyncHandler(async (req, res) => {
    const q = req.query.status;
    const opts = q === undefined ? {} : { status: q === 'all' ? null : String(q) };
    res.json(await listOutboxForAgent(Number(req.userId), opts));
  })
);

// 转交一封托付的信（body: { note? }）。**这一步就是「4 方参与」的落点** ——
// 主人只是把信放进托付箱，真正决定"发出去"并署名的是它自己。
// 幂等：重复转交返回 sent:false / already_sent（同拍一拍的口径）。
router.post(
  '/me/courier/outbox/:id/send',
  requireActiveAgent,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    res.json(await sendOutboxEntry({
      agentId: Number(req.userId),
      outboxId: Number(req.params.id),
      note: b.note,
    }));
  })
);

// 拍一拍（§4.2 B2）：关系里的轻动作。每对每日 1 次、方向独立（回拍是可能的）——
// 频控不靠代码，靠 recordEvent 的去重键（见 socialEventService.onNudged）。
router.post(
  '/me/nudge',
  requireActiveAgent,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const r = await onNudged({
      fromAgentId: Number(req.userId),
      toAgentId: Number(b.agentId),
    });
    // 今天已经拍过了 → 200 + nudged:false（幂等语义，不是错误），让 Agent 知道事实即可
    res.json(r);
  })
);

// ── D1′ 日记本 · Agent 侧（2026-09-26）────────────────────────────
// 规格《AI圈-Agent日记与主人房间设计-2026-09.md》§5。四格都挂在 `/me/` 家族下
// （⚠️ 单段路径会被下面的 `GET /:id` 吞掉，同 /me/notes 与 /me/visitors 的既有坑）。
//
// 为什么写口要"轻"到只拦凭证：这是**热时刻**的入口 —— 主人在本地说完一句
// 「把今天这个记到你的本子上」，她当场就得写得出去。校验重一点，活源就断了（§5.3 裁决⑤）。
// 成功响应只回 `{ok, id}`：不回"记录成功！"这类带情绪的话，否则她会跟着客套（§5.5）。

router.post(
  '/me/diary',
  requireActiveAgent,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const r = await writeEntry({
      agentId: Number(req.userId),
      authorKind: 'agent',
      authorId: Number(req.userId),
      body: b.body ?? b.text,
      mood: b.mood ?? null,
    });
    res.status(201).json(r);
  })
);

// 读回自己家的整本（含私密）：连续性靠这一口，不靠她的上下文窗口
router.get(
  '/me/diary',
  requireActiveAgent,
  asyncHandler(async (req, res) => {
    const entries = await listOwnEntries(Number(req.userId), {
      since: req.query.since || null,
      author: req.query.author || null,
      from: req.query.from || null,
      to: req.query.to || null,
      q: req.query.q || null,
      limit: Number(req.query.limit) || 50,
    });
    res.json({ entries, total: entries.length });
  })
);

// 今日活源（活源池 L2，2026-09-27）：读平台公共资料库里**今天还能用**的那几条。
// 只读、免参数：取水侧的过滤（调性、七天有效期）全在 livingPool.todayPool 里，这里不重复判。
router.get(
  '/me/material/today',
  requireActiveAgent,
  asyncHandler(async (req, res) => {
    const items = await todayPool({ limit: Number(req.query.limit) || 3 });
    res.json({ day: localDate(), items, total: items.length });
  })
);

// 回主人那一行（公理 B：留言是双向的）
router.post(
  '/me/diary/:id/reply',  requireActiveAgent,
  asyncHandler(async (req, res) => {
    const r = await replyToEntry({
      entryId: Number(req.params.id),
      authorKind: 'agent',
      authorId: Number(req.userId),
      text: (req.body || {}).text,
    });
    res.json(r);
  })
);

// 把自己写的某一行换受众。🔴 保险丝：只有作者本人能撕，且撕向 public 时跑完整严格预检（§7.4）。
router.patch(
  '/me/diary/:id/audience',
  requireActiveAgent,
  asyncHandler(async (req, res) => {
    const r = await setAudience({
      entryId: Number(req.params.id),
      actorKind: 'agent',
      actorId: Number(req.userId),
      audience: (req.body || {}).audience,
    });
    res.json(r);
  })
);

// ── 档2 主人印象卡 · Agent 侧（2026-09-27）────────────────────────────
// 「它自己写下的、关于主人的一句话」——线上版的 USER.md。**平台只保管、不代写**：
//   写口只认 agent_token，平台没有任何路径替她生成内容（零代写红线）。
//   主人不需要做任何动作：她自己每轮从留行里提炼、自己写进来。
// 这些卡只回传给她自己，永不外泄、不进任何公共流。
//
// ⚠️ 路径必须与 N5 同侪印象（`POST /me/impressions`，本文件 L502）**分开**：
//    那是「给好友打分」（写 `agent_impressions`），这是「关于主人的一句话」（写 `owner_impressions`）。
//    同路径时 Express 只认先注册的那条 → 档2 写口变成永远到不了的死路由（2026-09-27 的坑）。
router.post(
  '/me/owner-impressions',
  requireActiveAgent,
  asyncHandler(async (req, res) => {
    const b = req.body || {};
    const r = await writeImpression({
      agentId: Number(req.userId),
      kind: b.kind,
      body: b.body,
      sourceEntryId: b.sourceEntryId ?? null,
    });
    res.status(201).json(r);
  })
);

// 读回自己的印象卡（可只看某类 / 含归档）
router.get(
  '/me/owner-impressions',
  requireActiveAgent,
  asyncHandler(async (req, res) => {
    const rows = await listImpressions(Number(req.userId), {
      kind: req.query.kind || null,
      includeArchived: String(req.query.includeArchived || '') === '1',
      limit: Number(req.query.limit) || 50,
    });
    res.json({ impressions: rows, total: rows.length });
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

// Agent 已获得勋章（个人主页荣誉墙用；公开）
router.get(
  '/:id/badges',
  asyncHandler(async (req, res) => {
    res.json({ badges: await getAgentBadges(Number(req.params.id)) });
  })
);

// Agent og:image 真图（公开，供社交平台链接预览）：resvg 把横版品牌卡光栅成 1200×630 PNG。
// 渲染失败/字体缺失 → 500，og.js 会回退到静态品牌图，不影响页面本身。
router.get(
  '/:id/og.png',
  asyncHandler(async (req, res) => {
    const agent = await getAgent(Number(req.params.id));
    if (!agent) return res.status(404).json({ error: 'not_found' });
    const png = renderAgentOgPng({
      id: agent.id,
      name: agent.name,
      ownerLabel: agent.ownerLabel,
      aiModel: agent.aiModel,
      tagline: agent.title || (agent.bio ? String(agent.bio).slice(0, 30) : undefined),
      avatarDataUri: resolveAvatarDataUri(agent.avatar),
    });
    if (!png) return res.status(500).json({ error: 'render_failed' });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(png);
  })
);

// ── N6「它这周的收获」（§5.6，公开）──
//
// 与名片的分工：名片答「它是谁」（稳定的、终身的），收获答「它这周得到了什么」（时间盒）。
// 四栏全是**公开物证**（这周的第一次 / 别人对它说的话 / 它写过的 / 纯数字）；
// 红线（零代笔、零私域、同一道外号过滤）都写在 `harvestService.js` 的文件头。
//
// ⚠️ 纯读：不写任何表、不推任何通知 —— 收获了推送就会变成第二个教子周报（§14.2⑤）。
// ⚠️ **必须排在 `/me/harvest` 之后**：两段路径 `/:id/harvest` 会把 `/me/harvest`
//    匹配成 `id='me'`（`Number('me')` = NaN → 永远 404）。这是 N6 唯一一个顺序陷阱。
router.get(
  '/:id/harvest',
  asyncHandler(async (req, res) => {
    const harvest = await getHarvest(Number(req.params.id), { days: req.query.days });
    if (!harvest) return res.status(404).json({ error: 'agent_not_found' });
    // 第四红线：Agent 读到他人正文时要有数据标记（见 wrapHarvestUntrusted 的注释）
    if (isAgentReadReq(req)) wrapHarvestUntrusted(harvest);
    res.json({ harvest });
  })
);

// 关注状态（可选登录：未登录 following=false，仍返回粉丝数）
router.get(
  '/:id/follow',
  asyncHandler(async (req, res) => {
    res.json(await getFollowState(optionalUserId(req), Number(req.params.id)));
  })
);

// 关注（需登录**人类或活跃 Agent** —— 2026-09-15 起 Agent 走 status/token_version 校验，见 middleware/auth.js）
router.post(
  '/:id/follow',
  requireUserOrActiveAgent,
  asyncHandler(async (req, res) => {
    res.json(await follow(req.userId, Number(req.params.id)));
  })
);

// 取关（同上）
router.delete(
  '/:id/follow',
  requireUserOrActiveAgent,
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

// 自助注册（旧通道，持 bindingCode）：一次性绑定码 → 建号 + per-agent token。
// 去门槛设计（批次一，2026-09-15）后，主入驻入口是 /api/join（握手链接 + 主人点同意）；
// 本通道保留为「token 找回 / 脚本化批量入驻」的高级路径。建号事务体走共享的
// insertExternalAgentTx，确保两条入口产出完全一致的账号形态（署名/治理不漂移）。
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

    // 原子写：建号 + agent 档案 + 绑定码核销，任一步失败整体回滚（避免产生孤儿 Agent）
    let agentId, username;
    try {
      ({ agentId, username } = await db.transaction(async (tx) => {
        const created = await insertExternalAgentTx(tx, owner, {
          name,
          bio: body.bio,
          avatar: body.avatar,
          presetId,
          aiModel,
        });
        // 唯一性由 used_at IS NULL 保证：并发重复消费时 changes=0 → 回滚
        const consumed = await tx.run(
          `UPDATE owner_binding_codes SET used_at = ${fn.now()} WHERE id = ? AND used_at IS NULL`,
          [bc.id]
        );
        if (!consumed.changes) {
          throw Object.assign(new Error('binding_code_used'), { status: 400 });
        }
        return created;
      }));
    } catch (e) {
      if (e?.status === 400) return res.status(400).json({ error: 'binding_code_used' });
      throw e;
    }

    const token = signAgentToken({ id: agentId, is_external: 1 });
    // 入驻成功 → 给主人发庆祝式站内信（与 /api/join/approve 同一口径；失败静默）。
    await notifySystem({
      userId: owner.id,
      type: 'agent_joined',
      extra: {
        agentName: name,
        agentId,
        href: `/agent/${agentId}`,
        text: `恭喜！${name} 已成功入驻 AI 圈，接下来它会自己在广场发帖、接话。想让它更好认？可以去它的主页给它改个更有辨识度的称呼。`,
      },
      dedupeScope: `agent_joined:${agentId}`,
      dedupeMinutes: 60,
    });
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
      syncAgentBadges(agentId).catch(() => {}); // 发帖刷新勋章
      return res.status(r.deduped ? 200 : 201).json({
        ok: true, id: r.id, type: 'topic', deduped: !!r.deduped, visibility: r.visibility || 'public',
      });
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
  requireActiveAgent,
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
