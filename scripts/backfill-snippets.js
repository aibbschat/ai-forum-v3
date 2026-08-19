// scripts/backfill-snippets.js
// 冷启动回填：对站内已有的 AI 文章，用 LLM 提炼一句"专家此刻的洞察"写入 thinking_snippets，
// 让「思想广场」一上线就有内容、且每条都能「展开追问」跳到对话。
//
// 走 server/llm 统一路由层：供应商/模型由 .env 决定（默认火山包月），不直连端点。
//
// 幂等：已为该文章生成过 snippet（source_article_id 已存在）则跳过。
// 用法：node scripts/backfill-snippets.js [--limit 30]
//
// 设计要点：snippet 风格 = 朋友圈/微博式一句话洞察（≠ 文章摘要），带具体信息量、不标题党。

import dotenv from 'dotenv';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../server/database/db.js';
import { insertSnippet } from '../server/services/snippetService.js';
import { chat as llmChat } from '../server/llm/client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
dotenv.config({ path: join(ROOT, '.env') });

const args = process.argv.slice(2);
const limit = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 && args[i + 1] ? parseInt(args[i + 1], 10) : 30;
})();

async function genSnippet(agentName, title, excerpt) {
  const prompt =
    `你是「${agentName}」，一位驻站 AI 专家。\n` +
    `你刚写了一篇文章《${title}》，核心内容：${excerpt}\n\n` +
    `请提炼一句你此刻最想分享给读者的洞察——像发朋友圈/微博那样，一句话，≤40字，` +
    `口语化、有具体信息量、不标题党、不用问句、不要出现书名号。\n` +
    `只输出这句话本身，不要解释、不要引号。`;

  // 推理模型预算不足会让 content 为空 → 递增 maxTokens 重试
  for (const maxTokens of [1500, 3000]) {
    const res = await llmChat({
      purpose: 'chat',
      messages: [
        { role: 'system', content: '你是严谨的中文专家，只输出用户要求的一句话，不要多余内容。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.7,
      maxTokens,
    }).catch(() => null);
    const raw = res?.content?.trim();
    if (raw) return raw.replace(/^["'「『]|["'」』]$/g, '').slice(0, 140);
  }
  return null;
}

async function main() {
  // 已回填的文章 id 集合（跳过）
  const done = await db.all(`SELECT source_article_id FROM thinking_snippets WHERE source_article_id IS NOT NULL`);
  const doneSet = new Set(done.map((r) => r.source_article_id));

  const rows = await db.all(
    `SELECT p.id, p.title, p.content, p.author_id, u.nickname AS agent_name
     FROM posts p JOIN users u ON u.id = p.author_id
     WHERE p.post_type = 'article' AND p.is_ai_generated = 1
     ORDER BY p.id DESC LIMIT ?`,
    [limit]
  );

  let inserted = 0;
  for (const r of rows) {
    if (doneSet.has(r.id)) {
      console.log(`跳过(已回填) post=${r.id} ${r.title.slice(0, 16)}`);
      continue;
    }
    const excerpt = (r.content || '').replace(/\s+/g, ' ').slice(0, 120);
    const snippet = await genSnippet(r.agent_name, r.title, excerpt).catch(() => null);
    if (!snippet) {
      console.log(`未生成 post=${r.id}（LLM 返回空，跳过）`);
      continue;
    }
    const id = await insertSnippet({ agentId: r.author_id, content: snippet, sourceArticleId: r.id });
    if (id) {
      inserted++;
      console.log(`✓ snippet post=${r.id} [${r.agent_name}] ${snippet}`);
    }
    // 友好节流，避免打爆速率
    await new Promise((res) => setTimeout(res, 400));
  }
  console.log(`\n完成：新增 ${inserted} 条思考片段。`);
  process.exit(0);
}

main().catch((e) => {
  console.error('回填失败:', e);
  process.exit(1);
});
