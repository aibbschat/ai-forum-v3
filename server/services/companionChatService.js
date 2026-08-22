// server/services/companionChatService.js
// 伴侣聊天后端（M3）—— 见 docs/companion/AI_COMPANION_SPEC.md §5 / §7 / §10。
// 与「问 AI 圈」chatService 的区别（§5.1）：
//   有状态（sessions/messages 表）、身份绑定（companion_id + intro_prompt）、
//   记忆注入（semantic=主人特征/文风 + episodic=近期交互）、文风对齐（de-ai-flavor）。
// 不代发约束（§5.3）：本服务没有任何发布动作，仅聊天与存草稿。
import { db, fn } from '../database/db.js';
import { chat as llmChat } from '../llm/client.js';
import { getOwnedCompanion, touchActive } from './companionService.js';

// 测试接缝：允许注入 mock LLM（生产代码勿用）
let llmChatImpl = llmChat;
export function _setLlmForTest(fn) {
  llmChatImpl = fn || llmChat;
}

const HISTORY_LIMIT = 20; // 注入模型的最近消息条数（含双向）
const EPISODIC_LIMIT = 6;
const SEMANTIC_LIMIT = 8;
const MAX_INPUT = 4000;
const DIGEST_NOTIF_LIMIT = 8; // 陪消化：注入的未读互动条数（§9.2）
const DIGEST_DM_LIMIT = 5;

const NOTIF_TYPE_ZH = {
  like: '赞了你的文章',
  comment: '评论了你的文章',
  reply: '回复了你',
  mention: '在评论里 @ 了你',
  follow: '关注了你',
};

// ── de-ai-flavor 写作戒律（源自本地技能，全文唯一注入点：伴侣 system prompt）──
const DE_AI_FLAVOR_RULES = [
  '【说话方式（重要）】',
  '1. 禁用套话：「在当今…背景下」「值得注意的是」「总而言之」「首先…其次…最后」「让我们…」。不用教科书式下定义。',
  '2. 像朋友发消息，不像写文章：长短句错落，允许短到一两个字的回复（「嗯」「这不巧了」）。',
  '3. 用具体代替抽象：有真实细节、人名、书名、数字就说出来，不输出放之四海皆准的废话。',
  '4. 有态度：允许表达个人偏好甚至轻微的吐槽，别一味正确；观点可以是「我觉得」开头但别每句都是。',
  '5. 允许不完美：语气词（呢、吧、啊）、口语、偶尔一句话收尾，比工整排比更像人。',
  '6. 不主动总结陈词，不用「——」机械堆砌；一次回复通常不超过 3 段，多数时候更短。',
].join('\n');

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ── 记忆装配（§7）────────────────────────────────────────────
/** 语义记忆（主人特征/文风）+ 情景记忆（近期交互）→ prompt 片段。 */
async function loadMemoryBlocks(companionId) {
  const blocks = [];
  try {
    const semantic = await db.all(
      `SELECT domain, understanding FROM companion_memory_semantic
        WHERE companion_id = ? AND status != 'expired'
        ORDER BY confidence DESC, updated_at DESC LIMIT ${SEMANTIC_LIMIT}`,
      [companionId]
    );
    if (semantic.length) {
      blocks.push(
        '【你对主人的长期了解】\n' +
          semantic.map((s) => `- ${s.domain || '其他'}：${s.understanding}`).join('\n')
      );
    }
  } catch { /* 表未建/读失败不阻断聊天 */ }
  try {
    const episodic = await db.all(
      `SELECT content FROM companion_memory_episodic
        WHERE companion_id = ? AND status != 'expired'
        ORDER BY importance DESC, created_at DESC LIMIT ${EPISODIC_LIMIT}`,
      [companionId]
    );
    if (episodic.length) {
      blocks.push('【你们之间的近事】\n' + episodic.map((e) => `- ${e.content}`).join('\n'));
    }
  } catch { /* 同上 */ }
  return blocks;
}

