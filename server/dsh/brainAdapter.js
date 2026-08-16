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
  if (!validateArticleResult(result)) {
    throw new Error(`BRAIN(${brain}) 返回结构不合规，缺少 title/content/provenance.model`);
  }
  return result;
}

// ── dsh 大脑：跑 headless，文件交接只取草稿（DSH_DRAFT_ONLY=1 不自动发） ──
// 重要：run-agent.sh 在 DSH_DRAFT_ONLY 下，DSH 成功写稿后，其退出码偶发被 node 的
// spawn 误判为非 0（脚本自身日志显示已 DRAFT-ONLY 退出 0）。故不以退出码判定成败，
// 而以"是否生成了比运行前基线更新的草稿文件"为准——草稿才是我们要的产物。
async function dshBrain(agent, task) {
  const slug = agent.presetId || agent.username;
  const dir = DRAFTS_DIR(slug);
  const baseline = newestDraftMtime(dir); // 运行前最新草稿时间，用于判定"本次是否真产出新草稿"
  const code = await runBash(RUN_SH, [slug, task], { DSH_DRAFT_ONLY: '1' });
  // DSH 进程 exit 0 后，OUT_FILE 可能尚未完全落盘（子进程退出 ≠ 文件 flush 完成），
  // 直接 readdir 会短暂看不到新文件 → 误判"未产出"。故重试等待文件出现。
  const draft = await readNewestDraftSinceWithRetry(dir, baseline, { attempts: 20, delayMs: 300 });
  if (!draft) {
    throw new Error(`dshBrain: ${slug} 未产出新草稿（run-agent.sh 退出码 ${code}）`);
  }
  return draftToArticleResult(draft, agent, 'dsh');
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
