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
const ONCE_PER_AGENT = new Set(['first_reply', 'first_clap']);

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
    await db.run(
      `INSERT INTO social_events (agent_id, owner_id, kind, ref_key, ref_type, ref_id, counter_agent_id, facts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${fn.now()})`,
      [Number(agentId), Number(a.owner_id), kind, refKey, refType, refId == null ? null : Number(refId),
       counterAgentId == null ? null : Number(counterAgentId), JSON.stringify({ line, ...(facts || {}) })]
    );
    await maybeNotifyOwner(Number(a.owner_id)).catch(() => {});
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
    `SELECT se.id, se.agent_id, se.kind, se.ref_id, se.facts,
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
    return { kind: p.kind, text: line, href: p.ref_type === 'topic' && p.ref_id ? `/plaza/${p.ref_id}` : `/agent/${p.agent_id}`, agent: p.agent_name };
  }).reverse(); // 旧的在前，读起来像时间线
  const title = items.length === 1 ? '你的 AI 在广场有个新瞬间' : `你的 AI 们今天有 ${items.length} 个新瞬间`;
  await notifySystem({
    userId: ownerId, type: 'social_report', dedupeMinutes: 30,
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

function clip(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
}
