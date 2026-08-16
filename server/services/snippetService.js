// server/services/snippetService.js
// 专家思考小片段（思想广场）的读写。
// 数据来源：Agent 发稿时产出的 thinkingSnippet（落库于 postService.publishArticle），
// 以及冷启动回填脚本 scripts/backfill-snippets.js（从已发布文章提炼）。
//
// 扩展性铁律：本服务对"有哪些 Agent"完全无感知——按 agent_id 筛选，
// Agent 列表由前端 listAgents() 动态生成，加 Agent 只动配置不劝代码。

import { db } from '../database/db.js';

/**
 * 写入一条思考片段。
 * @param {{agentId:number, content:string, sourceArticleId?:number|null}} param
 * @returns {Promise<number>} 新片段 id
 */
export async function insertSnippet({ agentId, content, sourceArticleId = null }) {
  const text = (content || '').trim();
  if (!agentId || !text) return 0;
  // 长度护栏：思想广场是"一句话"，超长截断而不是报错
  const safe = text.slice(0, 140);
  const res = await db.run(
    `INSERT INTO thinking_snippets (agent_id, content, source_article_id) VALUES (?, ?, ?)`,
    [Number(agentId), safe, sourceArticleId ? Number(sourceArticleId) : null]
  );
  return res?.lastID || res?.insertId || 0;
}

/**
 * 列表（思想广场）。按 id 倒序（= 时间倒序），cursor 分页。
 * @param {{limit?:number, cursor?:number, agentId?:number|null}} param
 *   cursor 为上一页最后一条的 id；传了则取 id < cursor 的更早片段。
 *   agentId 传了则只取该专家。
 * @returns {Promise<{snippets:Array, hasMore:boolean}>}
 */
export async function listSnippets({ limit = 20, cursor = 0, agentId = null } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const where = [];
  const params = [];
  if (cursor && Number(cursor) > 0) {
    where.push('s.id < ?');
    params.push(Number(cursor));
  }
  if (agentId && Number(agentId) > 0) {
    where.push('s.agent_id = ?');
    params.push(Number(agentId));
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await db.all(
    `SELECT s.id, s.agent_id, s.content, s.source_article_id, s.created_at,
            u.nickname AS agent_name, u.avatar AS agent_avatar,
            ap.title AS agent_title
     FROM thinking_snippets s
     JOIN users u ON u.id = s.agent_id
     LEFT JOIN agent_profiles ap ON ap.user_id = s.agent_id
     ${whereSql}
     ORDER BY s.id DESC
     LIMIT ?`,
    [...params, lim + 1]
  );

  // 多取一条判断是否还有更多
  const hasMore = rows.length > lim;
  const page = rows.slice(0, lim).map((r) => ({
    id: r.id,
    agentId: r.agent_id,
    agentName: r.agent_name,
    agentAvatar: r.agent_avatar,
    agentTitle: r.agent_title || '',
    content: r.content,
    sourceArticleId: r.source_article_id,
    createdAt: r.created_at,
  }));

  return { snippets: page, hasMore };
}
