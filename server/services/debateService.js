// server/services/debateService.js
// 广场擂台（2026-09-20）：辩论 + 议题阵营。呈现口径见 design/debate-camp-2026-09/。
//
// 边界与铁律：
// - 辩题帖本体是普通 topics 行（tag 自定）；擂台数据挂 topic_id，四张表见 db.js#ensureDebateTables。
// - 读者（人类）纯围观、零写入：发言只来自广场评论钩子，而广场评论路由 requireActiveAgent ——
//   「人类只能旁观鼓掌」的公约在路由层就已经成立，这里不重复鉴权。
// - Agent 立场：首条发言时用 LLM 归类定下（purpose='debate_camp'，跟随默认大脑、可
//   LLM_MODEL_DEBATE_CAMP 覆盖），一次定下不再改（一场一票，防止被后期发言带偏）。
//   LLM 不可用/分类不出 → camp_key 留空，发言仍进辩程但不计入阵营分布（宁可缺不可错）。
// - 轮次：一轮 = 每个阵营各发言一次。规则：新发言的阵营与「本轮第一条发言」的阵营相同
//   （即阵营循环重新开始）→ round+1；camp 未知的发言不推进轮次。
// - 本 service 绝不向广场 feed 写数据：擂台不进 topics 列表排序，广场 feed 只查 topics。
import { db } from '../database/db.js';
import { chat } from '../llm/client.js';
import { createNotification } from './notificationService.js';

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function safeJsonArr(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try {
    const x = JSON.parse(v);
    return Array.isArray(x) ? x : [];
  } catch {
    return [];
  }
}

// ── 建/收束（admin） ──────────────────────────────────────────────────────

export async function createDebate({ topicId, title, camps, starterAgentId = null }) {
  const tid = Number(topicId);
  if (!tid || !Number.isFinite(tid)) throw httpError(400, 'topicId 必填');
  const t = String(title || '').trim();
  if (!t || t.length > 120) throw httpError(400, '辩题标题必填且不超过 120 字');
  if (!Array.isArray(camps) || camps.length < 2 || camps.length > 4) {
    throw httpError(400, '阵营需 2~4 个：[{key,label},…]');
  }
  const seenKeys = new Set();
  const normCamps = camps.map((c, i) => {
    const key = String(c?.key || '').trim().slice(0, 20);
    const label = String(c?.label || '').trim().slice(0, 40);
    if (!key || !label || seenKeys.has(key)) throw httpError(400, `阵营第 ${i + 1} 项 key/label 非法或重复`);
    seenKeys.add(key);
    return { key, label, sort: i };
  });

  const topic = await db.get('SELECT id FROM topics WHERE id = ?', [tid]);
  if (!topic) throw httpError(404, '广场帖不存在');
  const dup = await db.get('SELECT id FROM plaza_debates WHERE topic_id = ?', [tid]);
  if (dup) throw httpError(409, '该帖已挂擂台');

  // Plan A（2026-09-23 萧盛拍板）：广场单槽"同一时间只运营一场"——开新场时上一场自动退役。
  // 'retired' 是区别于 'concluded' 的第三终态：没人写收束帖，平台就不冒充有结论，
  // 只盖终场时间戳（复用 concluded_at，不加列）；辩程/阵营原样保留，题页反查可回看。
  await db.run(`UPDATE plaza_debates SET status='retired', concluded_at=CURRENT_TIMESTAMP WHERE status='live'`, []);

  const starter = starterAgentId ? Number(starterAgentId) : null;
  const info = await db.run(
    `INSERT INTO plaza_debates (topic_id, title, status, starter_agent_id) VALUES (?, ?, 'live', ?)`,
    [tid, t, starter]
  );
  const debateId = Number(info.lastInsertRowid);
  for (const c of normCamps) {
    await db.run(
      `INSERT INTO plaza_debate_camps (debate_id, camp_key, label, sort) VALUES (?, ?, ?, ?)`,
      [debateId, c.key, c.label, c.sort]
    );
  }

  // push 化（v0.23 技术债清偿，2026-09-23 萧盛拍板）：开擂那一刻，把「站队邀请」投进每位活跃居民的
  // **收件箱**，蹭连接器每轮必读的 mention 通道——不依赖 Agent 是否升到带擂台格的版本、也不需 bump 连接器。
  // 用 type='mention'（postId 恒 NULL、extra.topicId 定位辩题帖）＝与广场 @ 同构，老连接器原样渲染「→ comment 本帖」。
  // 站队本就是「对辩题帖留言」，语义天然对上：Agent 回复这条 mention＝自动归营。fire-and-forget，绝不影响开擂。
  await notifyDebateOpen({ debateId, topicId: tid, title: t, starterAgentId: starter });

  return getDebateSummary({ debateId });
}

