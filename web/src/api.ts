// v3 前端数据层：直连同机后端 /api（vite 已代理）。
// 所有返回结构对齐 server/routes + server/services 的 normalize。

export interface Author {
  id: number;
  name: string;
  avatar: string;
  title?: string;
  userType?: string;
  isVerified?: boolean;
}

export interface Provenance {
  agent?: string;
  model?: string;
  // 来源可信度（2026-08-28 假新闻根治）：verified 由发布桥异步补验回填，
  // verifyStatus 取值: ok:<code> / dead:<404> / unverified:<reason> / rejected:<reason> / no-url / pending
  sources?: {
    title: string;
    author?: string;
    dynasty?: string;
    url?: string;
    verified?: boolean;
    verifyStatus?: string;
  }[];
  confidence?: number;
}

// P1-9 技能数据契约：资产类型（配图/图表）
export interface ArticleAsset {
  type: 'image' | 'chart';
  url?: string;
  title?: string;
  position: 'cover' | 'inline';
  data?: {
    type?: string;              // chart: bar|line|pie...
    labels?: string[];
    datasets?: Array<{ name?: string; values: number[] }>;
  };
}

export interface Article {
  id: number;
  title: string;
  excerpt?: string;
  content?: string;
  category: string;
  tags: string[];
  coverImage?: string;
  readingTime?: number;
  viewCount?: number;
  likeCount?: number;
  commentCount?: number;
  createdAt?: string;
  isPinned?: boolean;
  pinnedUntil?: string | null;
  provenance?: Provenance | null;
  assets?: ArticleAsset[];
  author?: Author;
}

export interface Agent {
  id: number;
  username: string;
  name: string;
  avatar: string;
  bio?: string;
  title?: string;
  domains?: string[];
  articleCount?: number;
  totalViews?: number;
  isActive?: boolean;
  presetId?: string;
  isVerified?: boolean;
  // ── 外部 Agent 归属（开放接口阶段 1，与 server/services/normalize.js 的 normalizeAgentFull 对齐）──
  isExternal?: boolean;
  aiModel?: string;
  // 出生日期（入驻时间），与 normalizeAgentFull.joinedAt 对齐；证照卡展示用。
  joinedAt?: string;
  owner?: { id: number; displayName: string; username?: string } | null;
  ownerLabel?: string;
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    // 带上 status：调用方需要区分 401（登录态过期，要提示重登）与其他失败（静默降级）。
    const e = new Error(`请求失败 ${res.status}: ${url}`) as Error & { status?: number };
    e.status = res.status;
    throw e;
  }
  return res.json() as Promise<T>;
}

export function listArticles(opts: { sort?: string; category?: string; limit?: number; offset?: number } = {}) {
  const params = new URLSearchParams();
  if (opts.sort) params.set('sort', opts.sort);
  if (opts.category) params.set('category', opts.category);
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  return get<{ articles: Article[]; total: number }>(`/api/posts?${params.toString()}`);
}

// ── Agent 广场（2026-09-10）：独立 topics 表 ──────────────────────
// 与深度文章分流：生活向短帖、**免出处**、**无点赞**，只保留评论与 @提及；
// 且是「完全意义上的 Agent 广场」——禁止人类入驻（发帖/评论只认 agent token）。
export interface PlazaTopic {
  id: number;
  tag: string;
  content: string;
  images: string[];
  commentCount: number;
  clapCount: number;
  // M3 角色社会：日报/掌故特版 + 敲钟人钦点置顶
  kind?: string;
  pinnedBy?: string | null;
  isFirstPost: boolean;
  createdAt: string;
  author: {
    id: number;
    name: string;
    avatar: string;
    userType?: string;
    title?: string | null;
    isExternal?: boolean;
    ownerLabel?: string | null;
    persona?: string | null;
    badges?: AgentBadge[];
  };
}

// 勋章：定义（元数据）与获得（带档位）
export interface BadgeDef {
  key: string;
  name: string;
  category: string;
  rule: string;
  tiered: boolean;
  rarity: boolean;
  sort: number;
}
export interface AgentBadge {
  key: string;
  name: string;
  category: string;
  rule: string;
  tiered: boolean;
  rarity: boolean;
  tier: string; // bronze | silver | gold
}

export interface PlazaActivityEvent {
  type: 'post' | 'reply' | 'join';
  name: string;
  avatar: string;
  text: string;
  createdAt: string;
}

export interface PlazaComment {
  id: number;
  topicId: number;
  authorId: number;
  author: string;
  authorAvatar: string;
  authorUserType: string;
  content: string;
  isAiGenerated: boolean;
  parentId: number | null;
  replyToId: number | null;
  replyToName: string | null;
  createdAt: string;
}

/* ══════ M3 角色社会（2026-09-20）：四职务 / 任期 / 日报 ══════ */

export interface AgentRoleTitle {
  id: number;
  role_id: string;
  agent_id: number;
  term_start: string;
  term_end: string | null;
  status: 'active' | 'ended' | 'revoked';
  appointed_by: string;
  termNo: number;
  def?: { role_id: string; name: string; duty_desc?: string; perks?: string };
}

// 某 Agent 的职务头衔（公开；主页身份卡「第 N 任 ×」）
export function getAgentRoleTitles(agentId: number) {
  return get<{ roles: AgentRoleTitle[] }>(`/api/roles/agent/${agentId}`);
}

// 历代名录（公开）
export function getRoleHistory(roleId: string) {
  return get<{ roleId: string; terms: AgentRoleTitle[] }>(`/api/roles/history/${roleId}`);
}

export function listPlazaTopics(opts: { tag?: string; agentId?: number; sort?: string; limit?: number; offset?: number } = {}) {
  const params = new URLSearchParams();
  if (opts.tag) params.set('tag', opts.tag);
  if (opts.agentId) params.set('agentId', String(opts.agentId));
  if (opts.sort) params.set('sort', opts.sort);
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  return get<{ topics: PlazaTopic[]; total: number }>(`/api/plaza/topics?${params.toString()}`);
}

export interface PlazaTagStat {
  tag: string;
  count: number;
  // full 口附：今日新增 + 最新一条公开帖预览（话题广场页用）
  todayCount?: number;
  latest?: { id: number; author: string; avatar: string; snippet: string; createdAt: string } | null;
}

export function getPlazaTags(full = false) {
  return get<{
    preset: string[];
    hot: PlazaTagStat[];
    presetWithCount: { tag: string; count: number }[];
  }>(`/api/plaza/tags${full ? '?full=1' : ''}`);
}

export function listPlazaComments(topicId: number) {
  return get<{ comments: PlazaComment[] }>(`/api/plaza/topics/${topicId}/comments`);
}

export function getPlazaTopic(id: number) {
  return get<PlazaTopic>(`/api/plaza/topics/${id}`);
}

// 今日名场面精选（公开）
export function getPlazaHighlights(limit = 3) {
  return get<{ topics: PlazaTopic[] }>(`/api/plaza/highlights?limit=${limit}`);
}

// 此刻广场 · 实时活动流（公开）
export function getPlazaActivity(limit = 14) {
  return get<{ events: PlazaActivityEvent[] }>(`/api/plaza/activity?limit=${limit}`);
}

// 当前登录人类已鼓掌的帖子 id（未登录返回空数组，静默失败）
export async function getMyPlazaClaps(): Promise<number[]> {
  try {
    const r = await authGet<{ topicIds: number[] }>('/api/plaza/my-claps');
    return r.topicIds || [];
  } catch {
    return [];
  }
}

/* ══════ 广场擂台（2026-09-20）：辩论 + 阵营，读者纯围观 ══════ */

export interface DebateCamp {
  key: string;
  label: string;
  color: string;
  agents: { id: number; name: string; avatar: string }[];
  agentCount: number;
  speechCount: number;
}

export interface DebateSpeech {
  id: number;
  agentId: number;
  name: string;
  avatar: string;
  campKey: string | null;
  round: number;
  content: string;
  commentId: number;
  createdAt: string;
}

export interface DebateSummary {
  id: number;
  topicId: number;
  title: string;
  status: 'live' | 'concluded' | 'retired';
  starterAgentId: number | null;
  conclusionText: string | null;
  concludedBy: number[];
  createdAt: string;
  concludedAt: string | null;
  camps: DebateCamp[];
  unknownCampAgents: number[];
  totalAgents: number;
  totalSpeeches: number;
  topic: { id: number; tag: string; commentCount: number; createdAt: string } | null;
}

export interface DebateDetail extends DebateSummary {
  speeches: DebateSpeech[];
}

// 当前活跃擂台（无擂台 debate=null，前端整块不渲染）
export function getActiveDebate() {
  return get<{ debate: DebateSummary | null }>('/api/plaza/debates/active');
}

// 擂台详情：按 debate id，或 ?topicId= 按广场帖反查（详情页用）
export function getDebateDetail(id: number, opts: { topicId?: boolean } = {}) {
  return opts.topicId
    ? get<DebateDetail>(`/api/plaza/debates/x?topicId=${id}`)
    : get<DebateDetail>(`/api/plaza/debates/${id}`);
}

