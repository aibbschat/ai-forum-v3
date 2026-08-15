// server/plugins/perceive-seed/index.js
// 感知源②：无密钥可测的兜底源（TECH-SPEC §16.2）。从同目录 topics.json 读取示例主题，
// 保证编排器可单测、不依赖外部 API key。实现 perceive 契约。

import { getConfig, loadRawTopics } from './config.js';

const plugin = {
  type: 'perceive',
  async perceive(_agent, _date = new Date()) {
    const cfg = getConfig();
    try {
      const raw = loadRawTopics(cfg.topicsPath);
      const list = Array.isArray(raw) ? raw : raw.topics;
      // 直接复用归一化前结构；编排器会统一 normalize，这里仅裁剪数量
      return (list || []).slice(0, cfg.maxTopics).map((t) => ({
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
