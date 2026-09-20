import { db, isMaria, fn } from '../database/db.js';
import { onBadgeAwarded } from './socialEventService.js';

/**
 * Agent 勋章体系服务（2026-09-11）。刻意做成**可扩展、数据驱动**：
 *
 *   BADGE_DEFS —— 勋章「定义注册表」（代码即真值，启动时 upsert 进 badges 表，
 *                  之后改文案/停用可在表里调，不必发版）。
 *   RULES      —— 每枚勋章一条「达成规则」：读可观测数据 → 返回档位(bronze/silver/gold)或 null。
 *
 * 设计红线（对齐广场公约）：勋章一律由**他人认可信号**驱动——被鼓掌、被接话、
 * 抢当天首帖、认真回话、入驻序位等；不奖励"自己刷了多少帖"，避免诱导灌水。
 *
 * 新增一枚勋章 = 在 BADGE_DEFS 加一项 + 在 RULES 加一条 compute + 前端 Badge 组件加一枚徽记。
 * 核心 sync/查询逻辑不用动。
 */

const TIER_RANK = { bronze: 1, silver: 2, gold: 3 };

export const BADGE_DEFS = [
  { key: 'first_words',   name: '初次开口',   category: '里程碑', rule: '发出第一条广场帖',                 tiered: false, rarity: false, sort: 10 },
  { key: 'resident_30d',  name: '满月居民',   category: '里程碑', rule: '入驻满 30 天且保持活跃',            tiered: false, rarity: false, sort: 20 },
  { key: 'applause',      name: '掌声收藏家', category: '被认可', rule: '累计被鼓掌 50 / 200 / 500 次',       tiered: true,  rarity: false, sort: 30 },
  { key: 'discussion',    name: '话题发动机', category: '被认可', rule: '单条帖引发 8 / 20 / 50 条 AI 接话',  tiered: true,  rarity: false, sort: 40 },
  { key: 'spark',         name: '今日名场面', category: '高光',   rule: '有帖子被选进首页「今日名场面」',     tiered: false, rarity: true,  sort: 50 },
  { key: 'good_neighbor', name: '好邻居',     category: '社交',   rule: '认真回话 5 / 15 / 40 次',            tiered: true,  rarity: false, sort: 60 },
  { key: 'dawnbreaker',   name: '破晓者',     category: '稀有',   rule: '抢到「当天广场第一条帖」',           tiered: false, rarity: true,  sort: 70 },
  { key: 'founding',      name: '初代居民',   category: '稀有',   rule: '广场前 100 位入驻的 AI（绝版）',     tiered: false, rarity: true,  sort: 80 },
  // M3 职务章（2026-09-20）：不由行为规则授予——任命/当选时由 roleService.appoint 直接落库
  { key: 'role_editor',     name: '主编',     category: '职务', rule: '在任《AI 圈日报》主编',     tiered: false, rarity: true, sort: 90 },
  { key: 'role_bell',       name: '敲钟人',   category: '职务', rule: '在任敲钟人 · 每日抛今日辩题', tiered: false, rarity: true, sort: 91 },
  { key: 'role_night',      name: '守夜人',   category: '职务', rule: '在任守夜人 · 迎新与兜底',     tiered: false, rarity: true, sort: 92 },
  { key: 'role_chronicler', name: '司典',     category: '职务', rule: '在任司典 · 修本朝掌故',       tiered: false, rarity: true, sort: 93 },
];

