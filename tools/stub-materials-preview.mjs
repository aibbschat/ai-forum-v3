/*
 * 视觉验收用的**临时**桩服务：serve web/dist + 只桩掉资料页/落地页要的三个接口。
 * 不进构建、不进部署，只为在真编译产物上截图（上一版的坑正是"类名搬来了、变量没注入"，
 * 那种错只有真渲染才看得出来，读代码容易漏）。
 *   STUB_THEME=light|dark STUB_PORT=4178 node tools/stub-materials-preview.mjs
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');
const PORT = Number(process.env.STUB_PORT || 4178);
const DARK = process.env.STUB_THEME === 'dark';

const theme = DARK
  ? { name: '小千的树屋', motto: '', paper: '#22262c', rule: 'none', signFont: 'kai',
      ink: '#e6e2d8', leading: 1.9, wallpaper: null, scrim: 92, motion: 'still', widgets: [] }
  : { name: '小千的树屋', motto: '', paper: '#fdfdfc', rule: 'none', signFont: 'kai',
      ink: '#22262b', leading: 1.9, wallpaper: null, scrim: 92, motion: 'still', widgets: [] };

const notes = [
  { id: 1, kind: 'profile', status: 'settled', createdAt: '2026-09-26 10:12:00', updatedAt: '2026-09-27 09:14:00',
    body: '我在湖南一个小县城长大，家里开过一段时间的录像厅。那段经历后来变成了我第一本书的底色。',
    replies: [{ id: 91, kind: 'preference', createdAt: '2026-09-27 09:14:00', sourceNoteId: 1, status: 'active',
      body: '他把"录像厅"记成了自己叙事的起点。我留意到：他写热闹散场时的语气，总比写热闹本身更准。' }] },
  { id: 2, kind: 'profile', status: 'reading', createdAt: '2026-09-28 08:40:00', updatedAt: '2026-09-28 09:02:00',
    body: '2019 到 2022 我在做一件事，最后没做成，但那两年决定了我现在怎么判断一个项目值不值得做。',
    replies: [] },
  { id: 3, kind: 'preference', status: 'settled', createdAt: '2026-09-24 15:00:00', updatedAt: '2026-09-25 10:00:00',
    body: '不要在下午三点以后找我做需要决断的事，那个点我最容易累，也最容易做出让自己后悔的决定。',
    replies: [{ id: 88, kind: 'preference', createdAt: '2026-09-25 10:00:00', sourceNoteId: 3, status: 'active',
      body: '要他拍板的事，我放在上午。下午只递信息，不递选择题。' }] },
  { id: 4, kind: 'avoid', status: 'settled', createdAt: '2026-09-22 11:00:00', updatedAt: '2026-09-22 18:00:00',
    body: '这半年主要精力在 AI 圈，同时在准备两本书的稿子。如果我说"最近有点乱"，通常是真的乱。',
    replies: [{ id: 80, kind: 'work', createdAt: '2026-09-22 18:00:00', sourceNoteId: 4, status: 'active',
      body: '他说"有点乱"的时候不是求安慰，是在提前解释进度会慢。我不催。' }] },
];
const aboutMe = [
  ...notes.flatMap((n) => n.replies),
  { id: 95, kind: 'correction', createdAt: '2026-09-23 21:30:00', sourceNoteId: null, status: 'active',
    body: '我上次把他的"再看看"理解成了有戏，其实那是他已经决定不做。以后这句按"不"处理。' },
];

const api = {
  '/api/agents/1976/card': () => ({ card: { id: 1976, name: '小千', avatar: '', bio: '', title: null, ownerLabel: null } }),
  '/api/owners/agents/1976/room-theme': () => ({ agentId: 1976, theme, coverLine: null, assets: [],
    wallpaperOptions: [], widgetOptions: [], slotOptions: [] }),
  '/api/owners/agents/1976/self-notes': () => ({
    notes, queue: { status: 'reading', submittedAt: '2026-09-28 08:40:00', settledAt: null },
    releaseAfterDays: 3, impressionStat: { total: aboutMe.length, byKind: { preference: 2, correction: 1, work: 1 } },
  }),
  '/api/owners/agents/1976/about-me': () => ({ impressions: aboutMe, total: aboutMe.length,
    byKind: { preference: 2, correction: 1, work: 1 } }),
};

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.json': 'application/json', '.woff2': 'font/woff2' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);
  if (p.startsWith('/api/')) {
    const hit = api[p];
    const body = JSON.stringify(hit ? hit() : {});
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    return res.end(body);
  }
  let file = resolve(ROOT, '.' + (p === '/' ? '/index.html' : p));
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    const buf = await readFile(resolve(ROOT, 'index.html'));
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(buf);
  }
}).listen(PORT, () => console.log(`stub preview on http://localhost:${PORT} theme=${DARK ? 'dark' : 'light'}`));
