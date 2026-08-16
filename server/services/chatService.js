// server/services/chatService.js
// 「问 AI 圈」聊天后端：两层检索答案引擎。
//   Layer 1（优先）：站内文章 RAG —— 检索已发布文章 → 取 Top-K 片段 → DeepSeek 总结 + 来源标注。
//   Layer 2（兜底）：站内无命中 → 调 DeepSeek 联网检索（anthropic 兼容路由）总结，标注「网络检索」。
//
// 设计要点：
// - 文章是「成品」，自带 provenance/作者/质量门 —— 比直接读记忆层安全、出处可读。
// - 任何异常都不抛出中断，降级为友好提示（绝不 500 崩给用户）。
// - deepseek-v4-flash 为推理模型，content 预算不足会空 → 递增预算重试（1500→3000）。

import { search } from './searchService.js';

const DEEPSEEK_ENDPOINT = process.env.DEEPSEEK_ENDPOINT ?? 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_ANTHROPIC = process.env.DEEPSEEK_ANTHROPIC_ENDPOINT ?? 'https://api.deepseek.com/anthropic/v1/messages';
const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash';

/** 站内检索 + 拼上下文。 */
async function retrieveInSite(question) {
  const { articles } = await search({ q: question, type: 'article', limit: 8 });
  if (!articles?.length) return { contexts: [], sources: [] };

  const contexts = [];
  const sources = [];
  for (const a of articles.slice(0, 6)) {
    const text = (a.content || '').replace(/\s+/g, ' ').slice(0, 600);
    if (text.length < 20) continue;
    contexts.push(`【文章】《${a.title}》· 作者：${a.author?.name || '未知'}\n${text}`);
    sources.push({
      title: a.title,
      author: a.author?.name || '未知',
      articleId: a.id,
    });
  }
  return { contexts, sources };
}

/** 调用 DeepSeek chat/completions（带推理模型预算重试）。 */
async function callDeepSeek(messages, { temperature = 0.5 } = {}) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;
  for (const maxTokens of [1500, 3000]) {
    let resp;
    try {
      resp = await fetch(DEEPSEEK_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, temperature }),
      });
    } catch {
      continue;
    }
    if (!resp.ok) continue;
    const data = await resp.json().catch(() => null);
    const raw = data?.choices?.[0]?.message?.content?.trim();
    if (raw) return raw;
  }
  return null;
}

/** 联网兜底：调 DeepSeek anthropic 路由的 web_search 工具，返回 { answer, webSources }。 */
async function webFallback(question) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return null;
  try {
    const resp = await fetch(DEEPSEEK_ANTHROPIC, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [
          {
            role: 'user',
            content: `请用中文专业、客观地回答以下问题，去 AI 味、不标题党。问题：${question}`,
          },
        ],
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const blocks = Array.isArray(data?.content) ? data.content : [];
    const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim();
    const webSources = [];
    for (const b of blocks) {
      if (b?.type === 'web_search_tool_result' && Array.isArray(b.content)) {
        for (const c of b.content) {
          const t = c?.title ?? c?.page_title;
          const u = c?.url ?? c?.link;
          if (t && !webSources.some((s) => s.title === t)) {
            webSources.push({ title: String(t), url: u ? String(u) : undefined });
          }
        }
      }
    }
    if (text) return { answer: text, webSources: webSources.slice(0, 5) };
  } catch {
    return null;
  }
  return null;
}

/**
 * 回答一个问题。
 * @returns {Promise<{answer:string, sources?:Array, webSources?:Array, fromWeb:boolean}>}
 */
export async function answerQuestion(question) {
  const q = (question || '').trim();
  if (!q) return { answer: '请输入你的问题。', fromWeb: false };

  const { contexts, sources } = await retrieveInSite(q);

  // Layer 1：站内命中足够 → 站内 RAG 总结
  if (contexts.length > 0) {
    const contextText = contexts.join('\n\n---\n\n');
    const sys = [
      '你是 AI 圈的专家问答助手，由多位领域专家 Agent 共同支撑。',
      '请严格基于下方「站内资料」回答用户问题，做到专业、客观、去 AI 味。',
      '要求：',
      '1. 不编造资料之外的具体事实；资料不足时，明确指出「站内资料有限」。',
      '2. 涉及历史/数据类内容，保持严谨，不夸大、不绝对化。',
      '3. 在回答末尾另起一行，用「来源：《标题》· 作者」列出你参考的文章（可多条）。',
      '4. 若资料与问题无关，诚实说明并建议用户改用站内搜索或去相关板块。',
    ].join('\n');
    const user = `站内资料：\n${contextText}\n\n用户问题：${q}`;

    const answer = await callDeepSeek([
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ]);

    if (answer) {
      return { answer, sources: sources.slice(0, 5), fromWeb: false };
    }
    // 生成失败但有资料 → 退化为直接给资料列表
    return {
      answer: '站内找到相关资料，但总结生成失败。你可以查看以下文章：',
      sources,
      fromWeb: false,
    };
  }

  // Layer 2：站内无命中 → 联网兜底
  const web = await webFallback(q);
  if (web) {
    return { answer: web.answer, webSources: web.webSources, fromWeb: true };
  }

  return {
    answer: '抱歉，站内暂无相关资料，且当前无法联网检索。你可以换个问法，或去首页相关板块浏览。',
    fromWeb: false,
  };
}
