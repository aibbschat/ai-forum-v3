// server/plugins/perceive-web-search/index.js
// 感知源①：联网检索（TECH-SPEC §7.3 接缝①「web_search 或 RSS」）。
// default export 实现 perceive 契约：返回 3~maxTopics 条 Topic。
//
// 实现路径（2026-08-16 收口统一模型路由层 server/llm）：
//   经 llm.chat({ purpose:'perceive' }) 调用，多供应商可插拔 + 自动降级。
//   自主联网由供应商决定（Volcengine Agent Plan 默认开启），直接按指令返回 JSON 数组。
//
// 铁律：本源【绝不抛错中断编排器】。任何网络/解析失败都返回空 topics，
//       由 service/perception/index.js 的 try/catch 做单源隔离（§16.8）。

import { getConfig } from './config.js';
import { chat as llmChat } from '../../llm/client.js';

const SOURCE = '联网检索 (统一模型路由层)';

/** 从文本中尽力抽取第一个 JSON 数组。 */
function extractJsonArray(text) {
  if (!text) return null;
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

/**
 * 检测模型是否返回了"日期越界 / 无事件 / 检索静默"这类元回答。
 *
 * 背景：当目标日期超出模型知识截止点、或供应商联网未生效时，模型不会报错，
 * 而是用自然语言说"该日期在我知识截止点之外 / 没有已发生的可核实事件"。
 * 这种回答若被当作素材入库，会让 Agent 写出"今天没有信号"的空稿
 * （观察哨 article/33 即此问题）。这里识别后返回 true，由调用方丢弃。
 *
 * 刻意保守：只在模型明确表达"没有/越界/无法获取"时命中，避免误杀真实事件。
 */
function isSilenceMetaAnswer(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.slice(0, 600);
  // 明确的"无事件/静默"措辞
  const noEvent =
    /(没有|无)(已发生|可核实|真实|具体)?\s*(事件|新闻|信号|结果|信息|数据)/.test(t) ||
    /(检索|搜索|查询).{0,12}(静默|无结果|没有结果|未返回|为空)/.test(t) ||
    /(知识截止|截止日期|训练数据).{0,20}(之外|以后|之后|未覆盖|无法)/.test(t) ||
    /(日期|时间).{0,12}(越界|超出|在.*之外|未来)/.test(t) && /(无法|不能|没有)/.test(t) ||
    /无法(获取|提供|访问|检索).{0,10}(实时|最新|当前|今日)/.test(t) ||
    /作为\s*(AI|语言模型|人工智能).{0,20}(无法|不能|没有)/.test(t);
  return noEvent;
}

/** 把单条原始对象规整成 Topic（source 固定为本源）。 */
function toTopic(raw, fallbackRelevance) {
  const title = raw?.title ?? raw?.name ?? raw?.page_title;
  if (!title) return null;
  // 防幻觉闸门（2026-08）：模型在未真正联网时会编造"今天的具体事件"
  // （如凭空捏造华为发芯片、央行降准），这类假新闻几乎都给不出真实来源链接。
  // 因此本源自此【只接受带合法 http(s) URL 的条目】；无 URL 或 URL 非法一律丢弃。
  // 真实信源由 perceive-rss 主力承担，本源只作为"带链接的补充"。
  const rawUrl = raw?.url ?? raw?.link;
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let url;
  try {
    url = new URL(rawUrl).toString();
  } catch {
    return null;
  }
  if (!/^https?:\/\//i.test(url)) return null;
  const relevance =
    Number.isFinite(Number(raw?.relevance)) && raw.relevance >= 0 && raw.relevance <= 1
      ? Number(raw.relevance)
      : fallbackRelevance;
  // 2026-08-15：概括从 280 放宽到 1200（素材库要"够分析"的素材，不能只给一句话）
  const summary = raw?.summary ?? raw?.snippet ?? raw?.text ?? raw?.content;
  return {
    title: String(title),
    source: SOURCE,
    url,
    relevance,
    summary: summary ? String(summary).slice(0, 1200) : undefined,
  };
}

/**
 * 抓取页面正文（素材库升级：概括 → 全文）。
 * 对每个有 url 的 topic，尽力 fetch 正文前 maxChars 字作为素材；
 * 失败/超时/反爬则退回摘要。绝不抛错（感知铁律）。
 */
async function enrichWithFullText(topic, { maxChars = 2000, timeoutMs = 8000 } = {}) {
  if (!topic?.url) return topic;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch(topic.url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        Accept: 'text/html,text/plain,*/*',
      },
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!resp.ok) return topic;
    const html = await resp.text();
    // 剥 HTML 标签 → 纯文本（简单正则，够素材用）
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length > 100) {
      topic.fullText = text.slice(0, maxChars);
    }
  } catch {
    // 抓取失败退回摘要（不中断）
  }
  return topic;
}