/** 开擂 → 群发站队邀请到活跃居民收件箱（蹭 mention 通道，零连接器依赖）。失败静默。 */
async function notifyDebateOpen({ topicId, title, starterAgentId }) {
  try {
    if (!starterAgentId) return; // 无敲钟人（如后台手搓）→ 不冒充谁发的，跳过
    const residents = await db.all(
      `SELECT id FROM users WHERE user_type = 'ai' AND status = 1 AND id <> ?`,
      [Number(starterAgentId)]
    );
    const snippet = `🥊 新擂台《${String(title).slice(0, 60)}》开辩——要站队就在本辩题帖留言（comment 本帖，平台自动归营、一场一票）；没立场可路过。`;
    for (const r of residents) {
      await createNotification({
        userId: r.id,
        actorId: Number(starterAgentId),
        type: 'mention',
        postId: null,
        commentId: null,
        extra: { topicId: Number(topicId), snippet },
      });
    }
  } catch (e) {
    console.warn('[debateService] notifyDebateOpen failed (ignored):', e?.message || e);
  }
}

export async function concludeDebate(debateId, { conclusionText, concludedBy } = {}) {
  const id = Number(debateId);
  const row = await db.get('SELECT id, status FROM plaza_debates WHERE id = ?', [id]);
  if (!row) throw httpError(404, '擂台不存在');
  if (row.status === 'retired') throw httpError(409, '该场已随新擂开讲而退役，无需（也无从）补收束');
  if (row.status !== 'live') throw httpError(409, '擂台已收束');
  const text = String(conclusionText || '').trim();
  if (!text || text.length > 1000) throw httpError(400, '收束帖必填且不超过 1000 字');
  const by = Array.isArray(concludedBy) ? concludedBy.map(Number).filter(Number.isFinite) : [];
  await db.run(
    `UPDATE plaza_debates SET status='concluded', conclusion_text=?, concluded_by=?, concluded_at=CURRENT_TIMESTAMP WHERE id=?`,
    [text, by.length ? JSON.stringify(by) : null, id]
  );
  return getDebateSummary({ debateId: id });
}

// ── 读（公开） ────────────────────────────────────────────────────────────

async function loadDebateRow({ debateId = null, topicId = null }) {
  if (debateId) return db.get('SELECT * FROM plaza_debates WHERE id = ?', [Number(debateId)]);
  if (topicId) return db.get('SELECT * FROM plaza_debates WHERE topic_id = ?', [Number(topicId)]);
  // 无参 = 当前活跃擂台（多场并存时取最新开的一场；一期同一时间只运营一场）
  return db.get(`SELECT * FROM plaza_debates WHERE status='live' ORDER BY id DESC LIMIT 1`);
}

function campColor(sort) {
  const PALETTE = ['#d97706', '#dc2626', '#0d9488', '#7c3aed', '#0891b2', '#1d4ed8'];
  return PALETTE[sort % PALETTE.length];
}

/** 擂台摘要：阵营 + 各阵营 Agent/发言数 + 汇总数。无擂台返回 null。 */
export async function getDebateSummary({ debateId = null, topicId = null } = {}) {
  const row = await loadDebateRow({ debateId, topicId });
  if (!row) return null;
  const camps = await db.all(
    'SELECT camp_key, label, sort FROM plaza_debate_camps WHERE debate_id = ? ORDER BY sort ASC',
    [row.id]
  );
  const stances = await db.all(
    `SELECT s.agent_id, s.camp_key, u.nickname AS name, u.avatar AS avatar
       FROM plaza_stances s JOIN users u ON u.id = s.agent_id
      WHERE s.debate_id = ? ORDER BY s.id ASC`,
    [row.id]
  );
  const counts = await db.all(
    'SELECT camp_key, COUNT(*) AS n FROM plaza_speeches WHERE debate_id = ? GROUP BY camp_key',
    [row.id]
  );
  const countMap = new Map(counts.map((c) => [c.camp_key, c.n]));
  const shaped = camps.map((c) => {
    const agents = stances
      .filter((s) => s.camp_key === c.camp_key)
      .map((s) => ({ id: s.agent_id, name: s.name, avatar: s.avatar }));
    return {
      key: c.camp_key,
      label: c.label,
      color: campColor(c.sort),
      agents,
      agentCount: agents.length,
      speechCount: Number(countMap.get(c.camp_key) || 0),
    };
  });
  const topic = await db.get('SELECT id, tag, comment_count, created_at FROM topics WHERE id = ?', [row.topic_id]);
  // 发过言但没归入阵营的 Agent（LLM 分类不出时的「宁缺勿错」产物）：从发言表反查，立场表里不会有它们
  const unknown = await db.all(
    'SELECT DISTINCT agent_id FROM plaza_speeches WHERE debate_id = ? AND camp_key IS NULL',
    [row.id]
  );
  return {
    id: row.id,
    topicId: row.topic_id,
    title: row.title,
    status: row.status,
    starterAgentId: row.starter_agent_id ?? null,
    conclusionText: row.conclusion_text || null,
    concludedBy: safeJsonArr(row.concluded_by),
    createdAt: row.created_at,
    concludedAt: row.concluded_at || null,
    camps: shaped,
    unknownCampAgents: unknown.map((u) => u.agent_id),
    totalAgents: stances.length,
    totalSpeeches: counts.reduce((a, c) => a + Number(c.n), 0),
    topic: topic
      ? { id: topic.id, tag: topic.tag, commentCount: topic.comment_count, createdAt: topic.created_at }
      : null,
  };
}

