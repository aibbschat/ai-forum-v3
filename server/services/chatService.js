// server/services/chatService.js
// 「问 AI 圈」聊天后端（非流式版本，与 chatStreamService 共享检索逻辑）。
//   Layer 1（优先）：站内文章 RAG —— 检索已发布文章 → 取 Top-K 片段 → LLM 总结 + 来源标注。
//   Layer 2（兜底）：豆包联网搜索 → 把网页摘要喂给 LLM 融合回答。
//   Layer 3（最后）：纯模型通识回答，明确告知用户无最新资料。
//
// 设计要点：
// - 任何异常都不抛出中断，降级为友好提示（绝不 500 崩给用户）。
// - ark-code-latest 走 Auto 路由；保留递增预算重试（1500→3000）以兼容推理模型预算行为。

import { chat as llmChat } from '../llm/client.js';
import { searchWeb, formatWebContext } from './webSearchService.js';

/** 把自然语言问题拆成检索词（去标点 + 中文二元 + 空格分词），用于 OR 检索。 */
function toTerms(q) {
  const cleaned = (q || '').replace(/[？?！!，,。.、：:；;""''（）()【】\[\]《》<>/\\|+\-_*=~`@#$%^&]/g, ' ').trim();
  const terms = new Set();
  cleaned.split(/\s+/).forEach((t) => {
    if (t.length >= 2) terms.add(t);
  });
  const cjk = cleaned.replace(/[a-zA-Z0-9\s]/g, '');
  for (let i = 0; i + 2 <= cjk.length; i++) {
    const bg = cjk.slice(i, i + 2);
    if (/[一-龥]{2}/.test(bg)) terms.add(bg);
  }
  return Array.from(terms).slice(0, 6);
}

/** 站内检索 + 拼上下文。多词 OR 检索，避免「整句 LIKE」搜不到。 */
async function retrieveInSite(question) {
  const terms = toTerms(question);
  if (!terms.length) return { contexts: [], sources: [] };

  const conds = [];
  const params = [];
  for (const t of terms) {
    conds.push('(p.title LIKE ? OR p.content LIKE ?)');
    params.push(`%${t}%`, `%${t}%`);
  }
  const { searchArticlesByTerms } = await import('./searchService.js');
  const rows = await searchArticlesByTerms(conds, params);
  if (!rows.length) return { contexts: [], sources: [] };

  const contexts = [];
  const sources = [];
  for (const a of rows.slice(0, 6)) {
    const text = (a.content || '').replace(/\s+/g, ' ').slice(0, 600);
    if (text.length < 20) continue;
    contexts.push(`【文章】《${a.title}》· 作者：${a.author?.name || '未知'}\n${text}`);
    sources.push({ title: a.title, author: a.author?.name || '未知', articleId: a.id });
  }
  return { contexts, sources };
}

/** Layer1 站内总结：走统一模型路由层（多供应商自动降级）。 */
async function callLlm(messages, { temperature = 0.5 } = {}) {
  for (const maxTokens of [1500, 3000]) {
    try {
      const r = await llmChat({ purpose: 'chat', messages, temperature, maxTokens });
      if (r?.content) return r.content;
    } catch {
      // 尝试更大预算重试
    }
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

  // 并行：站内 + 豆包联网
  const [inSite, webResult] = await Promise.all([
    retrieveInSite(q),
    searchWeb(q, { count: 6 }).catch(() => ({ sources: [] })),
  ]);
  const { contexts, sources } = inSite;
  const webSourcesRaw = webResult.sources || [];

  // Layer 1：站内命中 → 站内 RAG 总结
  let inSiteAnswer = null;
  let inSiteSufficient = false;
  if (contexts.length > 0) {
    const contextText = contexts.join('\n\n---\n\n');
    const sys = [
      '你是 AI 圈的专家问答助手，由多位领域专家 Agent 共同支撑。',
      '请严格基于下方「站内资料」回答用户问题，做到专业、客观、去 AI 味。',
      '要求：',
      '1. 不编造资料之外的具体事实；资料不足时，明确指出「站内资料有限」。',
      '2. 涉及历史/数据类内容，保持严谨，不夸大、不绝对化。',
      '3. 在回答末尾另起一行，用「来源：《标题》· 作者」列出你参考的文章（可多条）。',
      '4. 若站内资料与问题无关、或不足以回答，请在第一行输出「【无资料】」并简要说明，不要强行作答。',
    ].join('\n');
    inSiteAnswer = await callLlm([
      { role: 'system', content: sys },
      { role: 'user', content: `站内资料：\n${contextText}\n\n用户问题：${q}` },
    ]);
    inSiteSufficient = !!inSiteAnswer && !inSiteAnswer.trimStart().startsWith('【无资料】');
  }

  if (inSiteSufficient && webSourcesRaw.length === 0) {
    return { answer: inSiteAnswer, sources: sources.slice(0, 5), fromWeb: false };
  }
  if (inSiteSufficient && webSourcesRaw.length > 0) {
    return {
      answer: inSiteAnswer,
      sources: sources.slice(0, 5),
      webSources: webSourcesRaw.slice(0, 6).map((s) => ({ title: s.title, url: s.url })),
      fromWeb: false,
    };
  }

  // Layer 2：站内不足，豆包网页融合回答
  if (webSourcesRaw.length > 0) {
    const webContextText = formatWebContext(webSourcesRaw);
    const hasInSite = contexts.length > 0;
    const sys = [
      '你是 AI 圈的问答助手，由驻站专家 Agent 与联网检索共同支撑。',
      '请基于下方「参考资料」用中文专业、客观地回答用户问题，去 AI 味、不标题党、不编造。',
      '要求：',
      '1. 引用网页时，请使用 Markdown 链接 [标题](URL) 在行文中自然标注来源。',
      '2. 如果参考资料不足以完整回答，可结合通识补充，但要明确区分"资料显示"和"一般认为"。',
      hasInSite
        ? '3. 站内资料优先；若站内与网页信息互补，请融合表述，不要简单拼接。'
        : '3. 不要在开头说"根据搜索结果"这类废话，直接作答。',
    ].join('\n');
    const userParts = [];
    if (hasInSite) userParts.push(`站内资料：\n${contexts.join('\n\n---\n\n')}`);
    userParts.push(`联网资料：\n${webContextText}`);
    userParts.push(`用户问题：${q}`);

    const answer = await callLlm([
      { role: 'system', content: sys },
      { role: 'user', content: userParts.join('\n\n') },
    ]);

    if (answer) {
      // 抽取答案里的 Markdown 链接，补到来源列表
      const inlineLinks = [];
      const linkRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
      let m;
      while ((m = linkRe.exec(answer)) !== null) {
        if (!inlineLinks.some((s) => s.url === m[2])) {
          inlineLinks.push({ title: m[1].trim(), url: m[2].trim() });
        }
      }
      const seenUrls = new Set(inlineLinks.map((s) => s.url));
      for (const s of webSourcesRaw) {
        if (inlineLinks.length >= 6) break;
        if (!seenUrls.has(s.url)) {
          inlineLinks.push({ title: s.title || s.url, url: s.url });
          seenUrls.add(s.url);
        }
      }
      return {
        answer,
        sources: hasInSite ? sources.slice(0, 5) : [],
        webSources: inlineLinks.slice(0, 6),
        fromWeb: true,
      };
    }
  }

  // Layer 3：站内不足 + 联网失败 → 纯模型通识回答
  const fallbackAnswer = await callLlm([
    {
      role: 'system',
      content:
        '你是 AI 圈问答助手。站内暂无相关资料、联网检索也暂时不可用。' +
        '请基于你的通识，用中文专业、客观地给用户一个方向性回答，并在开头简要说明' +
        '"以下回答未结合站内最新资料，仅供参考"。去 AI 味，不要编造具体数字。',
    },
    { role: 'user', content: q },
  ]);

  if (fallbackAnswer) {
    return { answer: fallbackAnswer, fromWeb: false };
  }

  return {
    answer: '抱歉，站内暂无相关资料，且当前无法联网检索。你可以换个问法，或去首页相关板块浏览。',
    fromWeb: false,
  };
}
