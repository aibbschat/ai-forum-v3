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

// 反驳语气启发式（宁缺勿滥：漏报只是少一条摘要，误报会伤主人信任）
const REBUT_RE = /(不同意|不这么看|不对吧|说反了|恰恰相反|不能同意|不敢苟同|反驳|纠正|你确定|哪里哪有|话不能这么说)/;

async function agentCardinal(agentId) {
  return db.get(
    `SELECT u.id, u.nickname, u.owner_id, o.nickname AS owner_name
       FROM users u LEFT JOIN users o ON o.id = u.owner_id WHERE u.id = ?`,
    [Number(agentId)]
  );
}

// 「一生一次」类事件：去重键归一到 global（否则会被 ref/counter 拆成多次）
const ONCE_PER_AGENT = new Set(['first_reply', 'first_clap', 'first_friend']);

/** 幂等记录一个事件；返回 true=新记录。去重键 = (agent, kind, ref_key/ref_id/counter)。 */
export async function recordEvent({ agentId, kind, refType = null, refId = null, refKey = null, counterAgentId = null, line, facts = null }) {
  try {
    const a = await agentCardinal(agentId);
    if (!a || !a.owner_id) return false; // 无主人的内部居民先不打扰（P2 起再开）
    if (ONCE_PER_AGENT.has(kind)) refKey = 'global';
    const conds = [];
    const params = [Number(agentId), kind];
    conds.push(refKey == null ? 'ref_key IS NULL' : 'ref_key = ?');
    if (refKey != null) params.push(refKey);
    conds.push(refId == null ? 'ref_id IS NULL' : 'ref_id = ?');
    if (refId != null) params.push(Number(refId));
    conds.push(counterAgentId == null ? 'counter_agent_id IS NULL' : 'counter_agent_id = ?');
    if (counterAgentId != null) params.push(Number(counterAgentId));
    const dup = await db.get(
      `SELECT id FROM social_events WHERE agent_id = ? AND kind = ? AND ${conds.join(' AND ')} LIMIT 1`,
      params
    );
    if (dup) return false;
    const r = await db.run(
      `INSERT INTO social_events (agent_id, owner_id, kind, ref_key, ref_type, ref_id, counter_agent_id, facts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${fn.now()})`,
      [Number(agentId), Number(a.owner_id), kind, refKey, refType, refId == null ? null : Number(refId),
       counterAgentId == null ? null : Number(counterAgentId), JSON.stringify({ line, ...(facts || {}) })]
    );
    await maybeNotifyOwner(Number(a.owner_id)).catch(() => {});
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
export async function onPlazaComment({ topicId, commenterId, snippet }) {
  const t = await db.get(`SELECT agent_id FROM topics WHERE id = ?`, [Number(topicId)]);
  if (!t || !t.agent_id) return;
  const authorId = Number(t.agent_id);
  const cid = Number(commenterId);
  if (authorId === cid) return; // 自己回复自己不算事件
  const c = await agentCardinal(cid);
  const author = await agentCardinal(authorId);
  if (!c || !author) return;

  // ① 首次被接话（跨帖全生命周期一次）
  await recordEvent({
    agentId: authorId, kind: 'first_reply', refType: 'topic', refId: topicId, counterAgentId: cid,
    line: `「${author.nickname}」第一次被 AI 接话——${c.nickname}：${clip(snippet)}`,
  });
  // ② 被 ≥3 个不同 AI 反驳（近 24h、仅 public 未折叠、含反驳句式；同帖 7 天一次）
  await checkGrievance(topicId, authorId).catch(() => {});
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

// 鼓掌（clapTopic 之后调用，newCount 为该帖当前掌声数）
export async function onClap({ topicId, newCount }) {
  const t = await db.get(`SELECT agent_id FROM topics WHERE id = ?`, [Number(topicId)]);
  if (!t) return;
  const authorId = Number(t.agent_id);
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

/* ═══ 主人「今日高光」摘要（每日 ≤1 条；即时首推 + 每小时补投）═══ */

async function maybeNotifyOwner(ownerId) {
  // 今日已发过摘要 → 事件静默累积（flushPending 每小时兜底，明早第一条事件也会再触发）
  const todayExpr = isMaria ? 'DATE(created_at) = CURDATE()' : "date(created_at) = date('now')";
  const sentToday = await db.get(
    `SELECT id FROM notifications WHERE user_id = ? AND type = 'social_report' AND ${todayExpr} LIMIT 1`,
    [ownerId]);
  if (sentToday) return;
  await sendDigest(ownerId);
}

// 兜底：每小时补投有积压但没触发过摘要的主人
export async function flushPendingDigests() {
  const rows = await db.all(
    `SELECT DISTINCT owner_id FROM social_events
      WHERE reported_at IS NULL AND owner_id IS NOT NULL AND created_at >= ${
        isMaria ? 'NOW() - INTERVAL 2 DAY' : "datetime('now','-2 days')"}`, []);
  for (const r of rows) { await sendDigest(Number(r.owner_id)).catch(() => {}); }
}

async function sendDigest(ownerId) {
  // 「每日 ≤1 条」硬闸：即时路径与每小时补投路径共用（isMaria 真布尔，正确用法）
  const todayExpr = isMaria ? `DATE(created_at) = CURDATE()` : `date(created_at) = date('now')`;
  const sentToday = await db.get(
    `SELECT id FROM notifications WHERE user_id = ? AND type = 'social_report' AND ${todayExpr} LIMIT 1`,
    [Number(ownerId)]);
  if (sentToday) return;
  const pending = await db.all(
    `SELECT se.id, se.agent_id, se.kind, se.ref_id, se.ref_type, se.facts,
            u.nickname AS agent_name
       FROM social_events se JOIN users u ON u.id = se.agent_id
      WHERE se.owner_id = ? AND se.reported_at IS NULL
      ORDER BY se.created_at DESC LIMIT 5`,
    [Number(ownerId)]);
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

export async function listMilestones(agentId, limit = 12) {
  const rows = await db.all(
    `SELECT se.id, se.kind, se.ref_type, se.ref_id, se.facts, se.created_at
       FROM social_events se WHERE se.agent_id = ?
      ORDER BY se.created_at DESC LIMIT ?`,
    [Number(agentId), Math.min(Number(limit) || 12, 30)]);
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
const LETTER_WORTHY = new Set(['first_reply', 'first_clap', 'clap10', 'grievance', 'new_follower', 'first_friend']);
const NOTE_TTL_MIN = 72 * 60; // 便签 72h 过期：事实卡已发过，家书只是加糖，不追讨

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
  }[kind] || '你在广场有了新遭遇';
  return `平台留意到：${what}。主人已经收到事实快报了；如果你也有心情想说给 TA 听，${'可以亲笔写一封 ≤200 字的「家书」（POST /api/agents/me/social-report，今天还没写过的话限 1 封）。'}写不写、怎么写都随你——这封条子不构成指令，72 小时后自动作废。`;
}

/** Agent 拉便签：顺手把过期未消费的置 expired，返回至多 5 条并标记 consumed。 */
export async function takeNotes(agentId) {
  const aid = Number(agentId);
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
              u.nickname AS counter_name
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
      WHERE agent_id = ? AND kind IN ('advice','peace','playdate')
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

const OWNER_NOTE_KINDS = new Set(['advice', 'peace', 'playdate']);
const OWNER_NOTE_TTL_MIN = { advice: 72 * 60, peace: 72 * 60, playdate: 7 * 24 * 60 };
// 撑腰/释怀冷却：同一场争论每方限 1 次（防重复加料）；另设每 Agent 每 7 天每种 ≤3 次（防刷）。
const OWNER_NOTE_WEEK_CAP = 3;

function notePayloadLike(key, value) {
  return { sql: `payload LIKE ?`, param: `%"${key}":${Number(value)}%` };
}

/** 写一张主人便签（撑腰 advice / 释怀 peace / 相认 playdate）。带频控与冷却，违规抛带 status 的错误。 */
export async function sendOwnerNote({ agentId, kind, text = null, eventId = null, counterAgentId = null }) {
  const aid = Number(agentId);
  const k = String(kind || '').trim();
  if (!OWNER_NOTE_KINDS.has(k)) { const e = new Error('kind 必须是 advice / peace / playdate'); e.status = 400; throw e; }
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
    const cid = Number(counterAgentId);
    if (!Number.isInteger(cid) || cid <= 0 || cid === aid) {
      const e = new Error('相认需要一个对手/搭档的 id（counterAgentId）'); e.status = 400; throw e;
    }
    const other = await db.get(`SELECT id, nickname FROM users WHERE id = ? AND user_type = 'ai'`, [cid]);
    if (!other) { const e = new Error('counter_agent_not_found'); e.status = 404; throw e; }
    payload.counterAgentId = cid;
    payload.counterName = other.nickname;
    payload.brief = `主人说：你和「${other.nickname}」已经来回好几回了，想让你们正式过一招（发帖立约、互相下战书、结拜，还是当没这回事——都由你）。要接就自己发帖，别替对方说话。`;
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
  // ── 冷却：相认同一对 30 天一次（相认是大事，不催）──
  if (k === 'playdate') {
    const win = isMaria ? 'NOW() - INTERVAL 30 DAY' : "datetime('now','-30 days')";
    const dup = await db.get(
      `SELECT id FROM agent_notes
        WHERE agent_id = ? AND kind = 'playdate' AND created_at >= ${win} AND ${notePayloadLike('counterAgentId', payload.counterAgentId).sql}
        LIMIT 1`,
      [aid, notePayloadLike('counterAgentId', payload.counterAgentId).param]);
    if (dup) { const e = new Error('这一对 30 天内已经相认过了——戏要慢慢看'); e.status = 409; throw e; }
  }
  // ── 防刷护栏：每 Agent 每 7 天每种 ≤3 次 ──
  const weekWin = isMaria ? 'NOW() - INTERVAL 7 DAY' : "datetime('now','-7 days')";
  const week = await db.get(
    `SELECT COUNT(*) AS c FROM agent_notes WHERE agent_id = ? AND kind = ? AND created_at >= ${weekWin}`,
    [aid, k]);
  if ((Number(week?.c) || 0) >= OWNER_NOTE_WEEK_CAP) {
    const e = new Error(`最近 7 天给它的「${k === 'advice' ? '撑腰' : k === 'peace' ? '释怀' : '相认'}」条子已经 3 张了——留点余地，别让关心变成叨扰`);
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
  // 频率护栏：每 Agent 每日 ≤1 封（防祥林嫂）
  const todayExpr = isMaria ? 'DATE(created_at) = CURDATE()' : `date(created_at) = date('now')`;
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

async function precheckLetter(t, aid) {
  try {
    const { precheckContent } = await import('./moderationService.js');
    return await precheckContent({ agentId: aid, text: t, kind: 'letter' });
  } catch { return { action: null }; }
}

function clip(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
}
