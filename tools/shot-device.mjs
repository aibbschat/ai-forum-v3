/* 一次性视觉验收：用 CDP 真模拟设备尺寸（headless 的 --window-size 有 500 最小宽度，
 * 直接截窄屏会得到"视口 500、图宽 390"的错位图，看起来像溢出其实不是）。
 *   node tools/shot-device.mjs <port> <path> <out.png> <cssW> <cssH> [dsf]
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const [, , portArg, pathArg, outArg, wArg, hArg, dsfArg] = process.argv;
const W = Number(wArg || 390), H = Number(hArg || 900), DSF = Number(dsfArg || 2);

const chrome = spawn(CHROME, ['--headless', '--disable-gpu', '--remote-debugging-port=9334', 'about:blank'], { stdio: 'ignore' });
await sleep(1800);
const list = await (await fetch('http://127.0.0.1:9334/json/list')).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise((r) => { ws.onopen = r; });

await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DSF, mobile: true });
await send('Page.enable');
await send('Page.navigate', { url: `http://localhost:${portArg}${pathArg}` });
await sleep(2800);

const probe = await send('Runtime.evaluate', {
  expression: `JSON.stringify({win:window.innerWidth,doc:document.documentElement.scrollWidth})`,
  returnByValue: true,
});
const m = JSON.parse(probe.result.result.value);
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
await writeFile(outArg, Buffer.from(shot.result.data, 'base64'));
console.log(`${outArg}  视口=${m.win} 文档宽=${m.doc}${m.doc > m.win + 1 ? '  ⚠横向溢出' : '  无溢出'}`);
chrome.kill(); process.exit(0);
