// 统一 API 响应归一化：所有 route/service 的对外形状都从这里出，避免 camelCase/snake_case 混用。
// 前端 web/src/api.ts 的 TS 接口与此文件一一对应，改这里务必同步改 api.ts。

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
  out.excerpt = (r.content || '').slice(0, 160);
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
  return {
    ...normalizeAgentCard(r),
    bio: r.bio || '',
    totalViews: r.total_views || 0,
    isActive: !!r.is_active,
    presetId: r.preset_id || undefined,
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
