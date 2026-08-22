// server/services/companionService.js
// AI 伴侣（用户个人 AI 伙伴）档案 CRUD —— 见 docs/companion/AI_COMPANION_SPEC.md §3 / §4。
// 仅操作 companion_profiles；记忆/聊天/草稿服务见 M3/M5。
import { db, fn } from '../database/db.js';

const BADGE_DEFAULT = '我的搭档';

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function buildDefaultIntro(name, persona) {
  const p = typeof persona === 'string' ? safeParse(persona) : persona || {};
  const interests = p.interests || p.domains || [];
  const list = Array.isArray(interests) ? interests.join('、') : interests || '';
  return [
    `你是"${name}"，是用户专属的 AI 搭档（私人伙伴），不是社区内容生产者。`,
    `你的职责是陪伴与辅助：记住用户的偏好、帮用户写作与脑暴，但绝不以用户身份公开发帖。`,
    list ? `你感兴趣的方向：${list}` : '',
    `请以自然、像朋友一样的语气交流，并保持对用户偏好的长期记忆。`,
  ].filter(Boolean).join('\n');
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

/** 解析行里的 persona_json 为对象，挂到 row.persona（不破坏原字段）。 */
function withParsed(row) {
  if (row && row.persona_json && typeof row.persona_json === 'string') {
    try { row.persona = JSON.parse(row.persona_json); } catch { row.persona = {}; }
  }
  return row;
}

export async function createCompanion(ownerId, input = {}) {
  if (!ownerId) throw httpError(401, 'unauthorized');
  const { name, username, avatar, persona_json, intro_prompt, sprite_sheet, badge } = input;
  if (!name || !username) throw httpError(400, 'name 与 username 必填');
  if (!/^[A-Za-z0-9_\u4e00-\u9fa5-]{2,50}$/.test(username)) {
    throw httpError(400, 'username 仅含字母/数字/下划线/汉字，2-50 字');
  }
  const dup = await db.get('SELECT id FROM companion_profiles WHERE username = ?', [username]);
  if (dup) throw httpError(409, 'username 已存在');

  // 一期每人 1 个（§2.1；二期开放多搭档）
  const owned = await db.get('SELECT id FROM companion_profiles WHERE owner_id = ?', [ownerId]);
  if (owned) throw httpError(409, '每位用户当前仅可创建 1 个搭档（二期开放多个）');

  const persona = typeof persona_json === 'string' ? persona_json : JSON.stringify(persona_json || {});
  const intro = intro_prompt || buildDefaultIntro(name, persona_json);

  await db.run(
    `INSERT INTO companion_profiles
       (owner_id, name, username, avatar, sprite_sheet, persona_json, intro_prompt, badge, is_public)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [ownerId, name, username, avatar || null, sprite_sheet || null, persona, intro, badge || BADGE_DEFAULT]
  );
  const row = await db.get('SELECT id FROM companion_profiles WHERE username = ?', [username]);
  return getCompanionById(row.id);
}

export async function getCompanionById(id) {
  const row = await db.get('SELECT * FROM companion_profiles WHERE id = ?', [id]);
  if (!row) throw httpError(404, '搭档不存在');
  return withParsed(row);
}

/** owner 隔离的取档（无权限抛 403）。 */
export async function getOwnedCompanion(ownerId, id) {
  const row = await getCompanionById(id);
  if (row.owner_id !== ownerId) throw httpError(403, '无权访问该搭档');
  return row;
}

export async function listCompanions(ownerId) {
  const rows = await db.all(
    `SELECT id, owner_id, name, username, avatar, sprite_sheet, badge, is_public,
            last_active_at, created_at, updated_at
     FROM companion_profiles WHERE owner_id = ? ORDER BY created_at DESC`,
    [ownerId]
  );
  return rows.map(withParsed);
}

export async function updateCompanion(ownerId, id, patch = {}) {
  await getOwnedCompanion(ownerId, id); // 鉴权 + 存在性
  const fields = {};
  if (patch.name != null) fields.name = patch.name;
  if (patch.avatar != null) fields.avatar = patch.avatar;
  if (patch.sprite_sheet !== undefined) fields.sprite_sheet = patch.sprite_sheet || null;
  if (patch.persona_json != null) {
    fields.persona_json = typeof patch.persona_json === 'string'
      ? patch.persona_json : JSON.stringify(patch.persona_json);
  }
  if (patch.intro_prompt != null) fields.intro_prompt = patch.intro_prompt;
  if (patch.badge != null) fields.badge = patch.badge;
  if (patch.is_public != null) fields.is_public = patch.is_public ? 1 : 0;
  if (Object.keys(fields).length === 0) return getCompanionById(id);

  const cols = Object.keys(fields);
  await db.run(
    `UPDATE companion_profiles
        SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ${fn.now()}
      WHERE id = ?`,
    [...cols.map((c) => fields[c]), id]
  );
  return getCompanionById(id);
}

export async function deleteCompanion(ownerId, id) {
  await getOwnedCompanion(ownerId, id);
  await db.run('DELETE FROM companion_profiles WHERE id = ?', [id]);
  return { ok: true };
}

/** 公开取档（按 username，供微主页/聊天页渲染；M3 聊天、M2 微主页卡片用）。不含写入。 */
export async function getCompanionByUsername(username) {
  const row = await db.get('SELECT * FROM companion_profiles WHERE username = ?', [username]);
  if (!row) throw httpError(404, '搭档不存在');
  return withParsed(row);
}

/** 更新在场感（聊天/互动时调用，M3 用）。 */
export async function touchActive(id) {
  await db.run(`UPDATE companion_profiles SET last_active_at = ${fn.now()} WHERE id = ?`, [id]);
}

export default {
  createCompanion,
  getCompanionById,
  getOwnedCompanion,
  listCompanions,
  updateCompanion,
  deleteCompanion,
  getCompanionByUsername,
  touchActive,
};
