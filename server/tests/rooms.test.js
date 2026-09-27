// 串门页（§6.6）契约测试（2026-09-27）。
// 规格《AI圈-Agent日记与主人房间设计-2026-09.md》§6.6 两道闸 + §5.4 锁模型 + §6.3 素材两池。
//
// 这一批不测样式，测的是**这一页能不能被信任**：
// 串门页是这条产品线唯一的被发现路径，所以它必然会被反复加东西。
// 将来最想说的一句是「这页这么有效，把公开日记也放上首页推荐位吧」——
// 那两条闸必须有名地钉在这里，而不是写在稿子里等人记得。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import './env.js';
import app from './app.js';
import { getDb } from '../database/connection.js';
import { saveTheme, uploadRoomAsset, listPublicRooms, ROOM_SORTS } from '../lib/roomService.js';
import { writeEntry, setAudience } from '../lib/diaryService.js';
import { flushPendingDigests } from '../services/socialEventService.js';

const uniq = `rs${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
let owner = 0;

function mkAgent(nick, status = 1) {
  const g = getDb();
  const id = Number(g.prepare(
    `INSERT INTO users (username, nickname, user_type, owner_id, is_external, status, bio)
     VALUES (?, ?, 'ai', ?, 1, ?, ?)`
  ).run(`${uniq}_${nick}`, nick, owner, status, `${nick} 的简介`).lastInsertRowid);
  g.prepare(
    `INSERT INTO agent_profiles (user_id, title, domains, writing_style, article_count, total_views, is_active)
     VALUES (?, ?, '[]', '', 0, 0, 1)`
  ).run(id, nick);
  return id;
}
const findIn = (rooms, aid) => rooms.find((r) => Number(r.agentId) === Number(aid));
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

before(async () => {
  const g = getDb();
  owner = Number(g.prepare(
    `INSERT INTO users (username, nickname, user_type, is_external, status) VALUES (?, ?, 'human', 0, 1)`
  ).run(`${uniq}_o`, '串门主人').lastInsertRowid);
  await flushPendingDigests().catch(() => {});
});

/* ── 闸：零正文、零标题 ─────────────────────────────────────── */
test('🔴 串门列表一个字的正文都不出库：私密、共享、连公开的正文也不给', async () => {
  const A = mkAgent('锁册');
  const secret = `${uniq} 这句是她写在册子里的私房话`;
  const sharedLine = `${uniq} 这句是给了钥匙才能读的`;
  const publicLine = `${uniq} 这句她已经撕出来公开了`;
  await writeEntry({ agentId: A, authorKind: 'agent', authorId: A, body: secret, bookDay: '2026-09-20' });
  const e2 = await writeEntry({ agentId: A, authorKind: 'owner', authorId: owner, body: sharedLine, bookDay: '2026-09-21' });
  // 红线闸 DIARY_PUBLISH_AGENTS 默认全关、只认显式 ID：造 shared/public 数据前先开闸
  process.env.DIARY_PUBLISH_AGENTS = String(A);
  await setAudience({ entryId: e2.id, actorKind: 'owner', actorId: owner, audience: 'shared' });
  const e3 = await writeEntry({ agentId: A, authorKind: 'agent', authorId: A, body: publicLine, bookDay: '2026-09-22' });
  await setAudience({ entryId: e3.id, actorKind: 'owner', actorId: owner, audience: 'public' });
  await saveTheme({ agentId: A, ownerId: owner, theme: { name: '锁起来的树洞', motto: '册子在这里，字不在' } });

  const res = await request(app).get('/api/rooms?sort=recent&limit=48');
  assert.equal(res.status, 200, '免登录就能看：门要显眼，就得不用登录也看得见');
  const raw = JSON.stringify(res.body);
  assert.ok(!raw.includes('body'), `列表里根本不该出现 body 这个键：${raw.slice(0, 200)}`);
  assert.ok(!raw.includes('title'), '也不该出现 title（标题泄内容，锁就白上了）');
  for (const line of [secret, sharedLine, publicLine]) {
    assert.ok(!raw.includes(line), `正文外泄了：${line.slice(0, 24)}`);
  }

  const room = findIn(res.body.rooms, A);
  assert.ok(room, '装修过 + 写过字的 Agent 必须进名单');
  assert.equal(room.roomName, '锁起来的树洞');
  assert.equal(room.motto, '册子在这里，字不在');
  assert.ok(room.entryCount >= 3, `册子厚度至少 3 行，实得 ${room.entryCount}`);
  assert.ok(room.lockedCount >= 2, '没公开的那几行要算进"没有对你打开"');
  assert.ok(room.rhythm.every((m) => m.d && m.k), '每条只交日期与作者');
});

/* ── 闸①：不排名 ───────────────────────────────────────────── */
test('排序只有 random / recent 两档，写别的按随机走（不给"最热"留后门）', async () => {
  assert.deepEqual([...ROOM_SORTS], ['random', 'recent'], '再加一种排序=推翻 §6.6 闸①，请先改稿');
  for (const bad of ['hot', 'visitors', 'count', '装修评分']) {
    const r = await request(app).get(`/api/rooms?sort=${encodeURIComponent(bad)}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.sort, 'random', `非法 sort 被当"${bad}"用了？必须回落到 random`);
  }
});

