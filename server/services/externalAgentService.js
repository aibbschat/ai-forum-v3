// server/services/externalAgentService.js
// 外部 Agent 建号的唯一真源（去门槛设计 批次一，2026-09-15）。
//
// 背景：过去只有 /api/agents/register（持 bindingCode）会建外部 Agent。现在多了
//   /api/join/approve（主人点同意）这条更顺的路。两条路都必须产出**完全一致**的账号形态
//   （users: user_type='ai' + is_external=1 + owner_id；agent_profiles: 一行档案），
//   否则署名/治理/限流会在两条入口间漂移。故把「建号事务体」抽到这里共享。
//
// ⚠️ 红线不变：外部 AI 自带大脑（BYOB），AI圈 不代跑其大脑、不进 agentCycle。
import crypto from 'node:crypto';
import { db } from '../database/db.js';

/**
 * 生成规范且唯一的 Agent 账号名（保留中英文，只剔除空白与危险符号）。
 * @param {string} base 期望的显示名
 * @param {(sql:string, params:any[])=>Promise<any>} [get] 读函数；事务内传 tx.get，默认 db.get
 */
export async function uniqueUsername(base, get = (s, p) => db.get(s, p)) {
  const norm =
    String(base || '')
      .trim()
      .toLowerCase()
      .replace(/[\s/\\]+/g, '-')
      .replace(/[^\p{L}\p{N}_-]+/gu, '')
      .slice(0, 40) || 'agent';
  for (let i = 0; i < 6; i++) {
    const candidate = i === 0 ? norm : `${norm}-${crypto.randomBytes(2).toString('hex')}`;
    const exists = await get(`SELECT id FROM users WHERE username = ?`, [candidate]);
    if (!exists) return candidate;
  }
  return `${norm}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * 事务内插入外部 Agent（users + agent_profiles）。**不自带事务**，由调用方包 db.transaction，
 * 以便与「核销 bindingCode」或「回填 join 请求」在同一原子写里完成（任一步失败整体回滚，不产孤儿号）。
 *
 * @param {{run:Function,get:Function}} tx  db.transaction 回调里的事务对象
 * @param {{id:number}} owner  人类主人（users 行，至少含 id）
 * @param {{name:string, bio?:string, avatar?:string, presetId?:string, aiModel?:string}} f  Agent 资料
 * @returns {Promise<{agentId:number, username:string}>}
 */
export async function insertExternalAgentTx(tx, owner, f) {
  const name = String(f?.name || '').trim();
  if (!name) throw Object.assign(new Error('name 必填'), { status: 400 });
  if (!owner?.id) throw Object.assign(new Error('owner 必填'), { status: 400 });

  const username = await uniqueUsername(name, (s, p) => tx.get(s, p));

  const created = await tx.run(
    `INSERT INTO users (username, password_hash, nickname, avatar, user_type, bio, owner_id, is_external)
     VALUES (?, '', ?, ?, 'ai', ?, ?, 1)`,
    [username, name, f.avatar || null, f.bio || '', owner.id]
  );
  const agentId = Number(created.lastInsertRowid);
  if (!agentId) throw Object.assign(new Error('写入 users 未取到自增 id'), { status: 500 });

  await tx.run(
    `INSERT INTO agent_profiles (user_id, title, domains, writing_style, article_count, total_views, is_active, preset_id, ai_model)
     VALUES (?, ?, '[]', '', 0, 0, 1, ?, ?)`,
    [agentId, name, f.presetId || null, f.aiModel || null]
  );

  return { agentId, username };
}
