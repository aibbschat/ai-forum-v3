import { parseBlocks, serializeBlocks, makeImageBlock } from './mdBlocks';

let fail = 0;
const check = (name: string, input: string) => {
  const out = serializeBlocks(parseBlocks(input));
  if (out !== input) {
    fail++;
    console.log(`❌ ${name}\n   in : ${JSON.stringify(input)}\n   out: ${JSON.stringify(out)}`);
  }
};

const cases: [string, string][] = [
  ['空串', ''],
  ['单字符', 'A'],
  ['尾随换行', 'A\n'],
  ['仅换行', '\n'],
  ['仅多个换行', '\n\n\n'],
  ['两行', 'A\nB'],
  ['图片夹在段落间', 'A\n\n![x](/covers/a.png)\n\nB'],
  ['仅一张图', '![x](/covers/a.png)'],
  ['两张图相邻', '![a](/covers/a.png)\n![b](/covers/b.png)'],
  ['图在两图之间有空行', '![a](/covers/a.png)\n\n![b](/covers/b.png)'],
  ['带 title', '![x](/covers/a.png "标题")'],
  ['行首缩进的图', '   ![x](/covers/a.png)'],
  ['行尾有空格的图', '![x](/covers/a.png)   '],
  ['行内混排不识别', '文字 ![a](b.png) 文字'],
  ['开头图结尾文', '![x](/covers/a.png)\n正文'],
  ['开头文结尾图', '正文\n![x](/covers/a.png)'],
  ['CRLF', 'A\r\n![x](/covers/a.png)\r\nB'],
  ['data URI 长图', '![x](data:image/png;base64,' + 'A'.repeat(5000) + ')'],
  ['方括号alt', '![a[b]c](/covers/a.png)'],
  ['空 alt', '![](/covers/a.png)'],
  ['标题样式', '## 标题\n\n正文\n\n![x](/covers/a.png)\n\n> 引用\n'],
  ['代码块里的图片语法', '```\n![x](/covers/a.png)\n```'],
  ['列表', '- a\n- b\n\n![x](/covers/a.png)\n'],
];

for (const [n, s] of cases) check(n, s);

// 模糊测试：随机拼接各种片段，验证 round-trip 严格无损
const atoms = [
  'a', 'B', '中文', ' ', '  ', '\n', '\n\n', '\t',
  '![x](/covers/a.png)', '![](u.png)', '![alt](/covers/' + 'z'.repeat(40) + '.png)',
  '![x](https://aibbs.chat/covers/inline-123-abc.png)', '文字 ![a](b) 文',
  '## ', '```', '> ', '- ', '**', ']', '[', ')', '(', '!', 'data:image/png;base64,AAAA',
];
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const ROUNDS = 30000;
for (let r = 0; r < ROUNDS; r++) {
  const n = 1 + Math.floor(rnd() * 8);
  let s = '';
  for (let i = 0; i < n; i++) s += atoms[Math.floor(rnd() * atoms.length)];
  check(`fuzz#${r}`, s);
  if (fail > 5) break;
}

// 结构断言：图片行确实被识别成图片块，而不是留在文本块里
const b = parseBlocks('正文\n\n![截图](/covers/inline-1.png)\n\n后文');
console.log('\n结构检查:', b.map((x) => (x.kind === 'image' ? `image(${x.alt})` : `text(${JSON.stringify(x.value)})`)).join(' | '));
const imgCount = b.filter((x) => x.kind === 'image').length;
if (imgCount !== 1) { fail++; console.log('❌ 图片块数量应为 1，实际', imgCount); }

// 历史脏数据识别
const legacy = parseBlocks('![x](data:image/png;base64,' + 'A'.repeat(5000) + ')');
if (!(legacy[0].kind === 'image' && legacy[0].legacyEmbedded)) { fail++; console.log('❌ 未识别出 legacyEmbedded'); }

// makeImageBlock 的可序列化性
const mb = makeImageBlock('a[b]c.png', '/covers/x.png');
if (serializeBlocks([mb]) !== '![abc.png](/covers/x.png)') { fail++; console.log('❌ makeImageBlock raw 不对:', mb.raw); }

console.log(fail === 0 ? `\n✅ 全部通过（含 ${ROUNDS} 轮模糊测试，round-trip 严格无损）` : `\n❌ 失败 ${fail} 项`);
if (fail !== 0) throw new Error(`mdBlocks 无损性测试失败 ${fail} 项`);
