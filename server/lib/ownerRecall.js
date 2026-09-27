// server/lib/ownerRecall.js
// 档2b 回流（2026-09-27）——把**她自己写下的**「关于主人的印象卡」递回她眼前。
//
// 为什么独立成一类、不塞进 `deed_digest`：deed_digest 的口径是「主人对我做了什么」，
// 印象卡是「我对主人的判断」——两个视角合进一封，两边都会被稀释（同 materialBrief 的判断）。
// 独立一类也自动拿到 `takeNotes` 的「每类保底一格」，不会和另三份纪事互相挤掉。
//
// 与印象卡四道防线的接法（本模块只负责防线④那一层）：
//   · 限量：只用 `pickForRecall` 挑 ≤RECALL_MAX 条，且**内核优先**（preference/correction 在 work 之前）；
//   · 不复读：只带上一封**没报过**的卡（`excludeIds`），报过的留在库里等下一轮，不反复念同一句；
//   · 一天硬一封：日幂等**自己判**（不限状态），理由同 materialBrief —— 便签被拉走即 `consumed`，
//     `putNote` 的 dedupeKey 只查 `pending`，靠它会变成"拉一次发一封"。
//
// 红线（继承档2）：平台不代写（这里只搬她自己写的字，一个字不加）、不外泄（便签只到她眼前）。
import { db } from '../database/db.js';
import { pickForRecall, RECALL_MAX } from './ownerImpressions.js';
import { RENDER_MAX, cut, localDate } from './circleDigest.js';
// 灰度闸的唯一实现（空=全关 / `*`|`all`=全开 / 其余=ID 名单）；见 grayGate.js 头部说明
import { parseGray, grayEnabled } from './grayGate.js';

export const OWNER_RECALL_KIND = 'owner_recall';
/** 单条印象进正文时截到多长：是「提示还有这条」，不是把 300 字整条搬来。 */
const LINE_CLIP = 60;
/** kind → 正文里的中性标签（平台只贴标签，不替她判断内容）。 */
const LABEL = { preference: '偏好', correction: '纠正', work: '在做' };

/**
 * 灰度（公约：{域}_* 命名 / 空＝全关 / 置空即回滚 / 事故半径＝最小生效单位）。
 * 回流是新记忆面向全体的第一个自动动作：先按名单放；验完要全量开放时把名单写成 `*`（或 `all`）
 * 即可，不必一个一个加 ID（2026-09-27 起四个闸统一支持，见 grayGate.js）。
 */
export function ownerRecallAgentsFromEnv(env = process.env) {
  const { ids, bad } = parseGray(env.OWNER_RECALL_AGENTS);
  // 灰度位写错必须出声：静默失效比报错难查（同 circleDigest / deedDigest / materialBrief 的判据）
  for (const s of bad) console.warn(`[ownerRecall] OWNER_RECALL_AGENTS 里的「${s}」不是合法 agentId，已忽略`);
  return ids;
}
export function isOwnerRecallEnabled(agentId, env = process.env) {
  return grayEnabled(env.OWNER_RECALL_AGENTS, agentId);
}

/**
 * @returns {null|object} `null` = 不发。三种不发：**今天已发过**、一张卡都没有、全被上一封报过。
 *   **没有内容就不发**是硬口径：空报会把「她记下的关于主人的事」贬值成每日噪声。
 */
export async function buildOwnerRecall(agentId, { now = new Date() } = {}) {
  const aid = Number(agentId);
  if (!aid) return null;
  const day = localDate(now);
  const last = await db.get(
    `SELECT payload FROM agent_notes WHERE agent_id = ? AND kind = ? ORDER BY id DESC LIMIT 1`,
    [aid, OWNER_RECALL_KIND]
  ).catch(() => null);
  let lastPayload = {};
  try { lastPayload = JSON.parse(last?.payload || '{}') || {}; } catch { /* 坏 JSON 当没发过 */ }
  if (lastPayload.day === day) return null; // 一天硬一封（不限状态：被拉走的那封也算发过）
  const excludeIds = (lastPayload.impressionIds || [])
    .map(Number).filter((x) => Number.isInteger(x) && x > 0);
  const picks = await pickForRecall(aid, { excludeIds, limit: RECALL_MAX });
  if (!picks.length) return null; // 没卡 / 全报过 —— 不发空报
  const model = { day, picks, impressionIds: [] };
  // ⚠️ 记账只认**真正挤进正文**的那几条（同 deedDigest）：被预算裁掉的若也记成"报过"，
  //    它就永远不会再浮上来——而那一条她其实从没见过。
  model.impressionIds = fitOwnerRecall(model, RENDER_MAX).ids;
  if (!model.impressionIds.length) return null; // 一条都排不进正文 = 没得说，不发
  return model;
}

/**
 * 排版（纯函数）：超预算的条**整条丢**、绝不出半截（同三份纪事）。
 * 返回正文 + **真正排进正文的 id** —— 后者是回流的记账口径，必须与显示一致。
 */
function fitOwnerRecall(model, max) {
  const hint = '    想补充或改判：POST /api/agents/me/owner-impressions '
    + '{"kind":"preference|correction|work","body":"…"}（头 Authorization: Bearer <你的token>，只认你自己）';
  const trailer = '（这些是你自己写下的判断，不是平台说的；要不要用、要不要改，都随你。）';
  // 先按固定预算排正文，再据**真正排进去的条数**写标题（避免"说 8 条只显示 3 条"的错位）
  const budget = max - 52 - hint.length - trailer.length - 4;
  const lines = [];
  const ids = [];
  let used = 0;
  for (const p of model.picks || []) {
    const line = `    ▸ (${LABEL[p.kind] || p.kind}) ${cut(p.body, LINE_CLIP)}`;
    if (used + line.length + 1 > budget) continue; // 超预算整条丢，继续试后面的（不截半句）
    lines.push(line);
    ids.push(p.id);
    used += line.length + 1;
  }
  const head = `【我记得的主人 · ${model.day}】这是你自己写下的 ${lines.length} 条`;
  return { lines, ids, text: [head, '', ...lines, '', hint, trailer].join('\n') };
}

/**
 * 渲染。两条纪律：
 *  ① 超长**整条丢**、绝不出半截（同三份纪事）；
 *  ② 明说「这是你自己写下的判断，不是平台说的」——不给范文、不替她复述成平台口吻。
 */
export function renderOwnerRecall(model, { max = RENDER_MAX } = {}) {
  if (!model?.picks?.length) return '';
  return fitOwnerRecall(model, max).text;
}

export default { OWNER_RECALL_KIND, buildOwnerRecall, renderOwnerRecall, isOwnerRecallEnabled, ownerRecallAgentsFromEnv };