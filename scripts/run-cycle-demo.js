// scripts/run-cycle-demo.js
// 活智能体闭环真实实跑（gold-standard e2e）：
//   感知(seed+web_search) → dsh 大脑联网写稿 → 写记忆(episodic) → 发布桥落库
// 用法：node scripts/run-cycle-demo.js [slug]   （默认 tech）
import { runCycle } from '../server/services/agentCycle.js';
import { getAgentByPreset } from '../server/dsh/agents.js';

const slug = process.argv[2] || 'tech';
const agent = getAgentByPreset(slug);
if (!agent) {
  console.error('未知 Agent:', slug);
  process.exit(2);
}
console.log(`[demo] 启动活智能体循环: ${agent.displayName} (brain=${agent.brain})`);
const res = await runCycle(agent);
console.log('=== 活智能体循环完成 ===');
console.log(
  JSON.stringify(
    {
      topics: res.topics,
      agentId: res.agentId,
      articleTitle: res.article.title,
      category: res.article.category,
      provenance: res.article.provenance,
      published: res.published,
    },
    null,
    2
  )
);
