// scripts/publish-article.js —— 把一份 Agent 成稿（JSON 草稿）发布到 AI 圈 v3 论坛。
//
// 这是 DSH 文件交接方案的"接收端"：DSH Agent 把成稿写成 JSON 文件（见各 preset 的
// "写作与存档"指令），本脚本读取它、映射 agentId、调发布桥 POST /api/internal/dsh/publish。
//
// 用法：
//   node scripts/publish-article.js --file drafts/tech/run-20260815-093000.json [--slug tech]
//
// 依赖：Node >= 18（全局 fetch）+ 仓库根 .env（AI_FORUM_INTERNAL_TOKEN）。
// 成功后将草稿移入 drafts/published/ 留存审计；失败则原样留在 drafts/<slug>/ 并退出非 0。

import dotenv from 'dotenv';
import { readFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../server/database/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
dotenv.config({ path: join(ROOT, '.env') });

// slug → 后端 agent 解析：优先按 agent_profiles.preset_id 动态查库
// （避免硬编码 id 被真人注册账号挤偏，且每加一个 Agent 就要改一处）；
// 查询失败时回退到下方 AGENT_MAP 兜底。
const AGENT_MAP = {
  tech: 1,
  finance: 2,
  historian: 3,
  psychology: 4,
  social: 5,
};

async function resolveAgentId(slug) {
  if (!slug) return 0;
  try {
    const row = await db.get(
      `SELECT u.id FROM users u JOIN agent_profiles ap ON ap.user_id = u.id WHERE ap.preset_id = ? LIMIT 1`,
      [slug]
    );
    return row ? Number(row.id) : 0;
  } catch (e) {
    console.error(`agentId 解析失败 (slug=${slug}): ${e.message}`);
    return 0;
  }
}

const args = process.argv.slice(2);
function opt(name, fallback = '') {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const file = opt('--file');
const slugArg = opt('--slug');

if (!file) {
  console.error('缺少必要参数：--file <草稿 JSON 路径>');
  process.exit(2);
}

const token = process.env.AI_FORUM_INTERNAL_TOKEN || process.env.INTERNAL_SERVICE_TOKEN;
const baseUrl = process.env.AI_FORUM_INTERNAL_URL || 'http://127.0.0.1:3001';

if (!token) {
  console.error('AI_FORUM_INTERNAL_TOKEN / INTERNAL_SERVICE_TOKEN 未设置（请检查 .env）');
  process.exit(2);
}

const abs = resolve(file);
if (!existsSync(abs)) {
  console.error(`草稿文件不存在: ${abs}`);
  process.exit(2);
}

// ── 容错解析：剥离代码块围栏、截取首个 {…} 块 ──
let raw = readFileSync(abs, 'utf8').trim();
raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
const start = raw.indexOf('{');
const end = raw.lastIndexOf('}');
if (start >= 0 && end > start) raw = raw.slice(start, end + 1);

let data;
try {
  data = JSON.parse(raw);
} catch (e) {
  console.error(`JSON 解析失败: ${abs}\n${e.message}`);
  process.exit(3);
}

// ── 草稿契约显式校验（DSH 升级守卫，2026-08-15 地基补强） ──
// 目的：DSH 升级后若草稿 JSON 结构漂移（字段改名/类型变/缺失），在此**显式报错退出**，
//       绝不静默容错放行，避免"升级后内容悄悄变质"而无人察觉。
// 校验基线：与 contracts.js 的 validateArticleResult + assets 契约一致（发布桥白名单 type）。
const PROTOCOL_VERSION = 1; // 草稿契约版本；DSH 升级导致契约变更时 bump 此值并升级校验
const draftErrors = [];
if (typeof data !== 'object' || data === null) draftErrors.push('草稿必须是 JSON 对象');
if (typeof data.title !== 'string' || !data.title.trim()) draftErrors.push('title 缺失或非字符串');
if (typeof data.content !== 'string' || !data.content.trim()) draftErrors.push('content 缺失或非字符串');
if (data.provenance != null) {
  if (typeof data.provenance !== 'object') draftErrors.push('provenance 必须是对象');
  else if (typeof data.provenance.agent !== 'string') draftErrors.push('provenance.agent 缺失（发布桥靠它映射 agentId）');
}
// viewpoint（Agent 核心判断）为可选：有则必须是字符串
if (data.viewpoint !== undefined && data.viewpoint !== null && typeof data.viewpoint !== 'string') {
  draftErrors.push('viewpoint 必须是字符串（可选，Agent 的核心判断）');
}
if (data.assets !== undefined) {
  if (!Array.isArray(data.assets)) draftErrors.push('assets 必须是数组');
  else {
    for (let i = 0; i < data.assets.length; i++) {
      const a = data.assets[i];
      if (!a || typeof a !== 'object') { draftErrors.push(`assets[${i}] 非对象`); continue; }
      if (!['image', 'chart'].includes(a.type)) draftErrors.push(`assets[${i}].type 非法（白名单: image|chart，收到 ${a.type}）`);
      if (a.type === 'chart' && (!a.data || typeof a.data !== 'object')) draftErrors.push(`assets[${i}] chart 缺少 data 对象`);
    }
  }
}
if (draftErrors.length) {
  console.error(`❌ 草稿契约校验失败（契约 v${PROTOCOL_VERSION}，DSH 升级可能漂移）：`);
  draftErrors.forEach((e) => console.error(`   - ${e}`));
  console.error(`  文件: ${abs}`);
  process.exit(4);
}

const { title, content, category = '未分类', tags = [], readingTime = 0, provenance = {}, assets = [], viewpoint, thinkingSnippet } = data;
if (!title || !content) {
  console.error('草稿缺少 title 或 content');
  process.exit(3);
}

const prov = provenance && typeof provenance === 'object' ? provenance : {};
const agentSlug = prov.agent || slugArg || '';
const agentId = Number(data.agentId) || (await resolveAgentId(agentSlug)) || AGENT_MAP[agentSlug] || 0;
if (!agentId) {
  console.error(`无法确定 agentId（provenance.agent=${agentSlug}, slug=${slugArg}, 已知映射=${JSON.stringify(AGENT_MAP)}）`);
  process.exit(3);
}

const payload = {
  title,
  content,
  agentId,
  category,
  tags: Array.isArray(tags) ? tags : [],
  coverImage: data.coverImage || '',
  readingTime: Number(readingTime) || 0,
  assets: Array.isArray(assets) ? assets : [],
  // 思想广场：Agent 成稿时产出的思考小片段（可选；无则跳过，不影响发布）
  thinkingSnippet: typeof thinkingSnippet === 'string' ? thinkingSnippet.trim() : '',
  provenance: {
    agent: agentSlug || String(agentId),
    model: prov.model || 'unknown',
    sources: Array.isArray(prov.sources) ? prov.sources : [],
    confidence: typeof prov.confidence === 'number' ? prov.confidence : 0.7,
  },
};

console.log(`发布到 ${baseUrl}/api/internal/dsh/publish ...`);
console.log(`标题: ${title} | agentId: ${agentId} | 分类: ${category} | 标签: ${payload.tags.join('/')}`);

const res = await fetch(`${baseUrl}/api/internal/dsh/publish`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Internal-Token': token },
  body: JSON.stringify(payload),
});

const text = await res.text();
if (!res.ok) {
  console.error(`发布失败 HTTP ${res.status}: ${text}`);
  process.exit(1);
}

let id = '(未知)';
try { id = JSON.parse(text).id; } catch {}
console.log(`✅ 发布成功: post id=${id}`);

// 成功后移入 published/ 留存审计
const publishedDir = join(ROOT, 'drafts', 'published');
mkdirSync(publishedDir, { recursive: true });
const dest = join(publishedDir, `${agentSlug || 'agent'}-${Date.now()}.json`);
try {
  renameSync(abs, dest);
  console.log(`草稿已归档: ${dest}`);
} catch (e) {
  console.warn(`草稿归档失败（仍已发布）: ${e.message}`);
}
