// server/services/agentCycle.js
// 沉淀契约闭环（TECH-SPEC §7.3 接缝④ / §7.2 成长闭环）：感知 → 大脑 → 写记忆 → 发布。
// 这是"活智能体"的单次运行入口；三个协作模块（感知层 / BrainAdapter / 记忆层）
// 在此汇合，把"一次 cron 生成"升级为"带记忆、可成长"的运行。
//
// 设计要点：
//   - 感知、大脑、记忆、发布均通过共享契约（server/plugins/contracts.js）对接，
//     任一可单独替换（换感知源 / 换大脑 / 换记忆后端）而不动本文件。
//   - 发布统一走 postService.publishArticle（单一发布通道），run-agent.sh 的
//     自动发布仅在独立 cron 模式生效；本闭环用 DSH_DRAFT_ONLY 取草稿后自行发布，
//     避免双重发布。

import { db } from '../database/db.js';

/** 解析 Agent 在库中的数值 id（posts.agent_id / memory_*.agent_id 用）。 */
async function resolveAgentId(agent) {
  const row = await db.get('SELECT user_id FROM agent_profiles WHERE preset_id = ?', [
    agent.presetId || agent.username,
  ]);
  return row?.user_id || null;
}

/**
 * 跑一次完整活智能体循环。
 * @param {object} agent         AGENTS 中的 Agent 定义
 * @param {object} [opts]
 * @param {Date}   [opts.date]   运行日期（传给感知层）
 * @param {Function} [opts.brainOverride]   注入自定义大脑（测试用）
 * @param {Function} [opts.publishOverride] 注入自定义发布（测试用，参数为 article, agentId）
 * @returns {Promise<{topics:number, article:ArticleResult, agentId:number|null, published:any}>}
 */