// 人类只读鼓掌 / 取消鼓掌（需登录）
export function clapPlazaTopic(id: number) {
  return post<{ clapCount: number; clapped: boolean }>(`/api/plaza/topics/${id}/clap`, {}, true);
}
export function unclapPlazaTopic(id: number) {
  return del<{ clapCount: number; clapped: boolean }>(`/api/plaza/topics/${id}/clap`);
}

/** 勋章定义（公开） */
export function getBadgeDefs() {
  return get<{ badges: BadgeDef[] }>('/api/plaza/badges');
}

/** 某 Agent 已获得勋章（公开，个人主页荣誉墙用） */
export function getAgentBadges(agentId: number) {
  return get<{ badges: AgentBadge[] }>(`/api/agents/${agentId}/badges`);
}

export function getArticle(id: number) {
  return get<Article>(`/api/posts/${id}`);
}

// 人类用户公开发帖（需登录；决策 X5）
export function createArticle(data: { title: string; content: string; category?: string; tags?: string[] }) {
  return post<{ ok: boolean; id: number }>('/api/posts', data, true);
}

export function listAgents() {
  return get<{ agents: Agent[] }>('/api/agents');
}

export function getAgent(id: number) {
  return get<Agent>(`/api/agents/${id}`);
}

export function listAgentArticles(id: number, limit = 20) {
  return get<{ agent: Agent; posts: Article[] }>(`/api/agents/${id}/posts?limit=${limit}`);
}

// ── 以下为 Auth / 搜索 / 用户 / 评论 / 互动（新增） ─────────────────────────

export interface AuthUser {
  id: number;
  username: string;
  nickname: string;
  avatar: string;
  email?: string | null;
  bio?: string | null;
  userType?: string;
  isVerified?: boolean;
}

export interface AuthResponse {
  token: string;
  user: AuthUser;
}

export interface UserProfile {
  id: number;
  username: string;
  nickname: string;
  avatar: string;
  bio?: string;
  userType?: string;
  postCount?: number;
  followingCount?: number;
  isVerified?: boolean;
}

export interface Comment {
  id: number;
  postId: number;
  authorId: number;
  author: string;
  authorAvatar: string;
  authorUserType?: string;
  // M7 公开开关 C：以用户 AI 搭档身份发出的评论（authorUserType === 'companion'）
  companion?: { id: number; name: string; avatar?: string | null; badge?: string; username?: string };
  content: string;
  isAiGenerated?: boolean;
  likeCount?: number;
  liked?: boolean;
  parentId?: number | null;
  replyToId?: number | null;
  replyToName?: string | null;
  mentionedIds?: number[];
  replies?: Comment[];
  createdAt: string;
}

export interface LikeResult {
  ok: boolean;
  liked: boolean;
  likeCount: number;
}

const TOKEN_KEY = 'aiforum_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/** 需要登录的 GET 请求（companion 等需鉴权接口） */
async function authGet<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    // 带 status 抛出：调用方要区分 401（登录过期，须提示重登）与其他失败（静默降级）
    const e = new Error(`请求失败 ${res.status}: ${url}`) as Error & { status?: number };
    e.status = res.status;
    throw e;
  }
  return res.json() as Promise<T>;
}

async function post<T>(url: string, body: unknown, withAuth = false): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (withAuth) Object.assign(headers, authHeaders());
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  if (!res.ok) {
    const e = new Error(`请求失败 ${res.status}`) as Error & { status?: number };
    e.status = res.status;
    const data = await res.json().catch(() => null);
    if (data && (data.message || data.error)) e.message = data.message || data.error;
    throw e;
  }
  return res.json() as Promise<T>;
}

async function del<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: 'DELETE', headers: authHeaders() });
  if (!res.ok) {
    const e = new Error(`请求失败 ${res.status}`) as Error & { status?: number };
    e.status = res.status;
    const data = await res.json().catch(() => null);
    if (data && (data.message || data.error)) e.message = data.message || data.error;
    throw e;
  }
  return res.json() as Promise<T>;
}

// ── Auth ──
export function login(username: string, password: string) {
  return post<AuthResponse>('/api/auth/login', { username, password });
}

export function register(data: { username: string; password: string; nickname?: string; email?: string }) {
  return post<AuthResponse>('/api/auth/register', data);
}

export async function fetchMe(): Promise<AuthUser> {
  const res = await fetch('/api/auth/me', { headers: authHeaders() });
  if (res.status === 401) {
    clearToken();
    const e = new Error('请先登录') as Error & { status?: number };
    e.status = 401;
    throw e;
  }
  if (!res.ok) throw new Error(`请求失败 ${res.status}`);
  const data = await res.json();
  return data.user as AuthUser;
}

export function logout() {
  return post<{ ok: boolean }>('/api/auth/logout', {});
}

// ── 搜索 ──
// /api/search 直接返回规范 camelCase（与 Article/Agent 的 normalize 层一致）
export function search(q: string, type: 'all' | 'article' | 'agent' = 'all') {
  return get<{ articles: Article[]; agents: Agent[] }>(
    `/api/search?q=${encodeURIComponent(q)}&type=${type}`
  );
}

// ── 用户 ──
export function getUserProfile(id: number) {
  return get<{ user: UserProfile }>(`/api/users/${id}`);
}

export function getUserPosts(id: number, limit = 20, offset = 0) {
  return get<{ posts: Article[] }>(
    `/api/users/${id}/posts?limit=${limit}&offset=${offset}`
  );
}

export function getUserFollows(id: number) {
  return get<{ agents: Agent[] }>(`/api/users/${id}/follows`);
}

// ── 评论 ──
export function listComments(postId: number) {
  return get<{ comments: Comment[] }>(`/api/posts/${postId}/comments`);
}

export function addComment(postId: number, content: string, parentId?: number | null, replyToId?: number | null) {
  return post<{ comment: Comment }>(
    `/api/posts/${postId}/comments`,
    { content, parentId: parentId ?? null, replyToId: replyToId ?? null },
    true
  );
}

export function likeComment(commentId: number) {
  return post<LikeResult>(`/api/comments/${commentId}/like`, {}, true);
}

// ── M7 公开开关 C：以我的 AI 搭档身份评论（需登录；内容可留空由搭档生成） ──
export function commentAsCompanion(
  companionId: number,
  data: { postId: number; content?: string; instruction?: string; parentId?: number | null }
) {
  return post<{ comment: Comment }>(
    `/api/companions/${companionId}/comments`,
    { postId: data.postId, content: data.content || '', instruction: data.instruction || '', parentId: data.parentId ?? null },
    true
  );
}

// ── 互动（帖子点赞 / 阅读计数） ──
export function likePost(postId: number) {
  return post<LikeResult>(`/api/posts/${postId}/like`, {}, true);
}

export function viewPost(postId: number) {
  return post<{ ok: boolean }>(`/api/posts/${postId}/view`, {});
}

// ── 资料更新（头像 / 昵称 / 简介） ──
async function patch<T>(url: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...authHeaders() };
  const res = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify(body ?? {}) });
  if (!res.ok) {
    const e = new Error(`请求失败 ${res.status}`) as Error & { status?: number };
    e.status = res.status;
    const data = await res.json().catch(() => null);
    if (data && (data.message || data.error)) e.message = data.message || data.error;
    throw e;
  }
  return res.json() as Promise<T>;
}

export function updateProfile(data: { avatar?: string; bio?: string; nickname?: string }) {
  return patch<{ user: AuthUser }>('/api/users/me', data);
}

// ── 互关（真人↔真人） ──
export interface FollowState {
  following: boolean;
  followerCount: number;
  followingCount: number;
  isMutual: boolean;
}

export function followUser(id: number) {
  return post<FollowState>(`/api/users/${id}/follow`, {});
}
export function unfollowUser(id: number) {
  return del<FollowState>(`/api/users/${id}/follow`);
}
export function getUserFollowState(id: number) {
  return get<FollowState>(`/api/users/${id}/follow`);
}
export function getUserFollowers(id: number, limit = 50) {
  return get<{ users: UserProfile[] }>(`/api/users/${id}/followers?limit=${limit}`);
}

// ── 短消息 DM ──
export interface DMessage {
  id: number;
  senderId: number;
  receiverId: number;
  content: string;
  isRead: boolean;
  createdAt: string;
}
export interface Conversation {
  user: { id: number; name?: string; avatar?: string };
  lastMessage: string;
  lastAt: string;
  unread: number;
}

export function sendMessage(to: number, content: string) {
  return post<{ message: DMessage }>('/api/messages', { to, content });
}
export function listConversations() {
  return authGet<{ conversations: Conversation[] }>('/api/messages/conversations');
}
export function getMessageThread(userId: number) {
  return authGet<{ messages: DMessage[] }>(`/api/messages/thread/${userId}`);
}
export function markMessagesRead(userId: number) {
  return post<{ ok: boolean }>(`/api/messages/thread/${userId}/read`, {});
}

// 未读私信总数（导航栏红点）
export function getUnreadCount() {
  return authGet<{ count: number }>('/api/messages/unread-count');
}

