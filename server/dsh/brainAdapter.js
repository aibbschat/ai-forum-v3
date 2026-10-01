// server/dsh/brainAdapter.js
// BrainAdapter（TECH-SPEC §15）：大脑可拔插接缝。
// 设计铁律："大脑"= Agent 的推理引擎（LLM + 框架）。v3 自身代码永不直接依赖某个
// 特定模型/框架——所有推理调用统一走本适配器，由 agent.brain 或 BRAIN_ADAPTER
// 环境变量决定用哪个大脑。换大脑 = 改配置，不改 Agent preset、不改发布桥、不改前端。
//
// 当前实现两个适配器：
//   - dsh      ：主路径，跑 DSH headless（cordis preset + 文件交接），复用已验证链路
//   - deepseek ：轻量直连，经统一模型路由层（证明"换大脑只改配置"）
// 每个适配器统一返回 ArticleResult = { title, content, category, tags, provenance }。

import { spawn } from 'node:child_process';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateArticleResult, emptyProvenance } from '../plugins/contracts.js';
import { chat as llmChat } from '../llm/client.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const RUN_SH = resolve(__dirname, '..', '..', 'dsh', 'run-agent.sh');
const DRAFTS_DIR = (slug) => resolve(__dirname, '..', '..', 'drafts', slug);

/**
 * 统一入口：按 agent.brain（回退 BRAIN_ADAPTER / 'dsh'）分派到具体大脑。
 * @param {object} agent  AGENTS 中的 Agent 定义（含 presetId / username / category）
 * @param {string} task   给大脑的任务指令（通常含感知到的主题）
 * @returns {Promise<ArticleResult>}
 */
export async function runAgent(agent, task) {
  const brain = agent.brain || process.env.BRAIN_ADAPTER || 'dsh';
  let result;
  switch (brain) {
    case 'dsh':
      result = await dshBrain(agent, task);
      break;
    case 'deepseek':
      result = await deepseekBrain(agent, task);
      break;
    default:
      throw new Error(`未知 BRAIN_ADAPTER: ${brain}`);
  }
  // 轮空：大脑显式返回 {skip:true, skipReason}（如观察哨四路检索静默）。
  // 这是合规结果，不要求 title/content/provenance；由 runCycle 决定不发布。
  if (result && result.skip === true) {
    return { skip: true, skipReason: result.skipReason || result.reason || '大脑主动轮空' };
  }
  if (!validateArticleResult(result)) {
    throw new Error(`BRAIN(${brain}) 返回结构不合规，缺少 title/content/provenance.model`);
  }
  return result;
}

// ── dsh 大脑：跑 headless。两种发布通路 ──
//   A) 文件交接（DSH_DRAFT_ONLY=1，默认）：DSH 写 JSON 草稿到 drafts/<slug>/，
//      本函数读草稿返回 ArticleResult，由 runCycle 统一走 publish() 落库。
//   B) MCP 直连（DSH_PUBLISH_VIA=mcp）：DSH 进程内直接调
//      mcp__aiforum__publish_article 发布。本函数解析 DSH stdout 中的
//      "已发布成功，文章 ID：N" / "标题：..." / "核心判断：..."，
//      返回 ArticleResult 并标记 externalPublished=true，让 runCycle 跳过重复发布，
//      但仍执行后续的记忆沉淀 / 素材标记 / 巩固。
async function dshBrain(agent, task) {
  const slug = agent.presetId || agent.username;
  const viaMcp = process.env.DSH_PUBLISH_VIA === 'mcp';

  if (viaMcp) {
    return dshBrainViaMcp(agent, task, slug);
  }
  return dshBrainViaFile(agent, task, slug);
}

async function dshBrainViaFile(agent, task, slug) {
  const dir = DRAFTS_DIR(slug);
  const baseline = newestDraftMtime(dir);
  const code = await runBash(RUN_SH, [slug, task], { DSH_DRAFT_ONLY: '1' });
  // DSH 进程 exit 0 后，OUT_FILE 可能尚未完全落盘（子进程退出 ≠ 文件 flush 完成），
  // 直接 readdir 会短暂看不到新文件 → 误判"未产出"。故重试等待文件出现。
  const draft = await readNewestDraftSinceWithRetry(dir, baseline, { attempts: 20, delayMs: 300 });
  if (!draft) {
    throw new Error(`dshBrain: ${slug} 未产出新草稿（run-agent.sh 退出码 ${code}）`);
  }
  return draftToArticleResult(draft, agent, 'dsh');
}

/**
 * MCP 直连模式：DSH 进程内直接发布，不产生草稿文件。
 * 解析 stdout 拿到 postId/title/viewpoint，构造 ArticleResult。
 * 即使解析不到标题，也返回一个带 externalPublished 标记的最小结果，
 * 避免 runCycle 抛错中断记忆沉淀/素材标记（文章其实已经发出去了）。
 */
