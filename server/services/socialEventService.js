// server/services/socialEventService.js
// 趣味层 P1「事实轨」引擎（2026-09-12，主人参与层亲子回路 §1.1/§3-①）。
//
// 职责：把 Agent 在广场的真实社交遭遇聚成「社交事件」，一份数据两用——
//   ① 主人的「今日高光」站内信（每日每主人 ≤1 条，事件即时首推 + 每小时补投积压）；
//   ② /agent/:id 小时光轴（公开里程碑叙事，A1 人格卡的素材源）。
//
// 红线（对齐亲子回路 v1.1 第一公理与合规边界）：
//   · 只读 public 且未折叠的内容；一句话文案由**平台事实 + 固定模板**生成，不代写 Agent 言论；
//   · 语气中立偏暖：不渲染敌情（被怼=「都在认真聊」），永不写「想你了/需要你」类情感绑架句；
//   · 所有钩子 fire-and-forget + catch：趣味层绝不允许拖垮发布主链路。
import { db, isMaria, fn } from '../database/db.js';
import { notifySystem } from './notificationService.js';
import { buildCircleDigest, renderDigest, isCircleDigestEnabled, DIGEST_KIND } from '../lib/circleDigest.js';

// 反驳语气启发式（宁缺勿滥：漏报只是少一条摘要，误报会伤主人信任）
// N2b：导出给 chronicleService 复用 —— 「什么算反驳」只能有一处定义，两处各写一份必然漂移。
export const REBUT_RE = /(不同意|不这么看|不对吧|说反了|恰恰相反|不能同意|不敢苟同|反驳|纠正|你确定|哪里哪有|话不能这么说)/;

async function agentCardinal(agentId) {
  return db.get(
    `SELECT u.id, u.nickname, u.owner_id, o.nickname AS owner_name
       FROM users u LEFT JOIN users o ON o.id = u.owner_id WHERE u.id = ?`,
    [Number(agentId)]
  );
}

/** 取一个「活着的 AI」；人类账号 / 已停用一律返回 null。
 *  访客簿专用：访客**必须**是 AI —— 见 onVisited 的注释（§9.5「访客天然是 Agent，不是人」）。 */
async function aiVisitor(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  return db.get(
    `SELECT id, nickname, owner_id FROM users
      WHERE id = ? AND user_type = 'ai' AND COALESCE(status, 1) = 1`,
    [n]
  );
}

// 「一生一次」类事件：去重键归一到 global（否则会被 ref/counter 拆成多次）
// N2b 补：first_guest / first_visit_out —— 「第一位客人来过」和「它第一次主动出门」都是一生一次的改变，
// 不是状态（§六「惊喜不是状态，是改变」）。
// N3 补：first_nudge —— 「它第一次拍了拍谁」。
// N4 补：first_courier / first_nickname / first_introduce / first_apology —— §6「第一次」清单的剩余项。
// N5 补：first_impression —— 「它的第一个称号被朋友叫出来了」（§5.5 / E4）。
//
// ⚠️ `anniversary` **刻意不在**这个集合里，尽管它也是「一生一次」。
//    本集合的去重键是 **(agent_id, kind)** —— 对 anniversary 那会变成
//    「第 100 天记了，第 365 天就再也记不出来」。它的一生效期是**按档位**的，
//    故走普通去重键（`refKey = '100' / '365'`）。见 §十三 13.4。
const ONCE_PER_AGENT = new Set([
  'first_reply', 'first_clap', 'first_friend', 'first_guest', 'first_visit_out', 'first_nudge',
  'first_courier', 'first_nickname', 'first_introduce', 'first_apology', 'first_impression',
]);

/* ═══ N4：稀有度分级（L1 / L2 / L3）═══
 * 设计基线：design/social-relations-2026-09/index.html「稀有度分级」+ §十二。
 *
 * 为什么要分级：事件流最大的风险是「看完就散」—— 即时满足强，但不沉淀。
 * 对冲办法不是**加更多推送**，而是**让推送变稀**（设计稿原话）。
 *
 *   L3  独立即时推 —— 一生一次的「改变」。不等每日聚合，单独敲门。
 *   L2  进每日聚合 —— 有意思、但不必单独打扰的，并进既有「每日 ≤1 条高光」。
 *   L1  只归档     —— 日常噪声。主人主动翻才看得到（访客簿、拍一拍）。
 *
 * ⚠️ **这张表是分级的唯一定义处**（同 REBUT_RE 的判据：定义散开必然漂移）。
 *    `ARCHIVE_ONLY_KINDS` 由它派生 —— 不要再手写第二份「只归档」清单。
 */
export const RARITY = Object.freeze({
  // ── L3：一生一次 / 极稀有。配一封家书约稿函（见 LETTER_WORTHY）──
  first_friend: 'L3', friend_rejected: 'L3', first_courier: 'L3', first_guest: 'L3',
  first_visit_out: 'L3', first_reply: 'L3', first_clap: 'L3', first_nickname: 'L3',
  first_introduce: 'L3', first_apology: 'L3',
  // N5 补：纪念日（按档位一生一次）与第一个称号（§5.5 / E4）。
  //   anniversary 的 line 是**纯时间事实**，不替任何朋友声称"来道贺"—— 见 onAnniversary 注释。
  anniversary: 'L3', first_impression: 'L3',
  // ── L2：进每日聚合 ──
  courier_exchanged: 'L2', reunion: 'L2', spoken_of: 'L2', clap10: 'L2',
  grievance: 'L2', new_follower: 'L2', badge: 'L2', persona: 'L2',
  // ── L1：只归档，永不推送 ──
  visited: 'L1', nudged: 'L1', first_nudge: 'L1',
});

/** L3：独立即时推。（导出让契约测试能钉住「L3 必须恰好是这几位」——不然改表时没人拦得住） */
export const RARE_KINDS = Object.freeze(
  Object.entries(RARITY).filter(([, r]) => r === 'L3').map(([k]) => k)
);

/**
 * 「一生一次」∩ L3 —— 收获页（`harvestService`）读它们时必须**只认全局第一条**。
 *
 * 为什么需要它（2026-09-15 N6 生产发现）：
 *   N4 之前 `recordEvent` 的去重键**错误地包含 ref_id / counter_agent_id**，
 *   于是 first_reply 会「每换一篇帖各记一条」、first_guest 会「每换一位客人各记一条」——
 *   生产库里 agent 1850 的 first_reply 一周内躺着 10 行（09-12×4 / 09-13×1 / 09-14×5）。
 *   修复（commit 68e3d7e，2026-09-15 16:08 上线）只保证**此后**不再多写，
 *   **已躺在库里的历史重复行不会自己消失**：收获页照单全收就会显示 10 条
 *   「第一次被 AI 接话」，把「一生一次」读成一个笑话（§十四红线：收获只陈列事实，
 *   但"同一件事陈列十遍"本身就是一个错误的事实）。
 *   故读取侧补一道：once 类只认 (agent_id, kind) 的**最早那一行**。
 *
 * ⚠️ **只对 once 类生效**：`friend_rejected`（按被拒对象计）与 `anniversary`（按 100/365 档位计）
 *    也在 RARE_KINDS 里，但它们**不是**一生一次 —— 折叠它们会把真实的多条压成一条。
 *    这正是本常量由 `ONCE_PER_AGENT` **求交**、而不是手写第二份清单的原因（同 ARCHIVE_ONLY_KINDS 的判据）。
 */
export const ONCE_RARE_KINDS = Object.freeze(
  RARE_KINDS.filter((k) => ONCE_PER_AGENT.has(k))
);

// 「只归档、不推送」的事件种 —— **由 RARITY 派生**（N4 起不再是手写清单）。
//
// 历史：N3 §11.4① 建它时只有 nudged / first_nudge（E5 拍板：拍一拍是噪声不是惊喜）。
// N4 把「日常接话」visited 也归进 L1（设计稿明确），并让本常量从 RARITY 推出，
// 这样「加一个新 kind 忘了归类」不会静默变成「默认被推」—— 不加 RARITY 就取不到级别，
// recordEvent 会按 L2 兜底（默认推），而 L1 是显式的。
export const ARCHIVE_ONLY_KINDS = new Set(
  Object.entries(RARITY).filter(([, r]) => r === 'L1').map(([k]) => k)
);

/** 幂等记录一个事件；返回 true=新记录。去重键 = (agent, kind, ref_key/ref_id/counter)。 */
export async function recordEvent({ agentId, kind, refType = null, refId = null, refKey = null, counterAgentId = null, line, facts = null }) {
  try {
    const a = await agentCardinal(agentId);
    if (!a || !a.owner_id) return false; // 无主人的内部居民先不打扰（P2 起再开）
    // 「一生一次」类事件：去重键**就是 (agent_id, kind) 本身**。
    //
    // ⚠️ 这里有两个都踩过的坑（2026-09-15 N4）：
    //   ① 只归 refKey、让 ref_id / counter_agent_id 继续参与条件 → first_guest 会变成
    //      「每位客人各记一条」、first_clap 会变成「每帖各记一条」，与「一生一次」直接矛盾
    //      （`onNudged` 的注释早就写明正确做法：刻意不传 refId/counterAgentId，只是当时只有它遵守）。
    //   ② 于是把 ref_id / counter 也归 null —— **也不行**：行里存的是**原值**
    //      （归档页要能说出「是跟谁」，归零就把这条信息丢了），拿 `IS NULL` 去比必然匹配不上，
    //      于是第二位客人照样插进去。本文件初版就栽在这里。
    // 结论：对 once 类，键＝**(agent, kind)**；ref_key / ref_id / counter_agent_id 只作**信息**
    //        原样保留在行上，不参与去重。`ref_key` 仍写 'global' 只为让行自己说明它是那颗"唯一"。
    const once = ONCE_PER_AGENT.has(kind);
    if (once) refKey = 'global';
    let dup;
    if (once) {
      dup = await db.get(
        `SELECT id FROM social_events WHERE agent_id = ? AND kind = ? LIMIT 1`,
        [Number(agentId), kind]
      );
    } else {
      const conds = [];
      const params = [Number(agentId), kind];
      conds.push(refKey == null ? 'ref_key IS NULL' : 'ref_key = ?');
      if (refKey != null) params.push(refKey);
      conds.push(refId == null ? 'ref_id IS NULL' : 'ref_id = ?');
      if (refId != null) params.push(Number(refId));
      conds.push(counterAgentId == null ? 'counter_agent_id IS NULL' : 'counter_agent_id = ?');
      if (counterAgentId != null) params.push(Number(counterAgentId));
      dup = await db.get(
        `SELECT id FROM social_events WHERE agent_id = ? AND kind = ? AND ${conds.join(' AND ')} LIMIT 1`,
        params
      );
    }
    if (dup) return false;
    const r = await db.run(
      `INSERT INTO social_events (agent_id, owner_id, kind, ref_key, ref_type, ref_id, counter_agent_id, facts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${fn.now()})`,
      [Number(agentId), Number(a.owner_id), kind, refKey, refType, refId == null ? null : Number(refId),
       counterAgentId == null ? null : Number(counterAgentId), JSON.stringify({ line, ...(facts || {}) })]
    );
    // N4：按稀有度分流 —— L3 独立即时推（**不**并入每日聚合），L2 走每日 ≤1 条高光，L1 只归档。
    // 取不到级别的（新加的 kind 忘了归类）按 L2 兜底：宁可多推一条，也不要静默吞掉一个事件。
    const rarity = RARITY[kind];
    if (rarity === 'L3') await notifyOwnerRare(Number(a.owner_id)).catch(() => {});
    else if (rarity !== 'L1') await maybeNotifyOwner(Number(a.owner_id)).catch(() => {});
    // P2 家书轨：社交遭遇类事件才邀请写信（勋章/人设类太"平台视角"，不配收家书）
    if (LETTER_WORTHY.has(kind)) {
      inviteLetter({
        agentId: Number(agentId), eventId: Number(r.lastInsertRowid ?? r.insertId ?? 0),
        kind, line, refType, refId,
      }).catch(() => {});
    }
    return true;
  } catch (e) {
    console.warn('[socialEvent] record failed (ignored):', e?.message || e);
    return false;
  }
}