export async function runCycle(agent, { date = new Date(), brainOverride = null, publishOverride = null } = {}) {
  // ① 感知：让 Agent 知道世界今天发生了什么
  const { perceiveWorld } = await import('../services/perception/index.js');
  const { topics } = await perceiveWorld(agent, date);

  const agentId = await resolveAgentId(agent);
  const { writeEpisodic } = await import('../services/memory/index.js');

  // ② 素材入池：感知到的主题作为素材写进 episodic（source='perceive', status='pending'），
  //    持续积累——这就是"素材库"。本次感知不立即写，等素材饱和。
  if (agentId && topics.length) {
    const avgRel = topics.reduce((s, t) => s + (t.relevance || 0.5), 0) / topics.length;
    // 每条素材独立入库（而非合并一条），供素材池按条锁定/标记
    for (const t of topics) {
      // 素材内容：优先全文（fullText，感知层抓取），否则摘要（summary）
      // 2026-08-15：素材库要"够分析"，不能只给 280 字概括
      const body = t.fullText || t.summary || '';
      await writeEpisodic({
        agentId,
        content: `[${t.source}] ${t.title}${body ? '：' + body.slice(0, 2500) : ''}${t.url ? `（${t.url}）` : ''}`,
        source: 'perceive',
        importance: t.relevance ?? 0.5,
        status: 'pending', // 素材待用
      });
    }
    console.log(
      `[agentCycle] ${agent.presetId || agent.username} 感知素材入库 ${topics.length} 条（pending）`
    );
  }

  // ③ 素材饱和判断：待用素材达到阈值才写（"有把握再写"，否则只积累不产文）
  const { materialSaturation, lockMaterial, markMaterialUsed, materialPoolStats } =
    await import('../services/memory/index.js');
  const minCount = Number(process.env.MATERIAL_MIN_COUNT || 3);
  const minScore = Number(process.env.MATERIAL_MIN_SCORE || 1.5);
  const sat = agentId ? await materialSaturation(agentId, { minCount, minScore }) : { saturated: false };
  if (!sat.saturated) {
    console.log(
      `[agentCycle] ${agent.presetId || agent.username} 素材未饱和（${sat.count}条/分${sat.score.toFixed(1)}，需≥${minCount}条/≥${minScore}分），本轮只积累不写作`
    );
    return { topics: topics.length, saturated: false, article: null, agentId, published: null };
  }

  // ④ 锁定素材为本次写作依据（pending → locked）
  const lockedIds = agentId ? await lockMaterial(agentId, { count: 5 }) : [];
  console.log(`[agentCycle] ${agent.presetId || agent.username} 素材饱和，锁定 ${lockedIds.length} 条写作`);

  // ⑤ 大脑：带 recall（记忆）+ persona 写作，素材作为依据
  const task = await buildTask(agent, topics, agentId, lockedIds);
  const article = brainOverride
    ? await brainOverride(agent, task)
    : await (await import('../dsh/brainAdapter.js')).runAgent(agent, task);

  // ⑥ 记忆写入：成稿 + 理解沉淀（防重复：recall 时能看到"写过什么/怎么判断"）
  const { extractViewpoint } = await import('../plugins/contracts.js');
  if (agentId) {
    await writeEpisodic({
      agentId,
      content: `成稿: ${article.title}`,
      source: 'publish',
      importance: 0.8,
    });
    const viewpoint = extractViewpoint(article);
    if (viewpoint) {
      await writeEpisodic({
        agentId,
        content: `我对「${article.title}」的理解：${viewpoint}`,
        source: 'publish',
        importance: 0.95, // 判断类记忆重要性最高，参与 recall 排序最优先
      });
    }

    // ★ 巩固节流（2026-08-15 半环补全）：短期判断 → 长期语义理解。
    const consolidateEveryDays = Number(process.env.CONSOLIDATE_EVERY_DAYS || 7);
    try {
      const { maybeConsolidate } = await import('../services/memory/index.js');
      const consolidated = await maybeConsolidate(agentId, {
        consolidateEveryDays,
        days: consolidateEveryDays,
      });
      if (consolidated) {
        console.log(
          `[agentCycle] agent=${agent.presetId || agent.username} 巩固完成：` +
            `领域=${consolidated.domains} 沉淀=${consolidated.written.length}`
        );
      }
    } catch (e) {
      console.warn(`[agentCycle] 巩固失败（继续发布）: ${e?.message || e}`);
    }
  }

  // ⑦ 发布
  const published = publishOverride
    ? await publishOverride(article, agentId)
    : await publish(article, agentId);

  // ⑧ 发布成功后：标记素材已用（locked → used，防下篇重复引用同一批素材）
  if (agentId && lockedIds.length) {
    await markMaterialUsed(agentId, lockedIds);
    const stats = await materialPoolStats(agentId);
    console.log(`[agentCycle] ${agent.presetId || agent.username} 素材已标记 used，池状态:`, stats);
  }

  return { topics: topics.length, saturated: true, article, agentId, published };
}

