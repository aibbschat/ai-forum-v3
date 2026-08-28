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
import { filterSourcesByKnownUrls, stripStructurallyFakeSources } from '../../scripts/lib/source-verify.js';

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
  const { writeEpisodic, materialExists } = await import('../services/memory/index.js');

  // ② 素材入池：感知到的主题作为素材写进 episodic（source='perceive', status='pending'），
  //    持续积累——这就是"素材库"。本次感知不立即写，等素材饱和。
  if (agentId && topics.length) {
    let inserted = 0;
    let skipped = 0;
    const seenThisRun = new Set(); // 本轮内也去重（web_search 与 seed 可能撞题）
    // 每条素材独立入库（而非合并一条），供素材池按条锁定/标记
    for (const t of topics) {
      // 本轮内同标题跳过
      const titleKey = String(t.title || '').trim().slice(0, 40);
      if (titleKey && seenThisRun.has(titleKey)) {
        skipped++;
        continue;
      }
      // 素材内容：优先全文（fullText，感知层抓取），否则摘要（summary）
      // 2026-08-15：素材库要"够分析"，不能只给 280 字概括
      const body = t.fullText || t.summary || '';
      const content = `[${t.source}] ${t.title}${body ? '：' + body.slice(0, 2500) : ''}${t.url ? `（${t.url}）` : ''}`;
      // 跨轮去重：静态 seed 主题每轮都会被重新感知，若已在素材池（任意状态）
      // 或近期已写过，就不再重复入库——否则同一选题会被反复写作（见历史考据官重复事件）。
      if (await materialExists(agentId, content, { withinDays: 30 })) {
        skipped++;
        if (titleKey) seenThisRun.add(titleKey);
        continue;
      }
      await writeEpisodic({
        agentId,
        content,
        source: 'perceive',
        importance: t.relevance ?? 0.5,
        status: 'pending', // 素材待用
      });
      inserted++;
      if (titleKey) seenThisRun.add(titleKey);
    }
    console.log(
      `[agentCycle] ${agent.presetId || agent.username} 感知素材入库 ${inserted} 条（跳过重复 ${skipped} 条）`
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
  //    只锁与本次感知选题同主题的素材（防跨话题串台：上周百花奖不得进入今日书展文）
  const topicTitles = (topics || []).map((t) => t.title || '').filter(Boolean);
  const lockedIds = agentId ? await lockMaterial(agentId, { count: 5, topics: topicTitles }) : [];
  console.log(`[agentCycle] ${agent.presetId || agent.username} 素材饱和，锁定 ${lockedIds.length} 条写作`);
  if (!lockedIds.length) {
    console.log(
      `[agentCycle] ${agent.presetId || agent.username} 池内无与本次选题同主题的素材，本轮只积累不写作（防串台）`
    );
    return { topics: topics.length, saturated: true, article: null, agentId, published: null };
  }

  // ⑤ 大脑：带 recall（记忆）+ persona 写作，素材作为依据
  const task = await buildTask(agent, topics, agentId, lockedIds);
  const article = brainOverride
    ? await brainOverride(agent, task)
    : await (await import('../dsh/brainAdapter.js')).runAgent(agent, task);

  // ⑤.5 轮空检测：大脑判断"无信号/无话可说"时不发布（如观察哨四路检索静默）。
  //     历史 bug：观察哨把"没有信号"本身写成元评论发出（article/33）。
  const { detectSkip } = await import('../plugins/contracts.js');
  const skip = detectSkip(article);
  if (skip.skip) {
    console.log(
      `[agentCycle] ${agent.presetId || agent.username} 本轮轮空不发布：${skip.reason}`
    );
    // 锁定的素材标记已用，避免下一轮用同一批"空素材"反复触发空稿。
    if (agentId && lockedIds.length) {
      await markMaterialUsed(agentId, lockedIds);
    }
    return { topics: topics.length, saturated: true, article: null, skipped: true, reason: skip.reason, agentId, published: null };
  }

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
    // 2026-08-19 改为非阻塞：巩固会对每个 domain 串行调 LLM（单次最长 30s，
    // domain 多时累计数分钟），await 它会把发稿拖到超时。巩固与本次发稿无数据依赖，
    // 故 fire-and-forget，在后台跑，绝不阻塞发布；所有异常在后台内部消化。
    const consolidateEveryDays = Number(process.env.CONSOLIDATE_EVERY_DAYS || 7);
    (async () => {
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
        console.warn(`[agentCycle] 巩固失败（后台，不影响发布）: ${e?.message || e}`);
      }
    })();
  }

  // ⑦ 发布
  // MCP 直连模式下文章已由 DSH 进程内 mcp__aiforum__publish_article 直接发布，
  // article.externalPublished=true 标记这一点；此时跳过 publish()，避免双重发布，
  // 但记忆写入（⑥）和素材标记（⑧）仍正常执行——这正是文件交接模式做不到的闭环。
  //
  // ★ 来源归属校验（2026-08-28 假新闻根治·第三层）：无论走 MCP 还是本地 publish，
  //   发布前都用本次锁定素材（web_search 真实取稿）的 URL 集合过滤 provenance.sources——
  //   凡 url 不在本次取稿结果里的，一律剔除（LLM 凭记忆"发明"的任何 URL 都进不了库）。
  //   先结构剔除（占位/假ID），再归属校验（必须来自本次取稿）。
  if (article && article.provenance && Array.isArray(article.provenance.sources)) {
    try {
      let knownUrls = new Set();
      if (agentId && lockedIds && lockedIds.length) {
        const { db: db2 } = await import('../database/db.js');
        const rows = await db2.all(
          `SELECT content FROM memory_episodic
            WHERE agent_id = ? AND id IN (${lockedIds.map(() => '?').join(',')})`,
          [agentId, ...lockedIds]
        );
        // 素材 content 形如 "[perceive] 标题：摘要（https://real.url）"——提取其中的真实 URL
        const urlRe = /https?:\/\/[^\s）)】\]]+/g;
        for (const r of rows) {
          const text = r?.content || '';
          const m = text.match(urlRe);
          if (m) m.forEach((u) => knownUrls.add(u.replace(/\/+$/, '')));
        }
      }
      let cleaned = stripStructurallyFakeSources(article.provenance.sources);
      cleaned = filterSourcesByKnownUrls(cleaned, knownUrls);
      article.provenance = { ...article.provenance, sources: cleaned };
      if (knownUrls.size > 0 && cleaned.length < article.provenance.sources.length) {
        console.log(
          `[agentCycle] ${agent.presetId || agent.username} 来源归属校验：剔除 ${article.provenance.sources.length - cleaned.length} 条非取稿来源（LLM 编造）`
        );
      }
    } catch (e) {
      console.warn(`[agentCycle] 来源归属校验失败（跳过，不阻塞发布）: ${e?.message || e}`);
    }
  }

  let published;
  if (article.externalPublished) {
    published = { id: article.externalPostId ?? null, viaMcp: true };
    console.log(
      `[agentCycle] ${agent.presetId || agent.username} 文章已由 MCP 直接发布（postId=${published.id}），跳过重复发布`
    );
  } else {
    published = publishOverride
      ? await publishOverride(article, agentId)
      : await publish(article, agentId, agent);
  }

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

  // ★ 主题聚焦（2026-08-16）：硬约束 Agent 只打一个核心议题，
  //   禁止把素材库里多条无关素材 / web 撞到的热点强行串成"现象蒙太奇"。
  //   本体层 Agent（有 taskBrief）不适用单议题约束（如观察哨本就要跨领域扫描），
  //   只保留"不硬凑关联"的底线。
  const focusBlock = agent.taskBrief
    ? `\n\n## 底线（硬约束）\n栏目形态按你的写作要求执行，但任何关联与归纳必须有素材或逻辑支撑，禁止硬凑"现象蒙太奇"；无话可说处坦诚说无，不注水。`
    : `\n\n## 主题聚焦（硬约束，先于一切发散）\n本文只打【一个】核心议题。素材库可能有多条素材，但只取与本次选题有【直接因果 / 论证关系】的一条主线展开；其余素材要么不提、要么仅一笔带过，严禁把无关事件、人物、数据强行串成一篇"现象蒙太奇"。标题即承诺——正文必须兑现标题承诺的具体议题，不得借题发挥漂移；即使 web 检索撞到别的热点，也只取与本文选题强相关者，其余忽略。`;

  // ★ 本体层 Agents（AI 之眼/观察哨/思维漫游）用 agent.taskBrief 覆盖默认写作要求：
  //   它们的文章形态（信号简报/思想实验）与"1000-2500 字论证"的通用模板不同，
  //   人格/素材/记忆/聚焦块仍然注入，保证闭环一致。
  const writingBrief = agent.taskBrief
    ? `\n\n请按你的人格与栏目定位产出本轮内容。写作要求：\n${agent.taskBrief}`
    : `\n\n请基于你的素材库写一篇专业文章。写作要求：\n1. 深入分析素材，形成你自己的判断（基于人格底色与记忆），不要复述素材、不要照搬来源结论。\n2. 用 1000-2500 字展开论证：现象 → 关键矛盾 → 证据 → 你的判断，论证要充分展开。\n3. 每个结论过三问：证据是什么？来源可靠吗？有反例吗？\n4. 区分事实 / 推断 / 猜测（猜测处明确标注）。\n5. 在成稿 JSON 中附 provenance（哪个 Agent / 哪个模型 / 引用了哪些素材来源 / 置信度）。\n6. 用 viewpoint 字段一句话写出你对这个话题的核心判断（会沉淀进你的记忆，成为下次写作的立场）。\n7. 写稿时若想引入新事件 / 人物 / 数据 / 行业动态，先自问"它和本文核心议题有直接的因果或论证关系吗？"答不上来就不写——宁可篇幅短、聚焦深，不要铺陈广。`;

  return `你是「${agent.displayName || agent.title || agent.username}」，一位有独立判断的专业内容创作者。${personaBlock}${materialBlock}${memoryBlock}${focusBlock}${writingBrief}`;
}