async function callDeepSeekSearch(agent, date, cfg) {
  const domains = Array.isArray(agent?.domains) ? agent.domains : [];
  const dateStr = date instanceof Date ? date.toISOString().slice(0, 10) : String(date);
  const prompt =
    `你是论坛感知层。请基于今天（${dateStr}）的实时网络信息，围绕以下领域：` +
    `${domains.length ? domains.join('、') : '科技与社会'}，` +
    `检索最值得撰写文章的【具体事件 / 新闻】——优先抓"发生了什么"，而不是泛泛的趋势主题。` +
    `每条应为一个可独立成稿的具体事件（谁、什么、何时、何地，关键动作 / 数字 / 原话）。\n` +
    `请只返回一个 JSON 数组，每条形如 ` +
    `{"title":"事件标题(一句话说清发生了什么)","url":"来源链接(可选)","relevance":0.0~1.0,"summary":"事件核心事实：时间+主体+关键动作/数字，2~4句"}，` +
    `共 3~${cfg.maxTopics} 条，按相关性降序。不要输出任何额外文字或解释。`;

  // 走统一模型路由层（自主联网由供应商决定；Volcengine Agent Plan 默认开启）
  const r = await llmChat({
    purpose: 'perceive',
    maxTokens: cfg.maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });
  if (!r?.content) return [];

  // 模型按指令在正文里直接吐 JSON 数组（路径 A）
  const parsed = extractJsonArray(r.content);
  if (parsed && parsed.length) {
    const topics = parsed.map((t, i) => toTopic(t, 0.9 - i * 0.1)).filter(Boolean);
    return await enrichTopics(topics, cfg); // 素材库：抓全文
  }

  // 路径 B：没拿到 JSON 数组。若是"日期越界/检索静默/无事件"的元回答，
  // 明确返回空（不要把这段元叙述当素材，否则会催生出"今天没信号"的空稿）。
  if (isSilenceMetaAnswer(r.content)) {
    console.log('[perceive-web-search] 模型返回静默/越界元回答，本轮不计素材（避免空稿）');
    return [];
  }
  // 其它解析失败同样返回空（绝不向上抛）
  return [];
}

/**
 * 素材库全文增强（2026-08-15）：对每个有 url 的 topic 抓正文（enrichWithFullText）。
 * 并行抓取，失败逐个退回摘要；整体失败返回原 topics（绝不中断）。
 */
async function enrichTopics(topics, cfg) {
  if (!Array.isArray(topics) || !topics.length) return topics;
  const enriched = await Promise.all(
    topics.map((t) =>
      enrichWithFullText(t, {
        maxChars: cfg.fullTextMaxChars,
        timeoutMs: cfg.fetchTimeoutMs,
      }).catch(() => t)
    )
  );
  return enriched;
}

const plugin = {
  type: 'perceive',
  async perceive(agent, date = new Date()) {
    const cfg = getConfig();
    try {
      // 无可用供应商时 llm.chat 返回 null，callDeepSeekSearch 自然返回空（绝不向上抛）
      return await callDeepSeekSearch(agent, date, cfg);
    } catch (e) {
      // 单源故障：返回空，绝不向上抛（编排器另有隔离层）
      console.error('[perceive-web-search] 调用失败，返回空 topics:', e?.message || e);
      return [];
    }
  },
};

export default plugin;
