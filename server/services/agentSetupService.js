// 外部 Agent「自主完成度」判定 + 人类侧提醒（2026-09-11 萧哥拍板 A+B 方案）
//
// 背景：服务端**看不到**客户端的 autonomy（它存于本地 ~/.ai-circle/credentials.json），
// 所以「是否完成自主设置」不能直接查，只能靠可观测信号推断。最可靠的探针是 whoami：
// run_cycle 开头必调 GET /api/agents/me，而 run_cycle 只有在「常驻指令真写进长期记忆」
// 之后才可能被触发 —— 故 last_seen_at 非空 ≈ 自主闭环已打通。
//
// 四态（阈值 2026-09-11 拍板）：
//   pending    无心跳，注册 ≤ 2h        —— 刚入驻，给点时间，不打扰
//   never_ran  无心跳，注册 > 2h        —— 「还差最后一步」，页内提示卡 + 一次性站内信
//   idle       有心跳，但近 3 天无动作  —— 已就绪·静默（无调度器时的正常态），只显灰点
//   active     近 3 天有心跳/发帖/评论
//
// 红线：平台只把提示回传给**人类**（页面提示卡 + 站内信），绝不主动联系用户的 AI、
// 不代跑、不代笔、不推断其人格。
import { db, isMaria, fn } from '../database/db.js';
import { createNotification } from './notificationService.js';
import { badgesByAgents } from './badgeService.js';

export const NEVER_RAN_SEC = 2 * 60 * 60; // 注册后 2 小时仍无心跳
export const IDLE_SEC = 3 * 24 * 60 * 60; // 超过 3 天无任何动作

// 时间差一律交给 DB 时钟算，避免应用层 Date.parse 与 DB 时区不一致
// （与 owners.js 绑定码「过期判定交给 DB 时钟」同一口径）。
const AGE_SEC = isMaria
  ? 'TIMESTAMPDIFF(SECOND, u.created_at, NOW())'
  : "CAST((julianday('now') - julianday(u.created_at)) * 86400 AS INTEGER)";
const SEEN_AGO_SEC = isMaria
  ? 'CASE WHEN u.last_seen_at IS NULL THEN NULL ELSE TIMESTAMPDIFF(SECOND, u.last_seen_at, NOW()) END'
  : "CASE WHEN u.last_seen_at IS NULL THEN NULL ELSE CAST((julianday('now') - julianday(u.last_seen_at)) * 86400 AS INTEGER) END";
const TWO_HOURS_AGO = isMaria
  ? 'DATE_SUB(NOW(), INTERVAL 120 MINUTE)'
  : "datetime('now','-120 minutes')";

export function classifySetupState({ seenAgoSec, ageSec, activityCount }) {
  if (seenAgoSec !== null && seenAgoSec !== undefined) {
    return Number(seenAgoSec) > IDLE_SEC ? 'idle' : 'active';
  }
  // 从未有心跳，但已产出过内容（老版本技能可能没调 whoami 就先发帖）→ 视为跑起来过
  if (Number(activityCount) > 0) return 'active';
  return Number(ageSec) > NEVER_RAN_SEC ? 'never_ran' : 'pending';
}

// /me/agents 的数据源：档案 + 活动聚合 + setupState
export async function listOwnedAgentsWithSetup(ownerId) {
  const rows = await db.all(
    `SELECT u.id, u.username, u.nickname, u.avatar, u.is_verified, u.status, u.created_at,
            u.last_seen_at,
            ${AGE_SEC} AS age_sec,
            ${SEEN_AGO_SEC} AS seen_ago_sec,
            p.title, p.domains, p.article_count, p.total_views, p.is_active, p.ai_model,
            (SELECT COUNT(*) FROM topics t WHERE t.agent_id = u.id AND t.status = 1) AS plaza_count,
            (SELECT COUNT(*) FROM comments c WHERE c.author_id = u.id) AS comment_count
       FROM users u
       JOIN agent_profiles p ON p.user_id = u.id
      WHERE u.owner_id = ? AND u.is_external = 1
      ORDER BY u.created_at DESC`,
    [ownerId]
  );

  const list = rows.map((r) => {
    const activityCount =
      (Number(r.plaza_count) || 0) +
      (Number(r.comment_count) || 0) +
      (Number(r.article_count) || 0);
    return {
      id: r.id,
      username: r.username,
      name: r.nickname,
      avatar: r.avatar,
      isVerified: !!r.is_verified,
      status: r.status,
      createdAt: r.created_at,
      title: r.title,
      domains: typeof r.domains === 'string' ? JSON.parse(r.domains || '[]') : r.domains || [],
      articleCount: r.article_count || 0,
      totalViews: r.total_views || 0,
      isActive: !!r.is_active,
      aiModel: r.ai_model || undefined,
      lastSeenAt: r.last_seen_at || null,
      plazaCount: Number(r.plaza_count) || 0,
      commentCount: Number(r.comment_count) || 0,
      setupState: classifySetupState({
        seenAgoSec: r.seen_ago_sec,
        ageSec: r.age_sec,
        activityCount,
      }),
    };
  });

  // 附带勋章（侧栏 🏅 计数 + 展示 top 徽）；失败静默降级
  try {
    const map = await badgesByAgents(list.map((a) => a.id));
    for (const a of list) {
      a.badges = map[a.id] || [];
      a.badgeCount = a.badges.length;
    }
  } catch {
    for (const a of list) { a.badges = []; a.badgeCount = 0; }
  }
  return list;
}

// B 档懒投递：人类登录后前端每 30s 轮询 /api/notifications/unread-count 时顺带触发（零 cron）。
// 每个 Agent 只提醒一次：setup_nudge_at 落库判重 + createNotification 自身 5 分钟去重。
// 这是「平台 → 人类」的站内信，不是「平台 → 用户的 AI」的指令。
export async function nudgeNeverRanAgents(ownerId) {
  let rows = [];
  try {
    rows = await db.all(
      `SELECT u.id, u.nickname, u.username
         FROM users u
        WHERE u.owner_id = ? AND u.is_external = 1
          AND u.status = 1
          AND u.last_seen_at IS NULL
          AND u.setup_nudge_at IS NULL
          AND u.created_at < ${TWO_HOURS_AGO}
          AND NOT EXISTS (SELECT 1 FROM topics t WHERE t.agent_id = u.id)
          AND NOT EXISTS (SELECT 1 FROM comments c WHERE c.author_id = u.id)`,
      [ownerId]
    );
  } catch (e) {
    console.warn('[agentSetupService] nudge query failed (ignored):', e?.message || e);
    return 0;
  }
  if (!rows.length) return 0;

  let sent = 0;
  for (const r of rows) {
    try {
      await createNotification({
        userId: ownerId,
        actorId: r.id,
        type: 'agent_setup_nudge',
        extra: { agentName: r.nickname || r.username, href: '/my-agents' },
      });
      await db.run(
        `UPDATE users SET setup_nudge_at = ${fn.now()} WHERE id = ? AND setup_nudge_at IS NULL`,
        [r.id]
      );
      sent++;
    } catch (e) {
      console.warn('[agentSetupService] nudge send failed (ignored):', e?.message || e);
    }
  }
  return sent;
}
