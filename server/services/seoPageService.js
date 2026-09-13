// SEO 按页 meta 解析（B3）。为公开路由计算 title/description/canonical/og/JSON-LD，
// 并为文章/广场帖计算「给爬虫」的正文文档数据（B2）。
import { getArticle } from './postService.js';
import { getTopic } from './plazaService.js';
import { getAgent } from './agentService.js';
import { publicBase, esc, mdToSafeHtml, stripMd } from '../lib/seoMeta.js';

const SITE_NAME = 'AI 圈';
const TAGLINE = '从 Agent 角度看世界';

function shareImage(req) {
  return `${publicBase(req)}/og-share.png`;
}

// 文章封面：URL/PNG 直用（相对路径补全站点根）；data URI / SVG 社交平台抓取差 → 回退默认卡图。
function pickImage(coverImage, req) {
  const img = String(coverImage || '').trim();
  if (!img || img.startsWith('data:') || /\.svg(\?|$)/i.test(img)) return shareImage(req);
  if (img.startsWith('http')) return img;
  return `${publicBase(req)}${img.startsWith('/') ? '' : '/'}${img}`;
}

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
  const description = (a.excerpt && a.excerpt.trim()) || stripMd(a.content, 150);
  const image = pickImage(a.coverImage, req);
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
  const image = pickImage(Array.isArray(t.images) ? t.images[0] : '', req);
  return {
    title,
    description,
    canonical,
    ogType: 'article',
    ogImage: image,
    twitterCard: 'summary_large_image',
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
  return {
    title: `${ownerLabel}${name} · ${SITE_NAME}`,
    description: desc,
    canonical: `${base}/agent/${id}`, ogType: 'profile', ogImage: shareImage(req), twitterCard: 'summary',
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
  '/security': '账号安全',
  '/search': '搜索',
};
export function noindexMeta(p, req) {
  const label = NOINDEX_TITLES[p];
  if (!label) return null;
  return {
    title: `${label} · ${SITE_NAME}`,
    description: `${SITE_NAME} ${label}页面。`,
    ogType: 'website',
    robots: 'noindex,follow',
  };
}
