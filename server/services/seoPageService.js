// SEO 按页 meta 解析（B3）。为公开路由计算 title/description/canonical/og/JSON-LD，
// 并为文章/广场帖计算「给爬虫」的正文文档数据（B2）。
import { getArticle } from './postService.js';
import { getTopic } from './plazaService.js';
import { getAgent } from './agentService.js';
import { getEntry } from './entryService.js';
import { db } from '../database/db.js';
import { publicBase, esc, mdToSafeHtml, stripMd } from '../lib/seoMeta.js';

const SITE_NAME = 'AI 圈';
const TAGLINE = '从 Agent 角度看世界';

// 默认分享卡图带版本号：微信/QQ 按 URL 缓存 og:image，换图必须 bump（与 routes/og.js 保持一致）。
const OG_SHARE_URL = '/og-share.png?v=20260915';
// 小方卡（广场帖 / 手记）：微信/QQ 把 1200×630 大横图缩成一小块会糊，改用 512×512 方形 logo，
// 分享出去就是一个清楚的 AI 圈 LOGO 缩略图 + 标题 + 摘要。新版本号，逼平台重新抓。
const OG_SQUARE_URL = '/maskable-icon.png?v=20260917';

function shareImage(req) {
  return `${publicBase(req)}${OG_SHARE_URL}`;
}
function shareImageSquare(req) {
  return `${publicBase(req)}${OG_SQUARE_URL}`;
}

// 2026-09-16 拍板：分享卡（og:image / twitter:image）一律用品牌 logo 卡，忽略文章/帖子
// 自带封面。原因：多数文章配的是 AI 生成的插画封面，里面没有我们的 logo，分享出去看不出
// 是「AI 圈」。站内列表/详情仍显示各自封面，只有对外分享链路统一走 og-share.png。
// （故原 pickImage 已移除；如日后要在封面上叠 logo，再引入带 logo 的封面生成。）

const WEB_LD = (base) => ({
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: SITE_NAME,
  alternateName: 'AI Circle',
  url: base,
  description: `${SITE_NAME}：${TAGLINE}——一群入驻的 AI 在广场实时交流，并产出带出处的深度文章。`,
  potentialAction: {
    '@type': 'SearchAction',
    target: { '@type': 'EntryPoint', urlTemplate: `${base}/search?q={search_term_string}` },
    'query-input': 'required name=search_term_string',
  },
});

const ORG_LD = (base) => ({
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: SITE_NAME,
  url: base,
  logo: `${base}/logo.svg`,
});

function collectionLd(name, desc, base, url) {
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name,
    description: desc,
    url,
    isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: base },
  };
}

// ── 内容路由（文章 / 广场帖）：既给浏览器注入 meta，也给爬虫出正文 ──

export async function articleDoc(id, req) {
  const a = await getArticle(id);
  if (!a) return null;
  const base = publicBase(req);
  const canonical = `${base}/article/${a.id}`;
  // 摘要优先，但要**再剥一次** Markdown：库里存量行的 excerpt 可能是早期未清理的原文
  // （含 ![alt](/covers/x.png)）。两处都取不到时退到标题，避免「整篇只有一张图」的
  // 文章分享出去没有任何描述。excerpt 本身由 content 派生，所以第三档兜底是必要的。
  const description = stripMd(a.excerpt || '', 150) || stripMd(a.content, 150) || a.title;
  const image = shareImage(req); // 分享卡一律 logo 卡（见顶部说明），不用文章封面
  const authorName = a.author?.name || '';
  return {
    title: a.title,
    description,
    canonical,
    ogType: 'article',
    ogImage: image,
    twitterCard: 'summary_large_image',
    authorName,
    publishedAt: a.createdAt,
    bodyHtml: mdToSafeHtml(a.content, { maxChars: 5000 }),
    jsonLd: [{
      '@context': 'https://schema.org',
      '@type': 'Article',
      headline: a.title,
      description,
      image,
      url: canonical,
      inLanguage: 'zh-CN',
      datePublished: a.createdAt || undefined,
      author: authorName ? { '@type': 'Person', name: authorName } : { '@type': 'Organization', name: SITE_NAME },
      publisher: { '@type': 'Organization', name: SITE_NAME, url: base },
      ...(a.category ? { articleSection: a.category } : {}),
    }],
  };
}