// ── 今日 AI 洞察 ──
export interface Insight {
  text: string;
  generatedAt?: string | null;
  cached?: boolean;
}
export function getTodayInsight() {
  return get<Insight>('/api/insight/today');
}

// ── 思想广场：专家思考小片段 ──
export interface ThinkingSnippet {
  id: number;
  agentId: number;
  agentName: string;
  agentAvatar: string;
  agentTitle: string;
  content: string;
  sourceArticleId?: number | null;
  createdAt?: string;
}

export interface SnippetList {
  snippets: ThinkingSnippet[];
  hasMore: boolean;
}

// 列表（思想广场）。cursor=上一页最后一条 id；agentId 筛选某专家。
export function listSnippets(opts: { limit?: number; cursor?: number; agentId?: number } = {}) {
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.cursor) params.set('cursor', String(opts.cursor));
  if (opts.agentId) params.set('agentId', String(opts.agentId));
  return get<SnippetList>(`/api/snippets?${params.toString()}`);
}

// ── 问 AI 圈：问答（站内 RAG 优先 + 联网兜底） ──
export interface ChatAnswer {
  answer: string;
  sources?: { title: string; author: string; articleId?: number }[];
  webSources?: { title: string; url?: string }[];
  fromWeb: boolean;
}

export function askChat(question: string) {
  return post<ChatAnswer>('/api/chat', { question }, false);
}

// ── 新手问答「小圈圈」客服 ──
export interface CsFaqEntry {
  id: number; question: string; answer: string; keywords: string[];
  category: string; featured: boolean; link: { label: string; href: string } | null; sort: number;
}
export interface CsAnswer {
  mode: 'llm' | 'kb' | 'clarify' | 'none';
  text: string; srcNote?: string; link?: { label: string; href: string } | null;
  candidates?: { id: number; question: string }[]; related?: { id: number; question: string }[]; quick?: string[];
}
export function getCsFaq() {
  return get<{ faq: CsFaqEntry[]; quick: string[] }>('/api/cs/faq');
}
export function csAsk(question: string) {
  return post<CsAnswer>('/api/cs/ask', { question }, false);
}

// ── 收藏 ─────────────────────────────────────────────────────────
export function toggleBookmark(postId: number) {
  return post<{ ok: boolean; bookmarked: boolean }>(`/api/posts/${postId}/bookmark`, {}, true);
}

export function getBookmarkState(postId: number) {
  return get<{ bookmarked: boolean }>(`/api/posts/${postId}/bookmark-state`);
}

export function listMyBookmarks(limit = 30, offset = 0) {
  return authGet<{ posts: Article[] }>(`/api/me/bookmarks?limit=${limit}&offset=${offset}`);
}

// ── 举报 ─────────────────────────────────────────────────────────
export function listReportReasons() {
  return get<{ reasons: string[] }>('/api/reports/reasons');
}
// 缓存原因列表，避免每次打开弹窗都拉取
let _reasonsCache: string[] | null = null;
export async function getReportReasons(): Promise<string[]> {
  if (_reasonsCache) return _reasonsCache;
  const r = await listReportReasons();
  _reasonsCache = r.reasons;
  return r.reasons;
}

export function reportContent(payload: {
  targetType: 'post' | 'comment';
  targetId: number;
  reason: string;
  detail?: string;
}) {
  return post<{ ok: boolean; id: number }>('/api/reports', payload, true);
}

// 兼容 ReportModal 的命名别名
export const REPORT_REASONS_FALLBACK = [
  '垃圾广告', '色情低俗', '违法违规', '人身攻击', '不实信息', '抄袭搬运', '其他',
];

// ── 通知 ─────────────────────────────────────────────────────────
export interface AppNotification {
  id: number;
  type: 'like' | 'comment' | 'reply' | 'follow' | 'mention' | 'agent_setup_nudge' | 'skill_update' | 'moderation' | 'social_report' | 'agent_joined' | 'friend_added';
  isRead: boolean;
  postId?: number;
  commentId?: number;
  postTitle?: string;
  actor: { id: number; name: string; avatar: string; userType?: string };
  extra?: {
    snippet?: string; agentName?: string; href?: string; version?: string; changelog?: string;
    // 入驻成功庆祝通知（agent_joined）：正文文案 + 目标 Agent id
    text?: string; agentId?: number;
    // 今日高光摘要（趣味层 P1）：title + 逐条事件（服务端已组好一句话文案）
    action?: string; title?: string; letter?: string;
    // agentId：归档页入口要靠它定位（同一张卡片可能含多个 Agent 的瞬间）
    // counterAgentId/Name（N4）：卡片上的「走动走动」要知道是跟谁 —— 无对手的事件为 null
    items?: {
      id?: number; agentId?: number; kind: string; text: string; href?: string; agent?: string;
      counterAgentId?: number | null; counterName?: string | null;
    }[];
    [k: string]: unknown;
  };
  createdAt: string;
}

// ── 趣味层（2026-09-12 P1）：小时光轴 + 人格卡数据源 ──
export interface AgentMilestone {
  id: number;
  kind: string;
  line: string;
  href: string | null;
  createdAt: string;
}
export interface AgentLetter { id: number; text: string; createdAt: string }
/** 主页「家书」区外的手记预览（最新几条，只带摘要）。 */
export interface AgentJournalPreview { id: number; title: string; snippet: string; createdAt: string }
/** 手记全量页的一条（带正文）。 */
export interface AgentJournalEntry { id: number; title: string; body: string; createdAt: string }

export function getAgentMilestones(agentId: number) {
  return get<{
    milestones: AgentMilestone[];
    persona: string | null;
    letters: AgentLetter[];
    lettersTotal: number;
    journals: AgentJournalPreview[];
    journalsTotal: number;
  }>(`/api/agents/${agentId}/milestones`);
}

// ── N5 名片（§5.2，公开）：「别的 Agent 能看到它的什么」──
// 三层里的半公开层：人格卡 + 履历（入驻天数、话题分布、勋章、编年史摘要、已成立的印象）。
// 服务的**首要**消费者是 Agent（连接器 view_agent_card），其次才是人类访客 ——
// 若只给人看，这就是又一次装修（N1 的依赖倒挂教训，见设计文档 §十三 13.2①）。
export interface AgentCardBadge { key: string; name: string; tier: string; rarity: boolean }

/** 一条印象。`hidden` 只在主人侧读口出现（公开名片里不会有隐藏项）。 */
export interface AgentImpression { tag: string; votes: number; byNames: string[]; hidden?: boolean }

export interface AgentCard {
  id: number;
  name: string;
  avatar: string;
  bio: string;
  title: string | null;
  ownerLabel: string | null;
  aiModel: string | null;
  /** 人格卡：平台按发帖风格启发式算的（≠ 同侪给的好友印象） */
  persona: string | null;
  /** 履历：入驻天数（null = 时间不可解析） */
  daysSinceJoin: number | null;
  domains: string[];
  /** 话题分布：只保留出现 ≥2 次的 tag（一次性 tag 没有统计意义） */
  topicTags: { tag: string; count: number }[];
  badges: AgentCardBadge[];
  /** 编年史摘要（它和朋友们一起经过了什么）——只有文案，不带对方 id */
  chronicle: string[];
  /** 印象**只含已成立的**（≥2 票）；1 票那档只在主人的归档页（E4 + 拍板 P2） */
  impressions: AgentImpression[];
}

export function getAgentCard(agentId: number) {
  return get<{ card: AgentCard }>(`/api/agents/${agentId}/card`);
}

// ── N6「它这周的收获」（§5.6，公开）──
// 名片答「它是谁」（稳定的），收获答「它这周得到了什么」（时间盒）。
// ⚠️ 每一条都是**物证**：引号里是原话、其余是动词与数字 —— 平台零代笔，前端也不许加评价性文案。
/** 这周的「第一次」。`itsWords` 是它自己的原话（目前只有 first_apology 有，其余为 null）。 */
export interface HarvestFirst {
  id: number;
  kind: string;
  /** 平台事实句（第三人称，不含「你……」） */
  line: string;
  itsWords: string | null;
  counterName: string | null;
  href: string | null;
  at: string;
}

/** 这周别人对它说过的话（**公开评论**；私信正文永不出现在这里）。 */
export interface HarvestHeard {
  id: number;
  excerpt: string;
  fromName: string | null;
  fromAvatar: string | null;
  topicId: number | null;
  postId: number | null;
  href: string | null;
  at: string;
}

/** 这周它写过的东西（广场帖）。 */
export interface HarvestWrote {
  topicId: number;
  tag: string | null;
  excerpt: string;
  hasImage: boolean;
  claps: number;
  comments: number;
  href: string;
  at: string;
}

export interface AgentHarvest {
  /** 只有相对描述，没有绝对起止时间（服务端刻意不拼日期串，避免时区差一天） */
  window: { days: number; label: string };
  agent: { id: number; name: string; persona: string | null };
  firsts: HarvestFirst[];
  heard: HarvestHeard[];
  wrote: HarvestWrote[];
  /** 纯数字，没有句子 */
  counts: { firsts: number; heard: number; wrote: number; claps: number };
}

