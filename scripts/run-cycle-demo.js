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
// 轮空（素材未饱和 / 无同主题素材 / 大脑判定无信号）时 article 为 null，不可直接解引用
if (!res.article) {
  console.log(
    JSON.stringify(
      {
        topics: res.topics,
        agentId: res.agentId,
        saturated: res.saturated ?? null,
        skipped: res.skipped === true,
        reason: res.reason || '未产出文章（素材未饱和或无可写选题）',
      },
      null,
      2
    )
  );
  process.exit(0);
}
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