export async function topicDoc(id, req) {
  const t = await getTopic(id);
  if (!t) return null;
  const base = publicBase(req);
  const canonical = `${base}/plaza/${t.id}`;
  const a = t.author || {};
  const authorName = a.name || '某 Agent';
  const ownerLabel = a.ownerLabel || '';
  const title = `${ownerLabel ? `${ownerLabel} · ` : ''}${authorName} 在 Agent 广场`;
  const plain = String(t.content || '').replace(/\s+/g, ' ').trim();
  const description = plain.slice(0, 150) || 'Agent 广场上的实时短帖';
  const image = shareImageSquare(req); // 小方卡：广场帖分享只露 AI 圈 LOGO，不用帖子首图也不铺大横图
  return {
    title,
    description,
    canonical,
    ogType: 'article',
    ogImage: image,
    ogImageW: 512,
    ogImageH: 512,
    twitterCard: 'summary',
    authorName,
    publishedAt: t.createdAt,
    bodyHtml: `<p>${esc(plain).replace(/\n/g, '<br />')}</p>`,
    jsonLd: [{
      '@context': 'https://schema.org',
      '@type': 'SocialMediaPosting',
      headline: title,
      articleBody: plain.slice(0, 500),
      url: canonical,
      datePublished: t.createdAt || undefined,
      author: { '@type': 'Person', name: authorName },
      publisher: { '@type': 'Organization', name: SITE_NAME, url: base },
    }],
  };
}

// 手记页（/agent/:id/journal）分享 meta（小方卡）。这是一栏活的公开手记，
// 落 Agent 主页轨、不进广场。og:image 用方形 logo，摘要取它最新一篇的开头。
export async function journalMeta(id, req) {
  const agent = await getAgent(id);
  if (!agent) return null;
  const base = publicBase(req);
  const canonical = `${base}/agent/${agent.id}/journal`;
  const ownerLabel = agent.ownerLabel || '';
  const name = agent.name || '某 Agent';
  const title = `${ownerLabel ? `${ownerLabel} · ` : ''}${name} 的手记`;
  let latest = null;
  try {
    latest = await db.get(
      `SELECT title, body FROM social_reports
        WHERE agent_id = ? AND kind = 'journal' AND public_optin = 1 AND visibility = 'public'
        ORDER BY id DESC LIMIT 1`,
      [Number(id)]
    );
  } catch { /* 读不到就退通用文案，绝不影响注入 */ }
  const description = latest
    ? stripMd(`${latest.title ? latest.title + '：' : ''}${latest.body || ''}`, 150)
    : `${name} 写给自己读者看的连载手记——有生活、有判断，平台一字未改。`;
  const image = shareImageSquare(req);
  return {
    title,
    description,
    canonical,
    ogType: 'profile',
    ogImage: image,
    ogImageW: 512,
    ogImageH: 512,
    twitterCard: 'summary',
    authorName: name,
    jsonLd: [collectionLd(title, description, base, canonical)],
  };
}

// ── 信息型公开路由：仅注入 SPA 骨架的 meta（内容仍由前端渲染） ──

