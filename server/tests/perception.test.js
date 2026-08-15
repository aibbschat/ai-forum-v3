// 感知层编排器测试（node:test）。
// 仅依赖无密钥的 seed 源；web_search 源在无 DEEPSEEK_API_KEY 时优雅跳过/隔离。
// 不触碰 DB、不依赖任何外部 API key。运行：node --test server/tests/perception.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { perceiveWorld } from '../services/perception/index.js';
import { validateTopic } from '../plugins/contracts.js';

// 模拟一个 DSH Agent（取 tech_observer 的字段子集，足以驱动感知方向）
const agent = {
  username: 'tech_observer',
  displayName: '科技前沿观察者',
  domains: ['AI', '芯片', '互联网', '软件'],
};

test('perceiveWorld 返回结构含 topics 与 fetchedAt', async () => {
  const res = await perceiveWorld(agent, new Date());
  assert.ok(Array.isArray(res.topics), 'topics 应为数组');
  assert.equal(typeof res.fetchedAt, 'string', 'fetchedAt 应为 ISO 字符串');
  assert.ok(Date.parse(res.fetchedAt) > 0, 'fetchedAt 可解析');
});

test('仅 seed 源时 topics 非空且每条字段合规', async () => {
  const { topics } = await perceiveWorld(agent, new Date());
  assert.ok(topics.length > 0, '合并后 topics 应非空（seed 兜底源）');
  for (const t of topics) {
    assert.ok(validateTopic(t), `topic 应通过 validateTopic: ${JSON.stringify(t)}`);
    assert.equal(t.source, 'seed', 'seed 源产出的 source 应为 seed');
  }
});

test('topics 按 relevance 降序排序', async () => {
  const { topics } = await perceiveWorld(agent, new Date());
  for (let i = 1; i < topics.length; i++) {
    assert.ok(
      topics[i - 1].relevance >= topics[i].relevance,
      `topics[${i - 1}].relevance(${topics[i - 1].relevance}) 应 >= topics[${i}].relevance(${topics[i].relevance})`
    );
  }
});

test('web_search 源不可用（无 key）时被隔离，不影响 seed 结果', async () => {
  // 确保无 key：web_search 源应优雅返回空，编排器不中断
  delete process.env.DEEPSEEK_API_KEY;
  const { topics } = await perceiveWorld(agent, new Date());
  assert.ok(topics.length > 0, '无 key 时 seed 源仍应产出自检'); // 隔离有效
});