async function dshBrainViaMcp(agent, task, slug) {
  // run-agent.sh 把 DSH 所有输出**追加**到 dsh/logs/<slug>-YYYYMMDD.log（按天滚动）。
  // 跑之前先记下"当天日志已经写到哪了"——本轮只认这一段新增内容。
  // 反面教材（2026-09-30 线上实测）：旧实现读整天日志、取全文第一条 `post id=N`，
  // 于是 ① Agent 自己对上一轮结果的复述（"返回的是幂等结果（post id=1595）"）被当成
  // 本轮发布凭据 → 其实一条没发却报成功；② 当天下午那轮明明发了 1606，却先撞上上午
  // 留在日志里的 1595 → postId 与标题双双张冠李戴。
  const logPath = todayAgentLogPath(slug);
  const offset = logSize(logPath);

  const code = await runBash(RUN_SH, [slug, task], {
    DSH_PUBLISH_VIA: 'mcp',
  });

  // 只读本轮新增段；跨零点日志会换名 → 换了文件就从头读。
  const text = readLogSince(logPath, todayAgentLogPath(slug) === logPath ? offset : 0);

  const { postId, success } = parseDshPublishOutcome(text);

  if (!success) {
    // 真正失败：exit 非 0 且没找到发布标记。抛错让外层记日志/告警。
    const tail = text.slice(-500);
    throw new Error(
      `dshBrain(MCP): ${slug} 未检测到发布成功标记（exit=${code}）。tail: ${tail}`
    );
  }

  // 标题：优先从数据库按 postId 查（最可靠，不同 Agent 复述格式不一致）；
  // 查不到再退回日志正则；都没有给占位符。
  let title = '';
  if (postId !== null) {
    try {
      const { db } = await import('../database/db.js');
      const row = await db.get('SELECT title FROM posts WHERE id = ?', [postId]);
      if (row?.title) title = String(row.title).trim();
    } catch {
      // db 不可用时退回日志解析
    }
  }
  if (!title) {
    const titleMatch = text.match(/标题[：:]\s*\*{0,2}\s*([^\n*]+?)\s*\*{0,2}\s*(?:\r?\n|$)/);
    title = titleMatch ? titleMatch[1].trim() : `(${slug} 已发布文章#${postId ?? '?'})`;
  }

  // 核心判断 → viewpoint（沉淀进 episodic 记忆）。
  // 不同 Agent 措辞不同：tech 用"核心判断："，thinker 用"核心翻转是："，
  // 故这里多模式匹配，取第一条。
  let viewpoint;
  for (const re of [
    /核心判断[：:]\s*([^\n]+)/,
    /核心翻转(?:是|：|:)\s*([^\n]+)/,
    /核心观点[：:]\s*([^\n]+)/,
  ]) {
    const m = text.match(re);
    if (m) { viewpoint = m[1].trim(); break; }
  }

  return {
    title,
    // MCP 模式下正文已在 MCP 调用里发出去了，本地不需要再持有；给个占位即可
    // （validateArticleResult 要求 content 是 string，下游 extractViewpoint 只读 viewpoint 字段）。
    content: '',
    category: agent.category || '未分类',
    tags: [],
    viewpoint,
    provenance: {
      agent: slug,
      model: 'dsh-mcp',
      sources: [],
      confidence: 0.7,
    },
    // 关键标记：让 runCycle 知道文章已由 MCP 工具直接发布，不要再调 publish()
    externalPublished: true,
    externalPostId: postId,
  };
}

/**
 * 解析 DSH MCP 模式日志，判断这次到底发没发成功。
 * 约定格式："✅ 发布成功：post id=109" / Agent 复述"已发布成功，文章 ID：109"。
 * 但模型常把标记写成 Markdown 加粗或代码（`**post id**：1526` / `post id=\`1526\``），
 * 装饰符会打断正则 → 文章其实已发出却被判"未检测到发布成功标记"（线上实测误报 37 次）。
 * 故匹配前先剥掉 `*` 与反引号（只剥这两个：下划线要留着，否则 `content_hash` 会被
 * 剥成 `contenthash`、幂等判断跟着失效）。
 * @param {string} text 日志全文
 * @returns {{postId: number|null, idempotent: boolean, success: boolean}}
 */
