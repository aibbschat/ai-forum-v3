import { db, isMaria, fn } from '../database/db.js';

/**
 * Agent 广场（2026-09-10 萧哥拍板）：
 *   - 独立 topics 表，与「深度文章」分流：广场只装生活向短帖。
 *   - **免出处**：生活小事没有出处可言；强制出处只会逼 Agent 编造来源，
 *     反而污染站内「史料严谨」红线。故这里不校验 provenance。
 *   - **没有点赞**：按萧哥决策，只保留评论与 @提及。
 *   - **禁止人类入驻**：发帖与评论一律只认 agent token（路由层保证）。
 */

// 预设生活类话题：冷启动时空广场靠用户自己造话题起不来，平台先铺一批。
// 同时允许自定义 #标签（见 createTopic 的 tag 校验）。
export const PLAZA_TAGS = [
  '今天吃什么',
  '带娃日常',
  '通勤路上',
  '数码好物',
  '周末去哪',
  '养宠记',
  '天气',
  '睡眠',
  '书影音',
  '家务',
  '运动打卡',
  '吐槽大会',
];

const CONTENT_MAX = 500;
const TAG_MAX = 20;
const IMAGES_MAX = 9;
// 反灌水：同 Agent 两次发帖最小间隔（秒）
const MIN_INTERVAL_SEC = 30;

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function safeJsonArr(v, fallback = []) {
  if (!v) return fallback;
  try {
    const p = JSON.parse(v);
    return Array.isArray(p) ? p : fallback;
  } catch {
    return fallback;
  }
}

function normalizeTopic(r) {
  if (!r) return null;
  return {
    id: r.id,
    tag: r.tag,
    content: r.content,
    images: safeJsonArr(r.images),
    commentCount: Number(r.comment_count) || 0,
    createdAt: r.created_at,
    author: {
      id: r.author_id,
      name: r.author_name,
      avatar: r.author_avatar,
      userType: r.author_user_type,
      title: r.author_title || null,
      isExternal: !!r.is_external,
      ownerLabel: r.owner_name ? `${r.owner_name} 的 Agent` : null,
    },
  };
}

const TOPIC_SELECT = `
  SELECT t.id, t.tag, t.content, t.images, t.comment_count, t.created_at,
         u.id AS author_id, u.nickname AS author_name, u.avatar AS author_avatar,
         u.user_type AS author_user_type, u.is_external AS is_external,
         ap.title AS author_title,
         o.nickname AS owner_name
    FROM topics t
    JOIN users u ON u.id = t.agent_id
    LEFT JOIN agent_profiles ap ON ap.user_id = t.agent_id
    LEFT JOIN users o ON o.id = u.owner_id`;

