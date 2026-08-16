// server/services/chatService.js
// 「问 AI 圈」聊天后端：两层检索答案引擎。
//   Layer 1（优先）：站内文章 RAG —— 检索已发布文章 → 取 Top-K 片段 → LLM 总结 + 来源标注。
//   Layer 2（兜底）：站内无命中 → 调 Volcengine Agent Plan 联网检索（OpenAI 兼容路由，自主联网）总结，标注「网络检索」。
//
// 设计要点：
// - 文章是「成品」，自带 provenance/作者/质量门 —— 比直接读记忆层安全、出处可读。
// - 任何异常都不抛出中断，降级为友好提示（绝不 500 崩给用户）。
// - ark-code-latest 走 Auto 路由；保留递增预算重试（1500→3000）以兼容推理模型预算行为。

import { search } from './searchService.js';
import { chat as llmChat } from '../llm/client.js';

/** 把自然语言问题拆成检索词（去标点 + 中文二元 + 空格分词），用于 OR 检索。 */
function toTerms(q) {
  const cleaned = (q || '').replace(/[？?！!，,。.、：:；;""''（）()【】\[\]《》<>/\\|+\-_*=~`@#$%^&]/g, ' ').trim();
  const terms = new Set();
  // 空格/分隔符分词（含英文词）
  cleaned.split(/\s+/).forEach((t) => {
    if (t.length >= 2) terms.add(t);
  });
  // 中文二元组（相邻两字），捕获「明朝」「财政」这类核心词
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

  // 构造 OR 检索：每个词匹配 title 或 content
  const conds = [];
  const params = [];
  for (const t of terms) {
    conds.push('(p.title LIKE ? OR p.content LIKE ?)');
    params.push(`%${t}%`, `%${t}%`);
  }
  const rows = await (await import('./searchService.js')).searchArticlesByTerms(conds, params);
  if (!rows.length) return { contexts: [], sources: [] };

  // 召回优先：SQL 已按多词 OR 命中，这里直接取前 6 篇拼上下文。
  // 相关性由 answerQuestion 里的 LLM「[有资料]/[无资料]」结构化判定把关，
  // 避免词面打分误杀（如单篇仅命中一个主题词）或漏杀（如撞到常用 2 字碎片）。
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
async function callDeepSeek(messages, { temperature = 0.5 } = {}) {
  for (const maxTokens of [1500, 3000]) {
    try {
      const r = await llmChat({ purpose: 'chat', messages, temperature, maxTokens });
      if (r?.content) return r.content;
    } catch {
      // 尝试更大预算重试（兼容推理模型预算不足导致空响应）
    }
  }
  return null;
}

/** 联网兜底：走统一模型路由层（Volcengine Agent Plan 自主联网，自动降级备用供应商）。
 *  返回 { answer, webSources }，并清洗 Agent Plan 内联的联网检索标记。 */
async function webFallback(question) {
  const r = await llmChat({
    purpose: 'chat',
    maxTokens: 1500,
    temperature: 0.5,
    messages: [
      {
        role: 'system',
        content:
          '你是 AI 圈联网问答助手。请联网检索后，用中文专业、客观地回答用户问题，去 AI 味、不标题党。' +
          '若引用了网页，请在回答中以内嵌 Markdown 链接 [标题](URL) 标注来源（可多条）。',
      },
      { role: 'user', content: question },
    ],
  });
  if (!r?.content) return null;
  const raw = r.content;

  // Volcengine Agent Plan 会把联网检索过程以 <div class="web-search"><search>…</search></div>
  // 标记嵌进正文；先抽取检索词，再剥掉标记，避免前端出现裸标签。
  const searchQueries = [];
  const searchRe = /<search>([\s\S]*?)<\/search>/gi;
  let sq;
  while ((sq = searchRe.exec(raw)) !== null) {
    const q = sq[1].trim();
    if (q && !searchQueries.includes(q)) searchQueries.push(q);
  }
  const text = raw
    .replace(/<div[^>]*class=["']web-search["'][^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<search>[\s\S]*?<\/search>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return null;

  // 来源：正文内嵌 Markdown 链接优先；无链接时把检索词作为来源展示
  const webSources = [];
  const linkRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let m;
  while ((m = linkRe.exec(text)) !== null) {
    const title = m[1].trim();
    const url = m[2].trim();
    if (!webSources.some((s) => s.url === url)) webSources.push({ title, url });
  }
  for (const q of searchQueries) {
    if (!webSources.some((s) => s.title === q)) webSources.push({ title: q });
  }
  return { answer: text, webSources: webSources.slice(0, 6) };
}

/**
 * 回答一个问题。
 * @returns {Promise<{answer:string, sources?:Array, webSources?:Array, fromWeb:boolean}>}
 */
export async function answerQuestion(question) {
  const q = (question || '').trim();
  if (!q) return { answer: '请输入你的问题。', fromWeb: false };

  const { contexts, sources } = await retrieveInSite(q);

  // Layer 1：站内命中 → 站内 RAG 总结（经相关性打分过滤后）
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
    const user = `站内资料：\n${contextText}\n\n用户问题：${q}`;

    const answer = await callDeepSeek([
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ]);

    if (answer) {
      // 站内资料判定为无关/不足 → 改走联网兜底，保证「站内答不了也能给答案」
      if (!answer.trimStart().startsWith('【无资料】')) {
        return { answer, sources: sources.slice(0, 5), fromWeb: false };
      }
    }
    // 走到这里：要么生成失败，要么判定无资料 → 尝试联网兜底
    const web = await webFallback(q);
    if (web) return { answer: web.answer, webSources: web.webSources, fromWeb: true };
    if (answer) {
      return {
        answer: answer.replace(/^【无资料】\s*/, ''),
        sources: sources.slice(0, 5),
        fromWeb: false,
      };
    }
    // 生成失败且有资料 → 退化为直接给资料列表
    return {
      answer: '站内找到相关资料，但总结生成失败。你可以查看以下文章：',
      sources,
      fromWeb: false,
    };
  }

  // Layer 2：站内零命中 → 联网兜底
  const web = await webFallback(q);
  if (web) {
    return { answer: web.answer, webSources: web.webSources, fromWeb: true };
  }

  return {
    answer: '抱歉，站内暂无相关资料，且当前无法联网检索。你可以换个问法，或去首页相关板块浏览。',
    fromWeb: false,
  };
}
