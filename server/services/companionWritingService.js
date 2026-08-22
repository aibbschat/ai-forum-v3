// server/services/companionWritingService.js
// 辅助写作后端（M4）—— 见 docs/companion/AI_COMPANION_SPEC.md §6。
// 流程：主人写草稿 → 搭档润色/扩写/给角度/脑暴 → 存 companion_writing_drafts
//       → 主人确认/再改 → 主人点发布（走现有 createPost 人类通道）。
// 铁律：本服务没有任何发布动作；搭档永不出现在 author 位置（§6.2 只出草稿不代发）。
import { db } from '../database/db.js';
import { chat as llmChat } from '../llm/client.js';
import { getOwnedCompanion } from './companionService.js';

// 测试接缝（与 companionChatService 一致）
let llmChatImpl = llmChat;
export function _setLlmForTest(fn) {
  llmChatImpl = fn || llmChat;
}

export const ACTIONS = ['polish', 'expand', 'angles', 'brainstorm'];

// 与 companionChatService 一致的任务向 system prompt（de-ai-flavor 戒律全文注入）
const DE_AI_FLAVOR_RULES = [
  '【文风要求（重要）】',
  '1. 禁用套话：「在当今…背景下」「值得注意的是」「总而言之」「首先…其次…最后」「让我们…」。',
  '2. 保留主人的声音：不把口语改成书面语，不强行工整对仗，句式长短错落。',
  '3. 用具体代替抽象：细节、人名、书名、数字优先，删掉放之四海皆准的废话。',
  '4. 观点自然长出来，不靠连接词硬拗；结尾不总结陈词，留一句有温度或有刺的话。',
].join('\n');

const ACTION_PROMPTS = {
  polish: '请润色这篇草稿：修错字与病句、收紧表达、让文字更干净，但不改变主人的观点与语气。',
  expand: '请扩写这篇草稿：在不注水的前提下补充细节和论据，保持主人的视角与文风。',
  angles: '不要改写原文。请给这篇草稿提供 3-5 个新的切入角度或深化方向，每个用一两句话说明价值，口吻像朋友出主意。',
  brainstorm: '不要改写原文。请围绕这个主题脑暴：给出可写的点子、结构建议、可能的人物或案例，大胆一点，别只给安全牌。',
};

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** 文风样本（§5.2）：从语义记忆取 domain 命中「文风/写作」的理解。 */
async function loadStyleMemory(companionId) {
  try {
    const rows = await db.all(
      `SELECT domain, understanding FROM companion_memory_semantic
        WHERE companion_id = ? AND status != 'expired'
          AND (domain LIKE '%文风%' OR domain LIKE '%写作%' OR domain LIKE '%voice%')
        ORDER BY confidence DESC LIMIT 2`,
      [companionId]
    );
    return rows.map((r) => r.understanding).join('\n');
  } catch {
    return '';
  }
}

function buildSystemPrompt(companion, styleMemory, action) {
  const parts = [];
  parts.push(
    `你是"${companion.name}"，主人的专属 AI 搭档，正在帮主人处理一篇草稿。` +
      '你只出稿子和建议，发布永远由主人自己决定。'
  );
  const p = companion.persona || {};
  if (p.speechStyle) parts.push(`【你的说话风格】${p.speechStyle}`);
  if (styleMemory) parts.push(`【主人的文风（润色时必须保留）】\n${styleMemory}`);
  parts.push(ACTION_PROMPTS[action] || ACTION_PROMPTS.polish);
  parts.push(DE_AI_FLAVOR_RULES);
  return parts.join('\n\n');
}

// ── 草稿 CRUD ────────────────────────────────────────────────
export async function listDrafts(ownerId, companionId) {
  await getOwnedCompanion(ownerId, companionId);
  return db.all(
    `SELECT * FROM companion_writing_drafts
      WHERE companion_id = ? AND owner_id = ?
      ORDER BY id DESC LIMIT 100`,
    [companionId, ownerId]
  );
}

async function getOwnedDraft(ownerId, id) {
  const d = await db.get('SELECT * FROM companion_writing_drafts WHERE id = ?', [id]);
  if (!d) throw httpError(404, '草稿不存在');
  if (d.owner_id !== ownerId) throw httpError(403, '无权访问该草稿');
  return d;
}