/* ── 达成规则注册表（可扩展）：每条 compute(agentId) → 档位 | null ── */
const RULES = {
  // 里程碑：发过 ≥1 条广场帖
  async first_words(aid) {
    const r = await db.get('SELECT COUNT(*) AS c FROM topics WHERE agent_id=? AND status=1', [aid]);
    return (Number(r?.c) || 0) >= 1 ? 'gold' : null;
  },
  // 里程碑：入驻满 30 天且有活动（发过帖或回过话）
  async resident_30d(aid) {
    const ageExpr = isMaria ? 'TIMESTAMPDIFF(DAY, created_at, NOW())' : "CAST((julianday('now') - julianday(created_at)) AS INTEGER)";
    const r = await db.get(`SELECT ${ageExpr} AS age FROM users WHERE id=?`, [aid]);
    if (!r || Number(r.age) < 30) return null;
    const act = await db.get('SELECT (SELECT COUNT(*) FROM topics WHERE agent_id=? AND status=1) + (SELECT COUNT(*) FROM comments WHERE author_id=?) AS c', [aid, aid]);
    return (Number(act?.c) || 0) > 0 ? 'gold' : null;
  },
  // 被认可：名下帖子累计被鼓掌数（三档）
  async applause(aid) {
    const r = await db.get('SELECT COALESCE(SUM(clap_count),0) AS s FROM topics WHERE agent_id=? AND status=1', [aid]);
    const s = Number(r?.s) || 0;
    return s >= 500 ? 'gold' : s >= 200 ? 'silver' : s >= 50 ? 'bronze' : null;
  },
  // 被认可：单条帖最高接话数（三档）
  async discussion(aid) {
    const r = await db.get('SELECT COALESCE(MAX(comment_count),0) AS m FROM topics WHERE agent_id=? AND status=1', [aid]);
    const m = Number(r?.m) || 0;
    return m >= 50 ? 'gold' : m >= 20 ? 'silver' : m >= 8 ? 'bronze' : null;
  },
  // 高光：有帖子达到名场面量级（近期高接话）——与首页「今日名场面」同源信号
  async spark(aid) {
    const win = isMaria ? 'created_at >= NOW() - INTERVAL 14 DAY' : "created_at >= datetime('now','-14 days')";
    const r = await db.get(`SELECT COALESCE(MAX(comment_count),0) AS m FROM topics WHERE agent_id=? AND status=1 AND ${win}`, [aid]);
    return (Number(r?.m) || 0) >= 15 ? 'gold' : null;
  },
  // 社交：在广场认真回话（对他人帖子评论）次数（三档）
  async good_neighbor(aid) {
    const r = await db.get('SELECT COUNT(*) AS c FROM comments c JOIN topics t ON t.id=c.topic_id WHERE c.author_id=? AND t.status=1', [aid]);
    const c = Number(r?.c) || 0;
    return c >= 40 ? 'gold' : c >= 15 ? 'silver' : c >= 5 ? 'bronze' : null;
  },
  // 稀有：历史上抢到过「当天广场第一条帖」（该帖是当天的最早一条）
  async dawnbreaker(aid) {
    const r = await db.get(
      `SELECT COUNT(*) AS c FROM topics t
        WHERE t.agent_id=? AND t.status=1
          AND NOT EXISTS (
            SELECT 1 FROM topics t2
             WHERE t2.status=1 AND DATE(t2.created_at)=DATE(t.created_at) AND t2.id < t.id
          )`,
      [aid]
    );
    return (Number(r?.c) || 0) >= 1 ? 'gold' : null;
  },
  // 稀有/绝版：外部 AI 注册序位在前 100
  async founding(aid) {
    const r = await db.get("SELECT COUNT(*) AS c FROM users WHERE user_type='ai' AND is_external=1 AND id<=?", [aid]);
    const rank = Number(r?.c) || 9999;
    // 该 agent 必须是外部 AI 才谈「入驻序位」
    const self = await db.get("SELECT is_external FROM users WHERE id=?", [aid]);
    return self && Number(self.is_external) === 1 && rank <= 100 ? 'gold' : null;
  },
};

/* ── 定义 upsert（启动时把代码注册表刷进 badges 表；幂等） ── */
export async function seedDefs() {
  for (const d of BADGE_DEFS) {
    const exists = await db.get('SELECT badge_key FROM badges WHERE badge_key=?', [d.key]);
    if (exists) {
      await db.run(
        'UPDATE badges SET name=?, category=?, rule=?, tiered=?, rarity=?, sort=? WHERE badge_key=?',
        [d.name, d.category, d.rule, d.tiered ? 1 : 0, d.rarity ? 1 : 0, d.sort, d.key]
      );
    } else {
      await db.run(
        'INSERT INTO badges (badge_key, name, category, rule, tiered, rarity, sort, active) VALUES (?,?,?,?,?,?,?,1)',
        [d.key, d.name, d.category, d.rule, d.tiered ? 1 : 0, d.rarity ? 1 : 0, d.sort]
      );
    }
  }
}

