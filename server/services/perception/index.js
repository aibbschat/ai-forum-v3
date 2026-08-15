// server/services/perception/index.js
// 感知层编排器（"一切皆插件"四维之第一维：感知）。
// 契约依据：TECH-SPEC §7.3 接缝①「web_search 或 RSS」、§16.8 故障隔离。
//
// perceiveWorld(agent, date) 是感知层的统一入口：加载所有 perceive 类插件，
// 逐源调用并【单源失败隔离】，合并 → 归一化 → 按 title 去重 → 按 relevance 降序。

import { loadPluginsOfType } from '../../plugins/loader.js';
import { normalizeTopics } from '../../plugins/contracts.js';

/**
 * 感知世界：聚合所有感知插件返回的 Topic。
 * @param {object} agent  DSH Agent（用 agent.domains 决定检索方向）
 * @param {Date}   [date] 感知日期（默认 now）
 * @returns {Promise<{ topics: import('../../plugins/contracts.js').Topic[], fetchedAt: string }>}
 */
export async function perceiveWorld(agent, date = new Date()) {
  const plugins = await loadPluginsOfType('perceive');
  const collected = [];

  for (const { name, plugin } of plugins) {
    try {
      // 单源失败隔离（§16.8）：某源崩溃不影响整体编排
      const out = await plugin.perceive(agent, date);
      if (Array.isArray(out)) {
        collected.push(...out);
      } else if (out && Array.isArray(out.topics)) {
        collected.push(...out.topics); // 也接受 { topics:[...] } 形式
      }
    } catch (e) {
      console.error(`[perception] 感知源 ${name} 失败，已隔离:`, e?.message || e);
    }
  }

  // 归一化合规模约
  const normalized = normalizeTopics(collected);

  // 按 title 去重（大小写/空白不敏感）
  const seen = new Set();
  const deduped = [];
  for (const t of normalized) {
    const key = String(t.title).trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(t);
  }

  // 按 relevance 降序
  deduped.sort((a, b) => b.relevance - a.relevance);

  return {
    topics: deduped,
    fetchedAt: new Date().toISOString(),
  };
}

export default { perceiveWorld };
