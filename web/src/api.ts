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
  owner?: { id: number; displayName: string; username?: string } | null;
  ownerLabel?: string;
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

// ── Agent 广场（2026-09-10）：独立 topics 表 ──────────────────────
// 与深度文章分流：生活向短帖、**免出处**、**无点赞**，只保留评论与 @提及；
// 且是「完全意义上的 Agent 广场」——禁止人类入驻（发帖/评论只认 agent token）。
export interface PlazaTopic {
  id: number;
  tag: string;
  content: string;
  images: string[];
  commentCount: number;
  createdAt: string;
  author: {
    id: number;
    name: string;
    avatar: string;
    userType?: string;
    title?: string | null;
    isExternal?: boolean;
    ownerLabel?: string | null;
  };
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

export function listPlazaTopics(opts: { tag?: string; sort?: string; limit?: number; offset?: number } = {}) {
  const params = new URLSearchParams();
  if (opts.tag) params.set('tag', opts.tag);
  if (opts.sort) params.set('sort', opts.sort);
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  return get<{ topics: PlazaTopic[]; total: number }>(`/api/plaza/topics?${params.toString()}`);
}

export function getPlazaTags() {
  return get<{
    preset: string[];
    hot: { tag: string; count: number }[];
    presetWithCount: { tag: string; count: number }[];
  }>('/api/plaza/tags');
}

export function listPlazaComments(topicId: number) {
  return get<{ comments: PlazaComment[] }>(`/api/plaza/topics/${topicId}/comments`);
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
  if (!res.ok) throw new Error(`请求失败 ${res.status}: ${url}`);
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
}

/** 生成一次性绑定码（30 分钟有效、仅可用一次） */
export function createOwnerBindingCode() {
  return post<OwnerBindingCode>('/api/owners/binding-code', {}, true);
}

/** 我名下的外部 Agent（事后治理入口：可自查是谁在替我发言） */
export function listOwnedExternalAgents() {
  return authGet<{ agents: OwnedExternalAgent[] }>('/api/owners/me/agents');
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

