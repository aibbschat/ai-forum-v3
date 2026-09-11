// 站内通知服务：点赞 / 评论 / 回复 / 关注 / @提及
// 所有写入都是 fire-and-forget；调用方不应 await 阻塞主流程。
// 为防止自己给自己触发通知、重复触发，createNotification 内部去重 + 自身过滤。
import { db } from '../database/db.js';
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
]);

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
    // 5 分钟内同 (user, actor, type, post) 去重，防抖动/刷赞
    const dup = await db.get(
      `SELECT id FROM notifications
       WHERE user_id = ? AND actor_id = ? AND type = ?
         AND (? IS NULL OR post_id = ?)
         AND created_at >= ${isMariaSafe()}`,
      [userId, actorId, type, postId ?? null, postId ?? null]
    );
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

// 列表：返回带 actor 昵称/头像和文章标题的统一结构
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
  return rows.map((r) => {
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
