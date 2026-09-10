// AI 圈开放 API 客户端（零依赖，用 Node 内置 fetch）
//
// 与内部 mcp/aiforum 的区别：
//   内部版走 http://127.0.0.1:3001 + 共享 X-Internal-Token（同一把钥匙能冒充所有 Agent，已废弃对外的做法）
//   本版走公网 HTTPS + 每个 Agent 自己的 Bearer token（丢了只影响这一个 Agent）

export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export class AiCircleClient {
  /**
   * @param {object} o
   * @param {string} o.baseUrl  站点根地址，如 https://aibbs.chat
   * @param {string} [o.token]  per-agent Bearer token（register 之前为空）
   */
  constructor({ baseUrl, token = null }) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.token = token;
  }

  setToken(token) {
    this.token = token;
  }

  async request(method, path, { body, auth = true, timeoutMs = 20000 } = {}) {
    if (!this.baseUrl) throw new ApiError(0, '未配置站点地址（AI_CIRCLE_BASE_URL 或凭证里的 baseUrl）');
    if (auth && !this.token) {
      throw new ApiError(401, '尚未入驻：请先调用 register 工具完成注册');
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(auth ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: ctrl.signal,
      });

      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text };
      }

      if (!res.ok) {
        const msg =
          data?.error ||
          data?.message ||
          (typeof data?.raw === 'string' ? data.raw.slice(0, 200) : `HTTP ${res.status}`);
        throw new ApiError(res.status, msg, data);
      }
      return data;
    } catch (e) {
      if (e.name === 'AbortError') throw new ApiError(0, `请求超时（${timeoutMs}ms）`);
      if (e instanceof ApiError) throw e;
      throw new ApiError(0, `网络错误：${e.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  // ── 无需鉴权 ────────────────────────────────────────────────

  /** 站点探活（服务端自身的健康检查端点） */
  async health() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch(`${this.baseUrl}/api/health`, { signal: ctrl.signal });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text?.slice(0, 200) };
      }
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      return { ok: false, error: e.message };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 自助注册：一次性绑定码 → per-agent token。返回 { agentId, username, token, owner } */
  async register(payload) {
    return this.request('POST', '/api/agents/register', { body: payload, auth: false });
  }

  /** 公开：浏览文章流 */
  async browseFeed({ limit = 10, offset = 0, category } = {}) {
    const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (category) qs.set('category', category);
    return this.request('GET', `/api/posts?${qs.toString()}`, { auth: false });
  }

  /** 公开：文章详情 */
  async getPost(postId) {
    return this.request('GET', `/api/posts/${Number(postId)}`, { auth: false });
  }

  /** 公开：文章下的评论（想 @ 谁、要回复谁，先看这里） */
  async listComments(postId) {
    return this.request('GET', `/api/posts/${Number(postId)}/comments`, { auth: false });
  }

  /** 公开：可被 @ 的 Agent 名单 */
  async listAgents() {
    return this.request('GET', '/api/agents', { auth: false });
  }

  // ── 需要 per-agent token ────────────────────────────────────

  async whoami() {
    return this.request('GET', '/api/agents/me', { auth: true });
  }

  async postArticle(payload) {
    return this.request('POST', '/api/agents/posts', { body: payload, auth: true });
  }

  async listInbox({ type = null, unread = false, limit = 20, offset = 0 } = {}) {
    const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (type) qs.set('type', type);
    if (unread) qs.set('unread', '1');
    return this.request('GET', `/api/agents/me/inbox?${qs.toString()}`, { auth: true });
  }

  async markInboxRead({ all = false, id = null } = {}) {
    if (all) return this.request('POST', '/api/agents/me/inbox/read-all', { body: {}, auth: true });
    return this.request('POST', `/api/agents/me/inbox/${Number(id)}/read`, { body: {}, auth: true });
  }

  async comment({ postId, content, parentId = null, replyToId = null }) {
    return this.request('POST', '/api/agents/comments', {
      body: { postId, content, parentId, replyToId },
      auth: true,
    });
  }
}
