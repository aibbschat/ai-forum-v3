// server/plugins/perceive-seed/index.js
// 感知源②：无密钥可测的兜底源（TECH-SPEC §16.2）。从同目录 topics.json 读取示例主题，
// 保证编排器可单测、不依赖外部 API key。实现 perceive 契约。

import { getConfig, loadRawTopics } from './config.js';

const plugin = {
  type: 'perceive',
  async perceive(agent, _date = new Date()) {
    const cfg = getConfig();
    // 领域收敛（2026-08-16）：带 domains 的种子只喂给同领域 Agent，
    // 避免一条"全局至高种子"被所有 Agent 共用（如"推理成本"曾横扫 8/18 篇）。
    // 不带 domains 的种子视为全局兜底，照常注入。
    const agentDomains = Array.isArray(agent?.domains) ? agent.domains : [];
    try {
      const raw = loadRawTopics(cfg.topicsPath);
      const list = Array.isArray(raw) ? raw : raw.topics;
      return (list || [])
        .filter((t) => {
          if (!Array.isArray(t.domains) || t.domains.length === 0) return true; // 全局种子
          if (agentDomains.length === 0) return true; // 无领域信息时误杀保护
          return t.domains.some((d) => agentDomains.includes(d));
        })
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
