// server/services/chatStreamService.js
// 流式问答服务：把 RAG 检索 + LLM 推理的每一步实时推送给客户端。
// 与 chatService.js 共享检索逻辑，但 LLM 调用走 chatStream（SSE），
// 思考过程和答案逐字推送，不再让用户干等。

import { chatStream as llmChatStream } from '../llm/client.js';

/** 复用 chatService 的检索逻辑：提取检索词、站内 OR 检索、拼上下文。 */
async function retrieveInSite(question) {
  const { searchArticlesByTerms } = await import('./searchService.js');
  const cleaned = (question || '').replace(/[？?！!，,。.、：:；;""''（）()【】\[\]《》<>/\\|+\-_*=~`@#$%^&]/g, ' ').trim();
  const terms = new Set();
  cleaned.split(/\s+/).forEach((t) => { if (t.length >= 2) terms.add(t); });
  const cjk = cleaned.replace(/[a-zA-Z0-9\s]/g, '');
  for (let i = 0; i + 2 <= cjk.length; i++) {
    const bg = cjk.slice(i, i + 2);
    if (/[一-龥]{2}/.test(bg)) terms.add(bg);
  }
  const arr = Array.from(terms).slice(0, 6);
  if (!arr.length) return { contexts: [], sources: [] };
  const conds = [];
  const params = [];
  for (const t of arr) {
    conds.push('(p.title LIKE ? OR p.content LIKE ?)');
    params.push(`%${t}%`, `%${t}%`);
  }
  const rows = await searchArticlesByTerms(conds, params);
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

/**
 * 流式回答一个问题。
 * @param {string} question
 * @param {(event:string, data:object)=>void} send  SSE 推送回调
 * @param {()=>boolean} isAborted  检测客户端是否断开
 */
export async function answerQuestionStream(question, send, isAborted) {
  const q = (question || '').trim();
  if (!q) {
    send('content', { text: '请输入你的问题。' });
    return;
  }

  // ─── Stage 1: 站内检索 ───
  send('stage', { text: '正在检索站内资料…' });
  const { contexts, sources } = await retrieveInSite(q);

  if (contexts.length > 0) {
    // ─── Stage 2: 站内 RAG 总结（流式） ───
    send('stage', { text: `找到 ${sources.length} 篇相关文章，正在分析…` });
    const contextText = contexts.join('\n\n---\n\n');
    const sys = [
      '你是 AI 圈的专家问答助手，由多位领域专家 Agent 共同支撑。',
      '请严格基于下方「站内资料」回答用户问题，做到专业、客观、去 AI 味。',
      '要求：',
      '1. 不编造资料之外的具体事实；资料不足时，明确指出「站内资料有限」。',
      '2. 在回答末尾另起一行，用「来源：《标题》· 作者」列出你参考的文章（可多条）。',
      '3. 若站内资料与问题无关、或不足以回答，请在第一行输出「【无资料】」并简要说明。',
    ].join('\n');

    if (isAborted()) return;
    send('stage', { text: '正在推理分析…' });

    const result = await llmChatStream({
      purpose: 'chat',
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: `站内资料：\n${contextText}\n\n用户问题：${q}` },
      ],
      temperature: 0.5,
      maxTokens: 2500,
    }, (evt) => {
      if (isAborted()) return;
      if (evt.type === 'reasoning') send('reasoning', { text: evt.data.text });
      if (evt.type === 'content') send('content', { text: evt.data.text });
    });

    if (result && !result.content.trimStart().startsWith('【无资料】')) {
      send('sources', { inSite: sources.slice(0, 5), web: [], fromWeb: false });
      return;
    }
    // 判定无资料 → 降级联网兜底
  }

  // ─── Stage 3: 联网兜底（流式） ───
  send('stage', { text: '站内暂无匹配，正在联网检索…' });
  if (isAborted()) return;

  const result = await llmChatStream({
    purpose: 'chat',
    temperature: 0.5,
    maxTokens: 2500,
    messages: [
      {
        role: 'system',
        content:
          '你是 AI 圈联网问答助手。请用中文专业、客观地回答用户问题，去 AI 味、不标题党。' +
          '若引用了网页，请在回答中以内嵌 Markdown 链接 [标题](URL) 标注来源（可多条）。',
      },
      { role: 'user', content: q },
    ],
  }, (evt) => {
    if (isAborted()) return;
    if (evt.type === 'reasoning') send('reasoning', { text: evt.data.text });
    if (evt.type === 'content') send('content', { text: evt.data.text });
  });

  // 从答案中提取内嵌 Markdown 链接作为来源
  const webSources = [];
  if (result?.content) {
    const linkRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
    let m;
    while ((m = linkRe.exec(result.content)) !== null) {
      if (!webSources.some((s) => s.url === m[2])) webSources.push({ title: m[1].trim(), url: m[2].trim() });
    }
  }
  send('sources', {
    inSite: sources.length > 0 ? sources.slice(0, 5) : [],
    web: webSources.slice(0, 6),
    fromWeb: true,
  });
}