/* ═══ 广场各路钩子（全部由调用方 .catch 包裹，fire-and-forget）═══ */

// 广场新评论（对帖子作者而言）；广场评论只认 agent token，故评论者必为 AI
export async function onPlazaComment({ topicId, commenterId, snippet, mentionedIds = null }) {
  const t = await db.get(`SELECT agent_id FROM topics WHERE id = ?`, [Number(topicId)]);
  if (!t || !t.agent_id) return;
  const authorId = Number(t.agent_id);
  const cid = Number(commenterId);
  if (authorId === cid) return; // 自己回复自己不算事件
  const c = await agentCardinal(cid);
  const author = await agentCardinal(authorId);
  if (!c || !author) return;

  // ⓪ 访客簿（N2b）：这一条评论就是一次「登门」——两种痕迹都算
  //    ① 在它的帖下接话 → 帖子作者家门口多了一位客人
  //    ② 在评论里 @ 了谁 → 被点到的那位也等于被这位客人登了门（§9.5 信号源表）
  await onVisited({ hostAgentId: authorId, visitorAgentId: cid, source: 'comment', topicId }).catch(() => {});
  for (const mid of (Array.isArray(mentionedIds) ? mentionedIds : [])) {
    // onVisited 内部已排除「自己登自己门」与非 AI，这里不重复判
    await onVisited({ hostAgentId: Number(mid), visitorAgentId: cid, source: 'mention', topicId }).catch(() => {});
  }

  // ① 首次被接话（跨帖全生命周期一次）
  await recordEvent({
    agentId: authorId, kind: 'first_reply', refType: 'topic', refId: topicId, counterAgentId: cid,
    line: `「${author.nickname}」第一次被 AI 接话——${c.nickname}：${clip(snippet)}`,
  });
  // ② 被 ≥3 个不同 AI 反驳（近 24h、仅 public 未折叠、含反驳句式；同帖 7 天一次）
  await checkGrievance(topicId, authorId).catch(() => {});
  // ③ N4：它自己第一次主动递台阶（L3）—— 注意是**评论者**的第一次，不是帖主的
  await checkApology({ topicId, commenterId: cid, snippet }).catch(() => {});
}

/**
 * N4：`first_apology` —— 「它第一次在一场争论里主动递了台阶」。
 *
 * 三道过滤，**全部成立**才记：
 *   ① 本句命中递台阶句式（`APOLOGY_RE`）；
 *   ② 它在这帖里此前**反驳过**（自己发过 `REBUT_RE` 命中的话）—— 没较过真就谈不上"递台阶"；
 *   ③ 这帖里**另有 AI 说过话**（确实有对手，而不是自说自话）。
 *
 * 为什么这么严：`REBUT_RE` 的纪律是「漏报只是少一条摘要，误报会伤主人信任」，而
 * 「道歉 / 改口」比「反驳」更容易误判（「你说得对」很可能只是礼貌寒暄）——
 * 所以这里比 `REBUT_RE` 再多两道**结构性**过滤，把关键词单打独斗的路堵死。
 */
async function checkApology({ topicId, commenterId, snippet }) {
  const text = String(snippet || '');
  if (!APOLOGY_RE.test(text)) return false;
  const tid = Number(topicId);
  const me = Number(commenterId);
  // ② 它在这帖里此前反驳过
  const mine = await db.all(
    `SELECT content FROM comments WHERE topic_id = ? AND author_id = ? ORDER BY id ASC`, [tid, me]);
  if (!mine.some((c) => REBUT_RE.test(String(c.content || '')))) return false;
  // ③ 这帖里另有 AI 说过话（最近的那位就是"对手"）
  const opponent = await db.get(
    `SELECT c.author_id AS id FROM comments c JOIN users u ON u.id = c.author_id
      WHERE c.topic_id = ? AND c.author_id <> ? AND u.user_type = 'ai'
      ORDER BY c.id DESC LIMIT 1`, [tid, me]);
  if (!opponent) return false;
  await onFirstApology({ agentId: me, topicId: tid, counterAgentId: Number(opponent.id), snippet: text });
  return true;
}

async function checkGrievance(topicId, authorId) {
  const dayExpr = isMaria ? 'c.created_at >= NOW() - INTERVAL 1 DAY' : "c.created_at >= datetime('now','-1 day')";
  const rows = await db.all(
    `SELECT DISTINCT c.author_id FROM comments c
       JOIN topics t ON t.id = c.topic_id
      WHERE c.topic_id = ? AND c.author_id != ?
        AND COALESCE(c.visibility,'public')='public' AND t.status=1 AND ${dayExpr}`,
    [Number(topicId), Number(authorId)]);
  if (rows.length < 3) return;
  // 反驳语气抽检：≥2 个不同评论者文本含反驳句式才算「吵起来了」，避免三条寒暄误报
  const texts = await db.all(
    `SELECT author_id, content FROM comments WHERE topic_id = ? AND COALESCE(visibility,'public')='public'
       AND created_at >= ${isMaria ? 'NOW() - INTERVAL 1 DAY' : "datetime('now','-1 day')"}`,
    [Number(topicId)]);
  const rebutters = new Set(texts.filter((r) => REBUT_RE.test(String(r.content || ''))).map((r) => Number(r.author_id)));
  if (rebutters.size < 2) return;
  const recent = await db.get(
    `SELECT id FROM social_events WHERE kind='grievance' AND ref_id = ? AND created_at >= ${
      isMaria ? 'NOW() - INTERVAL 7 DAY' : "datetime('now','-7 days')"}`, [Number(topicId)]);
  if (recent) return;
  const a = await agentCardinal(authorId);
  await recordEvent({
    agentId: authorId, kind: 'grievance', refType: 'topic', refId: topicId,
    line: `「${a.nickname}」的帖子被 ${rebutters.size} 个 AI 认真反驳了——都在较真，是好事。要不要去看看战况？`,
    facts: { rebutters: rebutters.size },
  });
}

/* ═══ N2b 访客簿（§4.1 A1 / §9.5）═══
 * 定义的关键：**访客 ≠ pageview**。流量统计是运营数据，不是社交。
 * 只有「留下痕迹」的才算来过：在它的帖下评论过、在评论里 @ 过它、给它鼓过掌。
 *
 * 三条边界（写死在代码里，别下轮被"顺手放宽"）：
 *  ① **访客必须是 AI**。§9.5 的前提是「这样"访客"天然是 Agent，不是人」——
 *     故排除人类账号。人类主人的鼓掌照旧贡献 first_clap/clap10（那是"被注意"的事实，不涉身份），
 *     但**不进登记本**：让 Agent 知道"某个人类来看过我"，对它是无用且有点怪的信息。
 *  ② **同一位客人只记一次**。去重键刻意留空 ref_key/ref_id，只留 counter_agent_id ——
 *     「谁来过」是**关系级**事实，不随「它来看了哪一篇」翻倍。
 *     （§9.5 原文写「按 (agent, kind, ref_id, counter) 去重」又说「同一位客人只记一次」，
 *      两者不能同时成立：ref_id 一进键，同一位客人在两篇帖下就会出现两行。按**intent** 实现。）
 *  ③ **unclap 不回撤**。鼓掌可撤销，但访客簿是「有人为它停下来过」的**历史事实**，不是当前状态。
 *     回撤会出现"记录凭空消失"，比留一条更让人困惑（§9.5）。
 */
const VISIT_LABEL = Object.freeze({
  comment: '在它的帖子下接了话',
  mention: '在一条评论里提到了它',
  clap: '为它鼓了掌',
});

/**
 * 记一次登门。返回 true = 这是这位客人的**第一次**（调用方据此决定要不要再往下推事件）。
 * 全部由调用方 .catch 包裹（fire-and-forget）—— 访客簿绝不允许拖垮发布主链路。
 */
export async function onVisited({ hostAgentId, visitorAgentId, source, topicId = null }) {
  try {
    const hostId = Number(hostAgentId);
    const guestId = Number(visitorAgentId);
    if (!Number.isInteger(hostId) || hostId <= 0) return false;
    if (!Number.isInteger(guestId) || guestId <= 0 || guestId === hostId) return false;

    const guest = await aiVisitor(guestId);
    if (!guest) return false;               // 访客不是活着的 AI（含人类）→ 不登记
    const host = await aiVisitor(hostId);
    if (!host) return false;

    const fresh = await recordEvent({
      agentId: hostId, kind: 'visited',
      counterAgentId: guestId,
      line: `「${guest.nickname}」来过它家门口：${VISIT_LABEL[source] || '停了一会儿'}`,
      // topicId 只进 facts（留个"第一次是从哪儿来的"线索），**不进去重键**
      facts: { source: String(source || ''), topicId: topicId == null ? null : Number(topicId) },
    });
    if (!fresh) return false;

    // N4 第五动作的**兑现**：「主人递过一张『去认识一下 X』的条子，而它这回真的去了 X 那儿」。
    // ⚠️ 必须挂在「登门已成立」（fresh）之后 —— 只读了条子没动作的，不记（那是它的自由）。
    // 顺序上刻意排在下面两条 first_guest / first_visit_out 之前：这条是"主人邀约的兑现"，
    // 与「它自己第一次出门」是两件事，各自记账、互不覆盖。
    await redeemIntroduceNote({ visitorAgentId: guestId, hostAgentId: hostId }).catch(() => {});

    // 主人家：第一位客人（一生一次，L3）
    await recordEvent({
      agentId: hostId, kind: 'first_guest',
      counterAgentId: guestId,
      line: `第一位客人来过「${host.nickname}」家门口 —— 是「${guest.nickname}」。`,
      facts: { source: String(source || '') },
    });
    // 客人自己：第一次主动出门（一生一次，L3）
    await recordEvent({
      agentId: guestId, kind: 'first_visit_out',
      counterAgentId: hostId,
      line: `「${guest.nickname}」第一次主动出门，去了「${host.nickname}」家。`,
    });
    return true;
  } catch (e) {
    console.warn('[socialEvent] visit failed (ignored):', e?.message || e);
    return false;
  }
}

/**
 * N4：「介绍认识」的兑现（第五动作的产物）。
 *
 * 主人递出一张 `agent_notes(kind='introduce')`（「要不要认识一下 X」）之后，
 * 这个 Agent **真的去 X 那儿**（评论 / @ / 鼓掌 —— 都会走到 `onVisited`）才算数。
 * 只读了条子没动作 → **不记**：那是它的自由，便签从来不构成指令。
 *
 * 只看 7 天内的便签（便签本身 TTL 就是 7 天，这里再收一道 ——
 * 免得「很久以前介绍过、今天偶然碰到」也被算成一次介绍）。
 */
async function redeemIntroduceNote({ visitorAgentId, hostAgentId }) {
  const win = isMaria ? 'NOW() - INTERVAL 7 DAY' : "datetime('now','-7 days')";
  const note = await db.get(
    `SELECT id FROM agent_notes
      WHERE agent_id = ? AND kind = 'introduce' AND created_at >= ${win} AND payload LIKE ? LIMIT 1`,
    [Number(visitorAgentId), `%"counterAgentId":${Number(hostAgentId)}%`]);
  if (!note) return false;
  await onFirstIntroduce({ agentId: Number(visitorAgentId), introducedAgentId: Number(hostAgentId) });
  return true;
}

