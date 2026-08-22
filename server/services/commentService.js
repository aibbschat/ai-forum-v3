import { db } from '../database/db.js';
import { createNotification } from './notificationService.js';

// ── @{nickname} 解析：从评论内容里抓 @xxx，返回用户 id 列表（已验证存在）──
const MENTION_RE = /@([\u4e00-\u9fa5A-Za-z0-9_\-]{1,30})/g;
async function extractMentionedIds(content) {
  if (!content || typeof content !== 'string') return [];
  const names = new Set();
  let m;
  while ((m = MENTION_RE.exec(content)) !== null) names.add(m[1]);
  if (names.size === 0) return [];
  const placeholders = [...names].map(() => '?').join(',');
  const rows = await db.all(
    `SELECT id FROM users WHERE nickname IN (${placeholders}) OR username IN (${placeholders})`,
    [...names, ...names]
  );
  return rows.map((r) => r.id);
}

// 评论列表：顶层 + 顶层下的回复（楼中楼，二维）。
// 顶层评论按 created_at ASC，其下回复按 created_at ASC。
export async function listComments(postId, { userId = null } = {}) {
  const rows = await db.all(
    `SELECT c.id, c.post_id, c.author_id, c.companion_id, c.content, c.is_ai_generated, c.created_at,
            c.parent_id, c.reply_to_id, c.mentioned_ids,
            u.nickname AS author, u.avatar AS author_avatar,
            u.user_type AS author_user_type,
            ru.nickname AS reply_to_name, ru.id AS reply_to_uid,
            cp.name AS companion_name, cp.avatar AS companion_avatar, cp.badge AS companion_badge,
            cp.username AS companion_username,
            (SELECT COUNT(*) FROM comment_likes cl WHERE cl.comment_id = c.id) AS like_count
     FROM comments c
     JOIN users u ON u.id = c.author_id
     LEFT JOIN users ru ON ru.id = c.reply_to_id
     LEFT JOIN companion_profiles cp ON cp.id = c.companion_id
     WHERE c.post_id = ?
     ORDER BY c.created_at ASC`,
    [postId]
  );

  // 顶层 id → row
  const byId = new Map();
  const top = [];
  for (const r of rows) {
    byId.set(r.id, r);
    if (!r.parent_id) top.push(r);
  }
  // 挂载回复（防御性：parent 不存在时把孤儿当顶层）
  for (const r of rows) {
    if (r.parent_id && byId.has(r.parent_id)) {
      const parent = byId.get(r.parent_id);
      if (!Array.isArray(parent._replies)) parent._replies = [];
      parent._replies.push(r);
    } else if (r.parent_id) {
      top.push(r);
    }
  }

  // 计算当前用户点赞状态（一次性 IN 查询，避免 N+1）
  let likedSet = new Set();
  if (userId) {
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      const ph = ids.map(() => '?').join(',');
      const liked = await db.all(
        `SELECT comment_id FROM comment_likes WHERE user_id = ? AND comment_id IN (${ph})`,
        [userId, ...ids]
      );
      likedSet = new Set(liked.map((x) => x.comment_id));
    }
  }

  const shape = (r) => ({
    id: r.id,
    postId: r.post_id,
    authorId: r.author_id,
    author: r.companion_id && r.companion_name ? r.companion_name : r.author,
    authorAvatar: r.companion_id && r.companion_name ? r.companion_avatar : r.author_avatar,
    authorUserType: r.companion_id ? 'companion' : r.author_user_type || 'human',
    companion: r.companion_id
      ? { id: r.companion_id, name: r.companion_name, avatar: r.companion_avatar, badge: r.companion_badge || '我的搭档', username: r.companion_username }
      : undefined,
    content: r.content,
    isAiGenerated: !!r.is_ai_generated,
    likeCount: r.like_count,
    liked: likedSet.has(r.id),
    parentId: r.parent_id ?? null,
    replyToId: r.reply_to_id ?? null,
    replyToName: r.reply_to_name ?? null,
    mentionedIds: safeJsonArr(r.mentioned_ids),
    createdAt: r.created_at,
  });

  // 输出：顶层评论带 replies 数组
  return top.map((t) => {
    const out = shape(t);
    if (Array.isArray(t._replies)) out.replies = t._replies.map(shape);
    else out.replies = [];
    return out;
  });
}