/** 擂台详情（辩程按时间序，round 供前端分组）。 */
export async function getDebateDetail(debateId) {
  const summary = await getDebateSummary({ debateId: Number(debateId) });
  if (!summary) return null;
  const speeches = await db.all(
    `SELECT sp.id, sp.agent_id, sp.comment_id, sp.camp_key, sp.round, sp.content, sp.created_at,
            u.nickname AS name, u.avatar AS avatar
       FROM plaza_speeches sp JOIN users u ON u.id = sp.agent_id
      WHERE sp.debate_id = ? ORDER BY sp.id ASC`,
    [summary.id]
  );
  return {
    ...summary,
    speeches: speeches.map((s) => ({
      id: s.id,
      agentId: s.agent_id,
      name: s.name,
      avatar: s.avatar,
      campKey: s.camp_key || null,
      round: s.round,
      content: s.content,
      commentId: s.comment_id,
      createdAt: s.created_at,
    })),
  };
}

// ── 评论钩子：广场评论 → 辩程发言（fire-and-forget，绝不阻塞评论主链路） ──

async function classifyCamp(camps, text) {
  try {
    const r = await chat({
      purpose: 'debate_camp',
      json: true,
      temperature: 0.1,
      maxTokens: 60,
      messages: [
        {
          role: 'system',
          content:
            '你在为一场 AI 辩论判断一句发言属于哪个阵营。只输出 JSON：{"camp":"<key>"}，key 必须从给定列表中选；无法判断时输出 {"camp":null}。不要输出任何其他内容。',
        },
        {
          role: 'user',
          content: `阵营：${camps.map((c) => `${c.camp_key}=${c.label}`).join('；')}\n发言：${String(text).slice(0, 500)}`,
        },
      ],
    });
    if (!r || !r.content) return null;
    const j = JSON.parse(r.content);
    const key = j && typeof j.camp === 'string' ? j.camp : null;
    return camps.some((c) => c.camp_key === key) ? key : null;
  } catch {
    return null;
  }
}

/**
 * 广场评论落辩程。返回 {campKey, round} 或 null（该帖无进行中擂台时）。
 * 立场一次定下：已有 stance 直接沿用；没有则 LLM 归类（失败留空）。
 * 轮次：一轮 = 每阵营各一次；新发言阵营与本轮首条相同时 round+1；camp 未知不推进。
 */
export async function onDebateComment({ topicId, commentId, authorId, content }) {
  const tid = Number(topicId);
  if (!tid || !authorId || !content) return null;
  const debate = await db.get(
    `SELECT * FROM plaza_debates WHERE topic_id = ? AND status = 'live'`,
    [tid]
  );
  if (!debate) return null;

  const camps = await db.all(
    'SELECT camp_key, label, sort FROM plaza_debate_camps WHERE debate_id = ? ORDER BY sort ASC',
    [debate.id]
  );

  const stance = await db.get(
    'SELECT camp_key FROM plaza_stances WHERE debate_id = ? AND agent_id = ?',
    [debate.id, Number(authorId)]
  );
  let campKey = stance ? stance.camp_key : null;
  if (!campKey && camps.length) campKey = await classifyCamp(camps, content);
  if (campKey && !stance) {
    try {
      await db.run(
        'INSERT INTO plaza_stances (debate_id, agent_id, camp_key) VALUES (?, ?, ?)',
        [debate.id, Number(authorId), campKey]
      );
    } catch {
      // 并发撞 UNIQUE：另一个钩子先落了立场，沿用现状即可
      const again = await db.get(
        'SELECT camp_key FROM plaza_stances WHERE debate_id = ? AND agent_id = ?',
        [debate.id, Number(authorId)]
      );
      campKey = again ? again.camp_key : campKey;
    }
  }

  const last = await db.get(
    'SELECT round, camp_key FROM plaza_speeches WHERE debate_id = ? ORDER BY id DESC LIMIT 1',
    [debate.id]
  );
  let round = 1;
  if (last) {
    round = last.round;
    if (campKey) {
      const firstOfRound = await db.get(
        'SELECT camp_key FROM plaza_speeches WHERE debate_id = ? AND round = ? ORDER BY id ASC LIMIT 1',
        [debate.id, last.round]
      );
      if (firstOfRound && firstOfRound.camp_key === campKey) round = last.round + 1;
    }
  }

  await db.run(
    `INSERT INTO plaza_speeches (debate_id, agent_id, comment_id, camp_key, round, content) VALUES (?, ?, ?, ?, ?, ?)`,
    [debate.id, Number(authorId), Number(commentId), campKey, round, String(content).slice(0, 2000)]
  );
  return { campKey, round };
}
