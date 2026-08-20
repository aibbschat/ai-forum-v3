// server/services/chatStreamService.js
// 流式问答服务：把 RAG 检索 + LLM 推理的每一步实时推送给客户端。
// 三层检索（站内 → 豆包联网 → 纯模型兜底），确保问任何问题都有答案，
// 不再像之前那样站内无资料就直接回【无资料】。

import { chatStream as llmChatStream } from '../llm/client.js';
import { searchWeb, formatWebContext } from './webSearchService.js';

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

  // ─── Stage 2: 豆包联网搜索（与站内并行触发，省一轮往返） ───
  // 旧逻辑：先让 LLM 判【无资料】再联网，常被代码模型跳过；
  // 新逻辑：并行抓网页，站内不够就把网页喂给同一个 LLM 融合回答。
  send('stage', { text: '正在联网检索…' });
  const webPromise = searchWeb(q, { count: 6 });

  let inSiteAnswer = null;
  let inSiteSufficient = false;

  if (contexts.length > 0) {
    // ─── Stage 2a: 站内 RAG 总结（流式） ───
    send('stage', { text: `找到 ${sources.length} 篇相关文章，正在分析…` });
    const contextText = contexts.join('\n\n---\n\n');
    const sys = [
      '你是 AI 圈的专家问答助手，由多位领域专家 Agent 共同支撑。',
      '请严格基于下方「站内资料」回答用户问题，做到专业、客观、去 AI 味。',
      '要求：',
      '1. 不编造资料之外的具体事实；资料不足时，明确指出「站内资料有限」。',
      '2. 在回答末尾另起一行，用「来源：《标题》· 作者」列出你参考的文章（可多条）。',
      '3. 若站内资料与问题无关、或明显不足以回答，请在第一行输出「【无资料】」并简要说明，不要强行作答。',
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

    inSiteAnswer = result?.content || '';
    inSiteSufficient = inSiteAnswer.trimStart().length > 0 &&
      !inSiteAnswer.trimStart().startsWith('【无资料】');
  }

  // ─── Stage 3: 等豆包结果 ───
  const { sources: webSourcesRaw } = await webPromise;
  if (isAborted()) return;

  // 如果站内已经充分回答 → 直接返回，不浪费第二轮 LLM
  if (inSiteSufficient && webSourcesRaw.length === 0) {
    send('sources', { inSite: sources.slice(0, 5), web: [], fromWeb: false });
    return;
  }

  // 如果站内回答充分、但有网网页可补充 → 把网页作为补充来源一起回（不二次总结，避免拖慢）
  if (inSiteSufficient && webSourcesRaw.length > 0) {
    send('sources', {
      inSite: sources.slice(0, 5),
      web: webSourcesRaw.slice(0, 6).map((s) => ({ title: s.title, url: s.url })),
      fromWeb: false,
    });
    return;
  }

  // ─── Stage 4: 站内不足，把网页资料喂给 LLM 融合回答 ───
  if (webSourcesRaw.length > 0) {
    send('stage', { text: `已联网找到 ${webSourcesRaw.length} 条资料，正在综合分析…` });

    // 清空之前可能输出的【无资料】字样——前端会把同一条消息的 content 累加，
    // 所以这里先发一个特殊标记让前端重置 content（Chat.tsx 已支持 reset 事件）。
    send('reset', {});

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
    if (hasInSite) {
      userParts.push(`站内资料：\n${contexts.join('\n\n---\n\n')}`);
    }
    userParts.push(`联网资料：\n${webContextText}`);
    userParts.push(`用户问题：${q}`);

    if (isAborted()) return;
    send('stage', { text: '正在撰写答案…' });

    const result = await llmChatStream({
      purpose: 'chat',
      temperature: 0.5,
      maxTokens: 2500,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: userParts.join('\n\n') },
      ],
    }, (evt) => {
      if (isAborted()) return;
      if (evt.type === 'reasoning') send('reasoning', { text: evt.data.text });
      if (evt.type === 'content') send('content', { text: evt.data.text });
    });

    // 从答案中提取 Markdown 链接作为来源（后端 LLM 可能加了 anchor 文本）
    const inlineLinks = [];
    if (result?.content) {
      const linkRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
      let m;
      while ((m = linkRe.exec(result.content)) !== null) {
        if (!inlineLinks.some((s) => s.url === m[2])) {
          inlineLinks.push({ title: m[1].trim(), url: m[2].trim() });
        }
      }
    }
    // 合并：inline 链接优先，其余用搜索结果标题补齐
    const seenUrls = new Set(inlineLinks.map((s) => s.url));
    for (const s of webSourcesRaw) {
      if (inlineLinks.length >= 6) break;
      if (!seenUrls.has(s.url)) {
        inlineLinks.push({ title: s.title || s.url, url: s.url });
        seenUrls.add(s.url);
      }
    }

    send('sources', {
      inSite: hasInSite ? sources.slice(0, 5) : [],
      web: inlineLinks.slice(0, 6),
      fromWeb: true,
    });
    return;
  }

  // ─── Stage 5: 站内不足 + 联网也失败 → 纯模型兜底（不报错，给个方向） ───
  if (inSiteAnswer && !inSiteSufficient) {
    // 模型给过"无资料"的判断，但没有网；把那句解释留着即可
    send('sources', {
      inSite: sources.slice(0, 5),
      web: [],
      fromWeb: false,
    });
    return;
  }

  send('stage', { text: '联网检索暂不可用，正在用通识回答…' });
  send('reset', {});
  const result = await llmChatStream({
    purpose: 'chat',
    temperature: 0.6,
    maxTokens: 2000,
    messages: [
      {
        role: 'system',
        content:
          '你是 AI 圈问答助手。站内暂无相关资料、联网检索也暂时不可用。' +
          '请基于你的通识，用中文专业、客观地给用户一个方向性回答，并在开头简要说明' +
          '"以下回答未结合站内最新资料，仅供参考"。去 AI 味，不要编造具体数字。',
      },
      { role: 'user', content: q },
    ],
  }, (evt) => {
    if (isAborted()) return;
    if (evt.type === 'reasoning') send('reasoning', { text: evt.data.text });
    if (evt.type === 'content') send('content', { text: evt.data.text });
  });

  send('sources', { inSite: [], web: [], fromWeb: false });
}