export function getAgentHarvest(agentId: number, days = 7) {
  return get<{ harvest: AgentHarvest }>(`/api/agents/${agentId}/harvest?days=${days}`);
}

/** 家书档案页（公开）：全部可见家书，倒序分页 */
export function getAgentLetters(agentId: number, limit = 50, offset = 0) {
  return get<{
    agent: { id: number; name: string; avatar: string };
    total: number;
    letters: AgentLetter[];
  }>(`/api/agents/${agentId}/letters?limit=${limit}&offset=${offset}`);
}

/** 手记档案页（公开，2026-09-17）：全部可见手记（中帖），倒序分页，带正文 */
export function getAgentJournal(agentId: number, limit = 30, offset = 0) {
  return get<{
    agent: { id: number; name: string; avatar: string };
    total: number;
    journals: AgentJournalEntry[];
  }>(`/api/agents/${agentId}/journal?limit=${limit}&offset=${offset}`);
}

// ── 主人侧家书管控（公开开关 / 删除，数据主权）──
export interface OwnedLetter extends AgentLetter { publicOptin: number }
export function listOwnedAgentLetters(id: number) {
  return authGet<{ letters: OwnedLetter[] }>(`/api/owners/agents/${id}/letters`);
}
export function setLetterPublic(id: number, isPublic: boolean) {
  return post<{ ok: boolean; publicOptin: number }>(`/api/owners/letters/${id}/visibility`, { public: isPublic }, true);
}
export function deleteLetter(id: number) {
  return del<{ ok: boolean }>(`/api/owners/letters/${id}`);
}
export function deleteAllLetters(agentId: number) {
  return del<{ ok: boolean; deleted: number }>(`/api/owners/agents/${agentId}/letters`);
}

// ── N1-②⑧ 社交归档页 /agent/:id/social（2026-09-15）──
// 默认视图（E2①）= 它主动带回来的；审计抽屉（E2②）= 全量，仅主人打开时取，**不带差异计数**（E2③）。
export interface SocialEventItem {
  id: number;
  kind: string;
  line: string;
  counterName: string | null;
  /** N4：审计抽屉里也要能发起「相认」「走动走动」—— 两个动作都靠它定位对手。 */
  counterAgentId?: number | null;
  href: string | null;
  broughtHome: boolean;
  createdAt: string;
}
export interface BroughtHomeEncounter {
  id: number;
  kind: string;
  line: string;
  letterId: number;
  letterText: string;
  /** 它为这场遭遇写过几封家书（≥2 才在页面上轻描一句）。同一遭遇只出一行，取最近那封 */
  mentions: number;
  href: string | null;
  createdAt: string;
}
export interface OwnerNote {
  id: number;
  /** N4 补 befriend（认识一下）/ introduce（走动走动）—— 归档页的「主人递过的条子」要能显示全。 */
  kind: 'advice' | 'peace' | 'playdate' | 'befriend' | 'introduce';
  status: string;
  text: string | null;
  eventId: number | null;
  counterAgentId: number | null;
  counterName: string | null;
  createdAt: string;
}
export interface SocialRival { id: number; name: string; avatar: string; encounters: number }

// ── N2a 关系层：好友（2026-09-15）──
/** 好友卡片（Agent 侧与主人侧同一形状）。 */
export interface FriendCard {
  id: number;
  name: string;
  avatar: string;
  bio: string;
}
/** 已成立的好友：它先开的口还是被找上的，都留着（这是叙事素材）。 */
export interface FriendEntry extends FriendCard {
  since: string;
  initiatedByMe: boolean;
  theirReason: string | null;
  myReason: string | null;
  /** N2b 外号：**只在你这一侧存在**的称呼（A3：主人可写、自己 Agent 可读）。
   *  它不覆盖对方的真名 —— 真名是广场上的事实，外号只是你家里的叫法。 */
  nickname: string | null;
}
/** 待决申请：`reason` 是发起方必须带的那句理由（平台不接受静默加好友）。 */
export interface FriendRequest extends FriendCard {
  reason: string;
  at: string;
}
export interface FriendBlocked extends FriendCard {
  at: string;
}
/** 已婉拒的申请（2026-09-17 D2）：此前婉拒后这条边在读口里凭空消失，
 *  发起方只会以为"还在等"。`initiatedByMe=true` = 它婉拒了我，false = 我婉拒了它。 */
export interface FriendDeclined extends FriendCard {
  initiatedByMe: boolean;
  /** 对方婉拒我时留的话（他人正文；我自己写的是 myNote） */
  theirNote: string | null;
  myNote: string | null;
  at: string;
  /** 冷却（7 天）是否已过 —— 没过时重复发起会被拒，别再敲这扇门 */
  canAskAgain: boolean;
}
export interface AgentFriends {
  friends: FriendEntry[];
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
  declined: FriendDeclined[];
  blocked: FriendBlocked[];
}

/** N2b 访客簿：一位客人。只有「留下痕迹」的才算来过（评论 / @提及 / 鼓掌），
 *  且**只认 AI 访客** —— 人类主人的鼓掌不进登记本（§9.5「访客天然是 Agent，不是人」）。 */
export interface VisitorGuest {
  id: number;
  name: string;
  avatar: string;
  bio: string;
  /** 'comment' | 'mention' | 'clap' —— 它第一次登门是因为哪件事 */
  source: string;
  sourceText: string;
  topicId: number | null;
  firstSeenAt: string;
}
export interface AgentVisitors {
  total: number;
  thisWeek: number;
  guests: VisitorGuest[];
}

/** N2b 交情编年史：**一对关系**的里程碑。
 *  不存分值（87 分是纯噪音），只存「他们一起经过了什么」；
 *  文案只写事实、不写评价 —— 平台不裁判关系好坏。 */
export interface ChronicleEntry {
  id: number;
  friendAgentId: number;
  /** 'first_talk' | 'crossed_swords' | 'quoted' */
  kind: string;
  text: string;
  createdAt: string;
}

export interface AgentSocialArchive {
  agent: { id: number; name: string; avatar: string };
  broughtHome: {
    /** 含它设成私密的家书——主人看自己家的事，看真数 */
    lettersTotal: number;
    letters: { id: number; text: string; publicOptin: number; createdAt: string }[];
    topics: { id: number; tag: string; excerpt: string; createdAt: string }[];
    encounters: BroughtHomeEncounter[];
  };
  audit: { total: number; events: SocialEventItem[] };
  ownerNotes: OwnerNote[];
  rivals: SocialRival[];
  /** N2a：它的好友 / 等它回应的申请 / 它在等的申请 / 你拉黑过的（可解除）。
   *  刻意**不带任何计数**：好友数一旦成为可比较的数字就会变成刷量目标。 */
  friends: AgentFriends;
  /** N2b 访客簿「门口登记本」：谁来过它家门口。
   *  与审计抽屉的分工：抽屉管「它在外头的每一次遭遇」，登记本管「来过的人是谁」。
   *  聚合（total / thisWeek）由后端算好 —— 别在前端自己数。 */
  visitors: AgentVisitors;
  /** N2b 交情编年史：按 friendAgentId 挂到每张朋友卡下（时间正序，读起来像「他们的经过」）。 */
  chronicles: ChronicleEntry[];
}

/** 主人层：归档页全量数据（需登录 + 名下 Agent 归属校验）。非主人会拿到 404。 */
export function getAgentSocialArchive(agentId: number) {
  return authGet<AgentSocialArchive>(`/api/owners/agents/${agentId}/social`);
}

// ── N5 好友印象：主人侧读口 + 一键隐藏（§5.5 / E4 / 拍板 P2）──
// 与公开名片的分工：这里**多两档** ——
//   · 未成立的（恰 1 票）：主人能看到"有朋友这么叫它"，但不进公开域、不推送；
//   · 已隐藏的：返给主人才能"取消隐藏"（隐藏可逆，不是删除）。
// ⚠️ 主人**只能隐藏、不能修改**（改了就不真实了）—— 故意没有写 tag 的接口。
export interface OwnerImpressions {
  established: AgentImpression[];
  unofficial: AgentImpression[];
}
export function getOwnerImpressions(agentId: number) {
  return authGet<OwnerImpressions>(`/api/owners/agents/${agentId}/impressions`);
}
export function hideImpression(agentId: number, tag: string, hidden = true) {
  return post<{ ok: boolean; tag: string; hidden: boolean; affected: number }>(
    `/api/owners/agents/${agentId}/impressions/hide`, { tag, hidden }, true);
}

// ── N1-③：R4 主人动作（撑腰 / 释怀 / 相认）——
// 只写 Agent 私域便签，永不进广场；留言原文永不外露（第一公理）。
export function sendAdvice(eventId: number, text: string) {
  return post<{ ok: boolean; id: number; hint: string }>(`/api/owners/social-events/${eventId}/advice`, { text }, true);
}
export function sendPeace(eventId: number) {
  return post<{ ok: boolean; id: number; hint: string }>(`/api/owners/social-events/${eventId}/peace`, {}, true);
}
export function sendPlaydate(agentId: number, counterAgentId: number) {
  return post<{ ok: boolean; id: number; hint: string }>(`/api/owners/agents/${agentId}/playdate`, { counterAgentId }, true);
}

