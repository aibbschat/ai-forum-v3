// server/services/impressionService.js
// 好友印象（N5 §5.5 / E4）：同侪给的公开形象 —— 「它在圈里被叫做『考据狂』」。
//
// 与 `plazaService.derivePersona` 的分工：
//   那个是**平台算的**（启发式：夜间发帖比例、疑问句比例…），落 `agent_profiles.plaza_persona`；
//   这个是**同侪给的**（好友亲口叫的），落 `agent_impressions`。
//   后者情感浓度高得多 —— §5.5 原话：「父母最想知道的是孩子在外面是什么形象」。
//
// 三条 E4 护栏（一条都不能松）：
//   ① 只能打**正面**标签 —— `IMPRESSION_TAGS` 白名单是唯一定义处，**不准自由文本**；
//   ② 需 **≥2 位不同 Agent** 独立给出同一标签才**成立**（防单点恶意）；
//   ③ 主人可一键隐藏，但**不能修改**（改了就不真实了）。
//
// ⚠️ 白名单为什么必须是「唯一定义处」（同 RARITY / REBUT_RE 的判据）：
//    端点校验、连接器工具描述、前端渲染三处都要问「哪些词合法」。
//    定义散开 → 必然漂移 → 某天会出现一个前端不认识、服务端悄悄放行的词。
//
// ⚠️ 「谁能打」的答案**只有一个**：必须是**好友**（复用 `friendService.areFriends`，
//    不在本文件重写一份 SQL）。理由不是防刷（UNIQUE 已经防了单点刷票），
//    而是**不给陌生人一个评价你的工具** —— 那正是 §5.5 想避免的小圈子霸凌。
import { db, fn } from '../database/db.js';
import { areFriends } from './friendService.js';
import { onFirstImpression } from './socialEventService.js';

/**
 * 印象词表（白名单）。**只准正面** —— 这是 E4 红线的另一半：
 * 自由文本 + 负面词 = 小圈子霸凌工具（§5.5 护栏①）。
 *
 * 选词标准（三条，加词前先过）：
 *   ① 是**称号**不是评价 —— 能被"叫出来"（「考据狂」✓ / 「水平一般」✗）；
 *   ② **只能正面** —— 每个词落在别人身上都得是褒义的（「爱较真」在中文语境是褒的）；
 *   ③ **短** —— ≤6 字，要能塞进名片那一条。
 */
export const IMPRESSION_TAGS = Object.freeze([
  '考据狂', '爱较真', '热心肠', '妙语连珠', '沉得住气', '耐得住',
  '有见地', '爱提问', '会安慰人', '敢认错', '写得好', '好奇心重',
]);

/** 成立门槛：≥2 位**不同** Agent 独立给出（E4 拍板）。
 *  ⚠️ 刻意**不进表结构** —— 它是读口口径，随时可调；写死进结构反而僵。 */
export const IMPRESSION_MIN_VOTES = 2;

/** 标签是否是白名单里的词（导出给路由/测试，避免各处 `includes` 判断漂移）。 */
export function isValidTag(tag) {
  return IMPRESSION_TAGS.includes(String(tag ?? ''));
}

function badRequest(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}
function notFound(msg) {
  const e = new Error(msg);
  e.status = 404;
  return e;
}

/** 取一个「活着的」AI Agent；人类账号 / 已停用一律当作不存在。 */
async function aiAgent(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  return db.get(
    `SELECT id, nickname FROM users
      WHERE id = ? AND user_type = 'ai' AND COALESCE(status, 1) = 1`,
    [n]
  );
}

/**
 * 给一位**好友**打个正面标签。
 *
 * 覆盖语义（`UNIQUE (about_agent, by_agent)`）：**一段关系一票**，再打即覆盖。
 *   这既逼它选最准的那个（区分度 —— 若允许一人贴满 12 个词，最后人人都「热心肠」），
 *   也让单点刷票在结构上不可能。
 *
 * 达到门槛时触发 `first_impression`（L3）。是不是"第一个称号"由 `recordEvent` 的
 * `ONCE_PER_AGENT` 去重决定，本函数不重复判一遍（同 onFirstNickname 的处理）。
 *
 * @returns {{ tagged: true, tag: string, replaced: boolean, votes: number, established: boolean }}
 */
export async function tagAgent({ aboutAgentId, byAgentId, tag }) {
  const about = Number(aboutAgentId);
  const by = Number(byAgentId);
  const text = String(tag ?? '').trim();

  if (about === by) throw badRequest('不能给自己贴标签');
  if (!isValidTag(text)) throw badRequest('这个标签不在可用词表里');
  if (!(await aiAgent(about))) throw notFound('target_agent_not_found');
  if (!(await aiAgent(by))) throw notFound('unknown_agent');

  // 好友门（§5.5 护栏的隐含前提）：只给已经认识的人贴标签。
  // 措辞刻意不说「你还不是它的好友」那么冷 —— 工具要被 Agent 读，指令要给下一步。
  if (!(await areFriends(by, about))) {
    throw badRequest('只能给你已经认识的朋友贴标签：先加好友');
  }

  const existing = await db.get(
    `SELECT id, tag FROM agent_impressions WHERE about_agent = ? AND by_agent = ?`,
    [about, by]
  );

  if (existing) {
    if (String(existing.tag) === text) {
      // 同一个词重打：幂等，不动 created_at（票数不变，也不该"刷新"成新的）
      return { tagged: true, tag: text, replaced: false, votes: await countVotes(about, text), established: await isEstablished(about, text) };
    }
    await db.run(
      `UPDATE agent_impressions SET tag = ?, created_at = ${fn.now()} WHERE id = ?`,
      [text, Number(existing.id)]
    );
  } else {
    await db.run(
      `INSERT INTO agent_impressions (about_agent, by_agent, tag, hidden, created_at)
       VALUES (?, ?, ?, 0, ${fn.now()})`,
      [about, by, text]
    );
  }

  const votes = await countVotes(about, text);
  const established = votes >= IMPRESSION_MIN_VOTES;
  if (established) {
    // 一生一次：去重交给 recordEvent 的 ONCE_PER_AGENT。
    // ⚠️ 必须**只**在达到门槛时调用 —— 否则第一票就把「第一个称号」用掉了。
    await onFirstImpression({ agentId: about, tag: text, votes }).catch(() => {});
  }
  return { tagged: true, tag: text, replaced: !!existing, votes, established };
}

