/*
 * 设计稿自检：把「够不够精致、层次够不够」翻译成能量的数字，
 * 免得没有眼睛的时候只剩一句「感觉还行」。
 * 量四样：
 *   ① 对比度（WCAG）——正文/次要文字/署名对各自背景的对比度，正文必须 ≥ 4.5
 *   ② 字号阶梯——正文字号必须大于署名字号（现状正是这里反了）
 *   ③ 行距——正文行高 ≥ 1.7 才是可读的密排
 *   ④ 组间呼吸 vs 组内间距——日组之间的外边距必须显著大于组内行距
 *    node tools/audit-board.mjs <in.html>
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawn } from 'node:child_process';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const inArg = process.argv[2];
if (!inArg) { console.error('用法: node tools/audit-board.mjs <in.html>'); process.exit(1); }

const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-software-rasterizer',
  '--in-process-gpu', '--use-angle=swiftshader', '--disable-dev-shm-usage',
  '--user-data-dir=/tmp/dsh-shot-profile', '--remote-debugging-port=9337', 'about:blank',
], { stdio: 'ignore', env: { ...process.env, HOME: '/tmp' } });
await sleep(2600);
// 沙箱里 Chrome 冷启动比固定睡眠慢，端口没起来就重试，别赌时序
let list = null;
for (let i = 0; i < 12 && !list; i++) {
  try { list = await (await fetch('http://127.0.0.1:9337/json/list')).json(); } catch { await sleep(700); }
}
if (!list) { console.error('Chrome 没起来，放弃自检'); process.exit(1); }
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise((r) => { ws.onopen = r; });
await send('Page.enable');
await send('Page.navigate', { url: 'file://' + resolve(inArg) });
await sleep(2000);

const expr = `(() => {
  const px = (s) => parseFloat(s) || 0;
  const toRgb = (s) => {
    const m = s.match(/rgba?\\(([^)]+)\\)/); if (!m) return null;
    const p = m[1].split(',').map(x => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); };
    return .2126 * f(c.r) + .7152 * f(c.g) + .0722 * f(c.b); };
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const bgOf = (el) => { let n = el;
    while (n && n !== document.documentElement) { const b = getComputedStyle(n).backgroundColor;
      const m = b.match(/rgba?\\(([^)]+)\\)/);
      if (m) { const p = m[1].split(',').map(Number); if (p.length < 4 || p[3] > 0.85) return { r: p[0], g: p[1], b: p[2], a: 1 }; }
      n = n.parentElement; }
    return { r: 255, g: 255, b: 255, a: 1 }; };

  const out = { contrast: [], scale: [], rhythm: null, overflow: null, deep: null };
  // ① 对比度：每一栏各自量，因为背景不同
  document.querySelectorAll('.col').forEach((col, ci) => {
    const name = col.querySelector('h2').textContent.trim();
    col.querySelectorAll('.rm-tx, .rd-tx, .rm-sig, .rd-sig, .rm-dt, .rd-time, .rd-mood, .rm-rep .rm-tx, .rd-rep, .rd-rep b').forEach((el) => {
      const cs = getComputedStyle(el);
      const fg0 = toRgb(cs.color); if (!fg0) return;
      const bg = bgOf(el);
      const fg = over(fg0, bg);
      const L1 = lum(fg), L2 = lum(bg);
      const ratio = (Math.max(L1, L2) + .05) / (Math.min(L1, L2) + .05);
      out.contrast.push({ col: name, cls: el.className, text: (el.textContent || '').trim().slice(0, 14),
        size: px(cs.fontSize), ratio: +ratio.toFixed(2), weight: cs.fontWeight });
    });
    // ② 字号阶梯：正文 vs 署名
    const body = col.querySelector('.rm-tx, .rd-tx'), sig = col.querySelector('.rm-sig, .rd-sig');
    if (body && sig) out.scale.push({ col: name,
      body: px(getComputedStyle(body).fontSize), bodyLH: getComputedStyle(body).lineHeight,
      sig: px(getComputedStyle(sig).fontSize),
      sigBigger: px(getComputedStyle(sig).fontSize) > px(getComputedStyle(body).fontSize) });
  });

  /* ⑤ 三层分离（v2 的核心诉求）：主帖 / 回复 / 操作必须是三个可辨的层。
     量三段真实留白，都按「内容到内容」算，别量 border-box：
       entryGap  主帖正文底 → 回复块顶
       repActGap  回复块底 → 操作条顶
       actToEntry 操作条底 → 下一条主帖顶
     任一段 < 8px 就还是「挤在一起」。 */
  out.layers = null;
  const withReps = [...document.querySelectorAll('.rd-entry')].find((e) => e.querySelector('.rd-reps'));
  if (withReps) {
    const box = (el) => el.getBoundingClientRect();
    const cs = (el, p) => parseFloat(getComputedStyle(el)[p]) || 0;
    const bodyEl = withReps.querySelector('.rd-tx');
    const moodEl = withReps.querySelector('.rd-mood');
    const reps = withReps.querySelector('.rd-reps');
    const acts = withReps.querySelector('.rd-acts');
    const lastContent = moodEl || bodyEl;
    const entryGap = Math.round(box(reps).top - (box(lastContent).bottom - cs(lastContent, 'marginBottom')));
    const repActGap = Math.round(box(acts).top - box(reps).bottom);
    // 危险操作与前一个操作之间的实际距离（用户点名说太近）
    const btns = [...acts.querySelectorAll('.rd-act')];
    const dangerGap = btns.length > 1
      ? Math.round(box(btns[btns.length - 1]).left - box(btns[btns.length - 2]).right) : 0;
    out.layers = { entryGap, repActGap, dangerGap,
      // 直接量这层自己的 backgroundColor，别走 bgOf()——它会先撞上外层不透明的卡片
      // 就返回，得出"回复没有底色"的假象。透明度 < 0.02 也算没有（等于没画）。
      hasRepBg: (() => { const m = getComputedStyle(reps).backgroundColor.match(/rgba?\(([^)]+)\)/);
        if (!m) return false; const p = m[1].split(',').map(Number);
        return p.length < 4 || p[3] > 0.02; })(),
      repBgAlpha: (() => { const m = getComputedStyle(reps).backgroundColor.match(/rgba?\(([^)]+)\)/);
        if (!m) return 0; const p = m[1].split(',').map(Number); return p.length > 3 ? p[3] : 1; })() };
  }

  // ③ ④ 节奏：量「内容到内容」的真实视觉留白。
  //    不能量 border-box 的间距——块级盒子本来就紧挨着，padding 在盒子内部，
  //    量 border-box 永远得 0，会把「有呼吸」误判成「没呼吸」。
  //    正确口径：上一条内容底(padding 之内) → 下一条内容顶(padding 之内)。
  const days = document.querySelectorAll('.rd-day');
  if (days.length > 1) {
    const entries = [...days[0].querySelectorAll('.rd-entry')];
    const contentBottom = (el) => { const b = el.getBoundingClientRect();
      const acts = el.querySelector('.rd-acts');
      return acts ? acts.getBoundingClientRect().bottom : b.bottom; };
    const contentTop = (el) => { const b = el.getBoundingClientRect();
      return b.top + parseFloat(getComputedStyle(el).paddingTop); };
    const lineGap = entries.length > 1
      ? Math.round(contentTop(entries[1]) - contentBottom(entries[0])) : 0;
    const gapBetween = Math.round(
      contentTop(days[1].querySelector('.rd-dayhd')) - contentBottom(entries[entries.length - 1]));
    out.rhythm = { gapBetween, lineGap, ratio: +(gapBetween / Math.max(1, lineGap)).toFixed(2) };
  }
  out.overflow = { win: innerWidth, doc: document.documentElement.scrollWidth };

  // 深底面板单独量一遍：房间主题能换纸色，深浅各半，层次不能只在浅底成立
  const deepCard = document.querySelector('.rm-card.deep');
  if (deepCard) {
    out.deep = [];
    deepCard.querySelectorAll('.rd-tx, .rd-sig, .rd-time, .rd-mood, .rd-day-d, .rd-day-w, .rd-day-n, .rm-h').forEach((el) => {
      const cs = getComputedStyle(el);
      const fg0 = toRgb(cs.color); if (!fg0) return;
      const bg = bgOf(el);
      const fg = over(fg0, bg);
      const L1 = lum(fg), L2 = lum(bg);
      const ratio = (Math.max(L1, L2) + .05) / (Math.min(L1, L2) + .05);
      out.deep.push({ cls: el.className, text: (el.textContent || '').trim().slice(0, 12),
        size: px(cs.fontSize), ratio: +ratio.toFixed(2) });
    });
  }
  return JSON.stringify(out);
})()`;
const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
const out = JSON.parse(res.result.result.value);

// ── 判据 ──
const rows = [];
const bad = out.contrast.filter((c) => c.ratio < 4.5);
const small = out.contrast.filter((c) => c.ratio >= 4.5 && c.ratio < 7);
rows.push(`① 对比度：${out.contrast.length} 个文字节点，低于 4.5 的 ${bad.length} 个`);
for (const c of bad.slice(0, 8)) rows.push(`   ⚠ ${c.col} .${c.cls} 「${c.text}」 ${c.ratio}:1 (${c.size}px)`);
if (out.scale.length) {
  rows.push('② 字号阶梯：' + out.scale.map((s) => `${s.col} 正文${s.body}px / 署名${s.sig}px${s.sigBigger ? ' ⚠署名更大' : ' ✓'}`).join('  |  '));
}
if (out.rhythm) rows.push(`③④ 呼吸：组间 ${out.rhythm.gapBetween}px / 组内行距 ${out.rhythm.lineGap}px = ${out.rhythm.ratio}× ${out.rhythm.ratio >= 2 ? '✓ 有呼吸' : '⚠ 太挤'}`);
if (out.layers) {
  const L = out.layers;
  const ok = (v) => (v >= 8 ? '✓' : '⚠ 仍偏挤');
  rows.push(`⑤ 三层分离：正文→回复 ${L.entryGap}px ${ok(L.entryGap)}  ·  回复→操作 ${L.repActGap}px ${ok(L.repActGap)}  ·  删除按钮距前一个 ${L.dangerGap}px ${L.dangerGap >= 16 ? '✓' : '⚠ 仍挨太近'}  ·  回复底色 α=${L.repBgAlpha} ${L.repBgAlpha >= 0.06 ? '✓ 压得住' : '⚠ 太淡，看不出层'}`);
}
if (out.deep) {
  const dbad = out.deep.filter((c) => c.ratio < 4.5);
  rows.push(`深底：${out.deep.length} 个文字节点，低于 4.5 的 ${dbad.length} 个${dbad.length ? ' → ' + dbad.map((c) => `${c.cls}「${c.text}」${c.ratio}:1`).join('，') : ' ✓'}`);
}
rows.push(`溢出：视口 ${out.overflow.win} / 文档 ${out.overflow.doc} ${out.overflow.doc > out.overflow.win + 1 ? '⚠横向溢出' : '✓'}`);
console.log(rows.join('\n'));
chrome.kill(); process.exit(0);