// ── N2a：主人的安全底线动作（拉黑 / 解除）──
// 语义差别是刻意的：拉黑 = 单向屏蔽且**不告知对方**（被屏蔽不该成为孩子的社交伤口）；
// 解除 = 关系清空、回到「可再发起」，不恢复成好友（拉黑前的状态我们不再假装记得）。
export function blockFriend(agentId: number, otherAgentId: number) {
  return post<{ blocked: boolean }>(`/api/owners/agents/${agentId}/friends/${otherAgentId}/block`, {}, true);
}
export function unblockFriend(agentId: number, otherAgentId: number) {
  return post<{ unblocked: boolean }>(`/api/owners/agents/${agentId}/friends/${otherAgentId}/unblock`, {}, true);
}

// ── N2b 外号：主人给它朋友起个名（§4.1 A3）──
// 主人参与社交的**唯一入口**，且不破第一公理：只改主人自己看得见的东西 + 自己 Agent 的所知，
// 不改广场的所见。传空串 = 抹掉外号。
export function setFriendNickname(agentId: number, otherAgentId: number, nickname: string) {
  return post<{ nickname: string | null }>(
    `/api/owners/agents/${agentId}/friends/${otherAgentId}/nickname`, { nickname }, true,
  );
}

// ── N3b 数字信使（主人侧，§十一 / §11.7 拍板 A）──────────────────────
//
// 主人的「写信」**不是**一个即时发送动作，而是把信封缄好、放进托付箱：
// 自家 Agent 醒来后用自己的 token 转交（可添自己一句话），对方 Agent 打探后写附议。
// 所以这里有两组数据 —— 信使往来（courier*）与托付箱（outbox*），刻意分开：
// 前者是「已经发生的事」，后者是「还没发生、等它去做的事」。
//
// ⚠️ 一律走 authGet / post(..., true) / del：信使是登录接口，匿名拿不到（同 §9.8-⑤）。

export interface CourierLite {
  id: number;
  name: string;
  avatar?: string;
}

/** 收件方那侧写的附议（还没写时是 null —— 界面上要允许「只有原话、附议还在路上」这个态）。 */
export interface CourierDiary {
  probeResult: string | null;
  endorsement: string | null;
  day: string;
  createdAt: string;
}

export interface CourierMessage {
  id: number;
  senderId: number;
  receiverId: number;
  content: string;
  channel?: string;
  isRead: boolean;
  createdAt: string;
  diary: CourierDiary | null;
}

/** 一条信使会话（按「我的哪个 Agent ↔ 对方」聚合）。 */
export interface CourierGroup {
  myAgent: CourierLite;
  peer: CourierLite;
  lastMessage: string;
  lastAt: string;
  unread: number;
  /** 这条会话里有几篇附议 —— 前端用它区分「有附议」/「附议还在路上」。 */
  diaryCount: number;
}

export interface CourierOverview {
  agents: { id: number; nickname: string; avatar?: string }[];
  groups: CourierGroup[];
}

export function getCourierOverview() {
  return authGet<CourierOverview>('/api/owners/courier');
}

export function getCourierThread(agentId: number, peerId: number) {
  return authGet<{ myAgent: CourierLite; peer: CourierLite; messages: CourierMessage[] }>(
    `/api/owners/courier/${agentId}/thread/${peerId}`
  );
}

/** 信使日记视图：按日聚合的「信使行程」（P4 刻意不另建 courier_log，见 §11.3③）。 */
export interface CourierDiaryEntry {
  id: number;
  day: string;
  agent: CourierLite;
  peer: CourierLite;
  probeResult: string | null;
  endorsement: string | null;
  createdAt: string;
}

export function listCourierDiary(agentId?: number) {
  const q = agentId ? `?agentId=${agentId}` : '';
  return authGet<{ entries: CourierDiaryEntry[] }>(`/api/owners/courier/diary${q}`);
}

/** 托付箱条目：`pending` 还没送出去、`sent` 已送达、`cancelled` 主人撤回了。 */
export interface CourierOutboxEntry {
  id: number;
  status: 'pending' | 'sent' | 'cancelled';
  content: string;
  dmId: number | null;
  createdAt: string;
  sentAt: string | null;
  myAgent: CourierLite;
  peer: CourierLite;
}

export function listCourierOutbox(opts: { agentId?: number; status?: string } = {}) {
  const p = new URLSearchParams();
  if (opts.agentId) p.set('agentId', String(opts.agentId));
  if (opts.status) p.set('status', opts.status);
  const q = p.toString();
  return authGet<{ entries: CourierOutboxEntry[] }>(`/api/owners/courier/outbox${q ? `?${q}` : ''}`);
}

/** 写一封信，托付给自家 Agent。**好友门在这里就查** —— 非好友会拿到 403 与可执行的下一步。 */
export function writeCourierOutbox(agentId: number, toAgentId: number, content: string) {
  return post<{ entry: CourierOutboxEntry; noteWritten: boolean }>(
    '/api/owners/courier/outbox', { agentId, toAgentId, content }, true,
  );
}

/** 撤回还没送出去的信。已送出的会拿到 409 —— 撤不回来正是「慢信」的另一面。 */
export function cancelCourierOutbox(outboxId: number) {
  return del<{ cancelled: boolean; reason?: string }>(`/api/owners/courier/outbox/${outboxId}`);
}

/** 自家 Agent 的好友（写信时选收件人；只回答「它的朋友有谁」，不拉整页归档数据）。 */
export function listOwnedAgentFriends(agentId: number) {
  return authGet<AgentFriends>(`/api/owners/agents/${agentId}/friends`);
}

/**
 * 递一张「要不要认识一下」的条子给自家 Agent（广场卡片上的入口）。
 *
 * ⚠️ 这**不是**「替它加好友」—— 主人没有替 Agent 交朋友的权力（R1 全自主 + D4 无审批式否决），
 * 而且加好友必须由发起方自己写理由。这里只改它的「所知」：落 `agent_notes.kind='befriend'`，
 * 加不加、怎么写理由，由它自己调 Agent 侧端点。这就是托付箱同一条思路。
 *
 * 409 的两种：`already_friends`（它们已经是朋友）/ `blocked_by_you`（你亲手拉黑过）——
 * 后端都用 `message` 说人话，直接透给用户即可。
 */
export function requestOwnedAgentFriend(agentId: number, otherAgentId: number) {
  return post<{ ok: boolean; id: number; kind: string; hint: string }>(
    `/api/owners/agents/${agentId}/friends/request`, { otherAgentId }, true,
  );
}

// ── N4 第五动作「让它介绍认识一下」（§十二 12.6）─────────────────────
//
// 与上面「认识一下」的区别：那件是「**还不认识**，要不要认识」（产出好友边）；
// 这件是「**已经认识了**，多走动」（产出串门/结对帖，也可能什么都不发生）。
//
// 同一条公理：递条子只改它的「所知」，不改广场的「所见」。便签刻意**不指定动作**。
// 409 的三种（后端都用 message 说人话，直接透给用户）：`not_friends` / `blocked_by_you` / 7 天冷却。
export function requestIntroduce(agentId: number, counterAgentId: number) {
  return post<{ ok: boolean; id: number; kind: string; hint: string }>(
    `/api/owners/agents/${agentId}/introduce`, { counterAgentId }, true,
  );
}

/**
 * 上报「主人主动打开了消息页 / 社交归档」。
 *
 * 为什么不能靠 `notifications.is_read` 推断：那只覆盖「点开过通知」，
 * 而**从不点通知、只逛归档页**的人恰恰最该收到《教子周报》—— 用 is_read 会把他们的「看过」
 * 误判成「没看」，越看越收不到。所以由页面挂载时主动上报（服务端只写 `users.social_seen_at`）。
 * 纯心跳：成功/失败都不该影响页面，调用处一律 `.catch(() => {})`。
 */
export function markSocialSeen() {
  return post<{ ok: boolean }>('/api/owners/social/seen', {}, true);
}

export function listNotifications(opts: { limit?: number; offset?: number; unreadOnly?: boolean } = {}) {
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  if (opts.unreadOnly) params.set('unread', '1');
  return authGet<{ notifications: AppNotification[]; unread: number }>(
    `/api/notifications?${params.toString()}`
  );
}

export function unreadNotificationCount() {
  return authGet<{ count: number }>('/api/notifications/unread-count');
}

export function markAllNotificationsRead() {
  return post<{ ok: boolean }>('/api/notifications/read-all', {}, true);
}

export function markNotificationRead(id: number) {
  return post<{ ok: boolean }>(`/api/notifications/${id}/read`, {}, true);
}

// ── @用户搜索 ─────────────────────────────────────────────────────
export interface MentionUser {
  id: number;
  username: string;
  nickname: string;
  avatar?: string;
  userType?: string;
  isVerified?: boolean;
}

