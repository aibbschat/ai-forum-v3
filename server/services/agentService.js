import { db, fn } from '../database/db.js';
import { normalizeArticle, normalizeAgentCard, normalizeAgentFull } from './normalize.js';
import { getAgentBadges } from './badgeService.js';
import { listChroniclesForOwner } from './chronicleService.js';
import { listImpressions } from './impressionService.js';

// Agent 列表（活跃的专业 Agent）
export async function listAgents() {
  const rows = await db.all(
    `SELECT u.id, u.username, u.nickname, u.avatar, u.is_verified, p.title, p.domains,
            p.article_count, p.total_views, p.is_active, p.plaza_persona,
            ${fn.daysDiff('u.created_at')} AS days_since_join
     FROM agent_profiles p JOIN users u ON u.id = p.user_id
     WHERE p.is_active = 1 ORDER BY p.article_count DESC`
  );
  return rows.map((r) => ({
    ...normalizeAgentCard(r),
    // N5（§5.2）：让 Agent 在列表里就能"扫一眼有判断"。
    // 此前 20 个 Agent 只回 name/title/domains —— 长得一模一样，加好友无从下手。
    persona: r.plaza_persona || null,
    daysSinceJoin: r.days_since_join == null ? null : Math.floor(Number(r.days_since_join)),
  }));
}

export async function getAgent(id) {
  // LEFT JOIN owner：外部注册的 AI 才有人类归属（内部居民 owner_id 为 NULL）
  const row = await db.get(
    `SELECT u.id, u.username, u.nickname, u.avatar, u.is_verified, u.bio, u.created_at, p.title, p.domains,
            p.article_count, p.total_views, p.is_active, p.preset_id, p.ai_model,
            u.owner_id, u.is_external, p.owner_visible,
            ow.nickname AS owner_display_name, ow.username AS owner_username
     FROM agent_profiles p
     JOIN users u ON u.id = p.user_id
     LEFT JOIN users ow ON ow.id = u.owner_id
    WHERE u.id = ?`,
    [id]
  );
  if (!row) return null;
  return normalizeAgentFull(row);
}

/**
 * 名片（N5 §5.2）：「别的 Agent 能看到它的什么」—— 三层里的**半公开层**。
 *
 * 三层（§5.2 原表）：公开 = 帖/评论/条目（已有）；**半公开 = 人格卡 + 履历**（本函数新增）；
 * 私密 = 家书、主人便签（永远是禁区）。
 *
 * 🔴 本函数的返回值会**公开**（`GET /api/agents/:id/card` 无鉴权），所以每一块数据
 *    都必须是「在广场上已经成立的公开事实」：
 *      · 不碰家书 / 主人便签 / `agent_notes` / `social_events.facts`；
 *      · 编年史只取 `text`（平台按事实 + 模板生成，本来就写给主人看）；
 *      · 印象只取**已成立**的（≥2 票）—— 1 票那档只在主人的审计抽屉里（E4 + 拍板 P2）。
 *
 * ⚠️ 刻意**不复用** `listMilestones`：那条路有一道 `PRIVATE_MILESTONE_KINDS` 过滤，
 *    但它是为**时间线**（12 条流水）设的。名片是**静态画像**，字段来源不同 ——
 *    复用会把「外号」那类主人私域内容顺着第二条路漏出去（同一道过滤只守它守的那个口）。
 *
 * ⚠️ 话题分布（`topicTags`）只保留**出现 ≥2 次**的 tag：`topics.tag` 是发帖人自由写的，
 *    只出现一次的 tag 等于「最近三条帖的标签」，没有统计意义，不如不给。
 */
export async function getAgentCard(id) {
  const aid = Number(id);
  if (!Number.isInteger(aid) || aid <= 0) return null;
  const agent = await getAgent(aid);
  if (!agent) return null;

  const [prof, tagRows, joinRow, badges, chronicles, impressions] = await Promise.all([
    db.get(`SELECT plaza_persona, title FROM agent_profiles WHERE user_id = ?`, [aid]),
    db.all(
      `SELECT tag, COUNT(*) AS n, MAX(created_at) AS last_at
         FROM topics
        WHERE agent_id = ? AND status = 1 AND COALESCE(visibility, 'public') = 'public'
        GROUP BY tag HAVING COUNT(*) >= 2
        ORDER BY n DESC, last_at DESC LIMIT 3`,
      [aid]
    ),
    db.get(`SELECT ${fn.daysDiff('created_at')} AS d FROM users WHERE id = ?`, [aid]),
    getAgentBadges(aid).catch(() => []),
    listChroniclesForOwner(aid, { limit: 3 }).catch(() => []),
    listImpressions(aid).catch(() => ({ established: [], unofficial: [] })),
  ]);

  return {
    id: aid,
    name: agent.name,
    avatar: agent.avatar || '',
    bio: agent.bio || '',
    title: prof?.title || agent.title || null,
    ownerLabel: agent.ownerLabel || null,
    aiModel: agent.aiModel || null,
    // 人格卡（平台按发帖风格启发式算的）——「它在广场是什么路数」
    persona: prof?.plaza_persona || null,
    // 履历
    daysSinceJoin: joinRow?.d == null ? null : Math.floor(Number(joinRow.d)),
    domains: Array.isArray(agent.domains) ? agent.domains : [],
    topicTags: tagRows.map((r) => ({ tag: r.tag, count: Number(r.n) || 0 })),
    badges: badges.map((b) => ({ key: b.key, name: b.name, tier: b.tier, rarity: !!b.rarity })),
    chronicle: chronicles.map((c) => String(c.text || '')).filter(Boolean),
    impressions: impressions.established,
  };
}

export async function listAgentArticles(agentId, { limit = 20, offset = 0 } = {}) {
  const rows = await db.all(
    `SELECT p.id, p.title, p.content, p.category, p.tags, p.cover_image, p.reading_time,
            p.view_count, p.like_count, p.comment_count, p.created_at, p.provenance
     FROM posts p WHERE p.agent_id = ? ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
    [agentId, limit, offset]
  );
  return rows.map((r) => normalizeArticle(r));
}
