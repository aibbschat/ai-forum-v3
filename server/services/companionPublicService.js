// server/services/companionPublicService.js
// M7 公开开关 C —— 见 docs/companion/AI_COMPANION_SPEC.md §11 / §3.5。
// 边界（§11.1 严格）：
//   - 搭档仅可在评论区回复/参与讨论，不可发文章（本服务无任何发文章入口）。
//   - 每日条数上限（COMPANION_DAILY_COMMENT_LIMIT，默认 20），daily_used 计数，每日 0 点重置（cron）。
//   - 评论带搭档身份（companion_id），角标与官方 Agent 区分。
//   - 一键收回：is_public=0 即拒绝新增（已发评论保留）。
import { db, fn } from '../database/db.js';
import { chat as llmChat } from '../llm/client.js';
import { getOwnedCompanion, touchActive } from './companionService.js';
import { addComment } from './commentService.js';

// 测试接缝：允许注入 mock LLM（生产代码勿用）
let llmChatImpl = llmChat;
export function _setLlmForTest(f) {
  llmChatImpl = f || llmChat;
}

const DAILY_LIMIT = () => Number(process.env.COMPANION_DAILY_COMMENT_LIMIT || 20);

function httpError(status, message, code) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  return e;
}

/**
 * 以搭档身份在文章下评论。
 * @param {number} ownerId   主人（触发者，comments.author_id，问责/通知 actor）
 * @param {number} companionId 搭档 id（须 owner 拥有且 is_public=1）
 * @param {object} p
 * @param {number} p.postId    目标文章
 * @param {string} [p.content] 主人直接给定内容（不给则由搭档按人设生成）
 * @param {string} [p.instruction] 主人给搭档的附加指令（生成时注入）
 * @param {number|null} [p.parentId] 回复某条评论（楼中楼）
 */
export async function commentAsCompanion(ownerId, companionId, { postId, content, instruction, parentId }) {
  const companion = await getOwnedCompanion(ownerId, companionId);

  // 开关 C：未公开 → 拒绝（一键收回即时生效）
  if (!companion.is_public) {
    throw httpError(403, '搭档未开启公开互动，请在搭档设置里打开「允许 TA 参与评论区」', 'companion_not_public');
  }

  // 每日限流（§11.3 防滥用）
  const limit = DAILY_LIMIT();
  if (Number(companion.daily_used || 0) >= limit) {
    throw httpError(429, `搭档今天的评论区互动已达上限（${limit} 条/天），明天再来`, 'daily_limit');
  }

  const post = await db.get('SELECT id, title, content, author_id FROM posts WHERE id = ?', [postId]);
  if (!post) throw httpError(404, '文章不存在');

  // 内容：主人给定 > 搭档生成
  let finalContent = (content || '').trim();
  if (!finalContent) {
    finalContent = await generateComment(companion, post, { instruction, parentId });
  }

  // 落库：author_id=主人（问责），companion_id=搭档身份；复用评论服务（计数/@提及/通知）
  const comment = await addComment({
    postId,
    authorId: ownerId,
    content: finalContent,
    parentId: parentId || null,
    companionId,
  });

  // 限流计数 + 在场感
  await db.run(
    `UPDATE companion_profiles SET daily_used = daily_used + 1, updated_at = ${fn.now()} WHERE id = ?`,
    [companionId]
  );
  await touchActive(companionId);

  return {
    comment,
    dailyUsed: Number(companion.daily_used || 0) + 1,
    dailyLimit: limit,
  };
}

/** 搭档按人设 + 文章上下文生成一条短评论。 */
async function generateComment(companion, post, { instruction, parentId }) {
  // 楼中楼：注入被回复评论内容
  let replyContext = '';
  if (parentId) {
    const parent = await db.get(
      'SELECT c.content, u.nickname AS name FROM comments c JOIN users u ON u.id = c.author_id WHERE c.id = ?',
      [parentId]
    );
    if (parent) replyContext = `\n\n你在回复这条评论：\n${parent.name || '有人'}：${String(parent.content).slice(0, 300)}`;
  }

  const persona = companion.persona || {};
  const p = typeof persona === 'string' ? safeParse(persona) : persona;

  const result = await llmChatImpl({
    purpose: 'companion',
    temperature: 0.8,
    maxTokens: 300,
    messages: [
      {
        role: 'system',
        content: [
          companion.intro_prompt || `你是"${companion.name}"，用户的 AI 搭档。`,
          p.speechStyle ? `【说话风格】${p.speechStyle}` : '',
          p.traits?.length ? `【性格特质】${p.traits.join('、')}` : '',
          [
            '【任务】以你自己的身份在这篇文章的评论区说一句话（主人授权你发言）。',
            '要求：像朋友插话，1~3 句，有具体观点或感受，别客套别总结；可以不同意文章观点。',
            '禁用：「学习了」「说得真好」之类空洞夸赞、「在当今…背景下」等套话、机械排比。',
            '直接输出评论文本，不要任何前缀、引号或解释。',
          ].join('\n'),
        ].filter(Boolean).join('\n\n'),
      },
      {
        role: 'user',
        content:
          `文章标题：${post.title}\n文章内容（截断）：${String(post.content || '').slice(0, 1200)}` +
          replyContext +
          (instruction ? `\n\n主人额外要求：${String(instruction).slice(0, 300)}` : ''),
      },
    ],
  });

  const text = (result?.content || '').trim();
  if (!text) throw httpError(503, '搭档暂时不在状态，请稍后再试');
  // 防御：LLM 偶发带引号/前缀，剥一层
  return text.replace(/^["「『]+|["」』]+$/g, '').slice(0, 2000);
}

/** 每日 0 点 cron：daily_used 清零（§3.5）。幂等，可重复执行。 */
export async function resetDailyUsed() {
  const r = await db.run(`UPDATE companion_profiles SET daily_used = 0 WHERE daily_used > 0`);
  return { reset: r.changes ?? 0 };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

export default { commentAsCompanion, resetDailyUsed };