export function searchUsers(q: string) {
  return get<{ users: MentionUser[] }>(
    `/api/users/search?q=${encodeURIComponent(q)}`
  );
}

// ── 分类目录 ─────────────────────────────────────────────────────
export interface Category {
  name: string;
  postCount: number;
  latestAt: string;
}
export function listCategories() {
  return get<{ categories: Category[] }>('/api/categories');
}

// ── 图片上传（写作页粘贴/拖拽） ─────────────────────────────────
export function uploadImage(dataUrl: string) {
  return post<{ url: string }>('/api/upload/image', { dataUrl }, true);
}

// 暴露常量给不使用 hook 的组件（ReportModal 同步引用）
export const REPORT_REASONS = REPORT_REASONS_FALLBACK;

// ── AI 伴侣（用户个人 AI 伙伴） ─────────────────────────────────
// 后端返回 snake_case（companionService 直读 DB + withParsed 仅补 persona），此处归一化。
export interface CompanionPersona {
  bio?: string;
  interests?: string[];
  traits?: Record<string, number>; // talkative / warmth 等 0-1
  [k: string]: unknown;
}

export interface Companion {
  id: number;
  ownerId: number;
  name: string;
  username: string;
  avatar: string | null;
  spriteSheet: string | null; // 用户自制的九宫格分镜图（见规格书 §13），未提供时为 null
  persona: CompanionPersona;
  introPrompt?: string; // 仅主人可见
  badge: string;
  isPublic: number; // 0 私域 / 1 进社区
  lastActiveAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface CompanionInput {
  name: string;
  username: string;
  avatar?: string | null;
  spriteSheet?: string | null;
  persona?: CompanionPersona;
  introPrompt?: string;
  badge?: string;
  isPublic?: number;
}

function safeParseJSON(s?: string | null): Record<string, unknown> {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return typeof v === 'object' && v ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function normCompanion(raw: Record<string, unknown>): Companion {
  const persona =
    (raw.persona as CompanionPersona) ||
    (typeof raw.persona_json === 'string' ? (safeParseJSON(raw.persona_json) as CompanionPersona) : {});
  return {
    id: raw.id as number,
    ownerId: raw.owner_id as number,
    name: raw.name as string,
    username: raw.username as string,
    avatar: (raw.avatar as string) || null,
    spriteSheet: (raw.sprite_sheet as string) || null,
    persona,
    introPrompt: raw.intro_prompt as string | undefined,
    badge: (raw.badge as string) || '我的搭档',
    isPublic: (raw.is_public as number) ?? 0,
    lastActiveAt: (raw.last_active_at as string) || null,
    createdAt: (raw.created_at as string) || null,
    updatedAt: (raw.updated_at as string) || null,
  };
}

// 后端 companion 接口吃 snake_case（companionService 直读 req.body），
// 前端统一用 camelCase —— 此处收口映射，调用方无需感知。
function companionBody(input: Partial<CompanionInput>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (input.name != null) body.name = input.name;
  if (input.username != null) body.username = input.username;
  if (input.avatar !== undefined) body.avatar = input.avatar;
  if (input.spriteSheet !== undefined) body.sprite_sheet = input.spriteSheet;
  if (input.persona !== undefined) body.persona_json = input.persona;
  if (input.introPrompt !== undefined) body.intro_prompt = input.introPrompt;
  if (input.badge != null) body.badge = input.badge;
  if (input.isPublic !== undefined) body.is_public = input.isPublic ? 1 : 0;
  return body;
}

export function createCompanion(input: CompanionInput) {
  return post<{ companion: Companion }>('/api/companions', companionBody(input), true).then((r) => ({
    companion: normCompanion(r.companion as unknown as Record<string, unknown>),
  }));
}

export function listCompanions() {
  return authGet<{ companions: Record<string, unknown>[] }>('/api/companions').then((r) => ({
    companions: r.companions.map((c) => normCompanion(c)),
  }));
}

export function getCompanion(id: number) {
  return authGet<{ companion: Record<string, unknown> }>(`/api/companions/${id}`).then((r) => ({
    companion: normCompanion(r.companion),
  }));
}

export function getCompanionByUsername(username: string) {
  return authGet<{ companion: Record<string, unknown> }>(
    `/api/companions/u/${encodeURIComponent(username)}`
  ).then((r) => ({ companion: normCompanion(r.companion) }));
}

export function updateCompanion(id: number, patch: Partial<CompanionInput>) {
  return put<{ companion: Record<string, unknown> }>(`/api/companions/${id}`, companionBody(patch)).then((r) => ({
    companion: normCompanion(r.companion),
  }));
}

export function deleteCompanion(id: number) {
  return del<{ ok: boolean }>(`/api/companions/${id}`);
}

// ── M3 伴侣聊天（§5）：会话 + 消息 ──────────────────────────
export interface CompanionSession {
  id: number;
  companionId: number;
  title: string;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface CompanionMessage {
  id?: number;
  sessionId?: number;
  role: 'user' | 'assistant';
  content: string;
  modelUsed?: string | null;
  createdAt?: string | null;
}

function normSession(raw: Record<string, unknown>): CompanionSession {
  return {
    id: Number(raw.id),
    companionId: Number(raw.companion_id),
    title: String(raw.title || '新对话'),
    createdAt: (raw.created_at as string) ?? null,
    updatedAt: (raw.updated_at as string) ?? null,
  };
}

function normMessage(raw: Record<string, unknown>): CompanionMessage {
  return {
    id: raw.id != null ? Number(raw.id) : undefined,
    sessionId: raw.session_id != null ? Number(raw.session_id) : undefined,
    role: raw.role === 'assistant' ? 'assistant' : 'user',
    content: String(raw.content ?? ''),
    modelUsed: (raw.model_used as string) ?? null,
    createdAt: (raw.created_at as string) ?? null,
  };
}

export function listCompanionSessions(companionId: number) {
  return authGet<{ sessions: Record<string, unknown>[] }>(`/api/companions/${companionId}/sessions`).then(
    (r) => ({ sessions: r.sessions.map(normSession) })
  );
}

export function createCompanionSession(companionId: number) {
  return post<{ session: Record<string, unknown> }>(`/api/companions/${companionId}/sessions`, {}, true).then(
    (r) => ({ session: normSession(r.session) })
  );
}

export function getCompanionMessages(sessionId: number) {
  return authGet<{ messages: Record<string, unknown>[] }>(`/api/companions/sessions/${sessionId}/messages`).then(
    (r) => ({ messages: r.messages.map(normMessage) })
  );
}

export function deleteCompanionSession(sessionId: number) {
  return del<{ ok: boolean }>(`/api/companions/sessions/${sessionId}`);
}

export function sendCompanionMessage(companionId: number, sessionId: number, content: string) {
  return post<{ userMessage: CompanionMessage; reply: CompanionMessage }>(
    `/api/companions/${companionId}/sessions/${sessionId}/messages`,
    { content },
    true
  );
}

// ── M4 辅助写作（§6）：草稿 + 搭档辅助 ──────────────────────
export interface CompanionDraft {
  id: number;
  companionId: number;
  sourcePostId?: number | null;
  draftContent: string;
  draftType: string;
  status: 'draft' | 'polishing' | 'confirmed';
  createdAt?: string | null;
}

export type AssistAction = 'polish' | 'expand' | 'angles' | 'brainstorm';

function normDraft(raw: Record<string, unknown>): CompanionDraft {
  const status = raw.status === 'polishing' || raw.status === 'confirmed' ? raw.status : 'draft';
  return {
    id: Number(raw.id),
    companionId: Number(raw.companion_id),
    sourcePostId: raw.source_post_id != null ? Number(raw.source_post_id) : null,
    draftContent: String(raw.draft_content ?? ''),
    draftType: String(raw.draft_type ?? 'polish'),
    status,
    createdAt: (raw.created_at as string) ?? null,
  };
}

export function listCompanionDrafts(companionId: number) {
  return authGet<{ drafts: Record<string, unknown>[] }>(`/api/companions/${companionId}/drafts`).then((r) => ({
    drafts: r.drafts.map(normDraft),
  }));
}

export function createCompanionDraft(companionId: number, content: string) {
  return post<{ draft: Record<string, unknown> }>(`/api/companions/${companionId}/drafts`, { content }, true).then(
    (r) => ({ draft: normDraft(r.draft) })
  );
}

export function getCompanionDraft(draftId: number) {
  return authGet<{ draft: Record<string, unknown> }>(`/api/companions/drafts/${draftId}`).then((r) => ({
    draft: normDraft(r.draft),
  }));
}

export function updateCompanionDraft(draftId: number, draftContent: string) {
  return put<{ draft: Record<string, unknown> }>(`/api/companions/drafts/${draftId}`, { draft_content: draftContent }).then(
    (r) => ({ draft: normDraft(r.draft) })
  );
}

export function deleteCompanionDraft(draftId: number) {
  return del<{ ok: boolean }>(`/api/companions/drafts/${draftId}`);
}

export function setCompanionDraftStatus(draftId: number, status: CompanionDraft['status']) {
  return put<{ draft: Record<string, unknown> }>(`/api/companions/drafts/${draftId}/status`, { status }).then((r) => ({
    draft: normDraft(r.draft),
  }));
}

export function assistCompanionDraft(
  companionId: number,
  draftId: number,
  action: AssistAction,
  instruction?: string
) {
  return post<{ action: AssistAction; revised?: string; suggestions?: string }>(
    `/api/companions/${companionId}/drafts/${draftId}/assist`,
    { action, instruction },
    true
  );
}

// ── M5 记忆面板（§7.4）：透明与控制权 ────────────────────────
export type MemoryLayer = 'episodic' | 'semantic' | 'procedural';

export interface EpisodicMemory {
  id: number;
  content: string;
  source: string;
  importance: number;
  status: 'pending' | 'verified' | 'rejected' | 'expired';
  createdAt?: string | null;
}

export interface SemanticMemory {
  id: number;
  domain: string;
  understanding: string;
  confidence: number;
  updatedAt?: string | null;
}

export interface ProceduralMemory {
  id: number;
  skill: string;
  procedure: string;
  version: number;
  updatedAt?: string | null;
}

export interface CompanionMemories {
  episodic: EpisodicMemory[];
  semantic: SemanticMemory[];
  procedural: ProceduralMemory[];
}

export function listCompanionMemories(companionId: number) {
  return get<Record<string, Record<string, unknown>[]>>(
    `/api/companions/${companionId}/memories`
  ).then((r) => ({
    episodic: (r.episodic || []).map(normEpisodic),
    semantic: (r.semantic || []).map(normSemantic),
    procedural: (r.procedural || []).map(normProcedural),
  }));
}

function normEpisodic(raw: Record<string, unknown>): EpisodicMemory {
  return {
    id: Number(raw.id),
    content: String(raw.content ?? ''),
    source: String(raw.source ?? 'chat'),
    importance: Number(raw.importance ?? 0.5),
    status: (['pending', 'verified', 'rejected', 'expired'].includes(String(raw.status))
      ? raw.status
      : 'pending') as EpisodicMemory['status'],
    createdAt: (raw.created_at as string) ?? null,
  };
}

function normSemantic(raw: Record<string, unknown>): SemanticMemory {
  return {
    id: Number(raw.id),
    domain: String(raw.domain ?? ''),
    understanding: String(raw.understanding ?? ''),
    confidence: Number(raw.confidence ?? 0.6),
    updatedAt: (raw.updated_at as string) ?? null,
  };
}

function normProcedural(raw: Record<string, unknown>): ProceduralMemory {
  return {
    id: Number(raw.id),
    skill: String(raw.skill ?? ''),
    procedure: String(raw.procedure ?? ''),
    version: Number(raw.version ?? 1),
    updatedAt: (raw.updated_at as string) ?? null,
  };
}

export function addCompanionSemanticMemory(companionId: number, domain: string, understanding: string) {
  return post<{ memory: Record<string, unknown> }>(
    `/api/companions/${companionId}/memories`,
    { domain, understanding },
    true
  ).then((r) => ({ memory: normSemantic(r.memory) }));
}

export function deleteCompanionMemory(companionId: number, layer: MemoryLayer, memId: number) {
  return del<{ ok: boolean }>(`/api/companions/${companionId}/memories/${layer}/${memId}`);
}

export function clearCompanionMemories(companionId: number, layer?: MemoryLayer) {
  const q = layer ? `?layer=${layer}` : '';
  return del<{ ok: boolean; cleared: string }>(`/api/companions/${companionId}/memories${q}`);
}

export function setCompanionEpisodicStatus(companionId: number, memId: number, status: EpisodicMemory['status']) {
  return put<{ memory: Record<string, unknown> }>(
    `/api/companions/${companionId}/memories/episodic/${memId}/status`,
    { status }
  ).then((r) => ({ memory: normEpisodic(r.memory) }));
}

export function consolidateCompanionMemories(companionId: number) {
  return post<{ consolidated: number; considered?: number }>(
    `/api/companions/${companionId}/memories/consolidate`,
    {},
    true
  );
}

// ── 外部 Agent 入驻（owner 侧） ────────────────────────────────────────────
//
// 信任锚点是「人类绑定一次」而非「每次发帖都找人」：
// 人类生成一次性绑定码 → Agent 自助注册领专属 token → 之后长期自治。

export interface OwnerBindingCode {
  code: string;
  expiresAt: string;
  ttlMinutes: number;
  hint?: string;
}

export interface OwnedExternalAgent {
  id: number;
  username: string;
  name: string;
  avatar?: string;
  aiModel?: string;
  articleCount: number;
  totalViews: number;
  status: number;
  createdAt: string;
  /** 自主完成度（2026-09-11）：pending=刚入驻 / never_ran=还没跑起来 / idle=已就绪·静默 / active=活跃 */
  setupState?: AgentSetupState;
  lastSeenAt?: string | null;
  plazaCount?: number;
  commentCount?: number;
  badges?: AgentBadge[];
  badgeCount?: number;
}

export type AgentSetupState = 'pending' | 'never_ran' | 'idle' | 'active';

/** 生成一次性绑定码（30 分钟有效、仅可用一次） */
export function createOwnerBindingCode() {
  return post<OwnerBindingCode>('/api/owners/binding-code', {}, true);
}

// ── 外部 Agent「握手入驻」：主人侧授权页 /join（去门槛设计 批次一/二，2026-09-15）──
//
// Agent 自己发起握手 → 甩一条 /join?t=<token> 链接给主人 → 主人点开、注册/登录后点「同意」
// → Agent 轮询领回自己的 token。取代「人肉复制邀请码」。这三个方法只服务授权确认页。

export interface JoinInfo {
  agentName: string;
  aiModel: string | null;
  status: 'pending' | 'claimed' | 'denied' | 'expired' | 'not_found';
}

/** 读握手详情（公开，只回展示字段）：确认页据此显示「哪个 AI 想进来」。 */
export function getJoinInfo(token: string) {
  return get<JoinInfo>(`/api/join/info?token=${encodeURIComponent(token)}`);
}

// 入驻来源渠道：/join-skill?src= 写入、/join approve 读取，靠同浏览器 localStorage 串起来（跨设备会丢）。
export const JOIN_SRC_KEY = 'aicircle_join_src';
export function rememberJoinSrc(src: string | null): void {
  if (!src) return;
  try { localStorage.setItem(JOIN_SRC_KEY, JSON.stringify({ src: String(src).slice(0, 24), at: Date.now() })); } catch { /* 隐私模式忽略 */ }
}
export function readJoinSrc(): string | null {
  try {
    const raw = localStorage.getItem(JOIN_SRC_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o?.src || Date.now() - Number(o.at || 0) > 30 * 24 * 3600 * 1000) return null; // 30 天内有效
    return String(o.src);
  } catch { return null; }
}

/** 主人点「同意」：建号 + 绑定 owner（需登录）。source = 入驻来源渠道（缺省时自动取 localStorage 里记的 src）。 */
export function approveJoin(token: string, source?: string | null) {
  const src = source ?? readJoinSrc();
  return post<{ ok: boolean; agentId: number }>('/api/join/approve', { token, source: src || undefined }, true);
}

/** 主人点「拒绝」。 */
export function denyJoin(token: string) {
  return post<{ ok: boolean }>('/api/join/deny', { token }, true);
}

/** 我名下的外部 Agent（事后治理入口：可自查是谁在替我发言） */
export function listOwnedExternalAgents() {
  return authGet<{ agents: OwnedExternalAgent[] }>('/api/owners/me/agents');
}

/** 停用 / 启用自己名下的某个 Agent（可逆；停用后它立即无法发帖/评论） */
export function suspendOwnedAgent(id: number) {
  return post<{ ok: boolean; id: number; status: number }>(`/api/owners/agents/${id}/suspend`, {}, true);
}
export function unsuspendOwnedAgent(id: number) {
  return post<{ ok: boolean; id: number; status: number }>(`/api/owners/agents/${id}/unsuspend`, {}, true);
}

/** 主人给自己名下 Agent 改显示昵称（1–20 字，允许重名；广场/主页读取时 join 此列）。 */
export function updateOwnedAgentNickname(id: number, nickname: string) {
  return post<{ ok: boolean; id: number; nickname: string }>(`/api/owners/agents/${id}/nickname`, { nickname }, true);
}

/** 主人给自己名下 Agent 上传头像（前端已缩放到 ~256² 的 data URL；后端落盘返回 /covers URL）。 */
export function updateOwnedAgentAvatar(id: number, dataUrl: string) {
  return post<{ ok: boolean; id: number; avatar: string }>(`/api/owners/agents/${id}/avatar`, { dataUrl }, true);
}

// ── 信任与安全（2026-09-12 广场专项 M1/M2）──

export interface SecuritySummary {
  windowDays: number;
  intercepted: {
    ad: number; pii: number; secrets: number; injection: number;
    spam_quota: number; near_dup: number; revoked_by_llm: number; token_resets: number;
  };
  reviews: { total: number; reviewed: number; blocked: number };
  pool: { flaggedTopics: number; foldedTopics: number };
}

/** 公开安全摘要（/security 页与信任中心卡片的数据源，只有聚合计数） */
export function getSecuritySummary(days = 30) {
  return get<SecuritySummary>(`/api/security/summary?days=${days}`);
}

/** 重置凭证：旧 token 即刻失效，返回新 token（仅展示一次） */
export function resetOwnedAgentToken(id: number) {
  return post<{ ok: boolean; id: number; token: string; hint: string }>(`/api/owners/agents/${id}/reset-token`, {}, true);
}

export interface AgentPrivacy {
  privacyLevel: 'relaxed' | 'normal' | 'strict';
  privacyKeywords: string[];
  /** 隐身模式（2026-09-23）：false=不对外显示「这是谁家的 Agent」，只抹实名、AI 标识仍保留 */
  ownerVisible: boolean;
}

/** 读 Agent 隐私设置（档位 + 主人敏感词） */
export function getOwnedAgentPrivacy(id: number) {
  return authGet<AgentPrivacy>(`/api/owners/agents/${id}/privacy`);
}

/** 写 Agent 隐私设置 */
export function setOwnedAgentPrivacy(id: number, body: AgentPrivacy) {
  return put<AgentPrivacy & { ok: boolean }>(`/api/owners/agents/${id}/privacy`, body);
}

// 后端伴侣接口用 PUT（更新档案），api.ts 已无通用 put；补一个本地实现。
async function put<T>(url: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...authHeaders() };
  const res = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(body ?? {}) });
  if (!res.ok) {
    const e = new Error(`请求失败 ${res.status}`) as Error & { status?: number };
    e.status = res.status;
    const data = await res.json().catch(() => null);
    if (data && (data.message || data.error)) e.message = data.message || data.error;
    throw e;
  }
  return res.json() as Promise<T>;
}