// 新增评论 / 回复（自动识别 @提及，回写 comment_count，并触发通知）。
// companionId（M7 公开开关 C）：非空 = 以用户 AI 搭档身份发出；author_id 仍是主人（问责/通知 actor）。
export async function addComment({ postId, authorId, content, parentId = null, replyToId = null, companionId = null }) {
  const text = String(content || '').trim();
  if (!postId || !authorId || !text) throw httpError(400, '评论内容不能为空');
  if (text.length > 2000) throw httpError(400, '评论过长（最多 2000 字）');

  const post = await db.get('SELECT id, author_id, agent_id FROM posts WHERE id = ?', [postId]);
  if (!post) throw httpError(404, '文章不存在');

  let normalizedParentId = null;
  let normalizedReplyToId = replyToId ?? null;
  if (parentId) {
    const parent = await db.get('SELECT id, author_id, post_id FROM comments WHERE id = ?', [parentId]);
    if (!parent || Number(parent.post_id) !== Number(postId)) throw httpError(400, '回复的评论不存在');
    // 不允许跨楼：如果 parent 自己已经是回复，把它的顶层作为本次 parent
    normalizedParentId = parent.id;
    // replyToId 缺省 = 被回复评论的作者
    if (!normalizedReplyToId) normalizedReplyToId = parent.author_id;
  }

  const mentionedIds = await extractMentionedIds(text);

  const info = await db.run(
    `INSERT INTO comments (post_id, author_id, companion_id, content, parent_id, reply_to_id, mentioned_ids, is_ai_generated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [postId, authorId, companionId || null, text, normalizedParentId, normalizedReplyToId, mentionedIds.length ? JSON.stringify(mentionedIds) : null, companionId ? 1 : 0]
  );
  await db.run('UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?', [postId]);

  // ── 通知（fire-and-forget，绝不阻塞评论） ──
  const snippet = text.slice(0, 80);
  const actorId = authorId;
  // 1) 文章作者收到「评论」/「回复」
  const isReply = !!normalizedParentId;
  if (post.author_id && post.author_id !== actorId) {
    createNotification({
      userId: post.author_id,
      actorId,
      type: isReply ? 'reply' : 'comment',
      postId,
      commentId: info.lastInsertRowid,
      extra: { snippet },
    });
  }
  // 2) 被精准回复的用户（楼中楼 replyToId）
  if (normalizedReplyToId && normalizedReplyToId !== actorId && normalizedReplyToId !== post.author_id) {
    createNotification({
      userId: normalizedReplyToId,
      actorId,
      type: 'reply',
      postId,
      commentId: info.lastInsertRowid,
      extra: { snippet },
    });
  }
  // 3) @提及的用户（去重）
  for (const uid of mentionedIds) {
    if (uid !== actorId && uid !== post.author_id && uid !== normalizedReplyToId) {
      createNotification({
        userId: uid,
        actorId,
        type: 'mention',
        postId,
        commentId: info.lastInsertRowid,
        extra: { snippet },
      });
    }
  }

  // ★ 层3 反馈接线（2026-08-15）：读者评论写回被评论 Agent 的记忆（source='feedback'）。
  if (post.agent_id && typeof post.agent_id === 'number') {
    if (text.length >= 6) {
      try {
        const { writeEpisodic } = await import('./memory/index.js');
        await writeEpisodic({
          agentId: post.agent_id,
          content: `读者反馈：${text.slice(0, 300)}`,
          source: 'feedback',
          importance: 0.7,
        });
      } catch (e) {
        console.warn('[commentService] 反馈写记忆失败（不影响评论）:', e?.message || e);
      }
    }
  }

  const row = await db.get(
    `SELECT c.id, c.post_id, c.author_id, c.companion_id, c.content, c.is_ai_generated, c.created_at,
            c.parent_id, c.reply_to_id, c.mentioned_ids,
            u.nickname AS author, u.avatar AS author_avatar,
            u.user_type AS author_user_type,
            ru.nickname AS reply_to_name,
            cp.name AS companion_name, cp.avatar AS companion_avatar, cp.badge AS companion_badge,
            cp.username AS companion_username
     FROM comments c JOIN users u ON u.id = c.author_id
     LEFT JOIN users ru ON ru.id = c.reply_to_id
     LEFT JOIN companion_profiles cp ON cp.id = c.companion_id
     WHERE c.id = ?`,
    [info.lastInsertRowid]
  );

  return {
    id: row.id,
    postId: row.post_id,
    authorId: row.author_id,
    author: row.companion_id && row.companion_name ? row.companion_name : row.author,
    authorAvatar: row.companion_id && row.companion_name ? row.companion_avatar : row.author_avatar,
    authorUserType: row.companion_id ? 'companion' : row.author_user_type || 'human',
    companion: row.companion_id
      ? { id: row.companion_id, name: row.companion_name, avatar: row.companion_avatar, badge: row.companion_badge || '我的搭档', username: row.companion_username }
      : undefined,
    content: row.content,
    isAiGenerated: !!row.is_ai_generated,
    likeCount: 0,
    liked: false,
    parentId: row.parent_id ?? null,
    replyToId: row.reply_to_id ?? null,
    replyToName: row.reply_to_name ?? null,
    mentionedIds: safeJsonArr(row.mentioned_ids),
    replies: [],
    createdAt: row.created_at,
  };
}

// 评论点赞（comment_likes 表去重切换，返回新计数）
export async function likeComment(commentId, userId) {
  if (!commentId || !userId) throw httpError(400, '参数不完整');
  const comment = await db.get(
    `SELECT c.id, c.author_id, c.post_id FROM comments c WHERE c.id = ?`,
    [commentId]
  );
  if (!comment) throw httpError(404, '评论不存在');

  const existing = await db.get(
    'SELECT id FROM comment_likes WHERE comment_id = ? AND user_id = ?',
    [commentId, userId]
  );
  let liked;
  if (existing) {
    await db.run('DELETE FROM comment_likes WHERE id = ?', [existing.id]);
    liked = false;
  } else {
    await db.run('INSERT INTO comment_likes (user_id, comment_id) VALUES (?, ?)', [
      userId,
      commentId,
    ]);
    liked = true;
    // 通知被点赞者
    createNotification({
      userId: comment.author_id,
      actorId: userId,
      type: 'like',
      postId: comment.post_id,
      commentId,
    });
  }

  const { n: likeCount } = await db.get(
    'SELECT COUNT(*) AS n FROM comment_likes WHERE comment_id = ?',
    [commentId]
  );
  return { ok: true, liked, likeCount };
}

function safeJsonArr(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try {
    const x = JSON.parse(v);
    return Array.isArray(x) ? x : [];
  } catch {
    return [];
  }
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
