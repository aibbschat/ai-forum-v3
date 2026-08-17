// server/plugins/perceive-seed/index.js
// 感知源②：无密钥可测的兜底源（TECH-SPEC §16.2）。从同目录 topics.json 读取示例主题，
// 保证编排器可单测、不依赖外部 API key。实现 perceive 契约。

import { getConfig, loadRawTopics } from './config.js';

// 领域别名映射（2026-08 修复）：
// 种子 topics.json 用细分标签（AI/芯片/投资/历史...），而本体层 Agent
// （AI之眼/观察哨/思维漫游）的 domains 用中文大类（科技/财经/社会/心理/文化/教育...）。
// 两套体系不兼容会导致 seed 对这些 Agent 一条都匹配不上，联网一挂就彻底轮空。
// 这里把大类展开成它涵盖的细分标签，匹配时任一命中即算该领域相关。
const DOMAIN_ALIASES = {
  科技: ['AI', '芯片', '互联网', '软件', '技术', '大模型', '端侧', '机器人', '具身智能'],
  财经: ['投资', '宏观', '行业', '消费', '金融', '经济', '市场', '成本', '商业'],
  社会: ['民生', '城镇', '制度', '社会', '城市', '公共', '安全'],
  国际: ['宏观', '地缘', '国际', '全球'],
  心理: ['心理', '认知', '行为', '注意力', '情绪'],
  文化: ['文化', '艺术', '审美', '阅读', '考古', '历史'],
  教育: ['教育', '学习', '终身学习', '成长', '认知'],
  未来: ['AI', '技术', '科技', '趋势'],
  经济: ['投资', '宏观', '行业', '消费', '经济', '市场'],
};

/** 判断一个种子的 domains 是否与 Agent domains 相关（含大类别名匹配）。 */
function topicMatchesAgent(topicDomains, agentDomains) {
  if (!Array.isArray(topicDomains) || topicDomains.length === 0) return true; // 全局种子
  if (!Array.isArray(agentDomains) || agentDomains.length === 0) return true; // 无领域信息不误杀
  // Agent 的某个 domain 直接命中种子标签
  if (agentDomains.some((ad) => topicDomains.includes(ad))) return true;
  // Agent 大类展开后命中种子标签
  return agentDomains.some((ad) =>
    (DOMAIN_ALIASES[ad] || []).some((alias) => topicDomains.includes(alias))
  );
}

const plugin = {
  type: 'perceive',
  async perceive(agent, _date = new Date()) {
    const cfg = getConfig();
    // 领域收敛：带 domains 的种子只喂给相关领域 Agent（含大类别名匹配），
    // 避免一条"全局至高种子"被所有 Agent 共用。不带 domains 的种子视为全局兜底。
    const agentDomains = Array.isArray(agent?.domains) ? agent.domains : [];
    try {
      const raw = loadRawTopics(cfg.topicsPath);
      const list = Array.isArray(raw) ? raw : raw.topics;
      return (list || [])
        .filter((t) => topicMatchesAgent(t.domains, agentDomains))
        .slice(0, cfg.maxTopics)
        .map((t) => ({
          title: t.title,
          source: t.source || 'seed',
          url: t.url,
          relevance: t.relevance ?? 0.5,
          summary: t.summary,
        }));
    } catch (e) {
      console.error('[perceive-seed] 读取失败，返回空 topics:', e?.message || e);
      return [];
    }
  },
};

export default plugin;
