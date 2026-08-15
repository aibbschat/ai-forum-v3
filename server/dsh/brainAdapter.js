// server/dsh/brainAdapter.js
// BrainAdapter（TECH-SPEC §15）：大脑可拔插接缝。
// 设计铁律："大脑"= Agent 的推理引擎（LLM + 框架）。v3 自身代码永不直接依赖某个
// 特定模型/框架——所有推理调用统一走本适配器，由 agent.brain 或 BRAIN_ADAPTER
// 环境变量决定用哪个大脑。换大脑 = 改配置，不改 Agent preset、不改发布桥、不改前端。
//
// 当前实现两个适配器：
//   - dsh      ：主路径，跑 DSH headless（cordis preset + 文件交接），复用已验证链路
//   - deepseek ：轻量直连 DeepSeek API，省一层框架依赖（证明"换大脑只改配置"）
// 每个适配器统一返回 ArticleResult = { title, content, category, tags, provenance }。

import { spawn } from 'node:child_process';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateArticleResult, emptyProvenance } from '../plugins/contracts.js';

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
async function dshBrain(agent, task) {
  const slug = agent.presetId || agent.username;
  const code = await runBash(RUN_SH, [slug, task], { DSH_DRAFT_ONLY: '1' });
  if (code !== 0) {
    throw new Error(`dshBrain: run-agent.sh(${slug}) 退出码 ${code}`);
  }
  const draft = readNewestDraft(DRAFTS_DIR(slug));
  if (!draft) {
    throw new Error(`dshBrain: ${slug} 未产出草稿（drafts/${slug}/run-*.json）`);
  }
  return draftToArticleResult(draft, agent, 'dsh');
}

// ── deepseek 大脑：直连 API，证明"换大脑只改配置" ──
async function deepseekBrain(agent, task) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('deepseekBrain: 缺少 DEEPSEEK_API_KEY');
  const prompt = buildPrompt(agent, task);
  const resp = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content: `你是「${agent.displayName || agent.title || agent.username}」，一位专业内容创作者。严格只输出 JSON，不要解释。`,
        },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.7,
    }),
  });
  if (!resp.ok) {
    throw new Error(`deepseekBrain: API ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content || '{}';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('deepseekBrain: 返回非合法 JSON');
  }
  const result = draftToArticleResult(parsed, agent, 'deepseek-chat');
  return result;
}

// ── 工具函数 ──
function draftToArticleResult(d, agent, model) {
  const p = d.provenance || {};
  return {
    title: d.title || '(无标题)',
    content: d.content || '',
    category: d.category || agent.category || '未分类',
    tags: Array.isArray(d.tags) ? d.tags : [],
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

function readNewestDraft(dir) {
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
  if (!newest) return null;
  try {
    return JSON.parse(readFileSync(newest, 'utf8'));
  } catch {
    return null;
  }
}

export { emptyProvenance };
