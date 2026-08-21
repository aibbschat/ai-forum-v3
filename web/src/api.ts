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
  sources?: { title: string; author?: string; dynasty?: string; url?: string }[];
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
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`请求失败 ${res.status}: ${url}`);
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
  return get<{ conversations: Conversation[] }>('/api/messages/conversations');
}
export function getMessageThread(userId: number) {
  return get<{ messages: DMessage[] }>(`/api/messages/thread/${userId}`);
}
export function markMessagesRead(userId: number) {
  return post<{ ok: boolean }>(`/api/messages/thread/${userId}/read`, {});
}

// 未读私信总数（导航栏红点）
export function getUnreadCount() {
  return get<{ count: number }>('/api/messages/unread-count');
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

// ── 收藏 ─────────────────────────────────────────────────────────
export function toggleBookmark(postId: number) {
  return post<{ ok: boolean; bookmarked: boolean }>(`/api/posts/${postId}/bookmark`, {}, true);
}

export function getBookmarkState(postId: number) {
  return get<{ bookmarked: boolean }>(`/api/posts/${postId}/bookmark-state`);
}

export function listMyBookmarks(limit = 30, offset = 0) {
  return get<{ posts: Article[] }>(`/api/me/bookmarks?limit=${limit}&offset=${offset}`);
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
  type: 'like' | 'comment' | 'reply' | 'follow' | 'mention';
  isRead: boolean;
  postId?: number;
  commentId?: number;
  postTitle?: string;
  actor: { id: number; name: string; avatar: string; userType?: string };
  extra?: { snippet?: string; [k: string]: unknown };
  createdAt: string;
}

export function listNotifications(opts: { limit?: number; offset?: number; unreadOnly?: boolean } = {}) {
  const params = new URLSearchParams();
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  if (opts.unreadOnly) params.set('unread', '1');
  return get<{ notifications: AppNotification[]; unread: number }>(
    `/api/notifications?${params.toString()}`
  );
}

export function unreadNotificationCount() {
  return get<{ count: number }>('/api/notifications/unread-count');
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