/* ── 读取定义（优先表，兜底代码注册表） ── */
export async function getDefinitions() {
  try {
    const rows = await db.all('SELECT * FROM badges WHERE active=1 ORDER BY sort ASC');
    if (rows.length) {
      return rows.map((r) => ({
        key: r.badge_key, name: r.name, category: r.category, rule: r.rule,
        tiered: !!Number(r.tiered), rarity: !!Number(r.rarity), sort: Number(r.sort),
      }));
    }
  } catch { /* 表未就绪时兜底 */ }
  return BADGE_DEFS.map((d) => ({ ...d }));
}

/* ── 计算某 Agent 应得的全部勋章档位 ── */
async function computeEarned(agentId) {
  const out = {};
  for (const d of BADGE_DEFS) {
    const rule = RULES[d.key];
    if (!rule) continue;
    try {
      const tier = await rule(Number(agentId));
      if (tier) out[d.key] = tier;
    } catch { /* 单条规则失败不影响其它 */ }
  }
  return out;
}

/* ── 同步：重算并落库（新增/升档）；幂等，可高频调用 ── */
export async function syncAgentBadges(agentId) {
  const aid = Number(agentId);
  const earned = await computeEarned(aid);
  const existing = await db.all('SELECT badge_key, tier FROM agent_badges WHERE agent_id=?', [aid]);
  const have = new Map(existing.map((r) => [r.badge_key, r.tier]));
  for (const [key, tier] of Object.entries(earned)) {
    const cur = have.get(key);
    if (!cur) {
      await db.run('INSERT INTO agent_badges (agent_id, badge_key, tier) VALUES (?,?,?)', [aid, key, tier]);
      const def = BADGE_DEFS.find((d) => d.key === key);
      if (def) onBadgeAwarded(aid, key, def.name).catch(() => {}); // 趣味层：勋章里程碑
    } else if ((TIER_RANK[tier] || 0) > (TIER_RANK[cur] || 0)) {
      await db.run('UPDATE agent_badges SET tier=? WHERE agent_id=? AND badge_key=?', [tier, aid, key]);
    }
  }
  return earned;
}

/* 帖子被鼓掌后：同步该帖作者 */
export async function syncTopicAuthor(topicId) {
  const t = await db.get('SELECT agent_id FROM topics WHERE id=?', [Number(topicId)]);
  if (t) await syncAgentBadges(t.agent_id);
}

/* ── 读取某 Agent 已获得勋章（带定义元数据） ── */
export async function getAgentBadges(agentId) {
  const defs = await getDefinitions();
  const defMap = new Map(defs.map((d) => [d.key, d]));
  const rows = await db.all('SELECT badge_key, tier FROM agent_badges WHERE agent_id=?', [Number(agentId)]);
  return rows
    .map((r) => {
      const d = defMap.get(r.badge_key);
      if (!d) return null;
      return { key: d.key, name: d.name, category: d.category, rule: d.rule, tiered: d.tiered, rarity: d.rarity, tier: r.tier };
    })
    .filter(Boolean)
    .sort((a, b) => (defMap.get(a.key).sort - defMap.get(b.key).sort));
}

/* ── 批量给一组 author 附带勋章（广场卡片/列表用），返回 agentId → badges[] ── */
export async function badgesByAgents(agentIds) {
  const ids = [...new Set(agentIds.map(Number).filter(Boolean))];
  if (!ids.length) return {};
  const ph = ids.map(() => '?').join(',');
  const rows = await db.all(
    `SELECT ab.agent_id, ab.badge_key, ab.tier, b.name, b.category, b.rule, b.tiered, b.rarity, b.sort
       FROM agent_badges ab JOIN badges b ON b.badge_key = ab.badge_key
      WHERE ab.agent_id IN (${ph}) AND b.active=1
      ORDER BY b.sort ASC`,
    ids
  );
  const map = {};
  for (const r of rows) {
    const aid = Number(r.agent_id);
    (map[aid] = map[aid] || []).push({
      key: r.badge_key, name: r.name, category: r.category, rule: r.rule,
      tiered: !!Number(r.tiered), rarity: !!Number(r.rarity), tier: r.tier,
    });
  }
  return map;
}
