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

  // ② 大脑：把感知到的主题写成专业文章（默认 BrainAdapter；可注入覆盖）
  //    先解析 agentId 供 recall（记忆进写作）使用
  const agentId = await resolveAgentId(agent);
  const article = brainOverride
    ? await brainOverride(agent, buildTask(agent, topics, agentId))
    : await (await import('../dsh/brainAdapter.js')).runAgent(agent, buildTask(agent, topics, agentId));

  // ③ 记忆写入：本次"读过什么 / 怎么理解 / 写了什么"落库（episodic），让 Agent 越来越懂世界
  const { writeEpisodic } = await import('../services/memory/index.js');
  const { extractViewpoint } = await import('../plugins/contracts.js');
  if (agentId) {
    const avgRel = topics.length
      ? topics.reduce((s, t) => s + (t.relevance || 0.5), 0) / topics.length
      : 0.5;
    await writeEpisodic({
      agentId,
      content: `感知主题(${topics.length}): ${topics.map((t) => t.title).join('; ')}`,
      source: 'perceive',
      importance: Math.min(1, avgRel),
    });
    await writeEpisodic({
      agentId,
      content: `成稿: ${article.title}`,
      source: 'publish',
      importance: 0.8,
    });
    // ★ 理解沉淀（活智能体关键一环）：把 Agent 的判断/观点写进记忆，
    //   下次 recall 时能读到"我上次怎么想"，观点才能演化。来源仍是 publish，
    //   但内容是"判断"而非"标题"——记忆从"运行日志"升级为"理解积累"。
    const viewpoint = extractViewpoint(article);
    if (viewpoint) {
      await writeEpisodic({
        agentId,
        content: `我对「${article.title}」的理解：${viewpoint}`,
        source: 'publish',
        importance: 0.95, // 判断类记忆重要性最高，参与 recall 排序最优先
      });
    }
  }

  // ④ 发布：统一走 postService（单一发布通道）
  const published = publishOverride
    ? await publishOverride(article, agentId)
    : await publish(article, agentId);

  return { topics: topics.length, article, agentId, published };
}

async function buildTask(agent, topics, agentId) {
  const lines = topics
    .map(
      (t) =>
        `- ${t.title}（来源：${t.source}，相关性 ${t.relevance}）${
          t.summary ? '：' + t.summary : ''
        }`
    )
    .join('\n');
  const domain = (agent.domains || []).join('/');

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

  return `你是「${agent.displayName || agent.title || agent.username}」，一位有独立判断的专业内容创作者。${memoryBlock}\n\n今日感知到以下主题，请择一撰写一篇专业文章：\n${lines}\n\n要求：\n1. 选题贴合你的领域（${domain}），引用真实来源。\n2. 文章要有你自己的判断与立场（基于你的记忆与视角），不要只罗列事实。\n3. 在成稿 JSON 中附 provenance（哪个 Agent / 哪个模型 / 引用了哪些来源 / 置信度）。\n4. 可选：用 viewpoint 字段一句话写出你对这个话题的核心判断（若有则最优先沉淀进记忆）。`;
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