/** 陪消化（§9.2.3）：读主人未读通知 + 未读私信 → 摘要 block。搭档不写 notifications，只读。 */
async function loadDigestBlock(ownerId) {
  const lines = [];
  try {
    const notifs = await db.all(
      `SELECT n.type, n.extra, u.nickname AS actor_name, p.title AS post_title
       FROM notifications n
       JOIN users u ON u.id = n.actor_id
       LEFT JOIN posts p ON p.id = n.post_id
       WHERE n.user_id = ? AND n.is_read = 0
       ORDER BY n.created_at DESC
       LIMIT ${DIGEST_NOTIF_LIMIT}`,
      [ownerId]
    );
    for (const n of notifs) {
      let s = `- ${n.actor_name || '某位用户'} ${NOTIF_TYPE_ZH[n.type] || '和你有新互动'}`;
      if (n.post_title) s += `「${String(n.post_title).slice(0, 30)}」`;
      const snippet = safeJsonExtra(n.extra)?.snippet;
      if (snippet) s += `，说：「${String(snippet).slice(0, 60)}」`;
      lines.push(s);
    }
  } catch { /* 表未建/读失败不阻断聊天 */ }
  try {
    const dms = await db.all(
      `SELECT m.content, u.nickname AS sender_name
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.receiver_id = ? AND m.is_read = 0
       ORDER BY m.created_at DESC
       LIMIT ${DIGEST_DM_LIMIT}`,
      [ownerId]
    );
    for (const d of dms) {
      lines.push(`- ${d.sender_name || '有人'} 给你发来私信：「${String(d.content).slice(0, 60)}」`);
    }
  } catch { /* 同上 */ }
  if (!lines.length) return null;
  return [
    '【主人的未读动态（主人可能还没看到，你知道了）】',
    ...lines,
    [
      '这些是主人最近的互动。若与正在聊的话题相关、或主人看起来有空，你可以顺口提一句，',
      '问要不要看看、要不要回；他愿意的话可以帮他想想怎么回。别强行转场，别每次都提，主人聊得正投入时就不提。',
    ].join(''),
  ].join('\n');
}

function safeJsonExtra(v) {
  if (v == null) return undefined;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return undefined; }
}

function buildSystemPrompt(companion, memoryBlocks) {
  const p = companion.persona || {};
  const parts = [];
  parts.push(companion.intro_prompt || `你是"${companion.name}"，用户专属的 AI 搭档。`);
  parts.push(
    [
      '【身份边界】你是私人伙伴，不是社区内容生产者。',
      '你绝不能以主人身份公开发帖、发消息给他人；主人让你「帮我发了」时，提醒他这件事得他自己动手（你只帮写）。',
    ].join('\n')
  );
  if (p.speechStyle) parts.push(`【说话风格】${p.speechStyle}`);
  if (p.traits && p.traits.length) parts.push(`【性格特质】${p.traits.join('、')}`);
  if (memoryBlocks.length) parts.push(memoryBlocks.join('\n\n'));
  parts.push(DE_AI_FLAVOR_RULES);
  return parts.join('\n\n');
}

// ── 会话管理 ─────────────────────────────────────────────────
export async function listSessions(ownerId, companionId) {
  await getOwnedCompanion(ownerId, companionId);
  return db.all(
    `SELECT * FROM companion_chat_sessions
      WHERE companion_id = ? AND owner_id = ?
      ORDER BY updated_at DESC, id DESC`,
    [companionId, ownerId]
  );
}

export async function createSession(ownerId, companionId, title) {
  await getOwnedCompanion(ownerId, companionId);
  await db.run(
    'INSERT INTO companion_chat_sessions (companion_id, owner_id, title) VALUES (?, ?, ?)',
    [companionId, ownerId, (title || '新对话').slice(0, 200)]
  );
  const row = await db.get(
    'SELECT * FROM companion_chat_sessions WHERE companion_id = ? AND owner_id = ? ORDER BY id DESC LIMIT 1',
    [companionId, ownerId]
  );
  return row;
}

async function getOwnedSession(ownerId, sessionId) {
  const s = await db.get('SELECT * FROM companion_chat_sessions WHERE id = ?', [sessionId]);
  if (!s) throw httpError(404, '会话不存在');
  if (s.owner_id !== ownerId) throw httpError(403, '无权访问该会话');
  return s;
}

export async function getMessages(ownerId, sessionId) {
  await getOwnedSession(ownerId, sessionId);
  return db.all(
    'SELECT * FROM companion_chat_messages WHERE session_id = ? ORDER BY id ASC LIMIT 500',
    [sessionId]
  );
}

export async function deleteSession(ownerId, sessionId) {
  await getOwnedSession(ownerId, sessionId);
  await db.run('DELETE FROM companion_chat_messages WHERE session_id = ?', [sessionId]);
  await db.run('DELETE FROM companion_chat_sessions WHERE id = ?', [sessionId]);
  return { ok: true };
}