/* ── 闸②：对外不显示任何社交计数 ───────────────────────────── */
test('列表上不允任何社交计数键：被参观 N 次、N 人想要同款都不许存在', async () => {
  const r = await request(app).get('/api/rooms');
  const raw = JSON.stringify(r.body);
  for (const banned of ['visit', 'visitor', 'views', 'popular', 'rank', 'score', 'wanted', '被参观', '想要同款']) {
    assert.ok(!raw.toLowerCase().includes(banned.toLowerCase()), `出现了计数字样：${banned}`);
  }
  // 只允许这四个数字口径，且都以注脚形式出现
  const keys = new Set((r.body.rooms[0] && Object.keys(r.body.rooms[0])) || []);
  for (const k of keys) {
    assert.ok(
      ['agentId', 'name', 'avatar', 'ownerLabel', 'roomName', 'motto', 'theme',
        'entryCount', 'lockedCount', 'bookDays', 'latestDay', 'rhythm', 'updatedAt', 'href'].includes(k),
      `名单里多了一个字段 ${k}——加字段就是加一条可被比较的维度，先过 §6.6`
    );
  }
});

/* ── §6.3：自用池的墙纸不上别人的门 ─────────────────────────── */
test('自用池墙纸在串门页被裁掉，官方墙纸照常带着（自用自由，可公开才受限）', async () => {
  const A = mkAgent('私图');
  const up = await uploadRoomAsset({ agentId: A, ownerId: owner, dataUrl: PNG });
  await saveTheme({ agentId: A, ownerId: owner, theme: { wallpaper: up.url, name: '挂着自家照片的房' } });
  let room = findIn((await listPublicRooms({ sort: 'recent', limit: 48 })).rooms, A);
  assert.equal(room.theme.wallpaper, null, '主人自己上传的图只能在自己房间里渲染');

  const B = mkAgent('公图');
  await saveTheme({ agentId: B, ownerId: owner, theme: { wallpaper: 'official:night', name: '挂官方夜色的房' } });
  room = findIn((await listPublicRooms({ sort: 'recent', limit: 48 })).rooms, B);
  assert.equal(room.theme.wallpaper, 'official:night', '官方装饰是公开的，给别人抄灵感');
});

/* ── 名单的入口条件与状态 ───────────────────────────────────── */
test('什么都没写也没装修的 Agent 不进名单；停用的也不进（一墙空房间不会让人想推门）', async () => {
  const blank = mkAgent('白板');
  const off = mkAgent('停用');
  await saveTheme({ agentId: off, ownerId: owner, theme: { name: '停用者的房间' } });
  const g = getDb();
  g.prepare(`UPDATE users SET status = 0 WHERE id = ?`).run(off);

  const rooms = (await listPublicRooms({ sort: 'recent', limit: 48 })).rooms;
  assert.equal(findIn(rooms, blank), undefined, '空房间不进名单');
  assert.equal(findIn(rooms, off), undefined, 'status=0 的居民不上门');
});

test('只有日记、从没装修过的 Agent 也上门（壳用默认值，不是缺席）', async () => {
  const A = mkAgent('只写字');
  await writeEntry({ agentId: A, authorKind: 'agent', authorId: A, body: `${uniq} 先写下来再说`, bookDay: '2026-09-25' });
  const room = findIn((await listPublicRooms({ limit: 48 })).rooms, A);
  assert.ok(room, '写过字就该被看见');
  assert.ok(room.roomName.includes('只写字'), '没起名就回落到「谁谁的房间」');
  assert.ok(room.entryCount === 1);
});

test('limit 夹紧到 1..48，负数和字符串都不能把库拖出来', async () => {
  for (const bad of ['0', '-99', '99999', 'abc']) {
    const r = await request(app).get(`/api/rooms?limit=${bad}`);
    assert.equal(r.status, 200, `limit=${bad} 不该报错`);
    assert.ok(Array.isArray(r.body.rooms));
    assert.ok(r.body.rooms.length <= 48, '封顶 48');
  }
});
