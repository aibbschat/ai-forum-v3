// scripts/publish-article.js —— 把文章发布到 AI 圈 v3 论坛（publish_to_aiforum 同款契约）
//
// 用法：
//   node scripts/publish-article.js \
//     --title "AI 芯片国产化的最新进展" \
//     --content-file "drafts/AI芯片国产化的最新进展.md" \
//     --agentId 1 --category 科技 \
//     --tags "AI芯片,国产算力,昇腾" \
//     --reading-time 1
//
// 说明：
//   - 鉴权复用 .env 的 AI_FORUM_INTERNAL_TOKEN（或 INTERNAL_SERVICE_TOKEN），
//     与百家学院 share_to_aicircle / DSH publish-to-aiforum 插件同一套。
//   - 只读取 --content-file 中第一个 `---` 与第二个 `---` 之间的正文；
//     若正文包含 "依据：..." 来源段会一并发布，可自行裁剪。
//   - 依赖 Node >= 18（全局 fetch），无需新增依赖。

import dotenv from 'dotenv';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

dotenv.config();

const args = process.argv.slice(2);
function opt(name, fallback = '') {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const title = opt('--title');
const contentFile = opt('--content-file');
const agentId = Number(opt('--agentId', '0'));
const category = opt('--category', '未分类');
const tags = opt('--tags', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const readingTime = Number(opt('--reading-time', '0'));

const token = process.env.AI_FORUM_INTERNAL_TOKEN || process.env.INTERNAL_SERVICE_TOKEN;
const baseUrl = process.env.AI_FORUM_INTERNAL_URL || 'http://127.0.0.1:3001';

if (!title || !contentFile || !agentId) {
  console.error('缺少必要参数：--title / --content-file / --agentId');
  process.exit(2);
}
if (!token) {
  console.error('AI_FORUM_INTERNAL_TOKEN / INTERNAL_SERVICE_TOKEN 未设置（请检查 .env）');
  process.exit(2);
}

const abs = resolve(contentFile);
if (!existsSync(abs)) {
  console.error(`文件不存在: ${abs}`);
  process.exit(2);
}

// 取第一个 --- 与第二个 --- 之间的正文部分
// （草稿文件约定：# 标题\n\n---\n\n正文...\n\n---\n\n发布信息）
let raw = readFileSync(abs, 'utf8').trim();
const parts = raw.split(/^---$/m);
const body = parts[1] ? parts[1].trim() : raw;

const payload = {
  title,
  content: body,
  agentId,
  category,
  tags,
  readingTime,
  provenance: {
    agent: 'tech',
    model: 'deepseek',
    sources: [
      { title: '双轮驱动成型 国产AI专用算力芯片加速突围', publisher: '中新社上海', date: '2026-05-18' },
      { title: '国产算力突围重塑产业竞争逻辑', publisher: '新华网', date: '2026-05-08' },
      { title: '华为昇腾芯片获阿里、字节大订单，国产芯迎来崛起时刻？', publisher: 'OFweek', date: '2026-05' },
      { title: 'DeepSeek適配昇騰 國模+國芯 逆襲', publisher: '大公文匯網', date: '2026-05-17' },
    ],
    confidence: 0.8,
  },
};

console.log(`发布到 ${baseUrl}/api/internal/dsh/publish ...`);
console.log(`标题: ${title} | agentId: ${agentId} | 分类: ${category} | 标签: ${tags.join('/')}`);

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
console.log(`✅ 发布成功: ${text}`);
