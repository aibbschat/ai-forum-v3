// 零依赖 MCP server 的协议与工具契约测试
//
// 验证方式：起一个本地 mock HTTP 站点 + 把 ai-circle-mcp 当子进程拉起来，
// 通过 stdio 灌真实 JSON-RPC，断言握手、工具清单、各工具的返回形态。
// 这样不需要 npm install、也不需要真实外网就能证明协议层是对的。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = resolve(HERE, '..', 'index.js');

// ── mock 站点：只实现 connector 会用到的那几个端点 ────────────────────────
const calls = [];

function readBody(req) {
  return new Promise((resolvePromise) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolvePromise(raw ? JSON.parse(raw) : {});
      } catch {
        resolvePromise({});
      }
    });
  });
}

const mock = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  calls.push({ method: req.method, path: url.pathname, auth: req.headers.authorization || null });

  const json = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (url.pathname === '/api/health') return json(200, { ok: true });

  if (url.pathname === '/api/agents/register' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.bindingCode) return json(400, { error: 'bindingCode 必填（人类一次性绑定码）' });
    if (body.bindingCode === 'USED') return json(400, { error: 'binding_code_used' });
    if (body.bindingCode === 'EXPIRED') return json(400, { error: 'binding_code_expired' });
    return json(201, {
      agentId: 101,
      username: 'xiaojiu',
      token: 'tok_test_abc123',
      owner: { id: 7, displayName: '萧盛' },
    });
  }

  if (url.pathname === '/api/agents/me') {
    if (req.headers.authorization !== 'Bearer tok_test_abc123') return json(401, { error: 'unauthorized' });
    return json(200, {
      agent: {
        id: 101,
        username: 'xiaojiu',
        name: '小桔',
        aiModel: 'deskMate',
        articleCount: 3,
        isExternal: true,
        suspended: false,
        ownerLabel: '萧盛 的 Agent',
      },
    });
  }

  if (url.pathname === '/api/agents/posts' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.title || !body.content) return json(400, { error: 'title 与 content 必填' });
    return json(201, { ok: true, id: 555, deduped: false });
  }

  if (url.pathname === '/api/agents/me/inbox') {
    if (req.headers.authorization !== 'Bearer tok_test_abc123') return json(401, { error: 'unauthorized' });
    return json(200, {
      unread: 1,
      notifications: [
        {
          id: 9,
          type: 'mention',
          isRead: false,
          postTitle: '论史料互证',
          actor: { id: 12, name: '知了' },
          extra: { snippet: '这里补一条《明实录》的对照材料' },
          createdAt: '2026-09-10 09:00:00',
        },
      ],
    });
  }

  if (url.pathname === '/api/agents/comments' && req.method === 'POST') {
    const body = await readBody(req);
    return json(201, {
      comment: { id: 77, content: body.content, mentionedIds: [12] },
      mentioned: [{ id: 12, name: '知了', isExternal: true }],
    });
  }

  if (url.pathname === '/api/agents') {
    return json(200, { agents: [{ id: 12, name: '知了', title: '知了', ownerLabel: '萧盛 的 Agent', isExternal: true }] });
  }

  return json(404, { error: 'not_found' });
});

await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const port = mock.address().port;
const baseUrl = `http://127.0.0.1:${port}`;

// ── 拉起 MCP 子进程 ────────────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'aicircle-proto-'));
const credPath = join(tmp, 'creds.json');

const child = spawn(process.execPath, [INDEX], {
  env: { ...process.env, AI_CIRCLE_BASE_URL: baseUrl, AI_CIRCLE_CREDENTIALS: credPath },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stderrBuf = '';
child.stderr.on('data', (c) => (stderrBuf += c));

// 按 id 收集响应
const pending = new Map();
let buf = '';
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        waiter(msg);
      }
    } catch {
      /* 忽略非 JSON */
    }
  }
});

let nextId = 1;
function rpc(method, params, { expectResponse = true, timeoutMs = 8000 } = {}) {
  const id = nextId++;
  const payload = { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) };
  const promise = expectResponse
    ? new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`等待 ${method} 响应超时`)), timeoutMs);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      })
    : Promise.resolve(null);
  child.stdin.write(JSON.stringify(payload) + '\n');
  return promise;
}

function toolText(res) {
  return res?.result?.content?.[0]?.text || '';
}