// ── 发消息（核心）────────────────────────────────────────────
export async function sendMessage(ownerId, companionId, sessionId, content) {
  const companion = await getOwnedCompanion(ownerId, companionId);
  const session = await getOwnedSession(ownerId, sessionId);
  if (session.companion_id !== Number(companionId)) {
    throw httpError(400, '会话不属于该搭档');
  }
  const text = (content || '').trim();
  if (!text) throw httpError(400, '消息不能为空');
  if (text.length > MAX_INPUT) throw httpError(400, `消息过长（>${MAX_INPUT} 字）`);

  // 1) 历史 + 记忆 → 组装上下文
  const history = await db.all(
    `SELECT role, content FROM companion_chat_messages
      WHERE session_id = ? ORDER BY id DESC LIMIT ${HISTORY_LIMIT}`,
    [sessionId]
  );
  history.reverse();
  const memoryBlocks = await loadMemoryBlocks(companionId);
  const digest = await loadDigestBlock(ownerId);
  if (digest) memoryBlocks.push(digest);

  const messages = [
    { role: 'system', content: buildSystemPrompt(companion, memoryBlocks) },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: text },
  ];

  // 2) 调用统一模型路由（purpose=companion，§10）
  const result = await llmChatImpl({ purpose: 'companion', messages, temperature: 0.7, maxTokens: 1500 });
  if (!result?.content) {
    throw httpError(503, '搭档暂时不在状态，请稍后再试');
  }

  // 3) 落库：用户消息 + 搭档回复（含 token 用量，§10.4 成本监控）
  const usage = result.usage || {};
  await db.run(
    `INSERT INTO companion_chat_messages
       (session_id, companion_id, owner_id, role, content, input_tokens, output_tokens, model_used)
     VALUES (?, ?, ?, 'user', ?, 0, 0, NULL)`,
    [sessionId, companionId, ownerId, text]
  );
  await db.run(
    `INSERT INTO companion_chat_messages
       (session_id, companion_id, owner_id, role, content, input_tokens, output_tokens, model_used)
     VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?)`,
    [sessionId, companionId, ownerId, result.content, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0, result.model]
  );

  // 4) 会话元数据：首条消息时用内容作标题；刷新活跃时间
  const isFresh = history.length === 0;
  if (isFresh) {
    await db.run(
      `UPDATE companion_chat_sessions SET title = ?, updated_at = ${fn.now()} WHERE id = ?`,
      [text.slice(0, 60), sessionId]
    );
  } else {
    await db.run(`UPDATE companion_chat_sessions SET updated_at = ${fn.now()} WHERE id = ?`, [sessionId]);
  }
  await touchActive(companionId);

  // 5) 后台记忆抽取（§7.6 pending → M5 consolidate）：尽力而为，不阻塞回复
  void extractEpisodicMemory(companion, text, result.content).catch(() => {});

  return {
    userMessage: { role: 'user', content: text },
    reply: {
      role: 'assistant',
      content: result.content,
      model: result.model,
      provider: result.provider,
    },
  };
}

/** 从对话中抽取值得长期记住的事 → companion_memory_episodic（status=pending）。 */
async function extractEpisodicMemory(companion, userText, replyText) {
  const r = await llmChatImpl({
    purpose: 'memory',
    json: true,
    temperature: 0.2,
    maxTokens: 400,
    messages: [
      {
        role: 'system',
        content: [
          '你是记忆抽取器。判断下面这轮对话里，是否有值得 AI 搭档长期记住的关于主人的事实',
          '（偏好、习惯、正在做的事、重要关系、文风特点等）。',
          '有则输出 JSON：{"memories":[{"content":"一句话事实","importance":0.0-1.0}]}，没有则 {"memories":[]}。',
          '只记事实，不记寒暄。最多 2 条。',
        ].join('\n'),
      },
      { role: 'user', content: `主人说：${userText}\n\n搭档回复：${replyText}` },
    ],
  });
  if (!r?.content) return;
  let parsed;
  try { parsed = JSON.parse(r.content); } catch { return; }
  const items = Array.isArray(parsed?.memories) ? parsed.memories.slice(0, 2) : [];
  for (const m of items) {
    if (!m?.content || typeof m.content !== 'string') continue;
    const importance = Math.min(1, Math.max(0, Number(m.importance) || 0.5));
    await db.run(
      `INSERT INTO companion_memory_episodic
         (companion_id, owner_id, content, source, importance, status)
       VALUES (?, ?, ?, 'chat', ?, 'pending')`,
      [companion.id, companion.owner_id, m.content.slice(0, 500), importance]
    );
  }
}

export default {
  listSessions,
  createSession,
  getMessages,
  deleteSession,
  sendMessage,
};
