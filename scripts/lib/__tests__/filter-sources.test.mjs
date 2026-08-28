// 验证 filterSourcesByKnownUrls：LLM 编造的 URL（不在本次取稿集合里）必须被剔除
import assert from 'node:assert';
import { filterSourcesByKnownUrls, stripStructurallyFakeSources, isStructurallyFake } from '../source-verify.js';

// 本次取稿的真实 URL 集合（来自 web_search 抓取）
const known = [
  'https://www.moe.gov.cn/jyb_xwfb/gzdt_gzdt/s5987/202608/t20260828_1048726.html',
  'https://www.thepaper.cn/newsDetail_forward_33835012',
];

// LLM 成文时"发明"的来源（看似合理但不在取稿集合里）
const llmSources = [
  { title: '真实来源', url: 'https://www.moe.gov.cn/jyb_xwfb/gzdt_gzdt/s5987/202608/t20260828_1048726.html' }, // 真实取稿 ✓
  { title: '编造的来源', url: 'http://www.moe.gov.cn/jyb_xwfb/gzdt_gzdt/s5987/202608/t20260828_9999999.html' }, // 编造 ✗
  { title: '无url来源', publisher: '教育部', date: '2026-08' }, // 无 url ✓ 保留
  { title: 'example占位', url: 'https://example.com/fake' }, // 结构假（被 strip 先剔）
];

const stripped = stripStructurallyFakeSources(llmSources);
const filtered = filterSourcesByKnownUrls(stripped, known);

assert.strictEqual(filtered.length, 2, `应保留 2 条（真实来源 + 无url来源），实际 ${filtered.length}: ${JSON.stringify(filtered)}`);
assert.strictEqual(filtered[0].url, known[0], '真实取稿来源应保留');
assert.ok(!('url' in filtered[1]) || !filtered[1].url, '无url来源应保持无url');
assert.ok(!filtered.some((s) => s.url && s.url.includes('9999999')), '编造的 URL 必须被剔除');
assert.ok(!filtered.some((s) => s.url && s.url.includes('example.com')), 'example.com 必须已被 strip 剔除');

// knownUrls 为空时退回不误删（只做结构剔除，保留有 url 来源——因为无法判断归属）
const safeWhenEmpty = filterSourcesByKnownUrls(stripStructurallyFakeSources(llmSources), []);
assert.strictEqual(safeWhenEmpty.length, 3, 'known 为空时：先 strip（example.com 被剔），剩 3 条');

console.log('✓ filterSourcesByKnownUrls: LLM 编造 URL 被剔除, 真实取稿来源保留');
console.log('结果样例:', JSON.stringify(filtered, null, 0));