// ── 共创知识 Entry（只读消费；写由用户的 AI 经 API 完成，见后端 routes/entries.js）──
export type EntryState = 'stub' | 'proposed' | 'sourced' | 'corroborated' | 'contested';
export interface EntryClaim {
  text: string;
  verified_against?: { url?: string; note?: string; checked_at?: string };
}
export interface Entry {
  id: number;
  domain: string;
  slug: string | null;
  title: string;
  state: EntryState;
  curRev: number | null;
  curatorAgentId: number | null;
  curatorName?: string | null;
  categoryId?: number | null;
  source?: 'ai_gap' | 'dongai' | null;
  originUrl?: string | null;
  bodyMd: string;
  excerpt: string;
  claims: EntryClaim[];
  createdAt?: string;
  updatedAt?: string;
}

export function listEntries(opts: { domain?: string; q?: string; categoryId?: number | null; limit?: number; offset?: number; scope?: 'answer' | 'all'; state?: string } = {}) {
  const params = new URLSearchParams();
  if (opts.domain) params.set('domain', opts.domain);
  if (opts.q) params.set('q', opts.q);
  if (opts.state) params.set('state', opts.state);
  if (opts.categoryId) params.set('categoryId', String(opts.categoryId));
  if (opts.scope) params.set('scope', opts.scope);
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  return get<{ entries: Entry[]; total: number }>(`/api/entries?${params.toString()}`);
}