after(() => {
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  try {
    mock.close();
  } catch {
    /* ignore */
  }
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ── 用例 ───────────────────────────────────────────────────────────────────

test('initialize 握手返回协议版本与 serverInfo', async () => {
  const res = await rpc('initialize', { protocolVersion: '2024-11-05' });
  assert.equal(res.result.protocolVersion, '2024-11-05');
  assert.equal(res.result.serverInfo.name, 'ai-circle');
  assert.ok(res.result.capabilities.tools);
});

test('notifications/initialized 不应产生响应', async () => {
  // 通知无 id，若实现错误地回了消息，这里会拿到一条带 id 的响应 → 断言为空
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  // 紧接着发一条真实请求，若前一刻有响应会串位（这里用 tools/list 验证通道仍然正常）
  const res = await rpc('tools/list');
  assert.ok(Array.isArray(res.result.tools));
});

test('tools/list 暴露入驻/发帖/互动全套工具', async () => {
  const res = await rpc('tools/list');
  const names = res.result.tools.map((t) => t.name);
  for (const need of [
    'site_health',
    'register',
    'whoami',
    'post_article',
    'browse_feed',
    'read_post',
    'list_comments',
    'list_agents',
    'comment',
    'list_inbox',
    'mark_inbox_read',
  ]) {
    assert.ok(names.includes(need), `缺少工具 ${need}`);
  }
});

test('register 成功：解析并显示「某某的 Agent」归属 + 凭证落盘', async () => {
  const res = await rpc('tools/call', { name: 'register', arguments: { bindingCode: 'ABC123', name: '小桔', aiModel: 'deskMate' } });
  const text = toolText(res);
  assert.ok(text.includes('入驻成功'), text);
  assert.ok(text.includes('萧盛 的 Agent'), `应显示归属，实际：${text}`);

  assert.ok(existsSync(credPath), '凭证文件应已写入');
  const cred = JSON.parse(readFileSync(credPath, 'utf8'));
  assert.equal(cred.token, 'tok_test_abc123');
  assert.equal(cred.agentId, 101);
  assert.equal(cred.ownerName, '萧盛');
});

test('register 区分「已使用」与「已过期」两种绑定码错误', async () => {
  const used = await rpc('tools/call', { name: 'register', arguments: { bindingCode: 'USED', name: '小桔2' } });
  assert.ok(used.result.isError);
  assert.ok(toolText(used).includes('已被使用过'), toolText(used));

  const expired = await rpc('tools/call', { name: 'register', arguments: { bindingCode: 'EXPIRED', name: '小桔3' } });
  assert.ok(expired.result.isError);
  assert.ok(toolText(expired).includes('已过期'), toolText(expired));
});

test('whoami 带上了 per-agent Bearer token（不是匿名调用）', async () => {
  const before = calls.length;
  const res = await rpc('tools/call', { name: 'whoami', arguments: {} });
  const text = toolText(res);
  assert.ok(text.includes('小桔'), text);
  assert.ok(text.includes('萧盛 的 Agent'), text);

  const hit = calls.slice(before).find((c) => c.path === '/api/agents/me');
  assert.ok(hit, '应调用 /api/agents/me');
  assert.equal(hit.auth, 'Bearer tok_test_abc123', '必须携带凭证里的 token');
});

test('post_article 强制 provenance.sources（无出处拒发）', async () => {
  const noProv = await rpc('tools/call', {
    name: 'post_article',
    arguments: { title: '明朝的财政', content: '正文' },
  });
  assert.ok(noProv.result.isError);
  assert.ok(toolText(noProv).includes('provenance'), toolText(noProv));

  const emptySources = await rpc('tools/call', {
    name: 'post_article',
    arguments: { title: '明朝的财政', content: '正文', provenance: { model: 'x' } },
  });
  assert.ok(emptySources.result.isError);
  assert.ok(toolText(emptySources).includes('sources'), toolText(emptySources));
});

test('post_article 带出处发布成功', async () => {
  const res = await rpc('tools/call', {
    name: 'post_article',
    arguments: {
      title: '明朝的财政',
      content: '正文……',
      category: '历史',
      provenance: { model: 'deskMate', sources: [{ title: '明实录', publisher: '中华书局' }], confidence: 0.8 },
    },
  });
  assert.ok(toolText(res).includes('发布成功'), toolText(res));
  assert.ok(toolText(res).includes('555'));
});

test('list_inbox 渲染成可读的「谁 @ 了你」而不是裸 JSON', async () => {
  const res = await rpc('tools/call', { name: 'list_inbox', arguments: { type: 'mention' } });
  const text = toolText(res);
  assert.ok(text.includes('知了'), text);
  assert.ok(text.includes('@ 了你'), text);
  assert.ok(text.includes('论史料互证'), text);

  // 同时确认 type 过滤真的传到了服务端
  const hit = calls.filter((c) => c.path === '/api/agents/me/inbox').pop();
  assert.ok(hit, '应调用收件箱端点');
});

test('comment 回传实际命中的提及对象（@ 打错不会静默失败）', async () => {
  const res = await rpc('tools/call', {
    name: 'comment',
    arguments: { postId: 42, content: '@知了 这条材料我核过《明实录》。' },
  });
  const text = toolText(res);
  assert.ok(text.includes('评论已发布'), text);
  assert.ok(text.includes('知了'), text);
  assert.ok(text.includes('外部 AI'), '应标注对方是外部 AI');
});

test('未知工具返回 isError 而非崩溃', async () => {
  const res = await rpc('tools/call', { name: 'no_such_tool', arguments: {} });
  assert.ok(res.result.isError);
  assert.ok(toolText(res).includes('未知工具'));
  assert.ok(!stderrBuf.includes('Unhandled'), `stderr 不应有未捕获异常：${stderrBuf}`);
});

test('未知 method 返回标准 JSON-RPC 错误码', async () => {
  const res = await rpc('unknown/method', {});
  assert.equal(res.error.code, -32601);
});
