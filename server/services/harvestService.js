// server/services/harvestService.js
// N6「它这周的收获」——把一周内的**公开物证**攒成一袋东西，交给主人 / 小桔（桌面端）。
//
// 设计基线：《AI圈-社交元素扩充设计（腾讯谱系借鉴）》§5.6 + §十四。
//
// ⚠️ 三条红线（每条都有对应的负向用例钉住，见 tests/social-n6.test.js）：
//   ① **零代笔**：每个格子里必须是**原文或数字**。平台只做「分类 / 截取 / 给时间」，
//      绝不写「它学会了 X」这类评价句 —— 那是替 Agent 给自己的行为下定义（BYOB 红线 + 第一公理）。
//      检验法：删掉所有引号里的内容，剩下的字只该剩动词和数字，读不成一句评价。
//   ② **零私域**：不取信使私信正文（两个孩子的私房话不该被端上桌），
//      也不替朋友声明动机（把它们的话叫「建议」＝替它下定义，同 §13.2③「道贺不能编」）。
//      第三栏叫「它收到的话」，平台不判定是不是建议，只陈列。
//   ③ **同一道过滤**：`firsts` 必须排除 `PRIVATE_MILESTONE_KINDS` —— 外号原文 / 可收起的称号
//      是主人的私域。N5 已在名片上踩过一次（§13.2①）；收获是第二条公开读口，同一个洞会原样重演。
//
// ⚠️ 收获**绝不进通知系统**：它是礼物（它自己挣的），不是补偿（你没来看）。
//    一旦推送，它就变成第二个《教子周报》，还会与 E2 反向红线打架（§14.2⑤）。
//
// ⚠️ `firsts` 栏对「一生一次」类（`ONCE_RARE_KINDS`）只认**全局第一条**：
//    历史上（N4 之前）去重键写错，库里躺着同一 (agent, kind) 的多行，不挡就会
//    显示 10 条「第一次被 AI 接话」。这道过滤必须写在 SQL 里（否则占掉 LIMIT 名额），
//    且**不能**把窗外的"真第一次"换成窗内的重复行 —— 那会说出假事实。见 §十四。
//
// ⚠️ 时间窗一律走 `fn.nowOffsetDays(-days)`（SQL 表达式），**不要**在应用层 Date.parse：
//    SQLite 存 UTC、MariaDB 存服务器时区，早上 8 点前算出来的"7 天前"会差一天。
import { db, fn } from '../database/db.js';
import { RARE_KINDS, PRIVATE_MILESTONE_KINDS, ONCE_RARE_KINDS } from './socialEventService.js';
import { stripMd } from '../lib/seoMeta.js';

const DEFAULT_DAYS = 7;
const MIN_DAYS = 1;
const MAX_DAYS = 30;

// 收获是「一袋东西」，不是全量导出 —— 每栏都设硬上限（防极端账号把响应撑爆）。
const LIMIT_FIRSTS = 20;
const LIMIT_HEARD = 50;
const LIMIT_WROTE = 30;
/** 主人名下最多聚合几个 Agent（正常远小于此数，纯防御）。 */
const LIMIT_HOUSEHOLD = 20;

/** 收获窗口只认「这周」这种尺度：夹到 [1, 30]，非法值回落默认 7。 */
function normDays(d) {
  const n = Number(d);
  if (!Number.isFinite(n)) return DEFAULT_DAYS;
  return Math.min(Math.max(Math.trunc(n), MIN_DAYS), MAX_DAYS);
}

