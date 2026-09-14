import { db } from '../database/db.js';
import { createNotification } from './notificationService.js';

// ── @提及解析：站内已知名「最长前缀匹配」 ──
// 旧实现用贪婪字符类 /@([中文…]{1,30})/ 抓名字，但中文没有词边界：昵称后一旦紧跟中文
// （如「@小桔帮我看看」），整串会被吞成不存在的名字再精确查库 → 静默漏投（写对也收不到）。
// 改为拿站内真实存在的 nickname/username 做最长前缀匹配：从 @ 之后尽量匹配最长的那个已知名，
// 命中即登记，从而正确切出「@小桔帮我看看」→ 小桔、「@小沃的 Agent」→ 小沃。
// 名字集合每次现查 users（表很小、写频率低，且规避改名后的缓存不一致）。
async function loadMentionableNameMap() {
  const rows = await db.all(`SELECT id, nickname, username FROM users WHERE status = 1`);
  const map = new Map(); // lowerName -> Set<id>（nickname 与 username 都可被 @）
  let maxLen = 0;
  for (const r of rows) {
    for (const raw of [r.nickname, r.username]) {
      const key = String(raw || '').trim().toLowerCase();
      if (!key) continue;
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(r.id);
      if (key.length > maxLen) maxLen = key.length;
    }
  }
  return { map, maxLen };
}

const AT_RE = /@/g;
export async function extractMentionedIds(content) {
  if (!content || typeof content !== 'string') return [];
  const { map, maxLen } = await loadMentionableNameMap();
  if (!map.size || !maxLen) return [];
  const ids = [];
  const seen = new Set();
  const addId = (id) => {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  };
  let m;
  AT_RE.lastIndex = 0;
  while ((m = AT_RE.exec(content)) !== null) {
    const rest = content.slice(m.index + 1).toLowerCase();
    const upper = Math.min(maxLen, rest.length);
    for (let len = upper; len >= 1; len--) {
      const hit = map.get(rest.slice(0, len));
      if (hit) {
        for (const id of hit) addId(id);
        break; // 最长优先，命中即止
      }
    }
  }
  return ids;
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
export async function addComment({ postId, topicId = null, authorId, content, parentId = null, replyToId = null, companionId = null, isAiGenerated = null }) {
  const text = String(content || '').trim();
  if ((!postId && !topicId) || !authorId || !text) throw httpError(400, '评论内容不能为空');
  if (text.length > 2000) throw httpError(400, '评论过长（最多 2000 字）');

  // 评论目标：文章（post）或 Agent 广场帖（topic）。
  // 广场评论的 post_id 写 NULL —— 它不属于任何文章，绝不塞 0 这类哨兵值污染语义。
  let targetAuthorId = null;
  let targetAgentId = null;
  if (topicId) {
    const topic = await db.get('SELECT id, agent_id FROM topics WHERE id = ?', [topicId]);
    if (!topic) throw httpError(404, '广场帖不存在');
    targetAuthorId = topic.agent_id;
    targetAgentId = topic.agent_id;
  } else {
    const post = await db.get('SELECT id, author_id, agent_id FROM posts WHERE id = ?', [postId]);
    if (!post) throw httpError(404, '文章不存在');
    targetAuthorId = post.author_id;
    targetAgentId = post.agent_id;
  }

  let normalizedParentId = null;
  let normalizedReplyToId = replyToId ?? null;
  if (parentId) {
    const parent = await db.get('SELECT id, author_id, post_id, topic_id FROM comments WHERE id = ?', [parentId]);
    if (!parent) throw httpError(400, '回复的评论不存在');
    const parentTarget = topicId ? parent.topic_id : parent.post_id;
    if (Number(parentTarget) !== Number(topicId || postId)) throw httpError(400, '回复的评论不存在');
    // 不允许跨楼：如果 parent 自己已经是回复，把它的顶层作为本次 parent
    normalizedParentId = parent.id;
    // replyToId 缺省 = 被回复评论的作者
    if (!normalizedReplyToId) normalizedReplyToId = parent.author_id;
  }

  const mentionedIds = await extractMentionedIds(text);

  const info = await db.run(
    `INSERT INTO comments (post_id, topic_id, author_id, companion_id, content, parent_id, reply_to_id, mentioned_ids, is_ai_generated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    // is_ai_generated：显式指定优先（外部 Agent 是独立 user，没有 companion_id，需显式标注 AI 身份）
    [topicId ? null : postId, topicId || null, authorId, companionId || null, text, normalizedParentId, normalizedReplyToId, mentionedIds.length ? JSON.stringify(mentionedIds) : null, isAiGenerated == null ? (companionId ? 1 : 0) : (isAiGenerated ? 1 : 0)]
  );
  if (topicId) {
    await db.run('UPDATE topics SET comment_count = comment_count + 1 WHERE id = ?', [topicId]);
  } else {
    await db.run('UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?', [postId]);
  }

  // ── 通知（fire-and-forget，绝不阻塞评论） ──
  const snippet = text.slice(0, 80);
  const actorId = authorId;
  const isReply = !!normalizedParentId;
  const notifyPostId = topicId ? null : postId;
  const baseExtra = { snippet, ...(topicId ? { topicId } : {}) };
  // 1) 帖子作者收到「评论」/「回复」
  if (targetAuthorId && targetAuthorId !== actorId) {
    createNotification({
      userId: targetAuthorId,
      actorId,
      type: isReply ? 'reply' : 'comment',
      postId: notifyPostId,
      commentId: info.lastInsertRowid,
      extra: baseExtra,
    });
  }
  // 2) 被精准回复的用户（楼中楼 replyToId）
  if (normalizedReplyToId && normalizedReplyToId !== actorId && normalizedReplyToId !== targetAuthorId) {
    createNotification({
      userId: normalizedReplyToId,
      actorId,
      type: 'reply',
      postId: notifyPostId,
      commentId: info.lastInsertRowid,
      extra: baseExtra,
    });
  }
  // 3) @提及的用户（去重）
  for (const uid of mentionedIds) {
    if (uid !== actorId && uid !== targetAuthorId && uid !== normalizedReplyToId) {
      createNotification({
        userId: uid,
        actorId,
        type: 'mention',
        postId: notifyPostId,
        commentId: info.lastInsertRowid,
        extra: baseExtra,
      });
    }
  }

  // ★ 层3 反馈接线（2026-08-15）：读者评论写回被评论 Agent 的记忆（source='feedback'）。
  if (targetAgentId && typeof targetAgentId === 'number') {
    if (text.length >= 6) {
      try {
        const { writeEpisodic } = await import('./memory/index.js');
        await writeEpisodic({
          agentId: targetAgentId,
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
    `SELECT c.id, c.post_id, c.topic_id, c.author_id, c.companion_id, c.content, c.is_ai_generated, c.created_at,
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
    topicId: row.topic_id ?? null,
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
