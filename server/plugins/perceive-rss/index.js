// server/plugins/perceive-rss/index.js
// 感知源③：真实新闻 RSS（站内主力信源，2026-08）。
//
// 背景：原 perceive-web-search 依赖模型"自主联网"，但火山转发端点未真正开启联网，
// 模型只能凭知识截止前的数据回答 → 天天"检索静默"。RSS 直接抓取新闻源，
// 拿到的是真实的当天标题/链接/摘要，不依赖模型联网能力，稳定可控。
//
// 契约：default export { type:'perceive', perceive(agent, date) }，
//       返回 Topic[]（{title, source, url, relevance, summary, fullText?}）。
// 绝不向上抛错（感知铁律）：单源失败返回已抓到的部分。

import { getConfig } from './config.js';

// 各领域 RSS 源。一个源可服务多个领域标签（用于按 agent.domains 过滤）。
// 仅收录在服务器网络环境下验证可访问、当天更新、有摘要的源（2026-08-18 实测）。
// RSSHub 公共实例偶发 503，故同一类内容用多个独立官方/聚合源互为冗余。
const FEEDS = [
  // ── 科技 / AI / 互联网（官方源，稳定）──
  { url: 'https://www.solidot.org/index.rss', tags: ['科技', 'AI', '互联网', '软件', '国际', '社会'] },
  { url: 'https://www.ithome.com/rss/', tags: ['科技', '互联网', '软件', '消费'] },
  { url: 'https://www.36kr.com/feed', tags: ['科技', '互联网', '创业', '商业', '消费'] },
  { url: 'https://rsshub.rssforever.com/36kr/motif/327686782977', tags: ['科技', 'AI', '互联网', '未来'] },
  // ── 财经 / 经济 ──
  { url: 'https://rsshub.rssforever.com/cls/telegraph', tags: ['财经', '经济', '金融', '市场', '投资'] },
  { url: 'https://rsshub.rssforever.com/jin10/flash', tags: ['财经', '经济', '金融', '市场', '国际'] },
  // ── 社会 / 国际 ──
  { url: 'https://rsshub.rssforever.com/thepaper/featured', tags: ['社会', '民生', '制度', '公共'] },
  { url: 'https://rsshub.rssforever.com/cctv/world', tags: ['国际', '社会', '地缘', '全球'] },
  // ── 科学 / 文化 / 思维（心理/教育/认知类选题的现实土壤）──
  { url: 'https://rsshub.rssforever.com/guokr/scientific', tags: ['科学', '心理', '认知', '教育', '健康', '文化'] },
  { url: 'https://rsshub.rssforever.com/zhihu/daily', tags: ['文化', '社会', '心理', '认知', '生活', '观点'] },
];

// 领域别名：把 agent.domains 的大类映射到上面的 tags（与 perceive-seed 保持一致口径）
const DOMAIN_ALIASES = {
  科技: ['科技', 'AI', '互联网', '软件', '芯片', '技术', '机器人', '未来'],
  财经: ['财经', '经济', '商业', '金融', '投资', '消费', '市场', '创业'],
  社会: ['社会', '民生', '城镇', '制度', '公共', '安全', '观点'],
  国际: ['国际', '地缘', '全球', '社会'],
  心理: ['心理', '认知', '行为', '科学', '教育', '文化', '健康', '生活'],
  文化: ['文化', '艺术', '审美', '阅读', '文娱', '历史', '社会', '生活', '观点'],
  教育: ['教育', '学习', '成长', '认知', '心理', '科学', '生活', '观点'],
  未来: ['科技', 'AI', '互联网', '技术', '未来', '科学'],
  经济: ['经济', '财经', '商业', '市场', '消费', '金融'],
};

/** 判断某条 feed 是否与 agent 领域相关（别名展开后直接命中）。 */
function feedRelevant(feedTags, agentDomains) {
  if (!agentDomains || agentDomains.length === 0) return true; // 无领域信息不误杀
  return agentDomains.some((d) =>
    feedTags.includes(d) || (DOMAIN_ALIASES[d] || []).some((a) => feedTags.includes(a)));
}

/**
 *  1) 严格：agent 领域（含别名展开）直接命中 feed 标签；
 *  2) 兜底：若严格命中的源不足 2 个，把人文社科类 agent 放宽到
 *     "文化/社会/教育/国际"等通用源——这些是心理/认知/思维类选题的现实土壤，
 *     避免纯心理学 RSS 稀缺导致思维漫游无素材可写。
 */
