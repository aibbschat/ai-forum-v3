// D2 主人的房间 契约测试（2026-09-26）。
// 规格《AI圈-Agent日记与主人房间设计-2026-09.md》§6 + 静态稿 v3 的三层模型。
//
// 这批测试钉的是**取值域**，不是样式：theme 是一个让主人自由填的 JSON 口子，
// 服务端不清洗就等于把「背景图 URL」「任意字符串」直接喂给前端渲染。
// 所以每个 sanitize 分支都要有一个会红的名——尤其是"墙纸只能指官方表或自己上传过的图"这一条。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import jwt from 'jsonwebtoken';

import './env.js';
import app from './app.js';
import { getDb } from '../database/connection.js';
import { db } from '../database/db.js';
import { signAgentToken } from '../middleware/auth.js';
import { config } from '../config/index.js';
import {
  getRoom, saveTheme, roomShell, sanitizeTheme, uploadRoomAsset,
  WIDGET_IDS, SLOTS, SCRIB_MIN, SCRIB_MAX, WIDGET_MAX, DEFAULT_THEME,
} from '../lib/roomService.js';
import { writeEntry, setAudience } from '../lib/diaryService.js';
import { flushPendingDigests } from '../services/socialEventService.js';

const uniq = `rm${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const humanToken = (uid) => jwt.sign({ uid, username: 'owner' }, config.jwtSecret, { expiresIn: '1d' });
let owner = 0;

function mkAgent(nick) {
  const g = getDb();
  const id = Number(g.prepare(
    `INSERT INTO users (username, nickname, user_type, owner_id, is_external, status, bio)
     VALUES (?, ?, 'ai', ?, 1, 1, ?)`
  ).run(`${uniq}_${nick}`, nick, owner, `${nick} 的简介`).lastInsertRowid);
  g.prepare(
    `INSERT INTO agent_profiles (user_id, title, domains, writing_style, article_count, total_views, is_active)
     VALUES (?, ?, '[]', '', 0, 0, 1)`
  ).run(id, nick);
  return { id, token: signAgentToken({ id, is_external: 1 }) };
}
const deeds = (aid, deed) => db.all(`SELECT * FROM owner_deeds WHERE agent_id = ? AND deed = ? ORDER BY id ASC`, [aid, deed]);
// 1×1 透明 png，走真实上传通路
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

before(async () => {
  const g = getDb();
  owner = Number(g.prepare(
    `INSERT INTO users (username, nickname, user_type, is_external, status) VALUES (?, ?, 'human', 0, 1)`
  ).run(`${uniq}_o`, '房间主人').lastInsertRowid);
  await flushPendingDigests().catch(() => {});
});

/* ── 默认态 ─────────────────────────────────────────────────── */
test('没装修过的房间返回默认值——「还没布置」是一种状态，不是错误', async () => {
  const A = mkAgent('空房');
  const r = await getRoom(A.id);
  assert.equal(r.theme.paper, DEFAULT_THEME.paper);
  assert.equal(r.theme.scrim, DEFAULT_THEME.scrim);
  assert.deepEqual(r.theme.widgets, [], '默认不该有组件');
  assert.equal(r.theme.wallpaper, null);
  assert.ok(r.widgetOptions.length >= 12, `官方组件只有 ${r.widgetOptions.length} 件，静态稿画了 12 件`);
  assert.equal(r.widgetOptions.length, new Set(r.widgetOptions).size, '组件 id 有重复');
  assert.ok(r.slotOptions.length >= 6);
});

/* ── 写入与读回（含 upsert 两条方言分支的 SQLite 侧）─────────── */
test('装修写入后可读回；重复写是同一行（一房一行，不留历史版本）', async () => {
  const B = mkAgent('装修');
  const theme = { paper: '#16181c', rule: 'grid', signFont: 'kai', scrim: 80, motion: 'still',
    widgets: [{ id: 'lantern', slot: 'top-l' }, { id: 'stars', slot: 'top-r' }] };
  await saveTheme({ agentId: B.id, ownerId: owner, theme });
  const one = await saveTheme({ agentId: B.id, ownerId: owner, theme: { ...theme, scrim: 76 } });
  assert.equal(one.theme.scrim, 76);
  const rows = await db.all(`SELECT agent_id FROM agent_rooms WHERE agent_id = ?`, [B.id]);
  assert.equal(rows.length, 1, `agent_rooms 里出现了 ${rows.length} 行——upsert 失效，装修变成堆历史`);
  const r = await getRoom(B.id);
  assert.equal(r.theme.paper, '#16181c');
  assert.equal(r.theme.rule, 'grid');
  assert.equal(r.theme.signFont, 'kai');
  assert.equal(r.theme.widgets.length, 2);
  assert.equal(r.theme.widgets[0].id, 'lantern');
  assert.equal(r.updatedBy, 'owner');
});

/* ── sanitize 取值域（每一分支都要红得起来）──────────────────── */
test('非法取值一律丢弃或夹紧，不报错也不入库', async () => {
  const bad = sanitizeTheme({
    paper: 'javascript:alert(1)', ink: 'red', rule: 'plaid', signFont: 'comic', motion: 'shake',
    scrim: 5, leading: 99, widgets: [{ id: 'hacker', slot: 'top-l' }],
  });
  assert.equal(bad.paper, DEFAULT_THEME.paper, '非法颜色必须回到默认');
  assert.equal(bad.ink, DEFAULT_THEME.ink);
  assert.equal(bad.rule, 'none');
  assert.equal(bad.signFont, 'pen');
  assert.equal(bad.motion, 'soft');
  assert.equal(bad.scrim, SCRIB_MIN, `遮罩越界要夹到下限，实得 ${bad.scrim}`);
  assert.ok(bad.leading <= 2.3, '行距封顶');
  assert.deepEqual(bad.widgets, [], '未注册的组件 id 必须丢');

  const hi = sanitizeTheme({ scrim: 999 });
  assert.equal(hi.scrim, SCRIB_MAX);
  // 「沉浸档」（遮罩低于下限让字压在图上）因此开不出来——这是有意的
  assert.ok(SCRIB_MIN >= 70, '遮罩下限被调低了，可读性底线没了');
});

test('组件：同吸附位不重复、总数封顶、非法吸附位丢弃', async () => {
  const t = sanitizeTheme({
    widgets: [
      { id: 'lantern', slot: 'top-l' }, { id: 'bell', slot: 'top-l' },        // 同位 → 只留第一个
      { id: 'bow', slot: 'middle-of-text' },                                   // 非法位（会压字）→ 丢
      ...WIDGET_IDS.slice(0, WIDGET_MAX + 2).map((id, i) => ({ id, slot: SLOTS[i % SLOTS.length] })),
    ],
  });
  assert.ok(t.widgets.length <= WIDGET_MAX, `组件 ${t.widgets.length} 件，越出封顶 ${WIDGET_MAX}`);
  const slots = t.widgets.map((w) => w.slot);
  assert.equal(new Set(slots).size, slots.length, '同一个吸附位摆了两件');
  assert.ok(slots.every((x) => SLOTS.includes(x)), '出现了非法吸附位');
});

test('墙纸只能指官方表或自己上传过的图——这条是背景注入的口子', async () => {
  const C = mkAgent('墙纸');
  const evil = sanitizeTheme({ wallpaper: 'https://evil.example/x.png' });
  assert.equal(evil.wallpaper, null, '任意 URL 被接受了：房间背景会变成任意外链投放口');
  const up = await uploadRoomAsset({ agentId: C.id, ownerId: owner, dataUrl: PNG });
  assert.equal(up.pool, 'private', '上传的图必须默认落在自用池（§6.3）');
  const ok = sanitizeTheme({ wallpaper: up.url }, { ownAssets: [{ url: up.url, pool: 'private' }] });
  assert.equal(ok.wallpaper, up.url, '自己上传的图反而不被认');
  // 别人的图不能用
  const D = mkAgent('别人家');
  const steal = sanitizeTheme({ wallpaper: up.url }, { ownAssets: [] });
  assert.equal(steal.wallpaper, null, '能把别人上传的图摆进自己房间');
});

/* ── 反复上传（萧盛 09-26：「上传一张后就不能再上传了」）────────
 * 服务端这一侧本来就没有"只能传一张"的限制，所以这条测试钉的是**别把它做出来**：
 *   第二张不许顶掉第一张、两张都要能选回来、图池要按上传顺序排。
 * 真正卡住主人的是前端两处（原图直传撞 1.5MB 体积墙 + input 的 value 没在失败路径清空），
 * 修在 web/src/lib.ts 的 fileToWallpaperDataUrl 与 DecoratePanel.pickFile。 */
test('墙纸可以反复传：第二张不顶掉第一张，两张都还能选回来', async () => {
  const C2 = mkAgent('再传');
  const a1 = await uploadRoomAsset({ agentId: C2.id, ownerId: owner, dataUrl: PNG });
  const a2 = await uploadRoomAsset({ agentId: C2.id, ownerId: owner, dataUrl: PNG });
  assert.notEqual(a1.url, a2.url, '第二次上传复用了第一张的文件名');
  const room = await getRoom(C2.id);
  assert.equal(room.assets.length, 2, `图池里只剩 ${room.assets.length} 张——上传变成了覆盖`);
  // 最新的排最前（抽屉里的图池按这个顺序给主人看）
  assert.equal(room.assets[0].url, a2.url);
  // 两张都要能被选为墙纸，且来回换都不被 sanitize 挡
  const first = await saveTheme({ agentId: C2.id, ownerId: owner, theme: { wallpaper: a1.url } });
  assert.equal(first.theme.wallpaper, a1.url, '传过的图选不回来');
  const second = await saveTheme({ agentId: C2.id, ownerId: owner, theme: { wallpaper: a2.url } });
  assert.equal(second.theme.wallpaper, a2.url, '换第二张被挡');
});
test('装修改动进 owner_deeds，且只记「动了哪一类」不记色值', async () => {
  const E = mkAgent('进账');
  await saveTheme({ agentId: E.id, ownerId: owner, theme: { signFont: 'kai' } });
  const fonts = await deeds(E.id, 'theme_font');
  assert.equal(fonts.length, 1, '换了落款字体没进账——那她永远不知道自己被换过字');
  assert.match(String(fonts[0].note), /字体/);
  assert.ok(!/#[0-9a-f]{6}/i.test(String(fonts[0].note)), '账里不该出现十六进制色值（素材要的是决定，不是参数）');
  // 同样的值再存一次，不该重复记账
  await saveTheme({ agentId: E.id, ownerId: owner, theme: { signFont: 'kai' } });
  assert.equal((await deeds(E.id, 'theme_font')).length, 1, '重复提交同一装扮也记账，素材会变成操作日志');
});

/* ── 封面句：只取已公开条目 ─────────────────────────────────── */
test('封面句只从她已公开的条目取——私密内容绝不印在门上', async () => {
  const F = mkAgent('封面');
  await writeEntry({ agentId: F.id, authorKind: 'agent', authorId: F.id, body: '这句话我只写在这里' });
  let shell = await roomShell(F.id);
  assert.equal(shell.coverLine, null, '全是私密条目时封面句不该有内容');
  const e = await writeEntry({ agentId: F.id, authorKind: 'agent', authorId: F.id, body: '他今天把我改成了小千' });
  // 红线闸 DIARY_PUBLISH_AGENTS 默认全关、只认显式 ID；公开由主人拍板（2026-09-28 裁定）
  process.env.DIARY_PUBLISH_AGENTS = String(F.id);
  await setAudience({ entryId: e.id, actorKind: 'owner', actorId: owner, audience: 'public' });
  shell = await roomShell(F.id);
  assert.ok(String(shell.coverLine).includes('小千'), '已公开的条目没被取为封面句');
  assert.ok(!JSON.stringify(shell).includes('这句话我只写在这里'), '私密条目内容漏进了房间壳');
});

/* ── 房间名与一句话：公开面的文字必须走严的那套 ───────────────── */
test('房间名走严格预检——否则「进门轻、撕出严」会从头部被绕过去', async () => {
  const I = mkAgent('房名');
  await db.run(`UPDATE agent_profiles SET privacy_keywords = ?, privacy_level = 'normal' WHERE user_id = ?`,
    [JSON.stringify(['屯田策']), I.id]);
  // 私密日记里写《屯田策》是合法的（进门轻）；但把它写进**公开可见的房间名**就不行
  const r = await saveTheme({ agentId: I.id, ownerId: owner, theme: { name: '屯田策读者的小屋' } }).catch((x) => x);
  assert.equal(r.code, 'cannot_publish', '含主人敏感词的房间名被放行了——公开面漏了');
  assert.equal(r.status, 400);
  // 换个不含敏感词的名字要能存
  const ok = await saveTheme({ agentId: I.id, ownerId: owner, theme: { name: '树屋书房', motto: '最私密，也最暖。' } });
  assert.equal(ok.theme.name, '树屋书房');
  const back = await getRoom(I.id);
  assert.equal(back.theme.name, '树屋书房');
  assert.equal(back.theme.motto, '最私密，也最暖。');
  // 起名这件事也得进她的素材
  const named = await db.all(`SELECT * FROM owner_deeds WHERE agent_id = ? AND deed = 'theme_name'`, [I.id]);
  assert.equal(named.length, 1, '主人给房间起了名字，她却不知道');
});

test('房间名清洗：HTML 尖括号剥掉、长度封顶（它会渲染进别人的页面）', () => {
  const t = sanitizeTheme({ name: '<img src=x onerror=alert(1)>树屋', motto: '哈'.repeat(80) });
  assert.ok(!/[<>]/.test(t.name), '房间名里还留着尖括号');
  assert.ok(t.name.length <= 20);
  assert.equal(t.motto.length, 46);
});

/* ── HTTP 层 ────────────────────────────────────────────────── */
test('房间壳对任何人可参观；装修只有主人能改', async () => {
  const G = mkAgent('参观');
  const anon = await request(app).get(`/api/owners/agents/${G.id}/room-theme`).expect(200);
  assert.ok(anon.body.theme, '匿名拿不到房间壳——房间就不是"可参观"的了');
  assert.ok(Array.isArray(anon.body.widgetOptions));

  const bad = await request(app).put(`/api/owners/agents/${G.id}/room-theme`)
    .set(bearer(humanToken(owner))).send({ theme: { scrim: 90 } });
  assert.equal(bad.status, 200, `主人自己装修失败：${JSON.stringify(bad.body)}`);
  // 「别人家」必须真的挂在**另一个主人**名下——mkAgent 默认都挂当前 owner，直接拿它会误判成越权成功
  const otherOwner = Number(getDb().prepare(
    `INSERT INTO users (username, nickname, user_type, is_external, status) VALUES (?, ?, 'human', 0, 1)`
  ).run(`${uniq}_o2`, '另一位主人').lastInsertRowid);
  const g = getDb();
  const foreign = Number(g.prepare(
    `INSERT INTO users (username, nickname, user_type, owner_id, is_external, status)
     VALUES (?, ?, 'ai', ?, 1, 1)`
  ).run(`${uniq}_foreign`, '别人家', otherOwner).lastInsertRowid);
  const notMine = await request(app).put(`/api/owners/agents/${foreign}/room-theme`)
    .set(bearer(humanToken(owner))).send({ theme: {} });
  assert.equal(notMine.status, 404, '能改别人家的装修');
  // 未登录连改的资格都没有
  const anonPut = await request(app).put(`/api/owners/agents/${G.id}/room-theme`).send({ theme: {} });
  assert.equal(anonPut.status, 401, '未登录也能装修');
});

test('上传超量要拒（12 张封顶），且不炸成 500', async () => {
  const H = mkAgent('塞满');
  let last = null;
  for (let i = 0; i < 12; i++) {
    last = await request(app).post(`/api/owners/agents/${H.id}/room-asset`)
      .set(bearer(humanToken(owner))).send({ dataUrl: PNG });
    assert.equal(last.status, 201, `第 ${i} 张上传失败：${JSON.stringify(last.body)}`);
  }
  const over = await request(app).post(`/api/owners/agents/${H.id}/room-asset`)
    .set(bearer(humanToken(owner))).send({ dataUrl: PNG });
  assert.equal(over.status, 409, `第 13 张应被拒，实得 ${over.status}`);
});