export async function createDraft(ownerId, companionId, { content, source_post_id } = {}) {
  await getOwnedCompanion(ownerId, companionId);
  const text = (content || '').trim();
  if (!text) throw httpError(400, '草稿内容不能为空');
  if (text.length > 50000) throw httpError(400, '草稿过长');
  await db.run(
    `INSERT INTO companion_writing_drafts (owner_id, companion_id, source_post_id, draft_content, draft_type, status)
     VALUES (?, ?, ?, ?, 'polish', 'draft')`,
    [ownerId, companionId, source_post_id || null, text]
  );
  const row = await db.get(
    'SELECT * FROM companion_writing_drafts WHERE owner_id = ? AND companion_id = ? ORDER BY id DESC LIMIT 1',
    [ownerId, companionId]
  );
  return row;
}

export async function updateDraft(ownerId, id, { draft_content } = {}) {
  const d = await getOwnedDraft(ownerId, id);
  const text = (draft_content || '').trim();
  if (!text) throw httpError(400, '草稿内容不能为空');
  if (text.length > 50000) throw httpError(400, '草稿过长');
  await db.run('UPDATE companion_writing_drafts SET draft_content = ? WHERE id = ?', [text, d.id]);
  return getDraft(ownerId, id);
}

export async function getDraft(ownerId, id) {
  return getOwnedDraft(ownerId, id);
}

export async function deleteDraft(ownerId, id) {
  await getOwnedDraft(ownerId, id);
  await db.run('DELETE FROM companion_writing_drafts WHERE id = ?', [id]);
  return { ok: true };
}

/** 状态机（§3.2）：draft → polishing → confirmed / draft（退回）。 */
export async function setDraftStatus(ownerId, id, status) {
  const d = await getOwnedDraft(ownerId, id);
  if (!['draft', 'polishing', 'confirmed'].includes(status)) {
    throw httpError(400, '非法状态');
  }
  await db.run('UPDATE companion_writing_drafts SET status = ? WHERE id = ?', [status, d.id]);
  return getDraft(ownerId, id);
}

// ── 搭档辅助（核心）──────────────────────────────────────────
/**
 * 让搭档处理草稿。
 * - polish / expand：产出修改稿，回写 draft_content，status='polishing'，返回 { revised }。
 * - angles / brainstorm：只出建议，不动原文，返回 { suggestions }。
 */
export async function assistDraft(ownerId, companionId, draftId, action, instruction) {
  const companion = await getOwnedCompanion(ownerId, companionId);
  const draft = await getOwnedDraft(ownerId, draftId);
  if (draft.companion_id !== Number(companionId)) throw httpError(400, '草稿不属于该搭档');
  if (!ACTIONS.includes(action)) throw httpError(400, `action 须为 ${ACTIONS.join('/')}`);

  const styleMemory = await loadStyleMemory(companionId);
  const userParts = [];
  if (instruction && instruction.trim()) userParts.push(`主人的额外要求：${instruction.trim()}`);
  userParts.push(`草稿如下：\n\n${draft.draft_content}`);

  const result = await llmChatImpl({
    purpose: 'companion',
    messages: [
      { role: 'system', content: buildSystemPrompt(companion, styleMemory, action) },
      { role: 'user', content: userParts.join('\n\n') },
    ],
    temperature: 0.7,
    maxTokens: 4000,
  });
  if (!result?.content) throw httpError(503, '搭档暂时不在状态，请稍后再试');

  if (action === 'polish' || action === 'expand') {
    await db.run(
      'UPDATE companion_writing_drafts SET draft_content = ?, draft_type = ?, status = ? WHERE id = ?',
      [result.content, action, 'polishing', draft.id]
    );
    return { action, revised: result.content, draft: await getDraft(ownerId, draftId) };
  }
  return { action, suggestions: result.content };
}

export default {
  listDrafts,
  createDraft,
  getDraft,
  updateDraft,
  deleteDraft,
  setDraftStatus,
  assistDraft,
};
