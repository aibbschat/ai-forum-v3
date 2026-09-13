// server/tests/skill-entry-client.test.js — 回哺边「技能包侧」接线契约（不依赖网络、不起 MCP server）。
// 两块：
//  A) api-client 四个写方法确实打到共创库对应 REST（与 entry-e2e.test.js 已验证的线上端点对齐）。
//  B) index.js（MCP server 主体，import 会起 stdio，故只做静态结构断言）：4 个工具定义 + 4 个 handler
//     + lookup_entry 未命中分支里的回填引导（raise_gap / create_entry）确实在位。
// 这是「发布新版前先巡通」纪律里的巡通部分之一；真正的端到端写侧行为由 entry-e2e 经真实 HTTP 覆盖。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { AiCircleClient } from '../../connector/ai-circle-skill/mcp/src/api-client.js';

const here = dirname(fileURLToPath(import.meta.url));
const MCP_INDEX = join(here, '../../connector/ai-circle-skill/mcp/index.js');

test('A: createEntry → POST /api/entries，带 domain/title/claims，auth=true', async () => {
  const c = new AiCircleClient({ baseUrl: 'https://aibbs.chat', token: 'tk' });
  let seen;
  c.request = async (method, path, opts = {}) => { seen = { method, path, ...opts }; return { ok: true, id: 7, state: 'proposed' }; };
  const r = await c.createEntry({ domain: 'office', title: 'T', bodyMd: 'b', claims: [{ text: 'x', verified_against: { url: 'https://support.microsoft.com/a' } }] });
  assert.equal(seen.method, 'POST');
  assert.equal(seen.path, '/api/entries');
  assert.equal(seen.auth, true);
  assert.equal(seen.body.domain, 'office');
  assert.equal(seen.body.claims[0].verified_against.url, 'https://support.microsoft.com/a');
  assert.equal(r.id, 7);
});

test('A: proposeRevision / reviewRevision / raiseGap 路径与鉴权正确', async () => {
  const c = new AiCircleClient({ baseUrl: 'https://aibbs.chat', token: 'tk' });
  const calls = [];
  c.request = async (method, path, opts = {}) => { calls.push({ method, path, ...opts }); return { ok: true }; };

  await c.proposeRevision({ entryId: '12', bodyMd: 'b', claims: [] });
  assert.equal(calls.at(-1).path, '/api/entries/12/revisions');
  assert.equal(calls.at(-1).method, 'POST');
  assert.equal(calls.at(-1).auth, true);

  await c.reviewRevision({ revisionId: 5, verdict: 'endorse', evidence: 'https://x.test/src' });
  assert.equal(calls.at(-1).path, '/api/entries/revisions/5/review');
  assert.equal(calls.at(-1).body.verdict, 'endorse');

  await c.raiseGap({ domain: 'agents', question: 'q?' });
  assert.equal(calls.at(-1).path, '/api/entries/gap');
  assert.equal(calls.at(-1).body.domain, 'agents');
});

test('A: 未注册（无 token）时写操作被拒（不静默打到网络）', async () => {
  const c = new AiCircleClient({ baseUrl: 'https://aibbs.chat', token: null });
  await assert.rejects(() => c.raiseGap({ domain: 'office', question: 'q' }), /register|入驻|401/);
});

test('B: index.js 声明了 4 个共创写工具 + 对应 handler + 未命中回填引导', () => {
  const src = readFileSync(MCP_INDEX, 'utf8');
  for (const tool of ['create_entry', 'propose_revision', 'review_revision', 'raise_gap']) {
    assert.ok(src.includes(`name: '${tool}'`), `缺少工具定义 ${tool}`);
    assert.ok(src.includes(`case '${tool}'`), `缺少工具 handler ${tool}`);
    assert.ok(src.includes(`client.${tool.replace(/_([a-z])/g, (_m, c) => c.toUpperCase())}(`), `handler 未调用对应 client 方法 ${tool}`);
  }
  // 回哺触发点：lookup_entry 未命中分支里应引导 raise_gap / create_entry
  const missIdx = src.indexOf('共创知识库暂无可引用条目');
  assert.ok(missIdx > -1, '未找到 lookup_entry 未命中分支');
  const missBlock = src.slice(missIdx, missIdx + 600);
  assert.match(missBlock, /raise_gap/, '未命中应引导 raise_gap');
  assert.match(missBlock, /create_entry/, '未命中应引导 create_entry');
});
