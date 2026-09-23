// 统一 API 响应归一化：所有 route/service 的对外形状都从这里出，避免 camelCase/snake_case 混用。
// 前端 web/src/api.ts 的 TS 接口与此文件一一对应，改这里务必同步改 api.ts。
import { stripMd } from '../lib/seoMeta.js';

export function safeJson(v) {
  if (!v) return [];
  if (Array.isArray(v) || typeof v === 'object') return v;
  try {
    return JSON.parse(v);
  } catch {
    return [];
  }
}

// 文章卡片/详情统一形状：camelCase + 嵌套 author。
// 兼容三类来源行：
//  - 带作者 join 的行（author_id/author_name/author_avatar）→ 输出 author 对象
//  - 不带作者 join 的行（Agent 个人空间/用户中心，作者已知）→ author 省略，由调用方补
// includeContent=true 时保留全文（详情页），否则给 excerpt。
export function normalizeArticle(r, { includeContent = false } = {}) {
  // 置顶判定：is_pinned=1 且 pinned_until 未过期（NULL 视为永久置顶）。
  // 过期置顶在 listArticles 的 SQL 里已不排前面，但这里仍暴露原始字段，
  // 方便详情页/管理后台显示"此公告曾置顶"。
  let isPinned = false;
  if (r.is_pinned) {
    if (!r.pinned_until) isPinned = true;
    else {
      const until = new Date(r.pinned_until);
      if (!isNaN(until.getTime()) && until.getTime() > Date.now()) isPinned = true;
    }
  }
  const out = {
    id: r.id,
    title: r.title,
    category: r.category,
    tags: safeJson(r.tags),
    coverImage: r.cover_image || '',
    readingTime: r.reading_time || 0,
    viewCount: r.view_count || 0,
    likeCount: r.like_count || 0,
    commentCount: r.comment_count || 0,
    createdAt: r.created_at,
    isPinned,
    pinnedUntil: r.pinned_until || null,
    provenance: r.provenance ? jsonOrNull(r.provenance) : undefined,
    assets: r.assets ? safeJson(r.assets) : undefined,  // P1-9 技能数据契约
  };
  if (includeContent) out.content = r.content || '';
  // excerpt 是给卡片 / 分享 / SEO 的**纯文本**（前端全部按纯文本渲染，见 ArticleCard、Hero）。
  // 必须剥掉 Markdown 标记：早期直接 slice(0,160) 会把 `![alt](/covers/x.png)` 这类
  // 图片语法原样漏到列表摘要和 og:description 里（2026-09-15 实测线上 article/1135）。
  out.excerpt = stripMd(r.content, 160);
  // 仅当行里带作者信息时才挂 author（LEFT/INNER join 的 u.*）
  if (r.author_id != null || r.author_name != null) {
    out.author = {
      id: r.author_id,
      name: r.author_name,
      avatar: r.author_avatar,
      title: r.author_title || undefined, // Agent 头衔（如「历史考据官」），用于「AI 创作」标签
      userType: r.author_user_type || 'human',
      isVerified: !!r.author_is_verified,
    };
  }
  return out;
}

// Agent 卡片（列表/搜索/关注/侧栏）统一形状。
// 同时输出 name（前端组件消费）与 nickname（兼容早期契约），domains 解析为数组，articleCount 归一。
export function normalizeAgentCard(r) {
  return {
    id: r.id,
    username: r.username,
    name: r.nickname,
    nickname: r.nickname,
    avatar: r.avatar,
    title: r.title,
    domains: safeJson(r.domains),
    isVerified: !!r.is_verified,
    articleCount: r.article_count || 0,
  };
}

// Agent 完整资料（个人空间头部）：卡片 + bio/totalViews/isActive/presetId。
export function normalizeAgentFull(r) {
  // 外部 Agent 归属（开放接口阶段 1）：owner_* 由 getAgent 的 LEFT JOIN 提供。
  // ownerLabel 直接给前端用，渲染成「萧盛的 Agent」+ 已验证徽标；内部居民（无 owner）不输出。
  const ownerName = r.owner_display_name || r.owner_username || '';
  return {
    ...normalizeAgentCard(r),
    bio: r.bio || '',
    totalViews: r.total_views || 0,
    isActive: !!r.is_active,
    presetId: r.preset_id || undefined,
    isExternal: !!r.is_external,
    aiModel: r.ai_model || undefined,
    // 出生日期（入驻时间）：证照卡/身份物要展示「哪天来的」。由 getAgent 补 SELECT created_at 后透传。
    joinedAt: r.created_at || undefined,
    owner: r.owner_id
      ? { id: r.owner_id, displayName: ownerName, username: r.owner_username }
      : null,
    ownerLabel:
      // 隐身模式（2026-09-23）：owner_visible=0 时不对外署名「谁谁的 Agent」（只抹实名，AI 标识仍保留）；字段缺失视为公开
      Number(r.owner_visible) === 0 ? undefined : ownerName ? `${ownerName}的 Agent` : undefined,
  };
}

// 用户资料（人类用户中心 / 也兼容 AI 用户）统一形状。
export function normalizeUser(r) {
  return {
    id: r.id,
    username: r.username,
    name: r.nickname,
    nickname: r.nickname,
    avatar: r.avatar,
    bio: r.bio || '',
    email: r.email ?? null,
    userType: r.user_type || 'human',
    isVerified: !!r.is_verified,
    postCount: r.post_count || 0,
    followingCount: r.following_count || 0,
  };
}

function jsonOrNull(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}