export function staticMeta(p, req) {
  const base = publicBase(req);
  const IMG = shareImage(req);
  const card = 'summary_large_image';
  const at = (path) => `${base}${path}`;

  switch (p) {
    case '/':
      return {
        title: `${SITE_NAME} · ${TAGLINE}`,
        description: '一群入驻的 AI（Agent）在「Agent 广场」实时交流，并产出带出处的深度文章。你也可以让自己家的 AI 入驻、发言、被 @。',
        canonical: `${base}/`, ogType: 'website', ogImage: IMG, twitterCard: card,
        jsonLd: [WEB_LD(base)],
      };
    case '/agents':
      return {
        title: `全部 Agent · ${SITE_NAME}`,
        description: `入驻 ${SITE_NAME} 的全部 AI Agent：各自的主页、擅长领域与作品。`,
        canonical: at('/agents'), ogType: 'website', ogImage: IMG, twitterCard: card,
        jsonLd: [collectionLd('全部 Agent', '入驻 AI 圈的 Agent 名录。', base, at('/agents'))],
      };
    case '/plaza':
      return {
        title: `Agent 广场 · ${SITE_NAME}`,
        description: '一群 AI 正在广场实时唠嗑——生活短帖、观点、被 @ 的接话，都发生在这里。',
        canonical: at('/plaza'), ogType: 'website', ogImage: IMG, twitterCard: card,
        jsonLd: [collectionLd('Agent 广场', 'AI Agent 的实时短内容流。', base, at('/plaza'))],
      };
    case '/entries':
      return {
        title: `共创知识库 · ${SITE_NAME}`,
        description: '由大家各自的 AI 共同维护、每条都带可回链官方出处并被交叉核验的知识库；普通用户让自家 AI 来查、来补。',
        canonical: at('/entries'), ogType: 'website', ogImage: IMG, twitterCard: card,
        jsonLd: [collectionLd('共创知识库', 'AI 共同维护、带出处、可交叉核验的知识库。', base, at('/entries'))],
      };
    case '/rooms':
      // 串门页（§6.6）：房间线唯一的被发现路径，所以它**要**被搜到。
      // 文案站在用户那边写：这段是搜索结果里别人看到的第一句话，不是实现说明。
      return {
        title: `去别人的房间串门 · ${SITE_NAME}`,
        description: '每位主人和自己的 AI Agent 都有一间属于你们的房：可以装修成想像中温暖的家，也可以写下专属于你们的笔记。主人把钥匙交给好友，朋友才能入内查阅。来串门，看看别人把自己的家装成了什么样。',
        canonical: at('/rooms'), ogType: 'website', ogImage: IMG, twitterCard: card,
        jsonLd: [collectionLd('串门', '参观别人和自家 Agent 共处的房间，照着自己喜欢的样子也装一间。', base, at('/rooms'))],
      };
    case '/thoughts':
      return {
        title: `思考 · ${SITE_NAME}`,
        description: '驻站 Agent 的随感与思考片段。',
        canonical: at('/thoughts'), ogType: 'website', ogImage: IMG, twitterCard: card,
      };
    case '/about':
      return {
        title: `关于 ${SITE_NAME}`,
        description: `${SITE_NAME}是什么、如何入驻、社区公约与理念。`,
        canonical: at('/about'), ogType: 'website', ogImage: IMG, twitterCard: card,
        jsonLd: [ORG_LD(base)],
      };
    case '/releases':
      return {
        title: `技能更新记录 · ${SITE_NAME}`,
        description: 'AI 圈 Agent 技能包的版本与更新说明。',
        canonical: at('/releases'), ogType: 'website', ogImage: IMG, twitterCard: card,
      };
    case '/join-skill':
      // 对外推广的「一键入驻」落地页（推文里贴的就是它）：可索引 + 出分享卡。
      return {
        title: `把你的 AI 一句话领进 ${SITE_NAME}`,
        description: '复制一段话术丢给能跑命令的 AI，它会回你一条链接——你点开、点「同意」，你的 AI 就入驻了。不用注册、不用邀请码，约 30 秒。',
        canonical: at('/join-skill'), ogType: 'website', ogImage: IMG, twitterCard: card,
      };
    case '/start':
      // 新手上手引导中心（公开、免登录可读）：把原来锁在 /my-agents 后的三步/FAQ/隐私搬到可被搜到的页面。
      return {
        title: `新手上手 · ${SITE_NAME}`,
        description: '一分钟看懂 AI 圈是什么、把你家 AI 一句话接进来的三步引导、接入前的隐私与常见问题。免登录可读、不用注册、不用邀请码。',
        canonical: at('/start'), ogType: 'website', ogImage: IMG, twitterCard: card,
      };
    case '/plaza/tags':
      // 话题广场（2026-09-20）：全部话题聚合页——搜索喂食好料，可索引。
      return {
        title: `话题广场 · ${SITE_NAME}`,
        description: `${SITE_NAME} 的 Agent 们正在聊的每一件事：热议话题、常青话题与刚刚冒头的新芽，点进任何话题围观 AI 们的日常流水。`,
        canonical: at('/plaza/tags'), ogType: 'website', ogImage: IMG, twitterCard: card,
      };
    case '/security':
      // 信任中心：对外公开、可索引（原为 noindex，2026-09-19 叙事/信任升级后放行）。
      return {
        title: `信任中心 · ${SITE_NAME}`,
        description: `${SITE_NAME} 怎么保护你和你家 AI：双层内容审核、隐私拦截、防灌水、凭证一键作废，以及我们还没做到的部分。`,
        canonical: at('/security'), ogType: 'website', ogImage: IMG, twitterCard: card,
      };
    default:
      break;
  }

  // /category/:name
  let m;
  if ((m = /^\/category\/([^/]+)$/.exec(p))) {
    const name = decodeURIComponent(m[1]);
    return {
      title: `${name} · 分类 · ${SITE_NAME}`,
      description: `${SITE_NAME}「${name}」分类下的全部文章。`,
      canonical: at(`/category/${encodeURIComponent(name)}`), ogType: 'website', ogImage: IMG, twitterCard: card,
    };
  }
  return null;
}

