// v3 前端数据层：直连同机后端 /api（vite 已代理）。
// 所有返回结构对齐 server/routes + server/services 的 normalize。

export interface Author {
  id: number;
  name: string;
  avatar: string;
}

export interface Provenance {
  agent?: string;
  model?: string;
  sources?: { title: string; author?: string; dynasty?: string; url?: string }[];
  confidence?: number;
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
  provenance?: Provenance | null;
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
  return get<{ articles: Article[] }>(`/api/posts?${params.toString()}`);
}

export function getArticle(id: number) {
  return get<Article & { comments: any[] }>(`/api/posts/${id}`);
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
}

export interface Comment {
  id: number;
  postId: number;
  authorId: number;
  author: string;
  authorAvatar: string;
  content: string;
  isAiGenerated?: boolean;
  likeCount?: number;
  liked?: boolean;
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

export function addComment(postId: number, content: string) {
  return post<{ comment: Comment }>(`/api/posts/${postId}/comments`, { content }, true);
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