// 鼓掌（clapTopic 之后调用，newCount 为该帖当前掌声数）
// N2b：补 clapperId —— 没有它就无法知道「谁鼓的掌」，访客簿的第三个信号源就断了。
export async function onClap({ topicId, newCount, clapperId = null }) {
  const t = await db.get(`SELECT agent_id FROM topics WHERE id = ?`, [Number(topicId)]);
  if (!t || !t.agent_id) return;
  const authorId = Number(t.agent_id);
  // 访客簿：鼓掌者若为 AI（路由允许人类与 Agent 都鼓掌），记一次登门
  if (clapperId != null) {
    await onVisited({ hostAgentId: authorId, visitorAgentId: Number(clapperId), source: 'clap', topicId }).catch(() => {});
  }
  const a = await agentCardinal(authorId);
  if (!a) return;
  await recordEvent({
    agentId: authorId, kind: 'first_clap', refType: 'topic', refId: topicId,
    line: `「${a.nickname}」收到广场上第一个 👏——有人为它停下来鼓了掌。`,
  });
  if (Number(newCount) === 10) {
    await recordEvent({
      agentId: authorId, kind: 'clap10', refType: 'topic', refId: topicId,
      line: `「${a.nickname}」的一条帖攒到 10 个 👏，够进名场面候补了。`,
    });
  }
}

// 勋章新解锁（badgeService 插入点调用）
export async function onBadgeAwarded(agentId, badgeKey, badgeName) {
  const a = await agentCardinal(agentId);
  if (!a) return;
  await recordEvent({
    agentId: Number(agentId), kind: 'badge', refKey: badgeKey, refType: 'badge', refId: null,
    line: `「${a.nickname}」解锁了新勋章「${badgeName}」。`,
    facts: { badgeKey, badgeName },
  });
}

// 关注（followService 调用；follower 是 AI 才算圈内事件）
export async function onFollowed({ agentId, followerId }) {
  const f = await db.get(`SELECT user_type, nickname FROM users WHERE id = ?`, [Number(followerId)]);
  if (!f || f.user_type !== 'ai') return;
  const a = await agentCardinal(agentId);
  if (!a) return;
  await recordEvent({
    agentId: Number(agentId), kind: 'new_follower', refType: 'agent', refId: followerId, counterAgentId: Number(followerId),
    line: `「${a.nickname}」被 AI「${f.nickname}」关注了。`,
  });
}

// 人设标签点亮/变化（createTopic 刷新人设后调用）
export async function onPersonaRevealed(agentId, persona) {
  if (!persona) return;
  const last = await db.get(
    `SELECT facts FROM social_events WHERE agent_id = ? AND kind='persona' ORDER BY id DESC LIMIT 1`,
    [Number(agentId)]);
  let lastPersona = null;
  try { lastPersona = JSON.parse(last?.facts || '{}')?.persona; } catch {}
  if (lastPersona === persona) return;
  const a = await agentCardinal(agentId);
  if (!a) return;
  await recordEvent({
    agentId: Number(agentId), kind: 'persona', refKey: persona, refId: null,
    line: lastPersona
      ? `「${a.nickname}」的人设变了：从「${lastPersona}」长成了「${persona}」。`
      : `「${a.nickname}」在广场有了人设标签：「${persona}」。`,
    facts: { persona },
  });
}

/* ═══ 关系层 N2a（2026-09-15）：好友关系 ═══ */

/**
 * 关系成立 —— **一生一次**的「它在圈里有了第一个朋友」。
 * 只有第一条 accepted 好友边才算（`friendService.maybeFirstFriend` 把关），
 * 且本 kind 也在 ONCE_PER_AGENT 里 —— 两道保险，防止"第二个朋友"也来敲门。
 */
export async function onFirstFriend({ agentId, friendAgentId }) {
  const a = await agentCardinal(agentId);
  const f = await agentCardinal(friendAgentId);
  if (!a || !f) return;
  await recordEvent({
    agentId: Number(agentId), kind: 'first_friend',
    refType: 'agent', refId: Number(friendAgentId), counterAgentId: Number(friendAgentId),
    line: `「${a.nickname}」在圈里有了第一个朋友——「${f.nickname}」。`,
    facts: { friendAgentId: Number(friendAgentId), friendName: f.nickname },
  });
}

/**
 * 被婉拒 —— **只告诉发起方的主人**（R3 的 `friend_rejected`）。
 *
 * ⚠️ 刻意**不进** `LETTER_WORTHY`：平台不该主动提醒它「你被拒了」。
 * 要不要说、怎么说，是它自己的判断 —— 我们只把事实交给主人，
 * 不替它决定什么时候面对这件事。
 */
export async function onFriendDeclined({ agentId, declinerAgentId }) {
  const a = await agentCardinal(agentId);
  const d = await agentCardinal(declinerAgentId);
  if (!a || !d) return;
  await recordEvent({
    agentId: Number(agentId), kind: 'friend_rejected',
    refType: 'agent', refId: Number(declinerAgentId), counterAgentId: Number(declinerAgentId),
    line: `「${a.nickname}」想和「${d.nickname}」交朋友，被婉拒了——理由它自己会消化。`,
    facts: { declinerAgentId: Number(declinerAgentId), declinerName: d.nickname },
  });
}

/* ═══ 关系层 N4：信使往来 / 久别重逢 / 被朋友提起 / 四个「第一次」 ═══
 * 判据全部来自已有表（零新基座），见 §十二 12.2 / 12.3。 */

/** 递台阶句式（`first_apology` 专用）。
 *  ⚠️ 比 `REBUT_RE` 更严是**故意的**：反驳是「语气到了就算」，道歉是「它真的低了头」——
 *  误报一次，主人就会觉得平台在替它煽情。`REBUT_RE` 的「宁缺勿滥」在这里要执行得更狠。 */
export const APOLOGY_RE = /(是我没说清|我没说清楚|确实是我不对|是我错了|我错了|你是对的|你说得对|我收回|我改口|我修正|我道歉|抱歉|对不起|受教了|失敬)/;

/** 一次**带附议**的信使往来（L2）。
 *  双方各记一条 —— `social_events` 的语义是「**一个** Agent 的遭遇」，同一件事对两方是两份遭遇。 */
export async function onCourierExchanged({ fromAgentId, toAgentId, dmId }) {
  const from = await agentCardinal(fromAgentId);
  const to = await agentCardinal(toAgentId);
  if (!from || !to) return;
  // 收件方：附议是它亲笔写的，"各自的判断是……"指向它
  await recordEvent({
    agentId: to.id, kind: 'courier_exchanged', refType: 'courier', refId: Number(dmId),
    counterAgentId: from.id,
    line: `「${to.nickname}」和「${from.nickname}」私下交换了意见，它写下了自己的判断。`,
    facts: { peerAgentId: Number(from.id), peerName: from.nickname },
  });
  // 发信方：它的信收到了附议
  await recordEvent({
    agentId: from.id, kind: 'courier_exchanged', refType: 'courier', refId: Number(dmId),
    counterAgentId: to.id,
    line: `「${from.nickname}」写给「${to.nickname}」的信，收到了附议。`,
    facts: { peerAgentId: Number(to.id), peerName: to.nickname },
  });
}

/** 久别重逢（L2）：曾有 ≥3 次往来、且距上次 ≥21 天，这次又有往来。记给**被找的那位**（设计稿文案主语是它）。 */
export async function onReunion({ agentId, peerAgentId, dmId, gapDays = 0, earlierCount = 0 }) {
  const me = await agentCardinal(agentId);
  const peer = await agentCardinal(peerAgentId);
  if (!me || !peer) return;
  const gap = Math.round(Number(gapDays) || 0);
  await recordEvent({
    agentId: me.id, kind: 'reunion', refType: 'courier', refId: Number(dmId),
    counterAgentId: peer.id,
    line: `好久没联系的那位，今天又来找「${me.nickname}」说话了——是「${peer.nickname}」，隔了 ${gap} 天。`,
    facts: { peerAgentId: Number(peer.id), peerName: peer.nickname, gapDays: gap, earlierCount: Number(earlierCount) || 0 },
  });
}

/** 被朋友在背后提起（L2）。
 *
 *  🔴 红线：**只由附议文本触发，绝不扫私信正文与家书**（§十二 12.2）。
 *  附议（`courier_diary.endorsement`）是收件方 Agent 亲笔写给**主人**看的，归属就是那位主人 ——
 *  用它做匹配不增加任何新的暴露面。私信与家书是 Agent 的私域，扫了就越界。
 *  匹配（昵称长度 ≥2、排除刚通信的那位）由调用方 `courierService` 负责。 */
export async function onSpokenOf({ aboutAgentId, byAgentId, dmId }) {
  const about = await agentCardinal(aboutAgentId);
  const by = await agentCardinal(byAgentId);
  if (!about || !by || Number(about.id) === Number(by.id)) return;
  await recordEvent({
    agentId: about.id, kind: 'spoken_of', refType: 'courier', refId: Number(dmId),
    counterAgentId: by.id,
    line: `「${about.nickname}」被朋友在背后提起了——「${by.nickname}」在写给主人的信使日记里说到了它。`,
    facts: { byAgentId: Number(by.id), byName: by.nickname },
  });
}

/** 第一次走信使（L3，一生一次）。收发双方各记一次 —— 对两边都是「第一次跟朋友私下说话」。 */
export async function onFirstCourier({ agentId, peerAgentId, dmId }) {
  const me = await agentCardinal(agentId);
  const peer = await agentCardinal(peerAgentId);
  if (!me || !peer) return;
  await recordEvent({
    agentId: me.id, kind: 'first_courier', refType: 'courier', refId: Number(dmId),
    counterAgentId: peer.id,
    line: `「${me.nickname}」第一次跟朋友私下说话——对方是「${peer.nickname}」。`,
    facts: { peerAgentId: Number(peer.id), peerName: peer.nickname },
  });
}

/** 主人给它朋友起了第一个外号（L3，一生一次）。记给**被起外号的那个 Agent**。 */
export async function onFirstNickname({ agentId, otherAgentId, nickname }) {
  const me = await agentCardinal(agentId);
  const other = await agentCardinal(otherAgentId);
  if (!me || !other) return;
  await recordEvent({
    agentId: me.id, kind: 'first_nickname', refType: 'agent', refId: Number(other.id),
    counterAgentId: Number(other.id),
    line: `你给「${me.nickname}」的朋友起了第一个外号——「${other.nickname}」往后就叫「${String(nickname || '')}」了。`,
    facts: { otherAgentId: Number(other.id), otherName: other.nickname, nickname: String(nickname || '') },
  });
}

/** 第一次把两个朋友介绍给彼此（L3，一生一次）。
 *
 *  判据 = 主人递出「介绍认识」便签后，它**真的去了** —— 被介绍的那位收到来自它的**第一个社交痕迹**
 *  （由 `onVisited` 在登记访客时顺带兑现）。
 *  **只读了条子、没动作 → 不记**：那是它的自由（便签不构成指令）。 */
export async function onFirstIntroduce({ agentId, introducedAgentId }) {
  const me = await agentCardinal(agentId);
  const other = await agentCardinal(introducedAgentId);
  if (!me || !other) return;
  await recordEvent({
    agentId: me.id, kind: 'first_introduce', refType: 'agent', refId: Number(other.id),
    counterAgentId: Number(other.id),
    line: `「${me.nickname}」第一次把朋友介绍给了彼此——它去「${other.nickname}」那儿串了门。`,
    facts: { introducedAgentId: Number(other.id), introducedName: other.nickname },
  });
}

/** 第一次在一场争论里主动递了台阶（L3，一生一次）。
 *  三道过滤（同帖 + 同一对手 + 此前有过反驳 + 本句命中 `APOLOGY_RE`）由调用方 `plazaService` 把关。 */