async function publish(article, agentId, agent = null) {
  if (!agentId) throw new Error('publish: 无法解析 agentId（agent_profiles 无对应 preset）');
  const { publishArticle } = await import('./postService.js');
  // 自动配图：发布管道确定性调用生图后端（dsh-eye 配置的同款端点）。
  // 有 Key 则生成真实封面 URL；无 Key / 失败 → undefined，由 postService.autoAssets 回落 SVG。
  let coverImage;
  try {
    const { generateCover } = await import('../services/imageGenService.js');
    coverImage = await generateCover(article);
  } catch (e) {
    console.warn(`[agentCycle] 生图失败（继续发布）: ${e?.message || e}`);
    coverImage = undefined;
  }
  // ★ 分类以 AGENTS 注册值为准（2026-08-16）：DSH 输出 JSON 时 category 偶发漂移
  //   （如观察哨写成"科技"），专栏归属是产品语义，不能依赖模型自觉。
  const category = agent?.category || article.category || '未分类';
  if (article.category && agent?.category && article.category !== agent.category) {
    console.warn(`[agentCycle] category 以 Agent 注册值为准：草稿「${article.category}」→「${agent.category}」`);
  }
  return publishArticle({
    title: article.title,
    content: article.content,
    agentId,
    category,
    tags: article.tags || [],
    coverImage: coverImage || undefined,
    provenance: article.provenance,
  });
}
