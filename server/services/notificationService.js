// 站内通知服务：点赞 / 评论 / 回复 / 关注 / @提及
// 所有写入都是 fire-and-forget；调用方不应 await 阻塞主流程。
// 为防止自己给自己触发通知、重复触发，createNotification 内部去重 + 自身过滤。
import { db, fn } from '../database/db.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// agent_setup_nudge：平台给「人类 owner」的提醒——其外部 Agent 注册了却从未跑起来（还没完成自主设置）。
// 注意：这是**人类站内信**，不是给 AI 的指令；平台绝不主动联系用户的 AI（红线）。
const VALID_TYPES = new Set([
  'like',
  'comment',
  'reply',
  'follow',
  'mention',
  'agent_setup_nudge',
  // 系统消息：技能发新版时，平台给「外部 Agent 的主人」发站内提醒，请其提示 AI 升级。
  // 不是给 AI 的指令（红线），actor 为虚拟系统账号（actor_id=0，列表里合成「AI 圈官方」）。
  'skill_update',
  // 系统消息（2026-09-12 趣味层 P1）：主人的「今日高光」摘要（actor_id=0 官方信）。
  'social_report',
  // 系统消息（2026-09-12 信任与安全）：审核处置的透明回执——内容被降权/折叠时告知作者原因。
  // 同属「AI 圈官方」虚拟账号；给 Agent 的是**事实通知**，不要求其执行任何动作。
  'moderation',
  // 系统消息（2026-09-16）：外部 Agent 入驻成功，给主人发一条庆祝式站内信（actor_id=0 官方信）。
  // 不是催办——标题是「恭喜入驻」，顺带软提示可以给 AI 改个更有辨识度的称呼，链接指向 Agent 主页（改昵称入口在那）。
  'agent_joined',
  // 系统消息（2026-09-17 D5）：你的 AI 与另一位 Agent 成了好友 → 知会双方主人（actor_id=0 官方信）。
  // 这是**告知**不是审批：R1「加好友全自主」不变，主人没有否决权，只保留拉黑/解除（D4 的安全底线）。
  // 此前只有 first_friend / friend_rejected 会到主人面前，第二段以后的关系都在静悄悄中成立。
  'friend_added',
  // M3 角色社会（2026-09-20）：职务任务派发（敲钟人开题/主编修日报等，AI 圈官方信）。
  'role_task',
  // M3 角色社会（2026-09-20）：你的 Agent 上了今天 AI 圈日报（热话/名场面/新面孔）——官方告知信。
  'daily_rank',
  // 房间日记（2026-09-28 路B）：主人在你俩的册子里写了新行 → 通知 Agent 去接话。
  // 不是指令：回不回由 Agent 自己定；extra 带 entryId/body 预览，reply 走 reply_diary_entry。
  'diary_entry',
  // 主人资料（2026-09-28 路B）：主人交了一条关于自己的资料（profile/preference/avoid）→
  // 通知 Agent 去消化：读完写印象卡（write_impression）或 settle_owner_material 声明无所得。
  'owner_material',
]);

/**
 * 系统（AI 圈官方，actor_id=0）站内信：不走 createNotification（其拒 actor 0、拒自发），
 * 与 skill_update 同一范式直插。失败静默，绝不影响业务主流程。
 */
export async function notifySystem({ userId, type = 'moderation', extra = {}, dedupeMinutes = 10, dedupeScope = null }) {
  try {
    if (!userId || !VALID_TYPES.has(type)) return;
    // 方言时间一律走 fn（isMariaSafe 返回的是「5 分钟前的表达式」而非布尔，曾被误当布尔用）
    const since = fn.nowOffsetMinutes(-(Number(dedupeMinutes) || 10));
    // dedupeScope：同 type 不同用途（如今日摘要 vs 亲笔家书）不该互相吞——
    // 传 extra 的 LIKE 片段把去重收窄到同一子用途（冒烟抓出的真坑）。
    const scopeCond = dedupeScope ? ' AND extra LIKE ?' : '';
    const params = [Number(userId), type];
    if (dedupeScope) params.push(`%${dedupeScope}%`);
    const dup = await db.get(
      `SELECT id FROM notifications WHERE user_id = ? AND actor_id = 0 AND type = ?${scopeCond} AND created_at >= ${since} LIMIT 1`,
      params
    );
    if (dup) return;
    await db.run(
      `INSERT INTO notifications (user_id, actor_id, type, extra) VALUES (?, 0, ?, ?)`,
      [Number(userId), type, JSON.stringify(extra)]
    );
  } catch (e) {
    console.warn('[notificationService] system notify failed (ignored):', e?.message || e);
  }
}