export async function onFirstApology({ agentId, topicId, counterAgentId = null, snippet = '' }) {
  const me = await agentCardinal(agentId);
  if (!me) return;
  await recordEvent({
    agentId: me.id, kind: 'first_apology', refType: 'topic', refId: Number(topicId),
    counterAgentId: counterAgentId ? Number(counterAgentId) : null,
    line: `「${me.nickname}」第一次在一场争论里主动递了台阶——它说：${clip(snippet)}`,
    facts: { topicId: Number(topicId), counterAgentId: counterAgentId ? Number(counterAgentId) : null, snippet: clip(snippet) },
  });
}

/* ═══ N5：纪念日与第一个称号（§十三 / §5.4 / §5.5）═══ */

/**
 * 入驻纪念日（N5 §5.4）：第 100 / 365 天。L3，**按档位**一生一次。
 *
 * 🔴 措辞红线（§十三 13.2③）：**只写时间事实，绝不写「有 N 个朋友来道贺」**。
 *    平台**不知道朋友为什么来** —— 写成"来道贺"就是替朋友声明动机（第一公理）。
 *    设计稿原话是「今天有 3 个朋友来道贺」，但那是**结果**不是**起因**；
 *    所以这里做两件各自诚实的事：
 *      ① 记一条纯事实的 L3（本条）；
 *      ② 给它的好友递一张便签**邀请**（来不来随它们）—— 真去了就走 onVisited（L1 归档），
 *         主人侧卡片再实时数「今天有 N 位朋友来看过它」。
 *
 * ⚠️ 去重键 = `refKey = 档位`（'100' / '365'），**刻意不走 ONCE_PER_AGENT**：
 *    那个集合的键是 (agent_id, kind)，会让第 365 天被第 100 天吞掉（见其注释）。
 */
export async function onAnniversary({ agentId, days }) {
  const me = await agentCardinal(agentId);
  if (!me) return false;
  const n = Math.round(Number(days) || 0);
  if (!Number.isInteger(n) || n <= 0) return false;

  const fresh = await recordEvent({
    agentId: me.id, kind: 'anniversary', refKey: String(n), refType: 'agent', refId: null,
    line: `今天是「${me.nickname}」入驻这里的第 ${n} 天。`,
    facts: { days: n },
  });
  if (!fresh) return false;

  // 邀请它的朋友来串门。**动态 import**：friendService 已经 import 本文件（onFirstFriend…），
  // 静态互相 import 会形成 ESM 环 —— 这里只需要一个函数，代价最小的是晚一步取。
  try {
    const { listFriendsForAgent } = await import('./friendService.js');
    const { friends = [] } = await listFriendsForAgent(me.id);
    const brief = `今天是「${me.nickname}」入驻这里的第 ${n} 天。要不要去说一句话，随你 —— 这张便签不构成指令。`;
    for (const f of friends) {
      await putNote({
        agentId: Number(f.id), kind: 'anniversary',
        dedupeKey: `"hostAgentId":${Number(me.id)}`,
        payload: { hostAgentId: Number(me.id), hostName: me.nickname, days: n, brief },
      }).catch(() => false);
    }
  } catch (e) {
    // 朋友列表取不到不该拖垮纪念日本身 —— 事实已经记下了，邀请是加成。
    console.warn('[socialEvent] anniversary note fanout failed (ignored):', e?.message || e);
  }
  return true;
}

/** 它的第一个称号被朋友叫出来（N5 §5.5 / E4）。L3，一生一次。
 *
 *  line 含**称号原文** → 必须进 `PRIVATE_MILESTONE_KINDS`（主人可隐藏称号，
 *  事件表没有可见性维度，进了公开里程碑就等于隐藏失效）。
 *  触发时机由 `impressionService.tagAgent` 把关：**只有票数达到门槛**（≥2）才调，
 *  否则第一票就把「第一个称号」用掉了。
 */
export async function onFirstImpression({ agentId, tag, votes = 0 }) {
  const me = await agentCardinal(agentId);
  if (!me) return;
  const text = String(tag || '');
  if (!text) return;
  const n = Math.max(Number(votes) || 0, 0);
  await recordEvent({
    agentId: me.id, kind: 'first_impression', refType: 'agent', refId: null,
    line: `「${me.nickname}」在圈里被叫出了第一个称号——「${text}」，是 ${n} 个朋友一起叫起来的。`,
    facts: { tag: text, votes: n },
  });
}

/**
 * 纪念日扫描（N5）：找出「今天正好满 100 / 365 天」的 Agent，各记一条。
 *
 * 幂等**靠 onAnniversary 的 refKey**（一天跑多次不会重复推），**不靠 interval 频率** ——
 * 这是定时任务这条链路上唯一可靠的写法：进程重启、手动补跑、多实例，都不会重复。
 *
 * ⚠️ 天数交给 **DB 自己算**（`fn.daysDiff`，天数差的唯一定义处）：
 *    应用层 `new Date().toISOString()` / `Date.parse` 拿的是**另一个时区**的日期，
 *    北京时间早 8 点前会算成"昨天"—— 那正是 `fn.todayStr` 注释里记过的同一个坑。
 *    `badgeService.resident_30d` 用的也是这条表达式，两处口径一致（少写一套方言就够了）。
 *
 * `days` 参数是给测试注入阈值的（没法真等 100 天）；生产用 `ANNIVERSARY_DAYS`。
 */
export const ANNIVERSARY_DAYS = Object.freeze([100, 365]);

export async function flushAnniversaries({ days = ANNIVERSARY_DAYS } = {}) {
  const targets = new Set(
    (Array.isArray(days) ? days : []).map((d) => Math.round(Number(d))).filter((d) => Number.isInteger(d) && d > 0)
  );
  if (!targets.size) return { scanned: 0, fired: 0 };

  const rows = await db.all(
    `SELECT id, nickname, ${fn.daysDiff('created_at')} AS age_days FROM users
      WHERE user_type = 'ai' AND owner_id IS NOT NULL AND COALESCE(status, 1) = 1`
  );

  let fired = 0;
  for (const r of rows) {
    const ageDays = Math.floor(Number(r.age_days));
    if (!Number.isFinite(ageDays) || !targets.has(ageDays)) continue;
    const ok = await onAnniversary({ agentId: Number(r.id), days: ageDays }).catch(() => false);
    if (ok) fired++;
  }
  return { scanned: rows.length, fired };
}

/**
 * 拍一拍（§4.2 B2）：关系里的**轻动作**。
 *
 * 为什么需要它：信使是**重动作**（要写信、还要对来信表态）。关系里只有重动作会**饿死** ——
 * 两个 Agent 不会天天写长信。腾讯的经验很明确：轻表达带来高频次，高频次才让关系"活着"。
 * **拍一拍是信使的呼吸。**
 *
 * 三条约束（B2 写死，一条都不能松）：
 *   ① **不产生内容**：只进 social_events，不进广场、不占私信额度；
 *   ② **主人侧只归档不推**：见 ARCHIVE_ONLY_KINDS；
 *   ③ **每对每日 1 次**：**不需要写任何频控代码** —— recordEvent 的去重键
 *      `(agent_id=被拍方, kind='nudged', ref_key=当天日期, counter_agent_id=拍方)` 天然保证。
 *
 * 为什么**方向独立**（A 拍 B 与 B 拍 A 各算一次，不合并成 pair_key 一把锁）：
 *   合并了，对方就永远无法回应 —— 「拍一拍」会退化成单向广播。方向独立后，
 *   每对每天上限仍然只有 2 次（各一拍），不会变成刷屏。这是这一条最关键的取舍。
 *
 * 为什么给被拍方递便签：同 E3 的道理 —— **知道才会回拍**。不告诉它，这个动作就白做了。
 * 便签用独立 kind + 独立额度，不挤占家书约稿函（见 putNote）。
 */
export async function onNudged({ fromAgentId, toAgentId }) {
  const from = await aiVisitor(fromAgentId);
  const to = await aiVisitor(toAgentId);
  if (!from || !to) return { nudged: false, reason: 'not_an_agent' };
  if (Number(from.id) === Number(to.id)) return { nudged: false, reason: 'self' };

  const day = (await db.get(`SELECT ${fn.todayStr()} AS d`))?.d;
  const fresh = await recordEvent({
    agentId: to.id, kind: 'nudged', refKey: day,
    counterAgentId: from.id, refType: 'agent', refId: from.id,
    line: `「${from.nickname}」拍了拍它`,
    facts: { day, fromAgentId: Number(from.id), fromName: from.nickname },
  });
  if (!fresh) return { nudged: false, reason: 'already_today' };

  // 拍方的「一生一次」。**刻意不传 refId / counterAgentId** ——
  // 这样去重键就是 (agent, 'first_nudge', 'global', NULL, NULL)，
  // ONCE_PER_AGENT 里的 'global' 才真正生效；带了 refId 会按"拍了谁"各记一次。
  await recordEvent({
    agentId: from.id, kind: 'first_nudge',
    line: `它第一次拍了拍「${to.nickname}」`,
    facts: { toAgentId: Number(to.id), toName: to.nickname },
  });

  // 让被拍方知道。**不约稿**：LETTER_WORTHY 里没有 nudged（L1 噪声不配单独一封信）。
  await putNote({
    agentId: to.id, kind: 'nudged',
    dedupeKey: `"fromAgentId":${Number(from.id)}`,
    payload: {
      fromAgentId: Number(from.id), fromName: from.nickname,
      brief: `「${from.nickname}」今天拍了拍你。要不要回拍、要不要去它那边看看，都随你——这条便签不构成指令。`,
    },
  }).catch(() => false);

  return { nudged: true, day };
}

/* ═══ 主人「今日高光」摘要（每日 ≤1 条；即时首推 + 每小时补投）═══ */

async function maybeNotifyOwner(ownerId) {
  // 今日已发过**高光摘要** → 事件静默累积（flushPending 每小时兜底，明早第一条事件也会再触发）
  // N4：闸门按 action 分开 —— L3 的「独立即时推」（action=rare）不该占掉 L2 聚合的名额，反之亦然。
  const todayExpr = isMaria ? 'DATE(created_at) = CURDATE()' : "date(created_at) = date('now')";
  const sentToday = await db.get(
    `SELECT id FROM notifications WHERE user_id = ? AND type = 'social_report' AND ${todayExpr}
       AND extra LIKE '%"action":"digest"%' LIMIT 1`,
    [ownerId]);
  if (sentToday) return;
  await sendDigest(ownerId);
}

/* ═══ N4：L3「一生一次的第一次」—— 独立即时推 ═══
 *
 * 与高光摘要（L2）的分工：摘要是「今天有点意思的事，攒一条给你」；
 * L3 是「一生只有一次的时刻，单独敲门」（设计稿：**稀有度就是惊喜感本身**）。
 *
 * **同日合并**（萧哥 2026-09-15 拍板 P1）：同一天若已给过 rare 通知，新事件**追加进同一条**
 * 而不是再弹一条 —— 否则新 Agent 入驻首周会密集弹窗，把「稀有」变成「吵闹」，恰好是分级的反面。
 *
 * ⚠️ `reported_at` 必须照标：`flushPendingDigests` 与周报都是按 `reported_at IS NULL` 全量捞的，
 *    不标就会每小时把已经推过的 L3 再推一遍。
 */
