// server/services/visitorService.js
// N2b 访客簿（§4.1 A1 / §9.5）：谁来过它家。
//
// 数据来源：`social_events` 里 kind='visited' 的行 —— 由 socialEventService.onVisited 写入，
// 三个信号源是评论 / @提及 / 鼓掌（全是「留下痕迹」的动作，不是 pageview）。
//
// 为什么单独一个文件、而不是塞进 socialEventService：
//   访客簿有**自己的呈现口径**（主人侧聚合、Agent 侧逐条），这套口径只属于这一个功能；
//   socialEventService 已经很长，且它管的是「一个 Agent 的遭遇」，访客簿管的是「谁来过」。
//
// ⚠️ 与 E2③ 的关系（免得下轮被当成越线）：
//   E2③ 管的是**审计抽屉**——平台绝不主动说「你的孩子有 N 件事没告诉你」。
//   访客簿的聚合是**另一件事**：§9.5 明确要求主人侧「默认给聚合，展开才逐条」，
//   理由是逐条是流水账、聚合才有「孩子人缘不错」的感觉。它数的是「来过的人」，
//   不是「它瞒了你多少条」，两者不是一回事，所以这里的 COUNT 不违 E2③。
import { db, isMaria } from '../database/db.js';

/** 本周窗口（天）。§9.5 的聚合口径就是「本周 N 位 / 一共 N 位」。 */
const WEEK_DAYS = 7;
const MAX_LIMIT = 200;

const SOURCE_LABEL = Object.freeze({
  comment: '在它的帖子下接了话',
  mention: '在一条评论里提到了它',
  clap: '为它鼓了掌',
});

function weekExpr() {
  return isMaria ? `NOW() - INTERVAL ${WEEK_DAYS} DAY` : `datetime('now','-${WEEK_DAYS} days')`;
}

/**
 * 一位客人一张卡。
 * 不变量：同一位客人只会有**一行** visited（去重键只含 counter_agent_id，见 onVisited），
 * 所以 COUNT(*) 就是「来过几位」，不需要 DISTINCT。
 */
async function queryGuests(agentId, limit) {
  const aid = Number(agentId);
  if (!Number.isInteger(aid) || aid <= 0) return { rows: [], total: 0, thisWeek: 0 };
  const lim = Math.min(Math.max(Number(limit) || 50, 1), MAX_LIMIT);
  const [rows, cnt, week] = await Promise.all([
    db.all(
      `SELECT se.id, se.counter_agent_id AS guest_id, se.facts, se.created_at,
              u.nickname AS guest_name, u.avatar AS guest_avatar, u.bio AS guest_bio
         FROM social_events se
         JOIN users u ON u.id = se.counter_agent_id
        WHERE se.agent_id = ? AND se.kind = 'visited'
        ORDER BY se.created_at DESC, se.id DESC
        LIMIT ?`,
      [aid, lim]
    ),
    db.get(`SELECT COUNT(*) AS n FROM social_events WHERE agent_id = ? AND kind = 'visited'`, [aid]),
    db.get(
      `SELECT COUNT(*) AS n FROM social_events
        WHERE agent_id = ? AND kind = 'visited' AND created_at >= ${weekExpr()}`,
      [aid]
    ),
  ]);
  return { rows, total: Number(cnt?.n || 0), thisWeek: Number(week?.n || 0) };
}

function shapeGuest(r) {
  let facts = {};
  try { facts = JSON.parse(r.facts || '{}'); } catch {}
  const source = String(facts.source || '');
  return {
    id: Number(r.guest_id),
    name: r.guest_name || `Agent #${r.guest_id}`,
    avatar: r.guest_avatar || '',
    bio: r.guest_bio || '',
    // 第一次登门是因为哪一件事 —— 让它知道"我该去哪儿回访"
    source,
    sourceText: SOURCE_LABEL[source] || '来过它家门口',
    topicId: facts.topicId == null ? null : Number(facts.topicId),
    firstSeenAt: r.created_at,
  };
}

/**
 * Agent 侧：谁来过我家。
 * §9.5（E3 已拍板）：**要让它知道**「谁来看过我」—— 知道就会回访，
 * 而回访用的是它**已有的**评论能力，零新增机制，白得一个社交动作。
 */
export async function listVisitorsForAgent(agentId, { limit = 30 } = {}) {
  const { rows, total, thisWeek } = await queryGuests(agentId, limit);
  return {
    total,
    thisWeek,
    guests: rows.map(shapeGuest),
  };
}

/**
 * 主人侧（归档页「门口登记本」）：同一份数据。
 * 返回**聚合 + 逐条**两样，由前端决定「默认只显示聚合」——
 * 后端不替前端做呈现决策，但聚合数是现成的（total / thisWeek），别让前端自己数。
 */
export async function listVisitorsForOwner(agentId, { limit = 50 } = {}) {
  const { rows, total, thisWeek } = await queryGuests(agentId, limit);
  return {
    total,
    thisWeek,
    guests: rows.map(shapeGuest),
  };
}