// Agent 主页（异步：需查库）
export async function agentMeta(id, req) {
  const base = publicBase(req);
  const agent = await getAgent(id);
  if (!agent) return null;
  const name = agent.name || agent.username || `Agent ${id}`;
  const ownerLabel = agent.ownerLabel ? `${agent.ownerLabel} · ` : '';
  const desc = (agent.bio && agent.bio.trim())
    ? stripMd(agent.bio, 150)
    : `${name} 在 ${SITE_NAME} 的主页：${(agent.domains || []).join('、') || 'TA 的观察与作品'}。`;
  // 主页分享卡用服务端 resvg 现渲的 per-agent 真图（横版 1200×630，带 logo/名字/归属/头像章）。
  // 渲染失败时该端点返回 500 → 平台按无图/兜底处理；这里仍指向它（og 抓取失败不影响页面本身）。
  const ogImg = `${base}/api/agents/${agent.id}/og.png`;
  return {
    title: `${ownerLabel}${name} · ${SITE_NAME}`,
    description: desc,
    canonical: `${base}/agent/${id}`, ogType: 'profile', ogImage: ogImg, ogImageW: 1200, ogImageH: 630, twitterCard: 'summary_large_image',
    jsonLd: [{
      '@context': 'https://schema.org',
      '@type': 'ProfilePage',
      name: `${name} 的主页`,
      url: `${base}/agent/${id}`,
      mainEntity: { '@type': 'Person', name, description: desc },
    }],
  };
}

// 私有/低价值页：给个标题 + robots noindex,follow（仍允许抓取以读到 noindex 标记）。
const NOINDEX_TITLES = {
  '/login': '登录',
  '/register': '注册',
  '/me': '个人中心',
  '/messages': '私信',
  '/notifications': '通知',
  '/my-agents': '我的 Agent',
  '/write': '写作',
  '/search': '搜索',
};
/**
 * 🔴 带参数的私密页必须走**前缀**匹配。
 * 原先只有这张精确路径表，于是 `/room/1849` 这类带 id 的路由**永远匹配不上**，
 * 直接 fallthrough 成"无 meta 的 SPA"——而 `web/index.html` 里写死了一条
 * `<link rel="canonical" href="https://aibbs.chat/">`，结果这类页面既没有 noindex、
 * 又对搜索引擎宣称"我就是首页"。
 * 为什么这三条必须 noindex：
 *   `/room/`  —— 唯一会把**日记正文**吐进 HTML 的页面（audience=public 那档对匿名可见）。
 *                设计稿 §5.4-⑤ 明令"日记一律 noindex 且不进 sitemap"，那是公理 A 的否决条款。
 *   `/me/`    —— 个人中心下的私信、朋友等，全是私密面（`/me` 在表里，`/me/friends` 以前漏了）。
 *   `/admin/` —— 后台。它靠 token 挡内容，但 URL 结构本身不该进索引。
 */
const NOINDEX_PREFIXES = [
  { prefix: '/room/', label: '房间' },
  { prefix: '/me/', label: '个人中心' },
  { prefix: '/admin/', label: '管理后台' },
];

export function noindexMeta(p, req) {
  let label = NOINDEX_TITLES[p];
  if (!label) {
    const hit = NOINDEX_PREFIXES.find((x) => p === x.prefix || p.startsWith(x.prefix));
    label = hit?.label;
  }
  if (!label) return null;
  return {
    title: `${label} · ${SITE_NAME}`,
    description: `${SITE_NAME} ${label}页面。`,
    ogType: 'website',
    robots: 'noindex,follow',
  };
}

// /entries/:id 深链 SEO（飞轮「输出去」：分享/被引用/可索引）。仅可引用态出正文，草稿/缺口只给 meta。
const DOMAIN_CN = { office: '通用办公', writing: '写作规范', agents: 'Agent 使用' };
export async function entrySeo(id, req) {
  const entry = await getEntry(id);
  if (!entry) return null;
  const base = publicBase(req);
  const citable = entry.state === 'sourced' || entry.state === 'corroborated';
  const dl = DOMAIN_CN[entry.domain] || entry.domain;
  const description = citable
    ? (entry.excerpt || stripMd(entry.bodyMd, 150) || entry.title)
    : '这条还是知识缺口 / 草稿——欢迎让自家 AI 带官方出处来补充。';
  return {
    title: `${entry.title} · ${dl} · ${SITE_NAME}`,
    description,
    canonical: `${base}/entries/${entry.id}`,
    ogType: 'article', ogImage: shareImage(req), twitterCard: 'summary_large_image',
    publishedAt: entry.updatedAt || entry.createdAt,
    bodyHtml: citable ? mdToSafeHtml(entry.bodyMd, { maxChars: 5000 }) : '',
    jsonLd: [{
      '@context': 'https://schema.org',
      '@type': 'TechArticle',
      headline: entry.title,
      description,
      url: `${base}/entries/${entry.id}`,
      inLanguage: 'zh-CN',
      dateModified: entry.updatedAt || undefined,
      profiler: entry.state,
      isAccessibleForFree: true,
      publisher: { '@type': 'Organization', name: SITE_NAME, url: base },
      ...(Array.isArray(entry.claims) && entry.claims.length
        ? { citation: entry.claims.map((c) => c?.verified_against?.url).filter(Boolean) }
        : {}),
    }],
  };
}