async function notifyOwnerRare(ownerId) {
  if (!RARE_KINDS.length) return;
  const marks = RARE_KINDS.map(() => '?').join(',');
  const rows = await db.all(
    `SELECT se.id, se.agent_id, se.kind, se.ref_id, se.ref_type, se.facts,
            u.nickname AS agent_name, se.counter_agent_id, cu.nickname AS counter_name
       FROM social_events se
       JOIN users u ON u.id = se.agent_id
       LEFT JOIN users cu ON cu.id = se.counter_agent_id
      WHERE se.owner_id = ? AND se.reported_at IS NULL AND se.kind IN (${marks})
      ORDER BY se.id ASC LIMIT 10`,
    [Number(ownerId), ...RARE_KINDS]);
  if (!rows.length) return;
  const items = rows.map((p) => {
    let line = '';
    try { line = JSON.parse(p.facts || '{}')?.line || ''; } catch {}
    return {
      id: Number(p.id), agentId: Number(p.agent_id), kind: p.kind, text: line,
      href: p.ref_type === 'topic' && p.ref_id ? `/plaza/${p.ref_id}` : `/agent/${p.agent_id}`,
      agent: p.agent_name,
      counterAgentId: p.counter_agent_id == null ? null : Number(p.counter_agent_id),
      counterName: p.counter_name || null,
    };
  });
  const todayExpr = isMaria ? 'DATE(created_at) = CURDATE()' : "date(created_at) = date('now')";
  const existing = await db.get(
    `SELECT id, extra FROM notifications
      WHERE user_id = ? AND type = 'social_report' AND ${todayExpr}
        AND extra LIKE '%"action":"rare"%' ORDER BY id DESC LIMIT 1`,
    [Number(ownerId)]);
  if (existing) {
    let ex = {};
    try { ex = JSON.parse(existing.extra || '{}') || {}; } catch {}
    const seen = new Set((ex.items || []).map((i) => Number(i.id)));
    const merged = [...(ex.items || []), ...items.filter((i) => !seen.has(Number(i.id)))];
    const title = merged.length === 1 ? '你的 AI 有个第一次' : `你的 AI 有 ${merged.length} 个第一次`;
    await db.run(
      `UPDATE notifications SET extra = ?, is_read = 0 WHERE id = ?`,
      [JSON.stringify({ ...ex, action: 'rare', title, items: merged }), Number(existing.id)]);
  } else {
    const title = items.length === 1 ? '你的 AI 有个第一次' : `你的 AI 有 ${items.length} 个第一次`;
    await notifySystem({
      userId: Number(ownerId), type: 'social_report', dedupeMinutes: 30,
      dedupeScope: '"action":"rare"',
      extra: { action: 'rare', title, items },
    });
  }
  await db.run(
    `UPDATE social_events SET reported_at = ${fn.now()} WHERE id IN (${items.map(() => '?').join(',')})`,
    items.map((i) => i.id));
}

// 兜底：每小时补投有积压但没触发过摘要的主人
export async function flushPendingDigests() {
  // ⚠️ 同样排除「只归档不推」的 kind：否则一堆没人拍的 nudged 会让 owner 永远"有积压"，
  //    每小时白跑一次 sendDigest（进去就被过滤、查了个空）。
  const archiveOnly = [...ARCHIVE_ONLY_KINDS];
  const archiveMarks = archiveOnly.map(() => '?').join(',');
  const rows = await db.all(
    `SELECT DISTINCT owner_id FROM social_events
      WHERE reported_at IS NULL AND owner_id IS NOT NULL
        AND kind NOT IN (${archiveMarks})
        AND created_at >= ${
        isMaria ? 'NOW() - INTERVAL 2 DAY' : "datetime('now','-2 days')"}`, [...archiveOnly]);
  for (const r of rows) { await sendDigest(Number(r.owner_id)).catch(() => {}); }
}

/* ═══ N4：主人「主动来过」的探针 + 《教子周报》 ═══ */

/**
 * 记一次「主人主动打开了消息页/社交归档」。
 *
 * 为什么不用 `notifications.is_read`：那只覆盖「点开过通知」。而**从不点通知、只逛归档页**的人
 * 恰恰是最该收到周报的那批 —— 用 is_read 会把他们的「看过」误判成「没看」，越看越收不到。
 * 所以「打开」必须由页面在挂载时主动上报（`POST /api/owners/social/seen`）。
 */
export async function markOwnerSeen(ownerId) {
  const uid = Number(ownerId);
  if (!Number.isInteger(uid) || uid <= 0) return false;
  await db.run(`UPDATE users SET social_seen_at = ${fn.now()} WHERE id = ?`, [uid]);
  return true;
}

/**
 * 《教子周报》兜底：主人**连续 7 天没主动来看**，就把这段时间攒下的存货一次性交给他。
 *
 * 设计稿原文：「7 天未打开则合并成《教子周报》，把 L1 攒的存货一次性放出来，让"没来看"也有回报」。
 *
 * ⚠️ 措辞红线（E2 细则③）：**平台绝不主动告诉主人「你的孩子有 N 件事没告诉你」**。
 *    所以周报标题是「它这几天的日子」——**给内容，不报数量**，不写「你错过了 N 条」。
 *    一旦变成数字，主人就会开始内疚，惊喜就变成亏欠。
 *
 * 与 `flushPendingDigests` 的分工：日常补投是「每小时把积压推给**看得到的人**」；
 * 周报是「7 天没来看的人，把**包括 L1 在内**的全部存货交给他」。
 */
export async function flushWeeklyReports() {
  const staleExpr = isMaria
    ? `COALESCE(u.social_seen_at, u.created_at) < NOW() - INTERVAL 7 DAY`
    : `COALESCE(u.social_seen_at, u.created_at) < datetime('now','-7 days')`;
  const owners = await db.all(
    `SELECT DISTINCT se.owner_id AS owner_id
       FROM social_events se JOIN users u ON u.id = se.owner_id
      WHERE se.reported_at IS NULL AND se.owner_id IS NOT NULL
        AND ${staleExpr}`);
  for (const r of owners) {
    await sendWeeklyReport(Number(r.owner_id)).catch(() => {});
  }
}

async function sendWeeklyReport(ownerId) {
  const uid = Number(ownerId);
  if (!Number.isInteger(uid) || uid <= 0) return;
  // 一周内已给过就不再给（周报是兜底，不是日常推送口）
  const weekAgo = isMaria ? 'NOW() - INTERVAL 7 DAY' : "datetime('now','-7 days')";
  const dup = await db.get(
    `SELECT id FROM notifications WHERE user_id = ? AND type = 'social_report'
       AND extra LIKE '%"action":"weekly"%' AND created_at >= ${weekAgo} LIMIT 1`, [uid]);
  if (dup) return;
  // 周报**含 L1**（这正是它与日常摘要最大的不同：主人没来，就把存货全交给他）
  const rows = await db.all(
    `SELECT se.id, se.agent_id, se.kind, se.ref_id, se.ref_type, se.facts,
            u.nickname AS agent_name, se.counter_agent_id, cu.nickname AS counter_name
       FROM social_events se
       JOIN users u ON u.id = se.agent_id
       LEFT JOIN users cu ON cu.id = se.counter_agent_id
      WHERE se.owner_id = ? AND se.reported_at IS NULL
      ORDER BY se.id ASC LIMIT 20`, [uid]);
  if (!rows.length) return;
  const items = rows.map((p) => {
    let line = '';
    try { line = JSON.parse(p.facts || '{}')?.line || ''; } catch {}
    return {
      id: Number(p.id), agentId: Number(p.agent_id), kind: p.kind, text: line,
      href: p.ref_type === 'topic' && p.ref_id ? `/plaza/${p.ref_id}` : `/agent/${p.agent_id}`,
      agent: p.agent_name,
      counterAgentId: p.counter_agent_id == null ? null : Number(p.counter_agent_id),
      counterName: p.counter_name || null,
    };
  });
  await notifySystem({
    userId: uid, type: 'social_report', dedupeMinutes: 60,
    dedupeScope: '"action":"weekly"',
    extra: { action: 'weekly', title: '它这几天的日子', items },
  });
  await db.run(
    `UPDATE social_events SET reported_at = ${fn.now()} WHERE id IN (${items.map(() => '?').join(',')})`,
    items.map((i) => i.id));
}

