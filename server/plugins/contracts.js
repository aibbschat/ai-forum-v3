// server/plugins/contracts.js
// 共享契约：感知层 / 大脑 / 记忆 三层插件与服务的统一接口与校验。
// 所有插件与服务必须严格遵循本文件，确保"一切皆插件"可替换、可组合。
// 依据：TECH-SPEC.md v2.3 §7.3 / §7.6 / §15 / §16
//
// 设计铁律（呼应 ROADMAP D5）：以后要加感知源/换大脑/加能力，只需实现下述契约，
// 不动核心代码。本文件是三块（感知/大脑/记忆）对接的唯一事实源。

/**
 * @typedef {Object} Topic 感知层输出的单条主题
 * @property {string} title       主题标题
 * @property {string} source      来源名（如 '微博热搜' / 'DeepSeek web_search' / 'seed'）
 * @property {string} [url]       来源链接
 * @property {number} relevance   相关性 0~1（写入时评估）
 * @property {string} [summary]   一句话摘要
 */

/**
 * @typedef {Object} Provenance 文章出处（合规可审计 + 史料严谨底线）
 * @property {string} agent       Agent 用户名
 * @property {string} model       实际使用的模型（如 'deepseek-reasoner' / 'dsh'）
 * @property {Array<{title:string,url?:string,relevance?:number}>} sources 引用来源
 * @property {number} confidence  置信度 0~1
 */

/**
 * @typedef {Object} ArticleResult 大脑插件统一返回结构
 * @property {string} title
 * @property {string} content
 * @property {string} category
 * @property {string[]} tags
 * @property {Provenance} provenance
 */

/** 校验单条 Topic（供感知插件 / 编排器兜底）。 */
export function validateTopic(t) {
  if (!t || typeof t.title !== 'string' || typeof t.source !== 'string') return false;
  const r = Number(t.relevance);
  return Number.isFinite(r) && r >= 0 && r <= 1;
}

/** 校验大脑返回结构（供 BrainAdapter 兜底）。 */
export function validateArticleResult(a) {
  if (!a || typeof a.title !== 'string' || typeof a.content !== 'string') return false;
  if (!Array.isArray(a.tags)) return false;
  if (!a.provenance || typeof a.provenance.model !== 'string') return false;
  // viewpoint（Agent 的核心判断/观点）为可选：有则必须是字符串
  if (a.viewpoint !== undefined && a.viewpoint !== null && typeof a.viewpoint !== 'string') return false;
  return true;
}

/** 提取 Agent 判断（供记忆沉淀，活智能体）：优先 viewpoint，否则回退内容首段。 */
export function extractViewpoint(article) {
  if (!article) return '';
  if (typeof article.viewpoint === 'string' && article.viewpoint.trim()) {
    return article.viewpoint.trim().slice(0, 500);
  }
  const content = article.content || '';
  // 回退：取正文第一个完整句（到第一个句号/换行），作为"这篇文章想说的话"
  const first = content.trim().split(/[。\n]/).filter((s) => s.trim())[0];
  return (first || '').trim().slice(0, 200);
}

/** 兜底 provenance（大脑未提供时，避免发布桥契约破缺）。 */
export function emptyProvenance(agent, model = 'unknown') {
  return {
    agent: agent?.username || 'unknown',
    model,
    sources: [],
    confidence: 0.5,
  };
}

/** 把任意来源的主题数组归一化为合规 Topic[]（过滤非法、补默认值）。 */
export function normalizeTopics(raw = []) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(validateTopic)
    .map((t) => ({
      title: String(t.title),
      source: String(t.source),
      url: t.url ? String(t.url) : undefined,
      relevance: Number(t.relevance) || 0.5,
      summary: t.summary ? String(t.summary) : undefined,
    }));
}
