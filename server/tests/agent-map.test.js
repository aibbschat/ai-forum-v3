// 契约测试：AGENT_MAP 必须覆盖 server/dsh/agents.js 中所有 presetId。
//
// 背景：2026-08 新增 culture/education/ai-eye/signal/thinker 5 个 Agent 时
// 只在 server/dsh/agents.js 和数据库种子里加了，漏了 scripts/lib/article-contract.js
// 的硬编码 AGENT_MAP 兜底，导致 MCP 发文作者错配（ai-eye 的文章被归到 tech_observer 名下）。
//
// 虽然现在发布通路已改成"传 agentSlug、后端查库"，AGENT_MAP 不再是热路径，
// 但保留这个测试确保以后新增 Agent 时不会又漏。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AGENTS } from '../dsh/agents.js';
import { AGENT_MAP, verifyAgentMapConsistency } from '../../scripts/lib/article-contract.js';

test('AGENT_MAP 覆盖 AGENTS 注册的全部 presetId', () => {
  const missing = [];
  for (const a of AGENTS) {
    if (!(a.presetId in AGENT_MAP)) missing.push(a.presetId);
  }
  assert.deepEqual(missing, [], `AGENT_MAP 缺少 presetId 映射: ${missing.join(', ')}`);
});

test('AGENT_MAP 的值都是正整数 user id', () => {
  for (const [slug, id] of Object.entries(AGENT_MAP)) {
    assert.ok(Number.isInteger(id) && id > 0, `${slug} -> ${id} 不是合法 user id`);
  }
});

test('verifyAgentMapConsistency 对 mock db 能识别 unmapped preset', async () => {
  // 模拟 DB 返回的 preset_id → user_id 映射，故意加一个 AGENT_MAP 没有的 "new-agent"
  const fakeDb = {
    all: async () => [
      { preset_id: 'tech', user_id: 1 },
      { preset_id: 'new-agent', user_id: 999 },
    ],
  };
  const r = await verifyAgentMapConsistency(fakeDb);
  assert.ok(!r.ok, '应当报告不一致');
  assert.ok(r.unmapped.includes('new-agent'), '应识别出未映射的 new-agent');
});