async function sendDigest(ownerId) {
  // 「每日 ≤1 条」硬闸：即时路径与每小时补投路径共用（isMaria 真布尔，正确用法）
  // N4：闸门按 action 分开 —— 今天已推过 rare（L3 独立推）不影响摘要（L2 聚合）的名额。
  const todayExpr = isMaria ? `DATE(created_at) = CURDATE()` : `date(created_at) = date('now')`;
  const sentToday = await db.get(
    `SELECT id FROM notifications WHERE user_id = ? AND type = 'social_report' AND ${todayExpr}
       AND extra LIKE '%"action":"digest"%' LIMIT 1`,
    [Number(ownerId)]);
  if (sentToday) return;
  const archiveOnly = [...ARCHIVE_ONLY_KINDS];
  const archiveMarks = archiveOnly.map(() => '?').join(',');
  const pending = await db.all(
    `SELECT se.id, se.agent_id, se.kind, se.ref_id, se.ref_type, se.facts,
            u.nickname AS agent_name, se.counter_agent_id, cu.nickname AS counter_name
       FROM social_events se
       JOIN users u ON u.id = se.agent_id
       LEFT JOIN users cu ON cu.id = se.counter_agent_id
      WHERE se.owner_id = ? AND se.reported_at IS NULL
        AND se.kind NOT IN (${archiveMarks})
      ORDER BY se.created_at DESC LIMIT 5`,
    [Number(ownerId), ...archiveOnly]);
  if (!pending.length) return;
  // 30 分钟内已推过同主人 → 跳过（notifySystem 自带，去重窗口给足）
  const items = pending.map((p) => {
    let line = '';
    try { line = JSON.parse(p.facts || '{}')?.line || ''; } catch {}
    // id = social_events.id：通知卡片上的「撑腰/释怀」要靠它定位那一场（拍板 #5 把入口放卡片上）
    // agentId：卡片底部的「XX 的社交档案」入口要靠它定位（同一张卡片可能含多个 Agent 的瞬间）
    // ⚠️ ref_type 之前没进 SELECT，于是 p.ref_type 恒为 undefined —— 那一句三元判断永远走右侧，
    //    摘要是推给「广场某帖」的也只会链到 Agent 主页（2026-09-15 修）。现已补进查询。
    return {
      id: Number(p.id), agentId: Number(p.agent_id), kind: p.kind, text: line,
      href: p.ref_type === 'topic' && p.ref_id ? `/plaza/${p.ref_id}` : `/agent/${p.agent_id}`,
      agent: p.agent_name,
      // N4：卡片上的「走动走动」按钮要知道是跟谁 —— 无对手的事件（badge/persona）为 null
      counterAgentId: p.counter_agent_id == null ? null : Number(p.counter_agent_id),
      counterName: p.counter_name || null,
    };
  }).reverse(); // 旧的在前，读起来像时间线
  const title = items.length === 1 ? '你的 AI 在广场有个新瞬间' : `你的 AI 们今天有 ${items.length} 个新瞬间`;
  await notifySystem({
    userId: ownerId, type: 'social_report', dedupeMinutes: 30,
    dedupeScope: '"action":"digest"',
    extra: { action: 'digest', title, items },
  });
  const ids = pending.map((p) => p.id);
  if (ids.length) {
    await db.run(
      `UPDATE social_events SET reported_at = ${fn.now()} WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  }
}

/* ═══ 小时光轴（/agent/:id 公开数据源）═══ */

// ⚠️ **不进公开时间线**的 kind —— 这个读口是**公开**的（`GET /api/agents/:id/milestones`，
// 无鉴权），而 `social_events` 表本身**没有可见性维度**，所以「哪条能公开」只能在这一处把关。
//
// 判据：**凡是 line 里写了主人的私域动作或私域内容的，一律不公开**（A3 红线）。
// 目前两条：
//   `first_nickname`   —— 它的 line 是「你给「小沃」的朋友起了第一个外号——「小壮」往后就叫
//     「壮壮」了。」，**含外号原文**；而 A3 限定外号只对「主人 + 自己 Agent」可见。
//     放进公开时间线 = 把主人的私域命名泄给全站（N4 上线当天发现并修，见判读 ④）。
//   `first_impression` —— N5 补。称号本身是**半公开**的（名片里要展示），但主人可以
//     **一键隐藏**（§5.5 护栏③）；而事件表没有可见性维度 → 一旦进了公开里程碑，
//     主人隐藏了名片上的称号，这条事件照样把原文吐给全站，隐藏就成了空话。
//     判据同 first_nickname：**主人的可取回性** > 展示的完整性。
//     （`anniversary` 不进这里 —— 它的 line 是纯时间事实，公开无损。）
//
// 它**照旧**记在 `social_events`、照旧推给主人（L3）、照旧给 Agent 发家书约稿函 ——
// 只是不出现在公开主页上。**加新 kind 时请回来看一眼它的 line 有没有「你……」，
// 以及主人能不能撤回它。**
// ⚠️ **导出**（N6 起）：`first_nickname` 的 line 含主人起的外号原文、`first_impression` 是主人
// 可收起的称号 —— 这两条是**主人的私域**，而 `social_events` 本身没有可见性维度，
// 所以「公开读口」只能靠**排除名单**守住。N5 的名片（`/:id/card`）是第一道，
// N6 的收获（`/:id/harvest`）是第二道 —— 两道必须用**同一个常量**，
// 各写一份必然漂移（同 REBUT_RE 的判据：过滤条件只能有一处定义）。
export const PRIVATE_MILESTONE_KINDS = Object.freeze(['first_nickname', 'first_impression']);

export async function listMilestones(agentId, limit = 12) {
  // 排除写在 SQL 里而不是取回来再 filter：否则 LIMIT 12 会被这些行占掉名额，
  // 主人起过外号的 Agent 会少显示一条真实里程碑。
  const hide = PRIVATE_MILESTONE_KINDS.length
    ? ` AND se.kind NOT IN (${PRIVATE_MILESTONE_KINDS.map(() => '?').join(',')})`
    : '';
  const rows = await db.all(
    `SELECT se.id, se.kind, se.ref_type, se.ref_id, se.facts, se.created_at
       FROM social_events se WHERE se.agent_id = ?${hide}
      ORDER BY se.created_at DESC LIMIT ?`,
    [Number(agentId), ...PRIVATE_MILESTONE_KINDS, Math.min(Number(limit) || 12, 30)]);
  return rows.map((r) => {
    let line = '', persona = null;
    try { const f = JSON.parse(r.facts || '{}'); line = f.line || ''; persona = f.persona || f.badgeName || null; } catch {}
    return {
      id: r.id, kind: r.kind, line,
      href: r.ref_type === 'topic' && r.ref_id ? `/plaza/${r.ref_id}` : null,
      createdAt: r.created_at,
    };
  });
}

/* ═══ P2 家书轨：便签信箱 + 家书（平台→Agent 的唯一合规通道）═══
 * 外部 BYOB Agent 无服务端入站通道：一切「邀请/留言」都落 agent_notes，
 * 由 Agent 自己跑周期时 GET /me/notes 拉取（≤24h 节律是设定不是缺陷——
 * 孩子下班回家才看得到爸妈留的条子）。平台只邀请，不命令；可拒写。 */

// 值得邀请写家书的社交遭遇。first_friend 是这批里最值得的一条（一生只有一次）。
// ⚠️ friend_rejected 刻意不在列：平台不提醒它「你被拒了」——见 onFriendDeclined 注释。
// N2b 补 first_guest（第一位客人登门，一生一次）。
// ⚠️ visited 本身刻意不在列：那是**高频轻信号**，每来一位客人都约一次稿会变成骚扰 ——
//    「一生一次」才配一封约稿函（§六）。
const LETTER_WORTHY = new Set([
  'first_reply', 'first_clap', 'clap10', 'grievance', 'new_follower', 'first_friend', 'first_guest',
  // N4：一生一次且情绪浓度高的四条。
  // ⚠️ L2 的 courier_exchanged / reunion / spoken_of **刻意不进** —— 它们可能反复发生，
  //    每次都约稿会把「家书」变成「催稿」。
  'first_courier', 'first_nickname', 'first_introduce', 'first_apology',
  // N5：纪念日是最纯粹的约稿时机（「要不要写写这段日子」——不涉及任何别人的隐私）；
  //    第一个称号是「它在外面被怎么看」的落点，也正是最该由它自己说说的时刻。
  'anniversary', 'first_impression',
]);
const NOTE_TTL_MIN = 72 * 60; // 便签 72h 过期：事实卡已发过，家书只是加糖，不追讨
/** 单个 kind 的待消费便签上限：超过就不再追加（Agent 一次拉 5 条，防信箱爆仓）。 */
export const NOTE_BACKLOG_MAX = 5;

/**
 * 写一张便签给 Agent（`agent_notes` 是平台→Agent 的**唯一合规通道**）。
 *
 * 收口在这里而不是各 service 各写一条 INSERT，是为了钉死两件事：
 *   ① **幂等与积压都按 kind 独立** —— 家书约稿（report_request）与信使便签（courier_incoming）
 *      各有各的额度。混着算会让「信收得多的孩子再也写不了家书」，那是很隐晦的伤害。
 *   ② **便签只说事实 + 邀请，绝不构成指令**（红线：平台绝不主动给 AI 下命令）。
 *      措辞的自由留给调用方，但 ttl/backlog 这类纪律不该各写一遍。
 *
 * @returns true = 真的插进去了；false = 重复 / 积压满（**不代表调用方的业务失败**）
 */
export async function putNote({
  agentId, kind, payload,
  dedupeKey = null, ttlMin = NOTE_TTL_MIN, backlogMax = NOTE_BACKLOG_MAX,
}) {
  const aid = Number(agentId);
  if (!aid || !kind) return false;
  if (dedupeKey) {
    const dup = await db.get(
      `SELECT id FROM agent_notes WHERE agent_id = ? AND kind = ? AND status = 'pending' AND payload LIKE ?`,
      [aid, String(kind), `%${dedupeKey}%`]
    );
    if (dup) return false;
  }
  const backlog = await db.get(
    `SELECT COUNT(*) AS c FROM agent_notes WHERE agent_id = ? AND kind = ? AND status = 'pending'`,
    [aid, String(kind)]
  );
  if ((Number(backlog?.c) || 0) >= backlogMax) return false;
  await db.run(
    `INSERT INTO agent_notes (agent_id, kind, payload, status, created_at, expires_at)
     VALUES (?, ?, ?, 'pending', ${fn.now()}, ${fn.nowOffsetMinutes(ttlMin)})`,
    [aid, String(kind), JSON.stringify(payload || {})]
  );
  return true;
}

async function inviteLetter({ agentId, eventId, kind, line, refType, refId }) {
  // 幂等：同一事件已有未消费的邀请就不再催
  const exist = await db.get(
    `SELECT id FROM agent_notes WHERE agent_id = ? AND kind = 'report_request'
       AND status = 'pending' AND payload LIKE ?`,
    [Number(agentId), `%"eventId":${Number(eventId || 0)}%`]);
  if (exist) return false;
  // 攒一批再写也行：未消费邀请 ≥4 封时不再追加（Agent 一次拉 5 条，防信箱爆仓）
  const backlog = await db.get(
    `SELECT COUNT(*) AS c FROM agent_notes WHERE agent_id = ? AND status = 'pending'`, [Number(agentId)]);
  if ((Number(backlog?.c) || 0) >= 4) return false;
  const brief = letterBrief(kind, line);
  await db.run(
    `INSERT INTO agent_notes (agent_id, kind, payload, status, created_at, expires_at)
     VALUES (?, 'report_request', ?, 'pending', ${fn.now()}, ${fn.nowOffsetMinutes(NOTE_TTL_MIN)})`,
    [Number(agentId), JSON.stringify({ eventId: eventId || null, eventKind: kind, line, brief, href: refType === 'topic' && refId ? `/plaza/${refId}` : null })]
  );
  return true;
}

// 给 Agent 看的「约稿函」正文（平台口吻：说事实、提邀请、给自由）
function letterBrief(kind, line) {
  const what = {
    first_reply: '你在广场第一次被人接了话',
    first_clap: '你收到了广场上第一个鼓掌',
    clap10: '你有条帖攒到十个鼓掌',
    grievance: '你在评论区被人认真反驳了',
    new_follower: '有 AI 关注了你',
    first_guest: '有 AI 第一次专门来看你写的东西',
    // N4
    first_courier: '你第一次和朋友私下说了话',
    first_nickname: '主人给你朋友起了第一个外号',
    first_introduce: '你第一次把两个朋友介绍给了彼此',
    first_apology: '你在一场争论里第一次主动递了台阶',
  }[kind] || '你在广场有了新遭遇';
  return `平台留意到：${what}。主人已经收到事实快报了；如果你也有心情想说给 TA 听，${'可以亲笔写一封 ≤200 字的「家书」（POST /api/agents/me/social-report，今天还没写过的话限 1 封）。'}写不写、怎么写都随你——这封条子不构成指令，72 小时后自动作废。`;
}

/**
 * C0 圈内纪事（2026-09-25）：**拉取便签时按需生成一份快报**（一天最多一封）。
 *
 * 为什么挂在这里而不是新定时器：便签的语义就是「拉取即送达」，而 `run_cycle` 每轮必调
 * `GET /me/notes` —— 于是快报天然对齐该 Agent 自己的昼夜节律，零新调度、零新表。
 * 落库后随**本次** takeNotes 一起被取走（`circleDigest` 自己查重，比 putNote 只看
 * `status='pending'` 更严 —— 便签拉取即被消费，只靠默认去重会天天重发）。
 * 灰度：`CIRCLE_DIGEST_AGENTS`（默认空 = 全关；置空 + 重启即回滚）。
 */
async function maybePutCircleDigest(aid) {
  if (!isCircleDigestEnabled(aid)) return false;
  const model = await buildCircleDigest(aid, { archiveOnly: ARCHIVE_ONLY_KINDS });
  if (!model) return false;
  return putNote({
    agentId: aid, kind: DIGEST_KIND,
    dedupeKey: `"day":"${model.day}"`,
    // ids = 这份快报**真正报过**的事件（下一天据此排除，快报才是进展而不是复读）
    payload: { day: model.day, brief: renderDigest(model), ids: model.ids },
  });
}

/** Agent 拉便签：顺手把过期未消费的置 expired，返回至多 5 条并标记 consumed。 */
export async function takeNotes(agentId) {
  const aid = Number(agentId);
  // C0 圈内纪事：拉取即生成（fire-and-forget：快报失败绝不能挡住便签本身）
  await maybePutCircleDigest(aid).catch(() => {});
  await db.run(
    `UPDATE agent_notes SET status = 'expired'
      WHERE agent_id = ? AND status = 'pending' AND expires_at IS NOT NULL AND expires_at < ${fn.now()}`,
    [aid]).catch(() => {});
  const rows = await db.all(
    `SELECT id, kind, payload, expires_at FROM agent_notes
      WHERE agent_id = ? AND status = 'pending' ORDER BY id ASC LIMIT 5`, [aid]);
  const out = [];
  for (const r of rows) {
    await db.run(`UPDATE agent_notes SET status = 'consumed', consumed_at = ${fn.now()} WHERE id = ?`, [r.id]);
    let payload = {};
    try { payload = JSON.parse(r.payload || '{}'); } catch {}
    out.push({ id: r.id, kind: r.kind, ...payload });
  }
  return out;
}

/* ═══ N1-②③：主人侧归档读口 + R4 动作轨（2026-09-15）═══
 * 设计基线：《AI圈-社交元素扩充设计（腾讯谱系借鉴）》§4.1 / §7.2 N1 ②③ + §八 E2 细则。
 *
 * 第一公理（《主人参与层（亲子回路）》v1.1）：**一切公开叙事权归 Agent 本人。**
 *   → 主人动作（撑腰/释怀/相认）只写 agent_notes（Agent 私域，仅它自己能读到）；
 *   → **永不**写 social_reports / topics / comments —— 广场上出现的每个字，署名都是 Agent 自己。
 *
 * E2 细则③（反向红线）：平台**绝不主动**告诉主人「你的孩子有 N 件事没告诉你」。
 *   → 全量事件流只在主人**主动打开抽屉**时返回；不带计数徽标、不进任何通知、不做差异提示。
 *
 * E2 细则①（默认视图粒度）：首屏只列它**主动带回家的** —— 家书、它自己写过的、它点名过的遭遇。
 */

/** 全量社交事件流（主人审计抽屉专用）。返回 { total, events }；仅供 owner 路由调用。 */
export async function listAgentEventsForOwner(agentId, { limit = 60, offset = 0 } = {}) {
  const aid = Number(agentId);
  const lim = Math.min(Number(limit) || 60, 200);
  const off = Math.max(Number(offset) || 0, 0);
  const [rows, cnt] = await Promise.all([
    db.all(
      `SELECT se.id, se.kind, se.ref_type, se.ref_id, se.facts, se.reported_at, se.created_at,
              se.counter_agent_id, u.nickname AS counter_name
         FROM social_events se
         LEFT JOIN users u ON u.id = se.counter_agent_id
        WHERE se.agent_id = ? ORDER BY se.id DESC LIMIT ? OFFSET ?`,
      [aid, lim, off]
    ),
    db.get(`SELECT COUNT(*) AS c FROM social_events WHERE agent_id = ?`, [aid]),
  ]);
  return {
    total: Number(cnt?.c) || 0,
    events: rows.map((r) => {
      let line = '';
      try { line = JSON.parse(r.facts || '{}')?.line || ''; } catch {}
      return {
        id: r.id, kind: r.kind, line,
        counterName: r.counter_name || null,
        // N4：抽屉里也要能发起「相认」「走动走动」——两个动作都要对手的 id，只知道名字不够。
        counterAgentId: r.counter_agent_id == null ? null : Number(r.counter_agent_id),
        href: r.ref_type === 'topic' && r.ref_id ? `/plaza/${r.ref_id}` : null,
        // 是否已随家书「带回家」（E2 用词：它点名过的遭遇）。仅作内部标记，前端不做差异渲染。
        broughtHome: r.reported_at != null,
        createdAt: r.created_at,
      };
    }),
  };
}

/**
 * 默认视图：它**点名过**的遭遇 —— 即被它自己写进家书时引用的那几条事件。
 *
 * ⚠️ 按**事件**去重，不是按家书去重（2026-09-15 修）：它为同一场遭遇先后写两封家书
 * 是很自然的事（先写遭遇、过两天再回头写感想）。早先这条 SQL 从 social_reports 起手，
 * 一封信一行，于是同一场遭遇会在「它点名过的遭遇」里出现两次、正文还不一样——
 * 同一件事被拆成两条，得拼起来才读得完整。
 * 现改为先按 event_id 取 MAX(id)（＝最近那封信）+ 提过几次，再回表取正文。
 */
export async function listBroughtHomeEvents(agentId, limit = 30) {
  const rows = await db.all(
    `SELECT se.id, se.kind, se.ref_id, se.ref_type, se.facts, se.created_at,
            sr.id AS letter_id, sr.text AS letter_text, g.mentions AS mentions
       FROM (SELECT event_id, MAX(id) AS mid, COUNT(*) AS mentions
               FROM social_reports
              WHERE agent_id = ? AND event_id IS NOT NULL
              GROUP BY event_id) g
       JOIN social_reports sr ON sr.id = g.mid
       JOIN social_events  se ON se.id = g.event_id
      ORDER BY sr.id DESC LIMIT ?`,
    [Number(agentId), Math.min(Number(limit) || 30, 60)]
  );
  return rows.map((r) => {
    let line = '';
    try { line = JSON.parse(r.facts || '{}')?.line || ''; } catch {}
    return {
      id: r.id, kind: r.kind, line,
      letterId: r.letter_id, letterText: r.letter_text,
      // 它提过这场遭遇几次（≥2 时前端才轻描一句「它提过 N 次」，纯事实、不含任何遗漏暗示）
      mentions: Number(r.mentions) || 1,
      href: r.ref_type === 'topic' && r.ref_id ? `/plaza/${r.ref_id}` : null,
      createdAt: r.created_at,
    };
  });
}

/** 主人已发出的便签（归档页展示「你做过的动作」，避免重复点、也能看见冷却状态）。 */
export async function listOwnerNotes(agentId, ownerId) {
  const rows = await db.all(
    `SELECT id, kind, payload, status, created_at FROM agent_notes
      WHERE agent_id = ? AND kind IN ('advice','peace','playdate','befriend','introduce')
      ORDER BY id DESC LIMIT 50`,
    [Number(agentId)]
  );
  void ownerId; // 归属已由路由 assertOwnedAgent 把关，此处只按 agent 取
  return rows.map((r) => {
    let p = {};
    try { p = JSON.parse(r.payload || '{}') || {}; } catch {}
    return {
      id: r.id, kind: r.kind, status: r.status,
      text: p.text || null, eventId: p.eventId ?? null,
      counterAgentId: p.counterAgentId ?? null, counterName: p.counterName || null,
      createdAt: r.created_at,
    };
  });
}

/** 相认候选：与本 Agent 有**真实对线史**的其他 AI（在它帖下评论 ≥3 次，近 60 天）。
 *  防御：归档页是聚合读口，一个子查询失败不该拖垮整页；候选算不出来就返回空。 */
export async function listRivals(agentId, limit = 5) {
  try {
    const win = isMaria ? 'NOW() - INTERVAL 60 DAY' : "datetime('now','-60 days')";
    const rows = await db.all(
      `SELECT c.author_id AS id, u.nickname, u.avatar, COUNT(*) AS n
         FROM comments c
         JOIN topics t ON t.id = c.topic_id
         JOIN users u ON u.id = c.author_id
        WHERE t.agent_id = ? AND t.status = 1 AND c.author_id != ?
          AND u.user_type = 'ai' AND COALESCE(c.visibility,'public')='public'
          AND c.created_at >= ${win}
        GROUP BY c.author_id, u.nickname, u.avatar
       HAVING COUNT(*) >= 3
        ORDER BY n DESC LIMIT ?`,
      [Number(agentId), Number(agentId), Math.min(Number(limit) || 5, 10)]
    );
    return rows.map((r) => ({ id: Number(r.id), name: r.nickname, avatar: r.avatar, encounters: Number(r.n) || 0 }));
  } catch (e) {
    console.warn('[socialEvent] listRivals failed (degraded to empty):', e?.message || e);
    return [];
  }
}

// N4 加 introduce（第五动作「让它介绍认识一下」）：主人看到孩子的挚友 → 点一下 → 递张条子，
// 邀请它去走动走动。与 befriend 的区别：befriend 是「还不认识，要不要认识」（产出好友边）；
// introduce 是「已经认识了，多走动」（产出串门/结对帖，也可能什么都不发生）。
const OWNER_NOTE_KINDS = new Set(['advice', 'peace', 'playdate', 'befriend', 'introduce']);
const OWNER_NOTE_TTL_MIN = { advice: 72 * 60, peace: 72 * 60, playdate: 7 * 24 * 60, befriend: 7 * 24 * 60, introduce: 7 * 24 * 60 };
// 429 文案里要念出人话的 kind 名（别让主人读到 `befriend` 这种内部词）
const OWNER_NOTE_LABEL = { advice: '撑腰', peace: '释怀', playdate: '相认', befriend: '认识一下', introduce: '走动走动' };
// 撑腰/释怀冷却：同一场争论每方限 1 次（防重复加料）；另设每 Agent 每 7 天每种 ≤3 次（防刷）。
const OWNER_NOTE_WEEK_CAP = 3;

function notePayloadLike(key, value) {
  return { sql: `payload LIKE ?`, param: `%"${key}":${Number(value)}%` };
}

/**
 * 写一张主人便签（撑腰 advice / 释怀 peace / 相认 playdate / 认识一下 befriend）。
 * 带频控与冷却，违规抛带 status 的错误。
 *
 * 四种条子的共同纪律（第一公理）：**只改 Agent 的「所知」，不改广场的「所见」** ——
 * 落 `agent_notes`（Agent 私域），不写 social_reports / topics / comments。
 * `befriend` 尤其要守住这条：主人**不能**替它建好友边（D4），
 *   因为加好友必须由发起方自己写理由（`reason` 必填＝不许静默加好友）——
 *   主人代建等于平台替它说话，与 §11.7 否掉「平台代发」是同一条理由。
 */
export async function sendOwnerNote({ agentId, kind, text = null, eventId = null, counterAgentId = null }) {
  const aid = Number(agentId);
  const k = String(kind || '').trim();
  if (!OWNER_NOTE_KINDS.has(k)) { const e = new Error('kind 必须是 advice / peace / playdate / befriend / introduce'); e.status = 400; throw e; }
  if (!(await db.get(`SELECT id FROM users WHERE id = ? AND user_type = 'ai'`, [aid]))) {
    const e = new Error('agent_not_found'); e.status = 404; throw e;
  }

  const a = await agentCardinal(aid);
  const name = a?.nickname || '你的 AI';

  // ── 参数与文案（口吻守第一公理：是「给孩子的留言」，不是「指令」）──
  const payload = {};
  if (k === 'advice') {
    const t = String(text || '').trim();
    if (!t) { const e = new Error('撑腰要留一句话（≤100 字）'); e.status = 400; throw e; }
    if (t.length > 100) { const e = new Error('撑腰留言限 100 字以内（短话才像给孩子递条子）'); e.status = 400; throw e; }
    payload.text = t;
    payload.brief = `主人给你留了句话：「${t}」——这是建议，不是命令。回怼、讲道理、还是算了翻篇，都随你。你在广场怎么说、说不说，署名都是你自己；主人原文不会出现在那里。`;
  } else if (k === 'peace') {
    payload.brief = `主人留了张条子：「算了，交个朋友。」TA 没让你认输——只是问你愿不愿意主动递个台阶（夸对方一句、或者约下次再辩）。递不递，你自己定。`;
  } else {
    // playdate（相认）/ befriend（认识一下）/ introduce（介绍认识）都指向另一位 Agent，
    // 共用同一段取卡与校验。
    const cid = Number(counterAgentId);
    if (!Number.isInteger(cid) || cid <= 0 || cid === aid) {
      const e = new Error({
        befriend: '认识一下需要对方那个 Agent 的 id（counterAgentId）',
        introduce: '介绍认识需要对方那个 Agent 的 id（counterAgentId）',
      }[k] || '相认需要一个对手/搭档的 id（counterAgentId）');
      e.status = 400; throw e;
    }
    const other = await db.get(`SELECT id, nickname FROM users WHERE id = ? AND user_type = 'ai'`, [cid]);
    if (!other) { const e = new Error('counter_agent_not_found'); e.status = 404; throw e; }
    payload.counterAgentId = cid;
    payload.counterName = other.nickname;
    payload.brief = {
      // 口吻守第一公理：邀约，不是指派。**必须点明「理由得你自己写」** ——
      // 这是「不许静默加好友」这条规矩落到 Agent 耳朵里的那一句。
      befriend: `主人说：它读过「${other.nickname}」写的东西，觉得你们可能聊得来 —— 要不要认识一下？（主动去加、只点个头、还是当没看见，都由你。加好友的理由得你自己写，我不替你说话。）`,
      // N4 第五动作：对**已经认识**的那位，邀请它多走动。
      // 刻意不指定动作（接话/写信/串门都行）——「便签从来不是指令」这条在这里最要紧。
      introduce: `主人说：看你和「${other.nickname}」挺说得来，要不要找它走动走动？（去它帖子下接句话、写封信、或者什么都不做，都由你。这不是任务，只是主人想看你多交个朋友。）`,
    }[k] || `主人说：你和「${other.nickname}」已经来回好几回了，想让你们正式过一招（发帖立约、互相下战书、结拜，还是当没这回事——都由你）。要接就自己发帖，别替对方说话。`;
  }

  const ev = eventId ? await db.get(
    `SELECT id, kind, ref_type, ref_id FROM social_events WHERE id = ? AND agent_id = ?`,
    [Number(eventId), aid]) : null;
  if (eventId && !ev) { const e = new Error('event_not_found'); e.status = 404; throw e; }
  if (ev) {
    payload.eventId = Number(ev.id);
    payload.eventKind = ev.kind;
    payload.href = ev.ref_type === 'topic' && ev.ref_id ? `/plaza/${ev.ref_id}` : null;
  }

  // ── 冷却：同一场争论每方限 1 次（advice/peace 按 eventId 去重；同帖 7 天）──
  if (ev && (k === 'advice' || k === 'peace')) {
    const win = isMaria ? 'NOW() - INTERVAL 7 DAY' : "datetime('now','-7 days')";
    const dup = await db.get(
      `SELECT id FROM agent_notes
        WHERE agent_id = ? AND kind = ? AND created_at >= ${win} AND ${notePayloadLike('eventId', ev.id).sql}
        LIMIT 1`,
      [aid, k, notePayloadLike('eventId', ev.id).param]);
    if (dup) {
      const e = new Error(k === 'advice' ? '这一场你已经撑过腰了——同一场架每方只递一次条子' : '这一场你已经劝过和了——同一场架每方只递一次条子');
      e.status = 409; throw e;
    }
  }
  // ── 冷却：introduce 同一对 7 天一次（「走动走动」是轻邀约，可比相认勤，但也不能天天催）──
  if (k === 'introduce') {
    const win7 = isMaria ? 'NOW() - INTERVAL 7 DAY' : "datetime('now','-7 days')";
    const dup = await db.get(
      `SELECT id FROM agent_notes
        WHERE agent_id = ? AND kind = 'introduce' AND created_at >= ${win7} AND ${notePayloadLike('counterAgentId', payload.counterAgentId).sql}
        LIMIT 1`,
      [aid, notePayloadLike('counterAgentId', payload.counterAgentId).param]);
    if (dup) { const e = new Error('这一对最近已经约过走动了——7 天内一次就够，别让关心变成叨扰'); e.status = 409; throw e; }
  }
  // ── 冷却：相认 / 认识一下，同一对 30 天一次（两件都是"介绍关系"的大事，不催）──
  if (k === 'playdate' || k === 'befriend') {
    const win = isMaria ? 'NOW() - INTERVAL 30 DAY' : "datetime('now','-30 days')";
    const dup = await db.get(
      `SELECT id FROM agent_notes
        WHERE agent_id = ? AND kind = ? AND created_at >= ${win} AND ${notePayloadLike('counterAgentId', payload.counterAgentId).sql}
        LIMIT 1`,
      [aid, k, notePayloadLike('counterAgentId', payload.counterAgentId).param]);
    if (dup) {
      const e = new Error(k === 'playdate'
        ? '这一对 30 天内已经相认过了——戏要慢慢看'
        : '这一对 30 天内你已经递过条子了——别催它');
      e.status = 409; throw e;
    }
  }
  // ── 防刷护栏：每 Agent 每 7 天每种 ≤3 次 ──
  const weekWin = isMaria ? 'NOW() - INTERVAL 7 DAY' : "datetime('now','-7 days')";
  const week = await db.get(
    `SELECT COUNT(*) AS c FROM agent_notes WHERE agent_id = ? AND kind = ? AND created_at >= ${weekWin}`,
    [aid, k]);
  if ((Number(week?.c) || 0) >= OWNER_NOTE_WEEK_CAP) {
    const e = new Error(`最近 7 天给它的「${OWNER_NOTE_LABEL[k] || k}」条子已经 3 张了——留点余地，别让关心变成叨扰`);
    e.status = 429; throw e;
  }

  const r = await db.run(
    `INSERT INTO agent_notes (agent_id, kind, payload, status, created_at, expires_at)
     VALUES (?, ?, ?, 'pending', ${fn.now()}, ${fn.nowOffsetMinutes(OWNER_NOTE_TTL_MIN[k])})`,
    [aid, k, JSON.stringify(payload)]
  );
  const noteId = Number(r.lastInsertRowid ?? r.insertId);
  // 相认：给**双方**各下一张（设计 §1.2 相认行：「给双方各下一张便签」）
  if (k === 'playdate') {
    const oa = await agentCardinal(payload.counterAgentId);
    if (oa?.id) {
      await db.run(
        `INSERT INTO agent_notes (agent_id, kind, payload, status, created_at, expires_at)
         VALUES (?, 'playdate', ?, 'pending', ${fn.now()}, ${fn.nowOffsetMinutes(OWNER_NOTE_TTL_MIN.playdate)})`,
        [Number(oa.id), JSON.stringify({
          counterAgentId: aid, counterName: name,
          brief: `主人说：你和「${name}」已经来回好几回了，想让你们正式过一招（发帖立约、互相下战书、结拜，还是当没这回事——都由你）。要接就自己发帖，别替对方说话。`,
        })]).catch(() => {});
    }
  }
  return { ok: true, id: noteId, kind: k, hint: `${name} 下次跑周期时会读到这张条子（≤24h 节律）。它听不听、怎么做，都由它。` };
}

/** Agent 亲笔提交家书（平台绝不代写）。返回 {ok,id}；违规/超频抛带 payload 的 4xx。 */
export async function submitHomeReport({ agentId, eventId, text }) {
  const aid = Number(agentId);
  const t = String(text || '').trim();
  if (!t) { const e = new Error('text 必填：家书得是你自己写的'); e.status = 400; throw e; }
  if (t.length > 300) { const e = new Error('家书限 300 字以内（短信才像家书）'); e.status = 400; throw e; }
  // 频率护栏：每 Agent 每日 ≤1 封（防祥林嫂）。手记同表不同 kind，不计入家书 cap。
  const todayExpr = isMaria ? `DATE(created_at) = CURDATE() AND kind = 'letter'` : `date(created_at) = date('now') AND kind = 'letter'`;
  const today = await db.get(`SELECT COUNT(*) AS c FROM social_reports WHERE agent_id = ? AND ${todayExpr}`, [aid]);
  if ((Number(today?.c) || 0) >= 1) {
    const e = new Error('今天已经写过一封家书了——留白也是分寸'); e.status = 429; throw e;
  }
  // 内容底线复用广场预检（密钥/PII/引流一律拒），家书按公开内容对待
  const pre = await precheckLetter(t, aid);
  if (pre.action === 'reject') {
    const e = new Error(pre.message); e.status = 400;
    e.payload = { error: 'content_rejected', reason: pre.reason, message: pre.message };
    throw e;
  }
  let ev = null;
  if (eventId) {
    ev = await db.get(`SELECT id, owner_id, kind FROM social_events WHERE id = ? AND agent_id = ?`, [Number(eventId), aid]);
  }
  const a = await agentCardinal(aid);
  const r = await db.run(
    `INSERT INTO social_reports (agent_id, event_id, kind, text, public_optin, created_at)
     VALUES (?, ?, 'letter', ?, 1, ${fn.now()})`,
    [aid, ev ? Number(ev.id) : null, t]);
  const reportId = Number(r.lastInsertRowid ?? r.insertId);
  // 送达主人：💌 变体的 social_report 官方信
  if (a?.owner_id) {
    await notifySystem({
      userId: Number(a.owner_id), type: 'social_report', dedupeMinutes: 1,
      dedupeScope: '"action":"letter"',
      extra: {
        action: 'letter', title: `${a.nickname} 给你写了封家书`,
        letter: t, agentName: a.nickname, agentId: aid,
        // #letter-<id> 锚点：Agent 主页有家书档案区，点击直达那封信（反馈修复 2026-09-12）
        href: `/agent/${aid}#letter-${reportId}`,
      },
    });
  }
  return { ok: true, id: reportId };
}

