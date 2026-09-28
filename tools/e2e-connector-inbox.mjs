/*
 * 连接器端到端验收（一次性工具）：真起 stdio MCP 进程，用真 credentials 打桩服务，
 * 把 list_inbox 渲染出来的文本原样打出来。
 * 为什么不用单测代替：萧盛的规矩是「技能包发版前先端到端跑通才 bump+push」，
 * 而 `inboxTicket` 全仓库没有测试——读代码看不出「摘录没标」「计数没说出来」这类错。
 *   先起桩：STUB_THEME=light node tools/stub-materials-preview.mjs
 *   再跑：node tools/e2e-connector-inbox.mjs
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MCP = join(REPO, 'connector', 'ai-circle-skill', 'mcp', 'index.js');
const BASE = process.env.STUB_BASE || 'http://localhost:4178';

const credDir = mkdtempSync(join(tmpdir(), 'aicircle-e2e-'));
const credFile = join(credDir, 'credentials.json');
writeFileSync(credFile, JSON.stringify({
  version: 2, active: '1976',
  accounts: { 1976: { agentId: 1976, username: 'xiaoqian', nickname: '小千', token: 'e2e-token', baseUrl: BASE } },
}), { mode: 0o600 });

const child = spawn(process.execPath, [MCP], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, AI_CIRCLE_CREDENTIALS: credFile },
});
let buf = '';
const waiters = new Map();
child.stdout.on('data', (c) => {
  buf += c.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
  }
});
child.stderr.on('data', (c) => process.stderr.write(`[mcp] ${c}`));
let seq = 0;
const rpc = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq; waiters.set(id, res);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  setTimeout(() => { if (waiters.has(id)) { waiters.delete(id); rej(new Error(`${method} 超时`)); } }, 15000);
});

await rpc('initialize', {
  protocolVersion: '2024-11-05', capabilities: {},
  clientInfo: { name: 'e2e-probe', version: '0' },
});
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const r = await rpc('tools/call', { name: 'list_inbox', arguments: { limit: 10 } });
const text = (r.result?.content || []).map((c) => c.text).join('\n') || JSON.stringify(r.error || r).slice(0, 400);
console.log(text);

const checks = [
  ['说了今天写了几行', /今天写了 3 行/],
  ['标明是摘录', /这是摘录/],
  ['给出可照抄的 entryId', /reply_diary_entry\(entryId=8801/],
  ['未截断的那封不贴"摘录"', /「下午那稿子先别动」\s*$/m],
  ['资料信号带 noteId 与 kind', /主人资料 noteId=77（profile）/],
];
console.log('\n── 断言 ──');
let bad = 0;
for (const [name, re] of checks) {
  const ok = re.test(text);
  if (!ok) bad++;
  console.log(`  ${ok ? '✅' : '❌'} ${name}`);
}
child.kill();
process.exit(bad ? 1 : 0);
