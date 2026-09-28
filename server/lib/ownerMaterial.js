// server/lib/ownerMaterial.js
// 档3 便签 `owner_material`（2026-09-28）——把"主人主动交给你的一份资料"递到她眼前。
//
// 为什么独立成一类、不塞进 owner_recall：
//   owner_recall 的口径是「我对主人的判断」（她自己写的卡）；
//   owner_material 的口径是「主人交给我的料」——两个视角合进一封，两边都会被稀释。
// 独立一类也自动拿到 takeNotes 的「每类保底一格」，不会被 owner_recall 挤掉。
//
// 纪律（同 ownerRecall / materialBrief）：
//   · 拉取即生成、一天硬一封（日幂等自判，查"上一条不限状态的同类便签"）；
//   · 无新不发：没有未消化的自述就不发；
//   · 正文只递"提示 + 读口形状"一句，**不长篇转载资料**——资料正文不进纪事（480 字预算装不下 SOUL.md），
//     纪事只递"去读"这一句；她用 list_owner_impressions 读口自己翻。
//   · 不催办：只描述"主人交了份资料"，不下发"主人在等你"这类压力（否则她会开始演戏）。
import { db } from '../database/db.js';
import { localDate } from './circleDigest.js';
import { grayEnabled } from './grayGate.js';

export const OWNER_MATERIAL_KIND = 'owner_material';

/** 灰度与回流同闸 OWNER_RECALL_AGENTS（空/未设=全关；`*`|`all`=全开；其余=ID 名单）。 */
export function isOwnerMaterialEnabled(agentId, env = process.env) {
  return grayEnabled(env.OWNER_RECALL_AGENTS, agentId);
}

/**
 * @returns {null|object} `null` = 不发（今天已发过 / 没有未消化的自述）。
 */
export async function buildOwnerMaterial(agentId, { now = new Date() } = {}) {
  const aid = Number(agentId);
  if (!aid) return null;
  const day = localDate(now);
  // 日幂等自判（不限状态：被拉走的那封也算发过）
  const last = await db.get(
    `SELECT payload FROM agent_notes WHERE agent_id = ? AND kind = ? ORDER BY id DESC LIMIT 1`,
    [aid, OWNER_MATERIAL_KIND]
  ).catch(() => null);
  let lastPayload = {};
  try { lastPayload = JSON.parse(last?.payload || '{}') || {}; } catch { /* 坏 JSON 当没发过 */ }
  if (lastPayload.day === day) return null;

  // 有没有未消化的自述
  const pending = await db.get(
    `SELECT id, kind, body FROM owner_self_notes
      WHERE agent_id = ? AND status IN ('pending','reading')
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [aid]
  ).catch(() => null);
  if (!pending) return null; // 无新不发

  return { day, selfNoteId: Number(pending.id), kind: pending.kind, body: String(pending.body || '') };
}

/**
 * 渲染。纪律：
 *   · 正文只递"去读"一句，**不长篇转载资料**（资料正文不进纪事）；
 *   · 不催办：不说"主人在等你"，只说"主人交了份资料，去读"。
 */
export function renderOwnerMaterial(model) {
  if (!model) return '';
  const KIND_LABEL = { profile: '关于他是谁', preference: '他喜欢什么', avoid: '别这么对他' };
  const label = KIND_LABEL[model.kind] || model.kind;
  const hint = '    去读：GET /api/agents/me/owner-impressions （找 source="owner_self" 的那条）；'
    + '读完写一条印象卡（write_owner_impression），或声明无所得（settle_owner_material {nothingToRecord:true}）';
  return [
    `【主人给了你一份资料 · ${model.day}】${label}`,
    '',
    hint,
  ].join('\n');
}

export default { OWNER_MATERIAL_KIND, buildOwnerMaterial, renderOwnerMaterial, isOwnerMaterialEnabled };
