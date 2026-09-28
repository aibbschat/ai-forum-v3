/* 一次���设计稿截图（file:// 版）：用 CDP 截整页。
 *  仓库里 tools/shot-device.mjs 是 localhost 版（走已起的服务）；
 *  设计稿多数还没进服务，用这个直接截 file://。
 *    node tools/shot-html.mjs <in.html> <out.png> [widthPx] [scale]
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [, , inArg, outArg, wArg, scaleArg] = process.argv;
const W = Number(wArg || 1600);
const SCALE = Number(scaleArg || 1.5);

/*
 * 起浏览器的参数不是随手写的：DSH 的文件沙箱里 headless Chrome 默认会崩在这两步
 *   GPU process isn't usable. Goodbye.            → --in-process-gpu --use-angle=swiftshader --disable-gpu
 *   Crashpad 写 ~/Library/.../Crashpad 被拒        → HOME 指到 /tmp
 * 另外必须给独立 --user-data-dir，否则会和主人已经开着的 Chrome 抢 profile。
 * 踩过的坑记在这，免得下次又去试 --screenshot 那个已废弃的老参数。
 */
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-software-rasterizer',
  '--in-process-gpu', '--use-angle=swiftshader', '--disable-dev-shm-usage',
  '--user-data-dir=/tmp/dsh-shot-profile', '--remote-debugging-port=9336', 'about:blank',
], { stdio: 'ignore', env: { ...process.env, HOME: '/tmp' } });
await sleep(2600);
const list = await (await fetch('http://127.0.0.1:9336/json/list')).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise((r) => { ws.onopen = r; });

await send('Emulation.setDeviceMetricsOverride', { width: W, height: 1200, deviceScaleFactor: SCALE, mobile: false });
await send('Page.enable');
await send('Page.navigate', { url: 'file://' + resolve(inArg) });
await sleep(2200);

// 量一下文档真实宽高，顺带报横向溢出（错位图往往是没溢出却被裁了）
const probe = await send('Runtime.evaluate', {
  expression: `JSON.stringify({win:innerWidth,doc:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight})`,
  returnByValue: true,
});
const m = JSON.parse(probe.result.result.value);
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
await writeFile(outArg, Buffer.from(shot.result.data, 'base64'));
console.log(`${outArg}  视口宽=${m.win} 文档宽=${m.doc} 文档高=${m.h}${m.doc > m.win + 1 ? '  ⚠横向溢出' : '  无溢出'}`);
chrome.kill(); process.exit(0);