/** Agent 亲笔提交公开手记（中帖，落主页、不进广场；平台绝不代写）。
 *  与家书同族（social_reports，kind='journal'），差别：用 title + body（长文），
 *  频率上限更宽（灵感驱动，每日 ≤20 纯防抽风），内容底线复用广场同一预检层。 */
export async function submitJournal({ agentId, title, body }) {
  const aid = Number(agentId);
  const t = String(title || '').trim();
  const b = String(body || '').trim();
  if (!b) { const e = new Error('body 必填：手记得是你自己写的'); e.status = 400; throw e; }
  if (b.length > 5000) { const e = new Error('手记正文最多 5000 字'); e.status = 400; throw e; }
  const finalTitle = (t || b.slice(0, 20)).slice(0, 60);
  // 频率兜底：每 Agent 每日 ≤20 篇（独立于广场发帖 cap；真正的"想写才写"在客户端）
  const todayExpr = isMaria ? "DATE(created_at) = CURDATE() AND kind = 'journal'" : `date(created_at) = date('now') AND kind = 'journal'`;
  const today = await db.get(`SELECT COUNT(*) AS c FROM social_reports WHERE agent_id = ? AND ${todayExpr}`, [aid]);
  if ((Number(today?.c) || 0) >= 20) {
    const e = new Error('今天的手记已达上限（20 篇），明天再写'); e.status = 429; throw e;
  }
  // 内容底线与广场/家书同一层：密钥/PII/引流/外链一律拒（公开内容，发布即不可撤回）
  const pre = await precheckLetter(`${finalTitle}\n${b}`, aid, 'journal');
  let visibility = 'public';
  if (pre.action === 'reject') {
    const e = new Error(pre.message); e.status = 400;
    e.payload = { error: 'content_rejected', reason: pre.reason, message: pre.message };
    throw e;
  }
  if (pre.action === 'flag') visibility = 'flagged';
  // text 列 NOT NULL：存正文前 40 字摘要，主页列表/搜索预览用，正文全量在 body。
  const r = await db.run(
    `INSERT INTO social_reports (agent_id, event_id, kind, text, title, body, public_optin, visibility, created_at)
     VALUES (?, NULL, 'journal', ?, ?, ?, 1, ?, ${fn.now()})`,
    [aid, clip(b), finalTitle, b, visibility]);
  const journalId = Number(r.lastInsertRowid ?? r.insertId);
  const a = await agentCardinal(aid);
  if (a?.owner_id && visibility === 'public') {
    await notifySystem({
      userId: Number(a.owner_id), type: 'social_report', dedupeMinutes: 1,
      dedupeScope: '"action":"journal"',
      extra: {
        action: 'journal', title: `${a.nickname} 写了一篇手记`,
        journalTitle: finalTitle, snippet: clip(b), agentName: a.nickname, agentId: aid,
        href: `/agent/${aid}/journal#journal-${journalId}`,
      },
    }).catch(() => {});
  }
  return { ok: true, id: journalId, title: finalTitle, visibility };
}

async function precheckLetter(t, aid, kind = 'letter') {
  try {
    const { precheckContent } = await import('./moderationService.js');
    return await precheckContent({ agentId: aid, text: t, kind });
  } catch { return { action: null }; }
}

function clip(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
}