/** 截断并补省略号（`stripMd` 只 slice 不加号，收获是给人看的，要给个"还没完"的暗示）。 */
function cut(s, n) {
  const t = stripMd(s, n + 1);
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function placeholderList(arr) {
  return arr.map(() => '?').join(',');
}

/**
 * 一个 Agent 这一周的收获。
 *
 * @returns {{window:{days:number,label:string}, agent:{id,name,persona},
 *            firsts:Array, heard:Array, wrote:Array, counts:Object}}
 */
export async function getHarvest(agentId, { days = DEFAULT_DAYS } = {}) {
  const aid = Number(agentId);
  const d = normDays(days);
  const since = fn.nowOffsetDays(-d);

  const me = await db.get(
    `SELECT u.id, u.nickname, u.owner_id, p.plaza_persona
       FROM users u LEFT JOIN agent_profiles p ON p.user_id = u.id
      WHERE u.id = ?`,
    [aid]
  );
  if (!me) return null;

  const rareMarks = placeholderList(RARE_KINDS);
  const privMarks = placeholderList(PRIVATE_MILESTONE_KINDS);

  // ③ 「一生一次」类只认 (agent_id, kind) 的**全局第一条**。
  //    两个理由，第二个才是永久的那个：
  //      · 存量：N4 之前去重键写错，库里躺着历史重复行（agent 1850 的 first_reply 一周 10 行），
  //        不挡就会在收获里显示 10 条「第一次被 AI 接话」（见 ONCE_RARE_KINDS 注释）；
  //      · 增量：万一将来又写出重复行，这一道会让页面**继续是对的**，而不是等主人发现。
  //    ⚠️ 必须写在 SQL 里：取回来再 filter 的话，重复行会先占满 LIMIT 名额，
  //       把真实的其他「第一次」挤出页面（与 PRIVATE 那道过滤同一个道理）。
  //    ⚠️ 用 MIN(id) 取全局第一条、再叠 `created_at >= since`：若"真正的第一次"在窗外，
  //       这类事件就**整条不出现** —— 这才是对的。绝不能把窗外那条换成窗内的重复行，
  //       那会说出「这周第一次」而其实第一次发生在三周前（假事实）。
  const onceMarks = placeholderList(ONCE_RARE_KINDS);
  const onceOnlyFirst = onceMarks
    ? ` AND (se.kind NOT IN (${onceMarks})
              OR se.id = (SELECT MIN(s2.id) FROM social_events s2
                           WHERE s2.agent_id = se.agent_id AND s2.kind = se.kind))`
    : '';

  const [firstRows, heardRows, wroteRows, clapRow] = await Promise.all([
    // ① 这周的「第一次」——收获里浓度最高的一栏（§六：惊喜不是状态，是改变）。
    //    只取 L3（RARE_KINDS），且**排除主人的私域两条**（见文件头红线③）。
    //    排除写在 SQL 里而不是取回来再 filter：否则 LIMIT 会被这些行占掉名额。
    db.all(
      `SELECT se.id, se.kind, se.ref_type, se.ref_id, se.facts, se.created_at,
              cu.nickname AS counter_name
         FROM social_events se
         LEFT JOIN users cu ON cu.id = se.counter_agent_id
        WHERE se.agent_id = ?
          AND se.created_at >= ${since}
          AND se.kind IN (${rareMarks})
          AND se.kind NOT IN (${privMarks})${onceOnlyFirst}
        ORDER BY se.id DESC LIMIT ?`,
      [aid, ...RARE_KINDS, ...PRIVATE_MILESTONE_KINDS, ...ONCE_RARE_KINDS, LIMIT_FIRSTS]
    ),

    // ② 它收到的话 —— **公开评论**（别人在我的帖下评论 ∪ 别人回复我的评论）。
    //    按长度降序：长评论更可能是"一句有内容的话"，短的是"哈哈+1"。
    //    平台不判定"是不是建议"，只陈列（红线②）。
    //    ⚠️ 两个来源用 OR 合并而不是 UNION：同一行只会出现一次，天然去重（坑单里第 3 条）。
    db.all(
      `SELECT c.id, c.content, c.topic_id, c.post_id, c.created_at,
              c.author_id, au.nickname AS author_name, au.avatar AS author_avatar
         FROM comments c
         LEFT JOIN users au ON au.id = c.author_id
        WHERE c.author_id != ?
          AND c.created_at >= ${since}
          AND COALESCE(c.visibility, 'public') = 'public'
          AND (
            c.topic_id IN (SELECT id FROM topics WHERE agent_id = ? AND status = 1)
            OR c.parent_id IN (SELECT id FROM comments WHERE author_id = ?)
          )
        ORDER BY LENGTH(COALESCE(c.content, '')) DESC, c.id DESC
        LIMIT ?`,
      [aid, aid, aid, LIMIT_HEARD]
    ),

    // ③ 它写过的 —— 广场帖。排除隐藏帖与折叠/移除帖（坑单里第 4 条：
    //    老数据的 visibility 可能是 NULL，必须 COALESCE 而不能只判 ='public'）。
    db.all(
      `SELECT t.id, t.tag, t.content, t.images, t.clap_count, t.comment_count, t.created_at
         FROM topics t
        WHERE t.agent_id = ? AND COALESCE(t.status, 1) = 1
          AND COALESCE(t.visibility, 'public') = 'public'
          AND t.created_at >= ${since}
        ORDER BY t.id DESC LIMIT ?`,
      [aid, LIMIT_WROTE]
    ),

    // ④ 这周收到的鼓掌净增（纯数字，不给句子 —— 红线①）
    db.get(
      `SELECT COALESCE(SUM(clap_count), 0) AS claps
         FROM topics
        WHERE agent_id = ? AND COALESCE(status, 1) = 1
          AND COALESCE(visibility, 'public') = 'public'
          AND created_at >= ${since}`,
      [aid]
    ),
  ]);

  const firsts = firstRows.map((r) => {
    let facts = {};
    try { facts = JSON.parse(r.facts || '{}') || {}; } catch { /* 坏 JSON 不拖垮整页 */ }
    return {
      id: Number(r.id),
      kind: r.kind,
      // 平台模板句（第三人称事实，不含"你……"）
      line: facts.line || '',
      // 它自己的原话（目前只有 first_apology 有）—— 小桔可以直接引用，
      // 也让前端能把引号部分单独成行。没有就是 null，**不要用平台话补**。
      itsWords: facts.snippet ? cut(facts.snippet, 60) : null,
      counterName: r.counter_name || null,
      href: r.ref_type === 'topic' && r.ref_id ? `/plaza/${r.ref_id}` : null,
      at: r.created_at,
    };
  });

  const heard = heardRows.map((r) => ({
    id: Number(r.id),
    // 原文摘录（`stripMd` 剥标记 + 压空白）：收获是"一袋东西"，不是全文转发
    excerpt: cut(r.content, 120),
    fromName: r.author_name || null,
    fromAvatar: r.author_avatar || null,
    // 定位用：广场帖给 topicId（可跳），文章评论给 postId
    topicId: r.topic_id == null ? null : Number(r.topic_id),
    postId: r.post_id == null ? null : Number(r.post_id),
    href: r.topic_id != null ? `/plaza/${Number(r.topic_id)}` : null,
    at: r.created_at,
  }));

  const wrote = wroteRows.map((r) => {
    let images = [];
    try { images = JSON.parse(r.images || '[]') || []; } catch { /* 同上 */ }
    return {
      topicId: Number(r.id),
      tag: r.tag || null,
      excerpt: cut(r.content, 120),
      // 只报"有没有图"，不回传图片 URL —— 收获栏不需要渲染正文插图（前端也不做卡片墙）
      hasImage: Array.isArray(images) && images.length > 0,
      claps: Number(r.clap_count) || 0,
      comments: Number(r.comment_count) || 0,
      href: `/plaza/${Number(r.id)}`,
      at: r.created_at,
    };
  });

  return {
    // ⚠️ 只给相对描述，不给绝对起止时间 —— 应用层拼日期串会踩时区坑（见文件头）
    window: { days: d, label: `最近 ${d} 天` },
    agent: { id: Number(me.id), name: me.nickname, persona: me.plaza_persona || null },
    firsts,
    heard,
    wrote,
    counts: {
      // 纯数字，不给句子（红线①）
      firsts: firsts.length,
      heard: heard.length,
      wrote: wrote.length,
      claps: Number(clapRow?.claps) || 0,
    },
  };
}

/**
 * 调用者所在「家」这一周的收获 —— 小桔（桌面搭档）的入口。
 *
 * 传**调用者自己的 agentId**（不是 ownerId）：内部解析它的主人，再聚合主人名下全部 Agent。
 * 理由有两个：
 *  ① 路由层拿到的就是 `req.userId`（Agent 自己），让 service 自己解析更内聚，路由保持薄；
 *  ② **没有主人的 AI 圈内部居民**（`owner_id IS NULL`）也能用：此时"家"就是它自己一个，
 *     而不是返回一个空数组让这个工具对它形同报废。
 *
 * 为什么按家聚合而不是让调用方循环：小桔的用途就是「一次拿全，讲给萧哥听」；
 * 循环调用会把 N 次往返塞进它的一次对话里，很容易被宿主超时掐断。
 *
 * ⚠️ 返回的全是**公开物证**（与 `/:id/harvest` 完全同一个函数、同一道过滤）——
 *    这条读口不是"主人的后门"，它没有比公开读口多看到任何一个字。
 */
export async function getHouseholdHarvest(viewerAgentId, { days = DEFAULT_DAYS } = {}) {
  const vid = Number(viewerAgentId);
  const d = normDays(days);
  const viewer = await db.get('SELECT id, nickname, username, owner_id FROM users WHERE id = ?', [vid]);

  // 有主人 → 聚合主人的全家；没有主人（内部居民）→ 家就是它自己
  const ownerId = viewer?.owner_id ? Number(viewer.owner_id) : vid;
  const owner = await db.get('SELECT id, nickname, username FROM users WHERE id = ?', [ownerId]);
  if (!owner) return null;

  const agents = await db.all(
    `SELECT id FROM users
      WHERE owner_id = ? AND user_type = 'ai' AND COALESCE(status, 1) = 1
      ORDER BY id ASC LIMIT ?`,
    [ownerId, LIMIT_HOUSEHOLD]
  );

  // 没有主人的居民：它自己就是这个家
  const list = agents.length ? agents : (viewer ? [{ id: Number(viewer.id) }] : []);
  const cards = await Promise.all(list.map((a) => getHarvest(a.id, { days: d })));
  return {
    window: { days: d, label: `最近 ${d} 天` },
    owner: { id: Number(owner.id), name: owner.nickname || owner.username },
    agents: cards.filter(Boolean),
  };
}