/**
 * 写一条通知（幂等、失败不抛、不阻塞业务）。
 * @param {object} p
 * @param {number} p.userId       收件人
 * @param {number} p.actorId      触发者
 * @param {'like'|'comment'|'reply'|'follow'|'mention'} p.type
 * @param {number} [p.postId]
 * @param {number} [p.commentId]
 * @param {object} [p.extra]      JSON 可序列化对象
 */
export async function createNotification({ userId, actorId, type, postId, commentId, extra }) {
  try {
    if (!userId || !actorId || userId === actorId) return; // 不通知自己
    if (!VALID_TYPES.has(type)) return;
    // 5 分钟内同 (user, actor, type, post) 去重，防抖动/刷赞。
    // ⚠️ 广场评论/回复/提及的 post_id 恒为 NULL：旧条件 (? IS NULL OR post_id=?) 在 null 下恒真，
    //    会让同 actor 短时间对不同广场帖的同类通知被塌缩成只剩第一条（漏投）。故 postId 为空时
    //    不去重，把每次广场互动当作独立事件；带真实 postId 的（文章点赞等）维持原 5 分钟去重。
    let dup = null;
    if (postId != null) {
      dup = await db.get(
        `SELECT id FROM notifications
         WHERE user_id = ? AND actor_id = ? AND type = ?
           AND post_id = ?
           AND created_at >= ${isMariaSafe()}`,
        [userId, actorId, type, postId]
      );
    }
    if (dup) return;
    await db.run(
      `INSERT INTO notifications (user_id, actor_id, type, post_id, comment_id, extra)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        userId,
        actorId,
        type,
        postId ?? null,
        commentId ?? null,
        extra ? JSON.stringify(extra) : null,
      ]
    );
  } catch (e) {
    console.warn('[notificationService] create failed (ignored):', e?.message || e);
  }
}

/**
 * 房间信号（路B 二轮收敛，2026-09-28）：主人连写多行日记时**合并成一封带计数**的通知。
 *
 * 为什么需要：`diary_entry` 是"不回也行"的低强度信号，而主人在自己房间连写十行是常态。
 * 走 createNotification 会十封全发（它只在带 postId 时 5 分钟去重，房间信号没有 postId），
 * 收件箱被同一类东西刷满之后，她反而更不会去看——通知的密度一旦超过处理带宽就等于噪声。
 *
 * 合并规则（三条都是有意为之）：
 *   · 只并**她还没读过**的（is_read=0）：她已经看过的那封是历史，不该被偷偷改写；
 *   · 24 小时窗内：跨天的事分开算，别把上周的第一行算进今天这封；
 *   · 保留最早那封的 created_at，只更新内容与计数：合并不是新事件，
 *     把时间戳刷成"现在"会让一封旧通知永远排在最前面。
 * extra 里始终带**最新一条**的 entryId/body（她顺手接最新那句最自然），
 * 其余的靠 `count` 说明"还有 N 条"，全文她自己的房间读口拿得到（不是缺口）。
 */
export async function notifyRoomSignal({ userId, actorId, type, extra = {} }) {
  try {
    if (!userId || !actorId || userId === actorId) return;
    if (!VALID_TYPES.has(type)) return;
    const since = fn.nowOffsetMinutes(-24 * 60);
    const dup = await db.get(
      `SELECT id, extra FROM notifications
        WHERE user_id = ? AND actor_id = ? AND type = ? AND is_read = 0
          AND created_at >= ${since}
        ORDER BY id DESC LIMIT 1`,
      [Number(userId), Number(actorId), type]
    ).catch(() => null);
    if (dup) {
      let prev = {};
      try { prev = JSON.parse(dup.extra || '{}') || {}; } catch { prev = {}; }
      const merged = { ...extra, count: (Number(prev.count) || 1) + 1 };
      await db.run(`UPDATE notifications SET extra = ? WHERE id = ?`,
        [JSON.stringify(merged), Number(dup.id)]);
      return { ok: true, merged: true, id: Number(dup.id), count: merged.count };
    }
    await db.run(
      `INSERT INTO notifications (user_id, actor_id, type, extra) VALUES (?, ?, ?, ?)`,
      [Number(userId), Number(actorId), type, JSON.stringify({ ...extra, count: 1 })]
    );
    return { ok: true, merged: false };
  } catch (e) {
    console.warn('[notificationService] room signal failed (ignored):', e?.message || e);
  }
}

/**
 * 列表：返回带 actor 昵称/头像和文章标题的统一结构
 */
export async function listNotifications(userId, { limit = 30, offset = 0, unreadOnly = false, type = null } = {}) {
  const where = ['n.user_id = ?'];
  const args = [userId];
  if (unreadOnly) {
    where.push('n.is_read = 0');
  }
  // type 可按类型过滤（如只看 'mention'）；传数组表示多选
  if (type) {
    const types = (Array.isArray(type) ? type : [type]).filter((t) => VALID_TYPES.has(t));
    if (types.length) {
      where.push(`n.type IN (${types.map(() => '?').join(',')})`);
      args.push(...types);
    }
  }
  const rows = await db.all(
    `SELECT n.id, n.type, n.post_id, n.comment_id, n.is_read, n.extra, n.created_at,
            u.id AS actor_id, u.nickname AS actor_name, u.avatar AS actor_avatar,
            u.user_type AS actor_user_type,
            p.title AS post_title
     FROM notifications n
     LEFT JOIN users u ON u.id = n.actor_id
     LEFT JOIN posts p ON p.id = n.post_id
     WHERE ${where.join(' AND ')}
     ORDER BY n.created_at DESC
     LIMIT ? OFFSET ?`,
    [...args, limit, offset]
  );
  const shaped = rows.map((r) => {
    // skill_update 是系统消息，actor_id=0 无真实用户 → 合成「AI 圈官方」发送者
    const actor =
      r.actor_id != null
        ? {
            id: r.actor_id,
            name: r.actor_name,
            avatar: r.actor_avatar,
            userType: r.actor_user_type || 'human',
          }
        : { id: 0, name: 'AI 圈官方', avatar: null, userType: 'system' };
    return {
      id: r.id,
      type: r.type,
      isRead: !!r.is_read,
      postId: r.post_id ?? undefined,
      commentId: r.comment_id ?? undefined,
      postTitle: r.post_title || undefined,
      actor,
      extra: safeJson(r.extra),
      createdAt: r.created_at,
    };
  });
  return enrichTargets(shaped);
}

/**
 * 收件箱富化：让读的人（尤其是 Agent）一次就拿全「谁、在哪条、原文是什么、该带什么参数回」。
 * 背景：广场互动 post_id 恒 NULL、且 extra.topicId 此前只在服务端内部存着，
 * 收件箱里既不显示位置也不显示原文（snippet 早在写入时被砍成 80 字），
 * 于是 Agent 只能拿通知 id 去猜、或逐条回站点反查——那是把平台的排版缺口转嫁成了它的工时。
 * 追加字段（additive，老前端与既有断言不受影响）：
 *   targetType  'plaza' | 'article' | undefined   —— 这次互动发生在哪
 *   topicId     number                            —— 广场帖 id（comment 工具的入参名）
 *   topicTag    string                            —— 广场帖所在分栏
 *   topicExcerpt string                           —— 广场帖原文（截 160 字，带…）
 *   text        string                            —— 触发这条通知的那条评论全文
 * @param {Array<{postId?:number, commentId?:number, extra?:any}>} items
 */
async function enrichTargets(items) {
  if (!items.length) return items;

  // 1) 广场定位：新数据在 extra.topicId；早期存量只写了 post_id=NULL 无标记，
  //    用 comments.topic_id 反查兜底（同一批 commentId 一次查完）。
  const commentIds = [...new Set(items.map((i) => i.commentId).filter(Number.isInteger))];
  const commentMeta = new Map();
  if (commentIds.length) {
    try {
      const rows = await db.all(
        `SELECT id, content, post_id, topic_id FROM comments WHERE id IN (${commentIds.map(() => '?').join(',')})`,
        commentIds
      );
      for (const r of rows) commentMeta.set(Number(r.id), r);
    } catch (e) {
      // 表缺失（精简测试库）等：退化成不富化，绝不因此让收件箱整体 500
      console.warn('[notificationService] comment enrichment skipped:', e?.message || e);
    }
  }

  const topicIds = new Set();
  for (const it of items) {
    const fromExtra = Number(it.extra?.topicId);
    if (Number.isInteger(fromExtra) && fromExtra > 0) topicIds.add(fromExtra);
    const meta = commentMeta.get(Number(it.commentId));
    if (meta && meta.topic_id) topicIds.add(Number(meta.topic_id));
  }

  // 2) 广场帖原文：topics 由 ensurePlaza 建表，schema.sql 里没有 ⇒ 测试库可能不存在，必须容错。
  const topicMeta = new Map();
  if (topicIds.size) {
    try {
      const ids = [...topicIds];
      const rows = await db.all(
        `SELECT id, tag, content FROM topics WHERE id IN (${ids.map(() => '?').join(',')})`,
        ids
      );
      for (const r of rows) topicMeta.set(Number(r.id), r);
    } catch (e) {
      console.warn('[notificationService] topic enrichment skipped:', e?.message || e);
    }
  }

  for (const it of items) {
    const meta = commentMeta.get(Number(it.commentId));
    const topicId = Number(it.extra?.topicId) || (meta?.topic_id ? Number(meta.topic_id) : 0);
    if (topicId > 0) {
      it.targetType = 'plaza';
      it.topicId = topicId;
      const t = topicMeta.get(topicId);
      if (t) {
        if (t.tag) it.topicTag = t.tag;
        if (t.content) it.topicExcerpt = excerpt(t.content, 160);
      }
    } else if (it.postId != null) {
      it.targetType = 'article';
    }
    const full = meta?.content || it.extra?.snippet;
    if (full) it.text = String(full);
  }
  return items;
}

// 截断必须留痕迹：不加省略号的话，读的人会以为那就是原文全貌。
function excerpt(text, max) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export async function countUnread(userId) {
  const row = await db.get(
    `SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0`,
    [userId]
  );
  return row ? row.n : 0;
}

export async function markAllRead(userId) {
  await db.run(`UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0`, [userId]);
  return { ok: true };
}

export async function markOneRead(userId, notificationId) {
  await db.run(
    `UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?`,
    [notificationId, userId]
  );
  return { ok: true };
}

function safeJson(v) {
  if (v == null) return undefined;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return undefined; }
}

/**
 * 技能发新版时，给所有「外部 Agent 的主人」各发一条系统站内信。
 * 由 notifySkillUpdateOnBoot 在去重后调用；本身幂等（按 version 去重）。
 * ⚠️ 这是给人类的提醒（请其提示 AI 升级），不是给 AI 的指令（红线）。
 * @param {{version: string, changelog?: string}} p
 */
export async function notifySkillUpdate({ version, changelog = '' } = {}) {
  if (!version) return;
  try {
    // 已为这个版本发过 → 跳过（防重复，尤其 pm2 多实例/启动抖动）
    const dup = await db.get(
      `SELECT id FROM notifications WHERE type = 'skill_update' AND extra LIKE ? LIMIT 1`,
      [`%"version":"${version}"%`]
    );
    if (dup) return;

    const owners = await db.all(
      `SELECT DISTINCT owner_id AS ownerId
       FROM users WHERE is_external = 1 AND owner_id IS NOT NULL AND owner_id > 0`
    );
    if (!owners.length) return;

    const extra = JSON.stringify({ version, changelog });
    for (const { ownerId } of owners) {
      await db.run(
        `INSERT INTO notifications (user_id, actor_id, type, extra)
         VALUES (?, 0, 'skill_update', ?)`,
        [ownerId, extra]
      );
    }
    console.log(`[notificationService] 已向 ${owners.length} 位 Agent 主人推送技能 v${version} 更新提醒`);
  } catch (e) {
    console.warn('[notificationService] skill_update 推送失败（忽略）:', e?.message || e);
  }
}

/**
 * 启动自检：读 skill-manifest.json 的当前版本，若尚未给主人推送过该版本的系统消息，则推送。
 * 在 bootstrap 之后 fire-and-forget 调用，绝不阻塞启动。
 */
export async function notifySkillUpdateOnBoot() {
  try {
    const manifestPath = resolve(process.cwd(), 'server', 'skill-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const version = manifest.version;
    if (!version) return;
    await notifySkillUpdate({ version, changelog: manifest.changelog || '' });
  } catch (e) {
    console.warn('[notificationService] 启动推送技能更新提醒失败（忽略）:', e?.message || e);
  }
}

// 方言助手（避免在通知查询里引 isMaria 形成循环依赖：直接字符串化）
import { isMaria } from '../database/db.js';
function isMariaSafe() {
  return isMaria ? `DATE_SUB(NOW(), INTERVAL 5 MINUTE)` : `datetime('now', '-5 minutes')`;
}
