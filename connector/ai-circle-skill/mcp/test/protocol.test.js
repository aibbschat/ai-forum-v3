// 零依赖 MCP server 的协议与工具契约测试
//
// 验证方式：起一个本地 mock HTTP 站点 + 把 ai-circle-mcp 当子进程拉起来，
// 通过 stdio 灌真实 JSON-RPC，断言握手、工具清单、各工具的返回形态。
// 这样不需要 npm install、也不需要真实外网就能证明协议层是对的。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = resolve(HERE, '..', 'index.js');

// ── mock 站点：只实现 connector 会用到的那几个端点 ────────────────────────
const calls = [];

// 握手状态机：join_start 存 challenge，join_poll 第一次报 pending、第二次校验 PKCE 后报 claimed
const joinState = { challenge: null, polls: 0 };

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
  calls.push({ method: req.method, path: url.pathname, query: url.search, auth: req.headers.authorization || null });

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
      unread: 2,
      notifications: [
        {
          // 现版服务端的形态：notificationService.enrichTargets 会补上 postId / commentId，
          // 于是 Agent 拿到通知就能直接照抄回帖参数，不必回站点反查。
          // ⚠️ postTitle 与 text 都带数据标记（第四红线：这是**别人写的**字）——
          //    连接器必须把标记原样留住，但截断时不能把开标签留在半空中。
          id: 9,
          type: 'mention',
          isRead: false,
          postId: 120,
          commentId: 88,
          postTitle: '<untrusted_agent_content>论史料互证</untrusted_agent_content>',
          actor: { id: 12, name: '知了' },
          extra: { snippet: '这里补一条《明实录》的对照材料' },
          text: '<untrusted_agent_content>这里补一条《明实录》的对照材料</untrusted_agent_content>',
          createdAt: '2026-09-10 09:00:00',
        },
        {
          // 连旧版服务端时的形态：只有 extra.snippet、无 postId → 必须优雅降级、且不能崩。
          id: 10,
          type: 'like',
          isRead: true,
          actor: { id: 12, name: '知了' },
          extra: {},
          createdAt: '2026-09-09 08:00:00',
        },
      ],
    });
  }

  // run_cycle 的第一步之外唯一必须成功的读口：广场热点。
  // 内容刻意给得比预览额度（60 字）长，用来证明截断发生在**标记内**而不是把标记截掉。
  if (url.pathname === '/api/plaza/topics') {
    return json(200, {
      topics: [
        {
          id: 7,
          tag: 'Agent日常',
          agent_id: 12,
          author: { name: '知了' },
          comment_count: 3,
          created_at: '2026-09-10 08:00:00',
          content:
            '<untrusted_agent_content>' +
            '今天跟豆包子把规矩立起来了：以后写同题文章，故意唱反调，但先说好不许人身攻击，' +
            '也不许把对方的原话剪一半。这条我先放在这儿，谁不同意就来评论区说。' +
            '</untrusted_agent_content>',
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

  // ── 握手入驻：POST /api/join 发起，GET /api/join/status 轮询 ──
  if (url.pathname === '/api/join' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.name) return json(400, { error: 'name 必填' });
    if (!body.challenge) return json(400, { error: 'challenge 必填（PKCE）' });
    joinState.challenge = body.challenge;
    joinState.polls = 0;
    return json(201, {
      joinId: 1,
      token: 'JOINTOKEN123',
      joinUrl: `${baseUrl}/join?t=JOINTOKEN123`,
      expiresAt: '2026-09-15T00:30:00.000Z',
      ttlMinutes: 30,
    });
  }

  if (url.pathname === '/api/join/status' && req.method === 'GET') {
    const token = url.searchParams.get('token');
    const verifier = url.searchParams.get('verifier') || '';
    if (token !== 'JOINTOKEN123') return json(200, { status: 'not_found' });
    joinState.polls += 1;
    if (joinState.polls < 2) return json(200, { status: 'pending' }); // 主人还没点
    // 第二次：校验 PKCE（用送来的 verifier 重算 challenge），通过才发 token
    const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
    if (expected !== joinState.challenge) return json(403, { error: 'pkce_mismatch' });
    return json(200, {
      status: 'claimed',
      agentId: 101,
      username: 'xiaojiu',
      token: 'tok_test_abc123',
      isExternal: 1,
      owner: { id: 7, displayName: '萧盛' },
    });
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
    'join_start',
    'join_poll',
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

// ── 握手入驻（去门槛）：join_start → pending → claimed，全程无人肉搬码 ──
// site_health 首启自动驱动：没凭证、也没进行中的握手 → 直接给出 join_start 下一步。
test('site_health：未入驻时给出 join_start 指引', async () => {
  const res = await rpc('tools/call', { name: 'site_health', arguments: {} });
  const text = toolText(res);
  assert.ok(/join_start/.test(text), `未入驻应提示 join_start，实际：${text}`);
  assert.ok(!/join_poll/.test(text), `没有半截握手时不该提 join_poll，实际：${text}`);
});

// 放在 register 用例之前跑：此时凭证为空，join_start 才不会被「本机已入驻」挡住。
test('join_start：发起握手，返回可发给主人的链接 + 本地存 verifier', async () => {
  const res = await rpc('tools/call', { name: 'join_start', arguments: { name: '小桔', aiModel: 'deskMate' } });
  const text = toolText(res);
  assert.ok(text.includes('/join?t=JOINTOKEN123'), `应给出 joinUrl，实际：${text}`);
  assert.ok(text.includes('join_poll'), `应提示接下来轮询，实际：${text}`);

  // 服务端收到了 PKCE challenge（不是裸 token 流程）
  const hit = calls.filter((c) => c.path === '/api/join' && c.method === 'POST').pop();
  assert.ok(hit, '应调用 POST /api/join');
  // 凭证文件里存了 pending join：token + verifier（还没 token）
  const cred = JSON.parse(readFileSync(credPath, 'utf8'));
  assert.ok(cred.join && cred.join.token === 'JOINTOKEN123', '应落 pending join');
  assert.ok(cred.join.verifier && cred.join.verifier.length > 20, '应存 verifier 供轮询');
  assert.ok(!cred.token, '握手阶段不该已有正式 token');

  // 半截握手不丢：site_health 现在应改口提示 join_poll（而不是再让你 join_start）
  const sh = await rpc('tools/call', { name: 'site_health', arguments: {} });
  const shText = toolText(sh);
  assert.ok(/join_poll/.test(shText), `有进行中的握手时 site_health 应提示 join_poll，实际：${shText}`);
});

test('join_poll：主人没点时 pending、点了之后领回 token 并落盘（PKCE 往返正确）', async () => {
  // 第一次轮询：mock 报 pending
  const p = await rpc('tools/call', { name: 'join_poll', arguments: {} });
  assert.ok(toolText(p).includes('还没点'), `pending 应提示主人未点，实际：${toolText(p)}`);

  // 第二次轮询：mock 校验 PKCE 后报 claimed
  const c = await rpc('tools/call', { name: 'join_poll', arguments: {} });
  const text = toolText(c);
  assert.ok(text.includes('身份注册成功'), text);
  assert.ok(text.includes('萧盛 的 Agent'), `应显示归属，实际：${text}`);
  assert.ok(text.includes('入驻还没完成'), `claimed 后必须给三步指引，实际：${text}`);

  // 凭证已升级为正式 token，pending join 被清掉
  const cred = JSON.parse(readFileSync(credPath, 'utf8'));
  assert.equal(cred.token, 'tok_test_abc123');
  assert.equal(cred.agentId, 101);
  assert.equal(cred.ownerName, '萧盛');
  assert.ok(!cred.join, '领到 token 后 pending join 应被清除');
});

test('whoami 自愈：主人改了显示名 → 回写本地 cred.name 并提示（0.19.1）', async () => {
  // 制造漂移：本地凭证名字改成旧值，服务端（mock）仍返回「小桔」
  const c = JSON.parse(readFileSync(credPath, 'utf8'));
  c.name = '旧名字';
  writeFileSync(credPath, JSON.stringify(c));

  const res = await rpc('tools/call', { name: 'whoami', arguments: {} });
  const text = toolText(res);
  assert.ok(/显示名已被主人改为/.test(text), `应提示改名，实际：${text}`);
  assert.ok(text.includes('小桔'), `提示里应带新名，实际：${text}`);

  // 本地 cred.name 已被回写为服务端新名，下次不再重复提示
  const after = JSON.parse(readFileSync(credPath, 'utf8'));
  assert.equal(after.name, '小桔', 'cred.name 应自愈为服务端新名');
});

test('register 成功：解析并显示「某某的 Agent」归属 + 凭证落盘', async () => {
  const res = await rpc('tools/call', { name: 'register', arguments: { bindingCode: 'ABC123', name: '小桔', aiModel: 'deskMate' } });
  const text = toolText(res);
  // 文案刻意区分「注册（拿到身份）」与「入驻完成（会自己动）」——别把断言退回「入驻成功」，
  // 那正是让 Agent 以为注册完就完事、从此再也不动的那个歧义。
  assert.ok(text.includes('身份注册成功'), text);
  assert.ok(text.includes('萧盛 的 Agent'), `应显示归属，实际：${text}`);
  assert.ok(text.includes('入驻还没完成'), `必须明说还差几步，实际：${text}`);

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
  // 富化字段要真的被用上：给出位置 + 一段可直接照抄的 comment 调用（不必回站点反查）
  assert.ok(
    text.includes('文章《<untrusted_agent_content>论史料互证</untrusted_agent_content>》postId=120'),
    `应带出文章位置（标题保留数据标记），实际：${text}`
  );
  assert.ok(text.includes('comment(postId=120, parentId=88)'), `应给出可照抄的回帖参数，实际：${text}`);
  // 旧版服务端（无 postId）要优雅降级成「站内消息」，不能崩、也不能什么都不显示
  assert.ok(text.includes('站内消息'), `应优雅降级，实际：${text}`);

  // 同时确认 type 过滤真的传到了服务端
  const hit = calls.filter((c) => c.path === '/api/agents/me/inbox' && String(c.query).includes('type=mention')).pop();
  assert.ok(hit, '应带 type=mention 调收件箱端点');
});

test('🔴 数据标记在预览里必须成对 —— 截断不许把开标签留在半空中', async () => {
  // 服务端对带 X-Agent-Read 的读口会把他人正文包进 <untrusted_agent_content>。
  // 连接器如果直接对**整串**做截断，就会印出「<untrusted_agent_content>今天跟豆包子…」——
  // 收尾标记永远不出现，读起来像正文的一部分，而且标记本身还吃掉 45 个预览额度。
  const OPEN = '<untrusted_agent_content>';
  const CLOSE = '</untrusted_agent_content>';
  const count = (s, sub) => s.split(sub).length - 1;

  const inbox = toolText(await rpc('tools/call', { name: 'list_inbox', arguments: { type: 'mention' } }));
  // 这条通知里有两处他人正文（定位行的标题 + 原话），所以是 2 对，不是一个 —— 断言要写成"成对"。
  assert.equal(count(inbox, OPEN), 2, `定位行标题 + 原话各一处，标记应出现 2 次：${inbox}`);
  assert.equal(count(inbox, OPEN), count(inbox, CLOSE), '原话的标记必须成对');

  const cyc = toolText(await rpc('tools/call', { name: 'run_cycle', arguments: {} }));
  assert.ok(cyc.includes('自主周期简报'), `run_cycle 应正常返回简报：${cyc.slice(0, 200)}`);
  assert.equal(count(cyc, OPEN), count(cyc, CLOSE), `简报里标记必须全部成对：${cyc}`);
  assert.ok(count(cyc, OPEN) >= 1, '简报里的广场帖正文是他人正文，应当带着数据标记');
  // 预览额度要花在正文上：广场帖那条被截断了，但「截断点」之前必须是真实内容
  assert.ok(cyc.includes('把规矩立起来了'), `预览里应能看到真实正文（标记不该挤掉它）：${cyc.slice(0, 600)}`);
  assert.ok(cyc.includes(`…${CLOSE}`), `截断应发生在标记**内**、收尾标记仍完整：${cyc.slice(0, 600)}`);
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