function selectFeeds(agentDomains) {
  if (!agentDomains || agentDomains.length === 0) return FEEDS;
  const isHumanistic = agentDomains.some((d) =>
    ['心理', '认知', '行为', '文化', '教育', '历史', '社会'].includes(d));
  const strict = FEEDS.filter((f) =>
    feedRelevant(f.tags, agentDomains));
  if (strict.length >= 2 || !isHumanistic) return strict;
  // 兜底：补入社会/国际/科学/文化/科技类通用源
  const fallbackTags = ['社会', '国际', '科学', '文化', '科技'];
  const extra = FEEDS.filter((f) =>
    !strict.includes(f) && f.tags.some((t) => fallbackTags.includes(t)));
  return [...strict, ...extra];
}

/** 解码 HTML 实体 + 剥标签，返回纯文本。 */
function cleanText(s) {
  if (!s) return '';
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** 解析 RSS 2.0 / Atom，返回 [{title, link, summary, pubDate}] */
function parseFeed(xml) {
  const items = [];
  // RSS 2.0 <item>
  const rssItems = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const it of rssItems) {
    const title = cleanText((it.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
    const link = cleanText((it.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1]) ||
                 cleanText((it.match(/<link[^>]*href="([^"]+)"/i) || [])[1]);
    const desc = cleanText((it.match(/<description[^>]*>([\s\S]*?)<\/description>/i) || [])[1] || '');
    const dateStr = cleanText((it.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) || [])[1] || '');
    if (title) items.push({ title, link, summary: desc.slice(0, 500), pubDate: dateStr });
  }
  if (items.length) return items;
  // Atom <entry>
  const entries = xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (const it of entries) {
    const title = cleanText((it.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
    const link = cleanText((it.match(/<link[^>]*href="([^"]+)"/i) || [])[1]);
    const summ = cleanText((it.match(/<(?:summary|content)[^>]*>([\s\S]*?)<\/(?:summary|content)>/i) || [])[1] || '');
    if (title) items.push({ title, link, summary: summ.slice(0, 500), pubDate: '' });
  }
  return items;
}

/** 抓取单个 feed，失败返回 []（绝不抛错）。 */
async function fetchFeed(feed, cfg) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.perFeedTimeoutMs);
  try {
    const resp = await fetch(feed.url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; aiforum-perception/1.0)' },
      redirect: 'follow',
    });
    if (!resp.ok) return [];
    const xml = await resp.text();
    return parseFeed(xml).map((it) => ({ ...it, feedTags: feed.tags, feedUrl: feed.url }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function isRecent(pubDate, maxAgeHours) {
  if (!pubDate) return true; // 无日期的保留（部分源不给）
  const t = Date.parse(pubDate);
  if (!Number.isFinite(t)) return true;
  return Date.now() - t <= maxAgeHours * 3600 * 1000;
}

const plugin = {
  type: 'perceive',
  async perceive(agent, _date = new Date()) {
    const cfg = getConfig();
    const agentDomains = Array.isArray(agent?.domains) ? agent.domains : [];
    const relevantFeeds = selectFeeds(agentDomains);

    // 并行抓取所有相关源
    const perFeedItems = await Promise.all(relevantFeeds.map((f) => fetchFeed(f, cfg)));

    // 跨源轮询：轮流从每个源取一条，保证选题来源多样，
    // 不会被某一个更新最快的源（如 solidot）占满名额。
    const seen = new Set();
    const topics = [];
    const maxLen = Math.max(0, ...perFeedItems.map((arr) => arr.length));
    // 过滤明显的软文/营销标题（36kr feed 偶有"专属文章/神器/福利"等推广）
    const AD_PAT = /(专属文章|盯盘神器|福利|优惠券|下载APP|扫码|限时|加微信|公众号)/;
    for (let i = 0; i < maxLen && topics.length < cfg.maxTopics; i++) {
      for (const items of perFeedItems) {
        if (topics.length >= cfg.maxTopics) break;
        const it = items[i];
        if (!it) continue;
        if (!isRecent(it.pubDate, cfg.maxAgeHours)) continue;
        const title = it.title.trim();
        const key = title.toLowerCase();
        if (!key || seen.has(key) || AD_PAT.test(title)) continue;
        seen.add(key);
        topics.push({
          title: it.title,
          source: 'RSS 新闻',
          url: it.link,
          relevance: 0.85,
          summary: it.summary,
        });
      }
    }
    return topics;
  },
};

export default plugin;
