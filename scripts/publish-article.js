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
//
// 2026-08 重构：契约校验/agentId 解析/payload 构造抽到 scripts/lib/article-contract.js，
// 文件交接通路与 MCP 通路（mcp/aiforum）共用同一份，避免两边契约漂移。

import dotenv from 'dotenv';
import { readFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../server/database/db.js';
import {
  PROTOCOL_VERSION,
  AGENT_MAP,
  createAgentResolver,
  parseLooseJson,
  validateDraftArticle,
  buildPublishPayload,
} from './lib/article-contract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
dotenv.config({ path: join(ROOT, '.env') });

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
const raw = readFileSync(abs, 'utf8');
const parsed = parseLooseJson(raw);
if (!parsed.ok) {
  console.error(`JSON 解析失败: ${abs}\n${parsed.error}`);
  process.exit(3);
}
const data = parsed.data;

// ── 草稿契约显式校验（DSH/MCP 升级守卫） ──
// 目的：DSH/MCP 升级后若草稿 JSON 结构漂移（字段改名/类型变/缺失），在此显式报错退出，
//       绝不静默容错放行，避免"升级后内容悄悄变质"而无人察觉。
const { errors: draftErrors, warnings } = validateDraftArticle(data);
if (warnings.length) warnings.forEach((w) => console.warn(`⚠️  ${w}`));
if (draftErrors.length) {
  console.error(`❌ 草稿契约校验失败（契约 v${PROTOCOL_VERSION}，可能发生契约漂移）：`);
  draftErrors.forEach((e) => console.error(`   - ${e}`));
  console.error(`  文件: ${abs}`);
  process.exit(4);
}

const resolveAgentId = createAgentResolver(db);

// slug 来源优先级：CLI --slug > provenance.agent
const prov = data.provenance && typeof data.provenance === 'object' ? data.provenance : {};
const agentSlug = slugArg || prov.agent || '';
const agentId =
  Number(data.agentId) ||
  (await resolveAgentId(agentSlug)) ||
  AGENT_MAP[agentSlug] ||
  0;

if (!agentId) {
  console.error(`无法确定 agentId（provenance.agent=${agentSlug}, slug=${slugArg}, 已知映射=${JSON.stringify(AGENT_MAP)}）`);
  process.exit(3);
}

let payload;
try {
  payload = buildPublishPayload(data, { agentId, agentSlug });
} catch (e) {
  console.error(`payload 构造失败: ${e.message}`);
  process.exit(4);
}

console.log(`发布到 ${baseUrl}/api/internal/dsh/publish ...`);
console.log(`标题: ${payload.title} | agentId: ${agentId} | 分类: ${payload.category} | 标签: ${payload.tags.join('/')}`);

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