async function buildTask(agent, topics, agentId, lockedIds = []) {
  const domain = (agent.domains || []).join('/');

  // ★ 素材库依据（P1-16）：锁定的素材（本次写作的真实依据）优先于当次 topics。
  //   素材是"积累到饱和"的（可能跨多次感知），比当次感知更充分。
  let materialBlock = '';
  if (agentId && lockedIds.length) {
    try {
      const { listMaterialPool } = await import('../services/memory/index.js');
      // 查回已锁定的素材内容
      const { db } = await import('../database/db.js');
      const rows = await db.all(
        `SELECT id, content FROM memory_episodic
          WHERE agent_id = ? AND id IN (${lockedIds.map(() => '?').join(',')})`,
        [agentId, ...lockedIds]
      );
      if (rows.length) {
        materialBlock =
          '\n\n## 你的素材库（这些是你近期积累、达到饱和的素材，写作应以它们为事实依据，深度分析而非复述）\n' +
          rows
            .map((r) => `- ${r.content.slice(0, 300)}`)
            .join('\n');
      }
    } catch (e) {
      console.warn(`[agentCycle] 素材读取失败: ${e?.message || e}`);
    }
  }

  // ★ 层2 recall（记忆进写作）：读取 Agent 的既有理解（semantic）+ 近期判断（episodic），
  //   让 Agent 带着"我上次怎么想"来面对今天的主题——观点从积累里长出来，而不是从指令里。
  let memoryBlock = '';
  if (agentId) {
    try {
      const { readMemory } = await import('../services/memory/index.js');
      const mem = await readMemory(agentId, { limit: 8 });
      const sems = (mem.semantic || []).slice(0, 5)
        .map((s) => `- [既有理解·${s.domain}] ${s.understanding}（置信 ${Math.round((s.confidence || 0) * 100)}%，${s.status === 'suspect' ? '存疑待核' : '已核验'}）`)
        .join('\n');
      const epis = (mem.episodic || []).slice(0, 5)
        .map((e) => `- [近期判断] ${e.content.slice(0, 120)}`)
        .join('\n');
      if (sems || epis) {
        memoryBlock = `\n\n## 你的记忆（写作前先回想，观点要在此基础上延续或修正，而非从零开始）\n${sems ? sems + '\n' : ''}${epis ? epis : ''}`;
      }
    } catch (e) {
      // recall 失败不阻塞写作（记忆是增强，不是前提）
      console.warn(`[agentCycle] recall 失败（继续写作）: ${e?.message || e}`);
    }
  }

  // ★ 层1 人格底色（2026-08-15）：把 Agent 的认知框架/立场/在意/看不惯拼进任务，
  //   让大脑带着"这个人是谁"来写作——观点从人格里长出来，而不是从模板里。
  const p = agent.persona || {};
  let personaBlock = '';
  if (p.worldview || p.stance || (p.cares && p.cares.length) || (p.dislikes && p.dislikes.length)) {
    const cares = (p.cares || []).map((c) => `  - ${c}`).join('\n');
    const dislikes = (p.dislikes || []).map((d) => `  - ${d}`).join('\n');
    personaBlock = `\n\n## 你是谁（这是你的人格底色，写作时观点从这长出来，不是空泛的立场表演）\n` +
      (p.worldview ? `世界观：${p.worldview}\n` : '') +
      (p.stance ? `立场：${p.stance}\n` : '') +
      (cares ? `你在意的事：\n${cares}\n` : '') +
      (dislikes ? `你看不惯的：\n${dislikes}` : '');
  }

  return `你是「${agent.displayName || agent.title || agent.username}」，一位有独立判断的专业内容创作者。${personaBlock}${materialBlock}${memoryBlock}\n\n请基于你的素材库写一篇专业文章。写作要求：\n1. 深入分析素材，形成你自己的判断（基于人格底色与记忆），不要复述素材、不要照搬来源结论。\n2. 用 1000-2500 字展开论证：现象 → 关键矛盾 → 证据 → 你的判断，论证要充分展开。\n3. 每个结论过三问：证据是什么？来源可靠吗？有反例吗？\n4. 区分事实 / 推断 / 猜测（猜测处明确标注）。\n5. 在成稿 JSON 中附 provenance（哪个 Agent / 哪个模型 / 引用了哪些素材来源 / 置信度）。\n6. 用 viewpoint 字段一句话写出你对这个话题的核心判断（会沉淀进你的记忆，成为下次写作的立场）。`;
}

async function publish(article, agentId) {
  if (!agentId) throw new Error('publish: 无法解析 agentId（agent_profiles 无对应 preset）');
  const { publishArticle } = await import('./postService.js');
  return publishArticle({
    title: article.title,
    content: article.content,
    agentId,
    category: article.category || '未分类',
    tags: article.tags || [],
    provenance: article.provenance,
  });
}
