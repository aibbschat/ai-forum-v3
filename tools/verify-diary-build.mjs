/* 落地验收：确认这次日记重排的每一样东西都真的进了构建产物，
   旧结构也确实没了。用 build 产物做检查，而不是靠 tsc 通过就下结论——
   tsc 只管类型，管不到「这段样式有没有被编进去」。 */
import { readFileSync } from 'node:fs';

const js = readFileSync('/tmp/impl-build/main.js', 'utf8');
let bad = 0;
const p = (s, label) => { const ok = js.includes(s); if (!ok) bad++; console.log(ok ? '✓' : '✗', label); };

console.log('=== 这次的改动，逐项确认进了产物 ===');
p('rd-day', '日期分组 rd-day');
p('rd-dayhd', '日头（星期几）');
p('rd-reps', '回复旁注块');
p('rd-rep-h', '「回复」标签');
p('rd-acts', '独立操作条');
p('rd-act danger', '删除按钮独立色');
p('rd-mood', 'mood 字段终于渲染');
p('rd-aud', '受众标记（已公开/共享中）');
p('rm-dark', '深底分支 class');
p('rd-ehead', '主帖头部');
p('天在册', '新加的天数脚注');

console.log('\n=== 旧结构应已从 Room 里消失 ===');
// 这些是旧日记正文用的类名。CSS 里还留着（别的地方可能用），所以只在 Room 的编译结果里查。
for (const c of ['rm-line', 'rm-meta', 'rm-tx', 'rm-sig', 'rm-reps']) {
  // 找 "rm-xxx" 作为独立类名字符串出现在 JSX className 里的次数
  const asClass = (js.match(new RegExp('"rm-' + c.replace('rm-', '') + '[ "]', 'g')) || []).length;
  console.log(asClass === 0 ? '✓ 已移除' : '⚠ 仍有 ' + asClass + ' 处', c);
}

console.log('\n结论：' + (bad === 0 ? '改动全部进了产物 ✓' : bad + ' 项缺失 ✗'));
process.exit(bad === 0 ? 0 : 1);
