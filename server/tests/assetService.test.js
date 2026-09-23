// 发布侧自动配图测试（assetService）：mock LLM，不真调 API
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractChartsFromText, generateCover, autoAssets, stripJsonFences } from '../services/assetService.js';

const SAMPLE = `2026 年国产 AI 芯片进入规模化商用。英伟达在华份额从 2024 年的 55% 跌至约 8%，
国产芯片市占率从 12% 突破到 60%。8 月寒武纪披露半年报：营收 59.96 亿元、同比增长 108%，
归母净利润 23.11 亿元、同比大涨 122%。`;

test('extractChartsFromText：有效 LLM 输出 → 归一化为合规 chart assets', async () => {
  const llmExtractor = async () => ({
    charts: [
      { title: '英伟达 vs 国产芯片市占率', labels: ['2024', '2026'], values: ['55', '8'] },
      { title: '营收增长', labels: ['营收', '净利润'], values: [59.96, 23.11] },
    ],
  });
  const charts = await extractChartsFromText({ content: SAMPLE }, { llmExtractor });
  assert.equal(charts.length, 2);
  assert.equal(charts[0].type, 'chart');
  assert.equal(charts[0].position, 'inline');
  assert.deepEqual(charts[0].data.labels, ['2024', '2026']);
  assert.deepEqual(charts[0].data.datasets[0].values, [55, 8]);
  assert.equal(charts[0].data.type, 'bar');
});

test('extractChartsFromText：LLM 输出非法结构 → 过滤，不抛错', async () => {
  const bad1 = await extractChartsFromText({ content: SAMPLE }, { llmExtractor: async () => ({ charts: 'x' }) });
  assert.deepEqual(bad1, []);
  const bad2 = await extractChartsFromText({ content: SAMPLE }, {
    llmExtractor: async () => ({ charts: [{ labels: ['a', 'b'], values: [1] }] }), // 长度不齐
  });
  assert.deepEqual(bad2, []);
  const bad3 = await extractChartsFromText({ content: SAMPLE }, {
    llmExtractor: async () => ({ charts: [{ labels: ['a'], values: [1] }] }), // 单点无对比
  });
  assert.deepEqual(bad3, []);
});

test('extractChartsFromText：LLM 抛错 → 静默降级 []，绝不外抛', async () => {
  const charts = await extractChartsFromText({ content: SAMPLE }, {
    llmExtractor: async () => { throw new Error('llm down'); },
  });
  assert.deepEqual(charts, []);
});

test('extractChartsFromText：无 DEEPSEEK_API_KEY → 默认提取器返回 []（不烧钱不报错）', async () => {
  const oldKey = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const charts = await extractChartsFromText({ content: SAMPLE }); // 用默认提取器
    assert.deepEqual(charts, []);
  } finally {
    if (oldKey !== undefined) process.env.DEEPSEEK_API_KEY = oldKey;
  }
});

test('generateCover：产出合规 data URI 封面（含分类配色 + 标题转义）', () => {
  const cover = generateCover({ title: '国产 AI 芯片 <胜负手> 分析', category: '科技' });
  assert.ok(cover);
  assert.equal(cover.type, 'image');
  assert.equal(cover.position, 'cover');
  assert.ok(cover.url.startsWith('data:image/svg+xml;base64,'));
  // 解码验证内容包含标题与分类
  const svg = Buffer.from(cover.url.split(',')[1], 'base64').toString('utf8');
  assert.ok(svg.includes('国产 AI 芯片'));
  assert.ok(svg.includes('&lt;胜负手&gt;')); // 标题被 XML 转义
  assert.ok(svg.includes('科技'));
});

test('generateCover：异常输入不抛（无标题回退未命名默认封面）', () => {
  const c1 = generateCover({});
  assert.ok(c1 && c1.url.startsWith('data:image/svg+xml;base64,'));
  // null 输入也回退默认封面（不抛、不返回 null）
  const c2 = generateCover(null);
  assert.ok(c2 && c2.url.startsWith('data:image/svg+xml;base64,'));
});

test('stripJsonFences：剥掉 LLM 返回的 markdown 围栏（线上真实失败形态）', () => {
  const fenced = '```json\n{"charts":[{"title":"t","labels":["A","B"],"values":[1,2]}]}\n```';
  assert.equal(
    stripJsonFences(fenced),
    '{"charts":[{"title":"t","labels":["A","B"],"values":[1,2]}]}',
  );
  // 无语言标记围栏
  assert.equal(stripJsonFences('```\n{"a":1}\n```'), '{"a":1}');
  // 纯 JSON 原样返回
  assert.equal(stripJsonFences('{"a":1}'), '{"a":1}');
  // 围栏未闭合 → 花括号兜底截取
  assert.equal(stripJsonFences('```json\n{"a":1} trailing'), '{"a":1}');
});

test('autoAssets：组合 chart + 封面；withChart=false 时只出封面', async () => {
  const llmExtractor = async () => ({ charts: [{ title: 't', labels: ['A', 'B'], values: [1, 2] }] });
  const full = await autoAssets({ title: '标题', content: SAMPLE, category: '财经' }, { llmExtractor });
  assert.ok(full.some((a) => a.type === 'chart'));
  assert.ok(full.some((a) => a.type === 'image' && a.position === 'cover'));
  const noChart = await autoAssets({ title: '标题', content: SAMPLE, category: '财经' }, { withChart: false });
  assert.ok(noChart.every((a) => a.type === 'image'));
});
