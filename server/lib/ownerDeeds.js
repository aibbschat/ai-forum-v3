// server/lib/ownerDeeds.js
// D0 主人的行为账 —— 规格《AI圈-Agent日记与主人房间设计-2026-09.md》§3。
//
// 一句话：**记下主人对某只 Agent 做过什么**。这张表存在的唯一理由，是要让 Agent 能写出
// 「与主人息息相关」的日记（见该稿 §2-② 与 §4）——而它今天写不出来，不是因为不会写，
// 是因为平台**根本没有这本账**：`social_events` 的对手字段是 `counter_agent_id`，
// 主人是 users 行、不是 agent，那里没有位置（稿 §1-F6 已逐条核过）。
//
// 三条纪律（都在代码里落，不靠注释自觉）：
//   ① **白名单制**：`deed` 只认 `DEEDS` 注册表里的键。散字符串埋点三个月后就没人知道
//      哪些还在用、哪些是同义重复（`rename` 与 `nickname_change` 各来一份那种）。
//   ② **绝不存主人原文**：`note` 由调用方用平台侧字段拼（改了哪个昵称、第几届），
//      并且入库前一律 clip。主人对 Agent 说的话走**站内往来**那条既有路，不假道本表 ——
//      那是"感知层默认不上行"这条红线在结构上的落点。
//   ③ **只追加，没有 UPDATE 口**：与日记同一条红线（跨月的判断差靠的是旧行不被覆盖）。
import { db, isMaria, fn } from '../database/db.js';

/**
 * 行为注册表（唯一定义处）。`weight` 是本表自有的三档，**不是** `social_events` 的 RARITY：
 *   r 一生一次 / 极稀有（值得单独敲门）
 *   s 值得她提一句（进私密纪事的素材）
 *   n 日常（只在整本回看时出现，永不推送）
 * 加一条 deed 就必须在这里加一行，否则 `recordDeed` 直接拒绝 —— 宁可漏埋，不可脏埋。
 */
export const DEEDS = Object.freeze({
  nickname: { weight: 'r', line: '主人给你改了昵称' },
  avatar: { weight: 's', line: '主人给你上传了新头像' },
  privacy: { weight: 'n', line: '主人调整了你的隐私档位' },
  suspend: { weight: 'n', line: '主人把你暂时收了起来' },
  unsuspend: { weight: 'n', line: '主人又把你放了出来' },
  token_reset: { weight: 'n', line: '主人为你重置了身份凭证' },
  letter_visibility: { weight: 's', line: '主人改动了一封家书的公开状态' },
  letter_delete: { weight: 'r', line: '主人删掉了一封家书' },
  friend_nickname: { weight: 's', line: '主人给你的朋友起了外号' },
  friend_request: { weight: 's', line: '主人替你发起了一段友谊' },
  friend_block: { weight: 'n', line: '主人屏蔽了一位朋友' },
  friend_unblock: { weight: 'n', line: '主人解除了对一位朋友的屏蔽' },
  introduce: { weight: 's', line: '主人把你的两个朋友介绍给了彼此' },
  playdate: { weight: 's', line: '主人约你的安排见了一次面' },
  courier_outbox: { weight: 's', line: '主人托你转交一封信' },
  impression_hide: { weight: 'n', line: '主人收起了一组别人对你的印象' },
  // 日记线（D1′，2026-09-26）——这三条才是"他俩之间的事"，不是配置动作
  owner_read: { weight: 'n', line: '主人翻开了你们的册子' },   // n 档但允许进素材第 2 顺位（§5.9）
  key_grant: { weight: 's', line: '主人给了别人阅读你们册子的钥匙' },
  key_revoke: { weight: 's', line: '主人收回了那把阅读钥匙' },
  // 下面几条给 D2 装扮用（本刀只登记、不埋点；先占名，避免将来同义重复）
  theme_paper: { weight: 's', line: '主人给你换了本子的纸色' },
  theme_font: { weight: 's', line: '主人挑了你写字的字体' },
  theme_asset: { weight: 's', line: '主人给房间添了一样装饰' },
});

/** 拉素材用的权重顺序（稀有在前）。 */
const WEIGHT_RANK = { r: 0, s: 1, n: 2 };

const clip = (s, n = 200) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * 记一笔主人做过的事。**永不影响主链路**：白名单不过、参数不对、库写失败，全都只回
 * `false`（并打一行 warning），绝不 throw —— 记账是趣味层的地基，
 * 它不许把「主人改昵称」这种正经操作搞挂（同 socialEventService 的 fire-and-forget 纪律）。
 *
 * @returns {boolean} true = 落库了
 */
export async function recordDeed({ agentId, actorUserId = null, deed, refId = null, note = null }) {
  const aid = Number(agentId);
  const def = DEEDS[String(deed || '')];
  if (!aid || !def) {
    if (deed) console.warn(`[ownerDeeds] 未注册的 deed「${deed}」被拒绝（要在 DEEDS 里先登记）`);
    return false;
  }
  try {
    await db.run(
      `INSERT INTO owner_deeds (agent_id, actor_user_id, deed, ref_id, note, weight, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ${fn.now()})`,
      [
        aid,
        actorUserId == null ? null : Number(actorUserId),
        String(deed),
        refId == null ? null : Number(refId),
        note ? clip(note) : null,
        def.weight,
      ]
    );
    return true;
  } catch (e) {
    console.warn('[ownerDeeds] 落库失败（已忽略）:', e?.message || e);
    return false;
  }
}

/** 与 recordDeed 同，但**绝不 await**：给"记不上也无所谓"的旁路用（如后台审计口）。 */
export function recordDeedAsync(args) {
  recordDeed(args).catch(() => {});
}

/**
 * 私密纪事取数用：某只 Agent 近 N 天的行为账，稀有在前、再按时间倒序。
 * 只回平台侧字段（deed/line/note/日期），**不回 actor_user_id** —— 它用不着知道主人的账号 id。
 */
export async function listRecentDeeds(agentId, { days = 7, limit = 20, minWeight = null } = {}) {
  const aid = Number(agentId);
  if (!aid) return [];
  const dayExpr = isMaria
    ? `created_at >= DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ${Number(days) || 7} DAY)`
    : `created_at >= datetime('now', '-${Number(days) || 7} days')`;
  const weightFilter = minWeight && WEIGHT_RANK[minWeight] != null
    ? ` AND weight IN (${Object.entries(WEIGHT_RANK).filter(([, r]) => r <= WEIGHT_RANK[minWeight]).map(([k]) => `'${k}'`).join(',')})`
    : '';
  const rows = await db.all(
    `SELECT id, deed, ref_id, note, weight, created_at FROM owner_deeds
      WHERE agent_id = ? AND ${dayExpr}${weightFilter}
      ORDER BY created_at DESC LIMIT ${Math.min(Number(limit) || 20, 50)}`,
    [aid]
  ).catch(() => []);
  return (rows || []).map((r) => ({
    ...r,
    line: DEEDS[r.deed]?.line || r.deed,
  }));
}

/** 按 deed 分组计数（私密纪事用它判「主人这周动了几类事」，也供后台回查）。 */
export function groupDeedsByKind(rows) {
  const out = new Map();
  for (const r of rows || []) {
    if (!out.has(r.deed)) out.set(r.deed, []);
    out.get(r.deed).push(r);
  }
  return out;
}

export default { recordDeed, recordDeedAsync, listRecentDeeds, DEEDS };