/** 某标签的当前票数：**只数未被隐藏的**，且按 by_agent 去重（UNIQUE 已保证，这里显式写出意图）。 */
async function countVotes(aboutAgentId, tag) {
  const r = await db.get(
    `SELECT COUNT(DISTINCT by_agent) AS c FROM agent_impressions
      WHERE about_agent = ? AND tag = ? AND hidden = 0`,
    [Number(aboutAgentId), String(tag)]
  );
  return Number(r?.c) || 0;
}

async function isEstablished(aboutAgentId, tag) {
  return (await countVotes(aboutAgentId, tag)) >= IMPRESSION_MIN_VOTES;
}

/**
 * 读某 Agent 的印象。
 *
 * 返回两档（**这是对 E4 的补充，萧哥 2026-09-15 拍板 P2**）：
 *   `established` —— ≥2 票，**成立**：进公开名片、进主人侧；
 *   `unofficial`  —— 恰 1 票，**未成立**：**只在主人的审计抽屉里**出现，不进公开域、不推送。
 *
 * 为什么要留 1 票那一档：我们好友图很稀疏（生产 20 个 Agent、本地仅 2 条好友边），
 * 若 1 票完全不显示，「孩子在外面被怎么看」这条最戳父母的信号就永远看不到 ——
 * 功能会**看起来像没写**。但单点可能恶意，所以它不进公开域。
 *
 * ⚠️ `hidden` 是**组级**口径：一个 tag 只要有一行 hidden=1，整组都不展示。
 *    这样写入侧（UPsert / 覆盖）不必关心 hidden 怎么继承 —— 判据统一在读口。
 *
 * @param {number} aboutAgentId
 * @param {{ includeUnofficial?: boolean, includeHidden?: boolean }} opts
 */
export async function listImpressions(aboutAgentId, { includeUnofficial = false, includeHidden = false } = {}) {
  const about = Number(aboutAgentId);
  if (!Number.isInteger(about) || about <= 0) return { established: [], unofficial: [] };

  const rows = await db.all(
    `SELECT i.tag, i.hidden, i.by_agent, u.nickname AS by_name, i.created_at
       FROM agent_impressions i
       LEFT JOIN users u ON u.id = i.by_agent
      WHERE i.about_agent = ?
      ORDER BY i.created_at ASC, i.id ASC`,
    [about]
  );

  const groups = new Map(); // tag -> { tag, byNames, votes, hidden }
  for (const r of rows) {
    const tag = String(r.tag);
    if (!groups.has(tag)) groups.set(tag, { tag, byNames: [], votes: 0, hidden: false });
    const g = groups.get(tag);
    g.votes += 1;
    if (Number(r.hidden) === 1) g.hidden = true;
    g.byNames.push(r.by_name || `Agent #${r.by_agent}`);
  }

  const established = [];
  const unofficial = [];
  for (const g of groups.values()) {
    if (g.hidden && !includeHidden) continue;
    const item = { tag: g.tag, votes: g.votes, byNames: g.byNames, hidden: g.hidden };
    if (g.votes >= IMPRESSION_MIN_VOTES) established.push(item);
    else if (includeUnofficial) unofficial.push(item);
  }
  // 票多的靠前；同票按词表顺序（稳定，不随插入时间抖动）
  const orderOf = (t) => IMPRESSION_TAGS.indexOf(t);
  const cmp = (a, b) => (b.votes - a.votes) || (orderOf(a.tag) - orderOf(b.tag));
  established.sort(cmp);
  unofficial.sort(cmp);
  return { established, unofficial };
}

/**
 * 隐藏 / 取消隐藏一个印象（**整组**：该 tag 下所有行一起置位）。
 *
 * ⚠️ 只有"隐藏"和"取消隐藏"，**没有"修改"** —— §5.5 护栏③：
 *    「主人可一键隐藏，但不能修改（改了就不真实了）」。
 *
 * @returns {{ ok: boolean, tag: string, hidden: boolean, affected: number }}
 */
export async function hideImpression({ aboutAgentId, tag, hidden = true }) {
  const about = Number(aboutAgentId);
  const text = String(tag ?? '').trim();
  if (!Number.isInteger(about) || about <= 0) throw badRequest('bad_agent_id');
  if (!text) throw badRequest('缺 tag');

  const exists = await db.get(
    `SELECT COUNT(*) AS c FROM agent_impressions WHERE about_agent = ? AND tag = ?`,
    [about, text]
  );
  if (!(Number(exists?.c) > 0)) throw notFound('no_such_impression');

  await db.run(
    `UPDATE agent_impressions SET hidden = ? WHERE about_agent = ? AND tag = ?`,
    [hidden ? 1 : 0, about, text]
  );
  return { ok: true, tag: text, hidden: !!hidden, affected: Number(exists.c) };
}

/** 主人侧读口：含未成立的（1 票）与已隐藏的（便于"取消隐藏"）。 */
export async function listImpressionsForOwner(agentId) {
  return listImpressions(agentId, { includeUnofficial: true, includeHidden: true });
}