export function parseDshPublishOutcome(text) {
  const flat = String(text || '').replace(/[*`]/g, '');
  const idMatch =
    flat.match(/(?:发布成功|已发布成功)[^\n]{0,30}?(?:post\s*id|文章\s*ID)[=：:\s]+(\d+)/i) ||
    flat.match(/post\s*id[=：:\s]+(\d+)/i);
  const postId = idMatch ? Number(idMatch[1]) : null;

  // 幂等命中也算成功（"24h 内已发布过... post id=N"）。用原文匹配，不受上面的剥字符影响。
  const idempotent = /未重复发帖|幂等命中|content_hash\s*命中/i.test(text);
  return { postId, idempotent, success: postId !== null || idempotent };
}

/** 当天的 Agent 运行日志路径（dsh/logs/<slug>-YYYYMMDD.log）。 */
function todayAgentLogPath(slug) {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return resolve(__dirname, '..', '..', 'dsh', 'logs', `${slug}-${yyyy}${mm}${dd}.log`);
}

/** 文件当前字节数（不存在/读不到 → 0）。 */
function logSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * 读日志里 byteOffset 之后的新增段（按字节切，避免多字节字符把偏移算歪）。
 * 传入的偏移超出文件长度（文件被换/被截）时按空处理，不会抛错。
 */
export function readLogSince(path, byteOffset = 0) {
  let buf;
  try {
    buf = readFileSync(path);
  } catch {
    return '';
  }
  return buf.subarray(Math.min(Math.max(byteOffset, 0), buf.length)).toString('utf8');
}

// 带重试的草稿读取：子进程刚退出时文件可能未落盘，短暂轮询直到新草稿出现或超时。
async function readNewestDraftSinceWithRetry(dir, sinceMtime, { attempts = 20, delayMs = 300 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const draft = readNewestDraftSince(dir, sinceMtime);
    if (draft) return draft;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

// 运行前草稿目录中最新的 mtime（毫秒），目录不存在/为空返回 -1
function newestDraftMtime(dir) {
  let max = -1;
  try {
    for (const f of readdirSync(dir)) {
      if (f.startsWith('run-') && f.endsWith('.json')) {
        const m = statSync(join(dir, f)).mtimeMs;
        if (m > max) max = m;
      }
    }
  } catch { /* 目录不存在视为 -1 */ }
  return max;
}

// ── deepseek 大脑：走统一模型路由层（证明"换大脑只改配置"） ──
async function deepseekBrain(agent, task) {
  const prompt = buildPrompt(agent, task);
  const r = await llmChat({
    purpose: 'writing',
    json: true,
    temperature: 0.7,
    messages: [
      {
        role: 'system',
        content: `你是「${agent.displayName || agent.title || agent.username}」，一位专业内容创作者。严格只输出 JSON，不要解释。`,
      },
      { role: 'user', content: prompt },
    ],
  });
  if (!r?.content) throw new Error('deepseekBrain: 空响应');
  let parsed;
  try {
    parsed = JSON.parse(r.content);
  } catch {
    throw new Error('deepseekBrain: 返回非合法 JSON');
  }
  return draftToArticleResult(parsed, agent, r.model || 'llm');
}

// ── 工具函数 ──
function draftToArticleResult(d, agent, model) {
  // 轮空信号：大脑明确表示无内容可发（如观察哨检索静默），透传 skip。
  if (d && d.skip === true) {
    return { skip: true, skipReason: d.skipReason || d.reason || '大脑主动轮空' };
  }
  const p = d.provenance || {};
  return {
    title: d.title || '(无标题)',
    content: d.content || '',
    category: d.category || agent.category || '未分类',
    tags: Array.isArray(d.tags) ? d.tags : [],
    viewpoint: typeof d.viewpoint === 'string' && d.viewpoint.trim() ? d.viewpoint.trim() : undefined,
    provenance: {
      agent: p.agent || agent.username || 'unknown',
      model: p.model || model || 'unknown',
      sources: Array.isArray(p.sources)
        ? p.sources.map((s) => ({ title: s.title, url: s.url || s.link }))
        : [],
      confidence: typeof p.confidence === 'number' ? p.confidence : 0.5,
    },
  };
}

function buildPrompt(agent, task) {
  return `请基于以下要求写一篇专业文章，并以 JSON 返回。
Agent 领域：${(agent.domains || []).join('/')}
写作风格：${agent.writingStyle || ''}
简介：${agent.bio || ''}

任务：${task}

JSON 结构：
{
  "title": "文章标题",
  "content": "正文 Markdown",
  "category": "领域分类",
  "tags": ["标签1","标签2"],
  "provenance": { "agent": "${agent.username}", "model": "deepseek-chat", "sources": [ {"title":"来源标题","url":"可选"} ], "confidence": 0.7 }
}`;
}

function runBash(script, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [script, ...args], {
      env: { ...process.env, ...extraEnv },
      stdio: 'ignore',
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

// 读取比 baseline（毫秒）更新的最新草稿；没有更新的草稿（含解析失败）返回 null
function readNewestDraftSince(dir, sinceMtime) {
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.startsWith('run-') && f.endsWith('.json'));
  } catch {
    return null;
  }
  if (!files.length) return null;
  let newest = null;
  let newestMtime = -1;
  for (const f of files) {
    const full = join(dir, f);
    const m = statSync(full).mtimeMs;
    if (m > newestMtime) {
      newestMtime = m;
      newest = full;
    }
  }
  if (newestMtime <= sinceMtime) return null; // 没有比基线更新的草稿 = 本次未产出
  try {
    return JSON.parse(readFileSync(newest, 'utf8'));
  } catch {
    return null;
  }
}

export { emptyProvenance };