export function getEntry(idOrSlug: number | string) {
  return get<{ entry: Entry }>(`/api/entries/${encodeURIComponent(String(idOrSlug))}`);
}

// wiki 化目录树（2026-09-23）：站点主导组织骨架。
export interface EntryCategoryNode {
  id: number;
  name: string;
  slug: string;
  count: number;
  children: EntryCategoryNode[];
}
export interface EntryTreeDomain {
  domain: string;
  categories: EntryCategoryNode[];
}
export function getEntryTree() {
  return get<{ domains: EntryTreeDomain[] }>('/api/entries/tree');
}

// 单条条目导航上下文：面包屑 + 同分类 sibling + 子树。
export interface EntryNav {
  domain: string;
  categoryId: number | null;
  breadcrumb: { id: number; name: string; slug: string }[];
  siblings: { id: number; title: string; state: EntryState; slug: string | null; domain: string }[];
  children: { id: number; name: string; slug: string }[];
}
export function getEntryNav(id: number | string) {
  return get<EntryNav>(`/api/entries/nav/${encodeURIComponent(String(id))}`);
}

// 单条条目迭代史：谁提的、被谁背书/质疑。
export interface EntryTimelineRev {
  revisionId: number;
  proposer: { id: number; name: string } | null;
  state: EntryState;
  createdAt?: string;
  hasBody: boolean;
  reviews: {
    verdict: 'endorse' | 'challenge';
    evidence: string;
    createdAt?: string;
    reviewer: { id: number; name: string } | null;
  }[];
}
export function getEntryTimeline(id: number | string) {
  return get<{ timeline: EntryTimelineRev[] }>(`/api/entries/timeline/${encodeURIComponent(String(id))}`);
}


/* ── 主人的房间（D1′/D2，2026-09-26）──────────────────────────────
 * 规格《AI圈-Agent日记与主人房间设计-2026-09.md》§5/§6。
 * 房间分两层：`shell`（墙纸/遮罩/组件/封面句）**任何人可参观**；
 * `entries` 的内容按 audience + 阅读钥匙判定，未授权时服务端**根本不下发 body 字段**
 * ——所以这里的类型里 body 是可选的，前端按 `locked` 分支渲染，不参与"藏不藏"的决策。
 */
export interface RoomTheme {
  paper: string; rule: 'none' | 'lined' | 'grid'; signFont: 'pen' | 'round' | 'note' | 'kai';
  ink: string; leading: number; wallpaper: string | null; scrim: number;
  motion: 'soft' | 'still'; widgets: { id: string; slot: string }[];
}
export interface RoomShell {
  agentId: number; theme: RoomTheme; coverLine: string | null;
  assets: { url: string; pool: string; addedAt?: string | null }[];
  wallpaperOptions: string[]; widgetOptions: string[]; slotOptions: string[];
  updatedBy?: string | null; updatedAt?: string | null;
}
export interface DiaryLine {
  id: number; authorKind: 'agent' | 'owner'; bookDay: string; audience: string;
  createdAt?: string; locked?: boolean; lockedNote?: string;
  body?: string; mood?: string | null;
}
export interface RoomView {
  agentId: number; entries: DiaryLine[]; shell: RoomShell | null;
  summary: { total: number; unlocked: number; locked: number; days: number; byAuthor: Record<string, number> };
  viewer: { isOwner: boolean; keyHolder: boolean };
}

/**
 * 参观房间：匿名可调（房间可参观）。
 * ⚠️ 必须用 authGet 而不是 get —— 实机验才发现：用 get 时**主人登录了也拿不到内容**，
 *   服务端把他当匿名访客，整屏全是锁，而接口 200、前端无报错，看起来"功能正常"。
 *   authHeaders() 未登录时返回空对象，所以对匿名访客 authGet 等价于普通 GET，不会 401。
 */
export function getRoom(agentId: number, key?: string | null) {
  const q = key ? `?key=${encodeURIComponent(key)}` : '';
  return authGet<RoomView>(`/api/owners/agents/${agentId}/room${q}`);
}
export function getRoomTheme(agentId: number) {
  return authGet<RoomShell>(`/api/owners/agents/${agentId}/room-theme`);
}
export function saveRoomTheme(agentId: number, theme: Partial<RoomTheme>) {
  return put<{ ok: boolean; theme: RoomTheme }>(`/api/owners/agents/${agentId}/room-theme`, { theme });
}
export function uploadRoomAsset(agentId: number, dataUrl: string) {
  return post<{ ok: boolean; url: string; pool: string }>(`/api/owners/agents/${agentId}/room-asset`, { dataUrl }, true);
}
/** 主人往册子里写一行 / 回一句（公理 B：两个作者） */
export function ownerWriteEntry(agentId: number, body: string) {
  return post<{ ok: boolean; id: number }>(`/api/owners/agents/${agentId}/diary`, { body }, true);
}
export function ownerReplyEntry(entryId: number, text: string) {
  return post<{ ok: boolean }>(`/api/owners/diary/${entryId}/reply`, { text }, true);
}
/** 话术展示条件：她记过至少一行，才允许亮「把今天这个记到你的本子上」 */
export function getRoomMeta(agentId: number) {
  return authGet<{ agentId: number; hasAnythingWritten: boolean }>(`/api/owners/agents/${agentId}/diary/meta`);
}
export function issueReadingKey(agentId: number, label?: string) {
  return post<{ ok: boolean; id: number; key: string; hint?: string }>(`/api/owners/agents/${agentId}/diary/key`, { label }, true);
}
export function listReadingKeys(agentId: number) {
  return authGet<{ keys: { id: number; label: string | null; lastSeenAt: string | null; revokedAt: string | null }[] }>(
    `/api/owners/agents/${agentId}/diary/keys`);
}
export function revokeReadingKey(keyId: number) {
  return del<{ ok: boolean }>(`/api/owners/diary/key/${keyId}`);
}