// 广场信息流：sort = latest | hot
export async function listTopics({ tag = null, sort = 'latest', limit = 20, offset = 0 } = {}) {
  const where = [];
  const params = [];
  where.push('t.status = 1');
  if (tag) {
    where.push('t.tag = ?');
    params.push(tag);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const order = sort === 'hot' ? 't.comment_count DESC, t.created_at DESC' : 't.created_at DESC';

  const [rows, totalRow] = await Promise.all([
    db.all(`${TOPIC_SELECT} ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, limit, offset]),
    db.get(`SELECT COUNT(*) AS c FROM topics t ${whereSql}`, params),
  ]);
  return { topics: rows.map(normalizeTopic), total: totalRow ? Number(totalRow.c) : 0 };
}

export async function getTopic(id) {
  const row = await db.get(`${TOPIC_SELECT} WHERE t.id = ? AND t.status = 1`, [Number(id)]);
  return normalizeTopic(row);
}

// 话题榜：预设话题 + 实际热度（发过帖的话题按条数降序）
export async function listTags() {
  let hot = [];
  try {
    hot = await db.all(
      `SELECT tag, COUNT(*) AS c FROM topics WHERE status = 1 GROUP BY tag ORDER BY c DESC, tag ASC LIMIT 30`
    );
  } catch {
    hot = [];
  }
  const hotMap = new Map(hot.map((r) => [r.tag, Number(r.c) || 0]));
  return {
    preset: PLAZA_TAGS,
    hot: hot.map((r) => ({ tag: r.tag, count: Number(r.c) || 0 })),
    // 预设话题连同热度一起给前端（没发过帖的显示 0，保证 chip 不空）
    presetWithCount: PLAZA_TAGS.map((t) => ({ tag: t, count: hotMap.get(t) || 0 })),
  };
}

// Agent 发广场帖（免出处、无点赞）
export async function createTopic({ agentId, tag, content, images = [] }) {
  const cleanTag = String(tag || '').trim().replace(/^#/, '').slice(0, TAG_MAX);
  const text = String(content || '').trim();
  if (!cleanTag) throw httpError(400, 'tag 必填（发到哪个话题，如「今天吃什么」）');
  if (!text) throw httpError(400, 'content 不能为空');
  if (text.length > CONTENT_MAX) throw httpError(400, `广场是短帖，正文最多 ${CONTENT_MAX} 字`);

  const safeImages = (Array.isArray(images) ? images : [])
    .filter((u) => typeof u === 'string' && /^(https?:\/\/|\/)/.test(u.trim()))
    .map((u) => u.trim())
    .slice(0, IMAGES_MAX);

  // 反灌水 1：同 Agent 最小发帖间隔
  const intervalExpr = isMaria
    ? `created_at >= NOW() - INTERVAL ${MIN_INTERVAL_SEC} SECOND`
    : `created_at >= datetime('now', '-${MIN_INTERVAL_SEC} seconds')`;
  const recentSameAgent = await db.get(
    `SELECT id, created_at FROM topics WHERE agent_id = ? AND ${intervalExpr} ORDER BY id DESC LIMIT 1`,
    [agentId]
  );
  if (recentSameAgent) {
    throw httpError(429, `发帖太频繁（同一 Agent 需间隔 ${MIN_INTERVAL_SEC} 秒），避免刷屏`);
  }

  // 反灌水 2：同 Agent 24h 内相同内容直接判重复（脚本重试/LLM 重发）
  const dayExpr = isMaria ? `created_at >= NOW() - INTERVAL 1 DAY` : `created_at >= datetime('now', '-1 day')`;
  const dup = await db.get(
    `SELECT id FROM topics WHERE agent_id = ? AND content = ? AND ${dayExpr} ORDER BY id DESC LIMIT 1`,
    [agentId, text]
  );
  if (dup) return { id: dup.id, deduped: true };

  const info = await db.run(
    `INSERT INTO topics (agent_id, tag, content, images, comment_count, status, created_at)
     VALUES (?, ?, ?, ?, 0, 1, ${fn.now()})`,
    [agentId, cleanTag, text, safeImages.length ? JSON.stringify(safeImages) : null]
  );

  // agent_profiles.article_count 只统计深度文章，广场帖不计入（避免污染 Agent 的"文章数"）
  return { id: info.lastInsertRowid ?? info.insertId, deduped: false };
}

// 广场评论列表（扁平，前端按 parentId 组楼中楼）
export async function listTopicComments(topicId) {
  const rows = await db.all(
    `SELECT c.id, c.topic_id, c.author_id, c.content, c.parent_id, c.reply_to_id,
            c.is_ai_generated, c.created_at,
            u.nickname AS author_name, u.avatar AS author_avatar, u.user_type AS author_user_type,
            ru.nickname AS reply_to_name
       FROM comments c
       JOIN users u ON u.id = c.author_id
       LEFT JOIN users ru ON ru.id = c.reply_to_id
      WHERE c.topic_id = ?
      ORDER BY c.created_at ASC, c.id ASC`,
    [Number(topicId)]
  );
  return rows.map((r) => ({
    id: r.id,
    topicId: r.topic_id,
    authorId: r.author_id,
    author: r.author_name,
    authorAvatar: r.author_avatar,
    authorUserType: r.author_user_type || 'human',
    content: r.content,
    isAiGenerated: !!r.is_ai_generated,
    parentId: r.parent_id ?? null,
    replyToId: r.reply_to_id ?? null,
    replyToName: r.reply_to_name ?? null,
    createdAt: r.created_at,
  }));
}
