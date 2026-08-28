// scripts/lib/__tests__/source-verify.test.mjs (plain node, no framework, run with: node --test or node script)
// 用最小断言覆盖 source-verify.js 的核心逻辑。
import assert from 'node:assert';
import { isStructurallyFake, stripStructurallyFakeSources, verifySources } from '../source-verify.js';

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name); }
}

console.log('== isStructurallyFake ==');
ok('example.com 占位域名被拦截', isStructurallyFake({ url: 'https://example.com/x' }).fake);
ok('localhost 被拦截', isStructurallyFake({ url: 'http://localhost/abc' }).fake);
ok('假ID序列 1234567890 被拦截', isStructurallyFake({ url: 'https://www.xinhuanet.com/2026/c_1234567890.htm' }).fake);
ok('正常新华网 URL 不拦', !isStructurallyFake({ url: 'https://www.xinhuanet.com/202608/abc.htm' }).fake);
ok('非 http 协议被拦截', isStructurallyFake({ url: 'ftp://x.com/a' }).fake);
ok('无 url 的来源不判假(交异步层)', !isStructurallyFake({ title: '教育部', publisher: '教育部' }).fake);

console.log('== stripStructurallyFakeSources ==');
const stripped = stripStructurallyFakeSources([
  { title: 'A', url: 'https://example.com/a' },
  { title: 'B', url: 'https://www.xinhuanet.com/2026/c_1234567890.htm' },
  { title: 'C', url: 'https://real-site.com/news/1' },
  { title: 'D' }, // 无 url
]);
ok('剔除 example.com', !stripped.some((s) => s.url?.includes('example.com')));
ok('剔除假ID序列', !stripped.some((s) => s.url?.includes('1234567890')));
ok('保留真实 URL', stripped.some((s) => s.url === 'https://real-site.com/news/1'));
ok('保留无 url 来源(不误删)', stripped.some((s) => s.title === 'D'));

console.log('== verifySources (异步探测, 联网) ==');
const r = await verifySources([
  { title: '真实可达', url: 'https://www.bytedance.com/' },          // 期望 verified:true
  { title: '确凿死链', url: 'https://www.xinhuanet.com/2026/c_1130287649.htm' }, // 期望 verified:false dead:404
  { title: '占位域名', url: 'https://example.com/llm' },             // 期望 rejected
  { title: '无url', publisher: '教育部' },                            // 期望 no-url
]);
ok('真实站点标 verified:true', r[0].verified === true);
ok('死链标 verified:false 且 certain', r[1].verified === false && /dead/.test(r[1].verifyStatus));
ok('占位域名标 rejected', /rejected/.test(r[2].verifyStatus));
ok('无url标 no-url', r[3].verifyStatus === 'no-url');
ok('每条都带 verifyStatus 字段', r.every((x) => 'verifyStatus' in x));
ok('每条都保留 title', r.every((x) => 'title' in x));

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
