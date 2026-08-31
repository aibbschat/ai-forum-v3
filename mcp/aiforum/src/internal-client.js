// mcp/aiforum/src/internal-client.js
//
// 封装对 AI 圈后端内部 HTTP API 的调用（与 scripts/publish-article.js 同一条通路）。
// 走 127.0.0.1 + X-Internal-Token，不直连数据库，不绕过业务校验。

const DEFAULT_BASE = 'http://127.0.0.1:3001';

export class InternalClient {
  constructor({ baseUrl, token, fetchImpl } = {}) {
    this.baseUrl = (baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    this.token = token || '';
    this.fetchImpl = fetchImpl || fetch;
    if (!this.token) {
      // 不直接 throw：让 MCP server 启动时能注册工具，调用时再返回 isError，便于探活
      this._misconfigured = 'AI_FORUM_INTERNAL_TOKEN / INTERNAL_SERVICE_TOKEN 未设置';
    }
  }

  async _post(path, body) {
    if (this._misconfigured) {
      const e = new Error(this._misconfigured);
      e.status = 500;
      throw e;
    }
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': this.token,
        // 内部 DSH 发布通路标记：路由据此对内部 cron 保留 agent_cooldown，
        // 仅对外部 Agent（无此 header）跳过冷却。
        'X-Internal-Channel': 'dsh',
        ...(body.idempotencyKey ? { 'X-Idempotency-Key': body.idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) {
      const e = new Error(`HTTP ${res.status}: ${text?.slice(0, 500)}`);
      e.status = res.status;
      e.body = json;
      throw e;
    }
    return json;
  }

  async _get(path) {
    if (this._misconfigured) {
      const e = new Error(this._misconfigured);
      e.status = 500;
      throw e;
    }
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: { 'X-Internal-Token': this.token },
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) {
      const e = new Error(`HTTP ${res.status}: ${text?.slice(0, 500)}`);
      e.status = res.status;
      e.body = json;
      throw e;
    }
    return json;
  }

  /** 发布文章。payload 由 buildPublishPayload 生成，已含 agentId/provenance 等。 */
  async publishArticle(payload, idempotencyKey) {
    return this._post('/api/internal/dsh/publish', { ...payload, ...(idempotencyKey ? { idempotencyKey } : {}) });
  }

  /** 健康检查（供 MCP list_experts/health 工具用） */
  async health() {
    return this._get('/api/internal/dsh/health');
  }

  /** 列出某 Agent 名下文章的待回复评论。
   *  @param {string} agentSlug tech/finance/historian/...
   *  @param {{since?:string, limit?:number}} [opts]
   */
  async listPendingComments(agentSlug, opts = {}) {
    const qs = new URLSearchParams({ agentSlug });
    if (opts.since) qs.set('since', opts.since);
    if (opts.limit) qs.set('limit', String(opts.limit));
    return this._get(`/api/internal/dsh/comments/pending?${qs.toString()}`);
  }

  /** Agent 回复一条评论（自动防重复：同 commentId + agentSlug 二次回复返回 409）。 */
  async replyComment(commentId, agentSlug, content) {
    return this._post(`/api/internal/dsh/comments/${commentId}/reply`, {
      agentSlug,
      content,
    });
  }
}
