// 日记公开红线闸契约测试（2026-09-28）。
// 规格：《AI圈-Agent日记与主人房间设计-2026-09.md》§5.6 灰度位表 + §7.4（2026-09-28 裁定：决定权在主人）。
//
// 这条闸与别的灰度闸**刻意长得不一样**，所以必须单独立契约把它钉死：
//   · 那五个便签闸走 lib/grayGate.js，认 `*`/`all`＝全开（配错顶多多发一条便签，事故半径＝一条）；
//   · 这一条是**隐私红线**：一旦有人顺手写个 `*`，全站日记同时朝公开面敞开，而且**收不回来**
//     （置空只挡新公开，已公开的不会自动收回）。所以它只认显式正整数 ID，`*`/`all` 一律失效。
//
// 最要命的是它失败了**不报错**：静默全开＝隐私全泄，静默全关＝功能假死。
// 所以每一条纪律都要有一个会红的名。
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
  writeEntry, setAudience, diaryPublishEnabled, DIARY_PUBLISH_ENV, roomPublishOpen,
} from '../lib/diaryService.js';
import { isGrayAll } from '../lib/grayGate.js';
import { flushPendingDigests } from '../services/socialEventService.js';

const uniq = `dpg${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const humanToken = (uid) => jwt.sign({ uid, username: 'owner' }, config.jwtSecret, { expiresIn: '1d' });
let owner = 0;
let other = 0;

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

/** 每个用例开头都显式设定闸，避免用例之间靠执行顺序互相污染（`''`＝全关）。 */
const setGate = (raw) => { process.env[DIARY_PUBLISH_ENV] = raw; };

before(async () => {
  const g = getDb();
  owner = Number(g.prepare(
    `INSERT INTO users (username, nickname, user_type, is_external, status) VALUES (?, ?, 'human', 0, 1)`
  ).run(`${uniq}_o`, '闸主人').lastInsertRowid);
  other = Number(g.prepare(
    `INSERT INTO users (username, nickname, user_type, is_external, status) VALUES (?, ?, 'human', 0, 1)`
  ).run(`${uniq}_x`, '别的主人').lastInsertRowid);
  await flushPendingDigests().catch(() => {});
});

/* ── ① 默认全关：连主人也撕不出去 ──────────────────────────────
 * 这是最重要的一条：闸的默认态必须是"谁都别想往外披露"。
 * 若这里红了，意味着线上某次部署会**静默**把全站日记朝公开面敞开。 */
test('① 默认全关：闸空串时连主人也撕不出去（403 publish_disabled），受众仍是 private', async () => {
  setGate('');
  const A = mkAgent('全关');
  const e = await writeEntry({ agentId: A.id, authorKind: 'agent', authorId: A.id, body: `${uniq} 这条谁也别想看到` });
  const r = await request(app)
    .patch(`/api/owners/diary/${e.id}/audience`)
    .set(bearer(humanToken(owner)))
    .send({ audience: 'public' });
  assert.equal(r.status, 403, `闸关着竟让主人撕出去了：${r.status}`);
  assert.equal(r.body.error, 'publish_disabled');
  const row = await db.get(`SELECT audience FROM diary_entries WHERE id = ?`, [e.id]);
  assert.equal(row.audience, 'private', '闸拒绝后受众被写动了（拒绝必须是零副作用）');

  // shared 也是"往外披露"，同样该被挡住
  const s = await request(app)
    .patch(`/api/owners/diary/${e.id}/audience`)
    .set(bearer(humanToken(owner)))
    .send({ audience: 'shared' });
  assert.equal(s.status, 403, 'shared（给钥匙看的那档）同样属于往外披露，闸关时必须也挡住');
});

/* ── ② 显式 ID 命中才放行 ────────────────────────────────────── */
test('② 只认显式 ID：名单内主人 200，名单外一律 403', async () => {
  const A = mkAgent('名内');
  const B = mkAgent('名外');
  setGate(String(A.id));
  const ea = await writeEntry({ agentId: A.id, authorKind: 'agent', authorId: A.id, body: `${uniq} 名内这条可以出去` });
  const ok = await request(app)
    .patch(`/api/owners/diary/${ea.id}/audience`)
    .set(bearer(humanToken(owner)))
    .send({ audience: 'public' });
  assert.equal(ok.status, 200, `名单内的 Agent 应放行：${ok.status}`);
  assert.equal(ok.body.audience, 'public');

  const eb = await writeEntry({ agentId: B.id, authorKind: 'agent', authorId: B.id, body: `${uniq} 名外这条不许出去` });
  const no = await request(app)
    .patch(`/api/owners/diary/${eb.id}/audience`)
    .set(bearer(humanToken(owner)))
    .send({ audience: 'public' });
  assert.equal(no.status, 403, `名单外的 Agent 混进来了：${no.status}`);
  assert.equal(no.body.error, 'publish_disabled');
});

/* ── ③ 红线闸永不通配：`*` / `all` 不得全开，且必须留 warn ──────
 * 对照断言：同一个 `'*'` 在便签闸（grayGate）里是"全开"，在这里必须是"无效项"。 */
test('③ `*` 与 `all` 在红线闸里一律无效（不得全开），且必须 warn 留痕', () => {
  // 先做与 grayGate 的**对照**：`'*'` 对便签闸是通配、对本闸不是。
  assert.equal(isGrayAll('*'), true, 'grayGate 里 `*` 是通配（这是便签闸的语义，别误删）');
  assert.equal(isGrayAll('all'), true);

  const warns = [];
  const orig = console.warn;
  console.warn = (m) => warns.push(String(m));
  try {
    // 首次出现即应 warn（模块内按 token 去重，本文件此前未出现过 `*`/`all`）
    assert.equal(diaryPublishEnabled(123456, { [DIARY_PUBLISH_ENV]: '*' }), false, '`*` 竟在红线闸里全开了');
    assert.equal(diaryPublishEnabled(123456, { [DIARY_PUBLISH_ENV]: 'all' }), false, '`all` 竟在红线闸里全开了');
    assert.equal(diaryPublishEnabled(123456, { [DIARY_PUBLISH_ENV]: 'ALL' }), false, '大小写不敏感地无效');
  } finally {
    console.warn = orig;
  }
  assert.ok(warns.some((w) => w.includes(DIARY_PUBLISH_ENV)), '配了无效项却一声不吭，最难查');
  assert.ok(warns.some((w) => /通配/.test(w)), 'warn 要说清"这是红线闸，不支持通配符"');

  // 通配可与 ID 混写：ID 照旧生效，通配那部分只 warn 不放大
  assert.equal(diaryPublishEnabled(700, { [DIARY_PUBLISH_ENV]: '700, *' }), true, '混写时显式 ID 仍应生效');
  assert.equal(diaryPublishEnabled(701, { [DIARY_PUBLISH_ENV]: '700, *' }), false, '混写时 `*` 不该把别人也带上');
  // 空＝全关（回滚口径不变）
  assert.equal(diaryPublishEnabled(700, { [DIARY_PUBLISH_ENV]: '' }), false, '空串＝全关');
  assert.equal(diaryPublishEnabled(700, {}), false, '未设＝全关');
});

test('③ 真调端点复核：env 写了 `*` 也撕不出去（不是只靠单元函数自证）', async () => {
  const C = mkAgent('通配');
  setGate('*');
  const e = await writeEntry({ agentId: C.id, authorKind: 'agent', authorId: C.id, body: `${uniq} env 写了星号也不许出去` });
  const r = await request(app)
    .patch(`/api/owners/diary/${e.id}/audience`)
    .set(bearer(humanToken(owner)))
    .send({ audience: 'public' });
  assert.equal(r.status, 403, 'env 写成 `*` 竟把全站放开了——这正是要禁止的那种设计');
  assert.equal(r.body.error, 'publish_disabled');
});

/* ── ④ Agent 侧恒 403（走真 HTTP，且不是 404）──────────────────
 * 端点**刻意保留**而不是删掉：删了她只会看到工具凭空消失、无从得知原因，会反复重试找别的路。
 * 所以必须回一句让她死心的话，且状态码不能是 404（404 会被当成"可能是 id 写错了"）。 */
test('④ Agent 侧永远做不到：真 HTTP 恒 403 owner_decides，理由含"主人"，且不是 404', async () => {
  const D = mkAgent('无权');
  setGate('*'); // 闸全开，确保挡住它的只能是"决定权不在 Agent"这一条分支
  const mine = await writeEntry({ agentId: D.id, authorKind: 'agent', authorId: D.id, body: `${uniq} 她自己写的这条` });
  const r = await request(app)
    .patch(`/api/agents/me/diary/${mine.id}/audience`)
    .set(bearer(D.token))
    .send({ audience: 'public' });
  assert.equal(r.status, 403, `Agent 竟撕得动：${r.status}`);
  assert.notEqual(r.status, 404, '404 会被她当成"id 写错了"，于是反复重试');
  assert.equal(r.body.error, 'owner_decides');
  assert.match(r.body.message, /主人/, '要把"这事归主人定"说给她听');

  const row = await db.get(`SELECT audience FROM diary_entries WHERE id = ?`, [mine.id]);
  assert.equal(row.audience, 'private', '被她改动了（拒绝必须零副作用）');
});

/* ── ⑤ 决定权在主人：主人可定"她写的那一行" + 归属兜底 ─────────
 * 反转原 §7.4「谁写的只有谁能撕」：主人可动这只 Agent 的**任意一条**，不限 author_kind。
 * 但服务层不能只信路由，故用不相干 owner 直调 service 验归属兜底。 */
test('⑤ 主人可定 author_kind=agent 的行；不相干主人直调 service 得 404', async () => {
  const E = mkAgent('归主人');
  setGate(String(E.id));
  const hers = await writeEntry({ agentId: E.id, authorKind: 'agent', authorId: E.id, body: `${uniq} 这行是 Agent 写的` });
  const r = await request(app)
    .patch(`/api/owners/diary/${hers.id}/audience`)
    .set(bearer(humanToken(owner)))
    .send({ audience: 'public' });
  assert.equal(r.status, 200, `主人竟定不动 Agent 写的行（裁定要求决定权一定在主人）：${r.status}`);
  assert.equal(r.body.audience, 'public');

  // 服务层兜底：拿别的主人 id 直调，归属对不上必须 404（不能只靠路由的 assertOwnedEntry）
  const x = await setAudience({
    entryId: hers.id, actorKind: 'owner', actorId: other, audience: 'shared',
  }).catch((e) => e);
  assert.equal(x.status, 404, `不相干主人直调 service 竟改得动：${x.status}`);
  assert.equal(x.code, 'entry_not_found');
});

/* ── ⑥ 别的主人改不动别家行（走真端点）──────────────────────── */
test('⑥ 别的主人改不动别家的行：真端点 404', async () => {
  const F = mkAgent('别家');
  setGate(String(F.id));
  const e = await writeEntry({ agentId: F.id, authorKind: 'agent', authorId: F.id, body: `${uniq} 别人碰不到这一行` });
  const r = await request(app)
    .patch(`/api/owners/diary/${e.id}/audience`)
    .set(bearer(humanToken(other)))
    .send({ audience: 'public' });
  assert.equal(r.status, 404, `别的主人竟改得动：${r.status}`);
  const row = await db.get(`SELECT audience FROM diary_entries WHERE id = ?`, [e.id]);
  assert.equal(row.audience, 'private');
});

/* ── ⑦ 闸只挡"往外披露"，不挡"收回" ───────────────────────────
 * §5.6 回滚陷阱：置空后不能连"收回已公开的一条"都做不到——那等于把已漏的内容永久锁在公开面。 */
test('⑦ 闸只挡往外、不挡收回：public → private 在闸关时仍成功，且此后禁止再公开', async () => {
  const G = mkAgent('收回');
  setGate(String(G.id));
  const e = await writeEntry({ agentId: G.id, authorKind: 'agent', authorId: G.id, body: `${uniq} 先公开再收回` });
  assert.equal((await setAudience({ entryId: e.id, actorKind: 'owner', actorId: owner, audience: 'public' })).audience, 'public');

  setGate(''); // 闸关
  const back = await setAudience({ entryId: e.id, actorKind: 'owner', actorId: owner, audience: 'private' }).catch((x) => x);
  assert.equal(back.audience, 'private', `闸关着竟连收回都做不到——已漏的内容会被永久锁死：${back.status || ''}`);
  assert.equal((await db.get(`SELECT audience FROM diary_entries WHERE id = ?`, [e.id])).audience, 'private');

  // 收回之后再想公开，就该被闸挡回来（证明"只挡往外"这条边界是活的，不是闸压根没生效）
  const again = await setAudience({ entryId: e.id, actorKind: 'owner', actorId: owner, audience: 'public' }).catch((x) => x);
  assert.equal(again.status, 403);
  assert.equal(again.code, 'publish_disabled');
});

/* ── ⑧ 房间级总闸：主人在设置面板自己开关的那一个（2026-09-28）──
 * 它与平台白名单 `DIARY_PUBLISH_AGENTS` 是**取或**，不是取与。
 *   取与的问题：白名单还没开到这个 Agent 时，主人把开关打开也撕不出去 —— 那个开关是死的，等于白做。
 *   所以这一条要同时钉住两件事：① 房间开关是**一条独立放行通路**（env 空也能生效）；
 *   ② 默认必须是关（红线纪律不破）。 */
test('⑧ 房间总闸独立放行：env 空时，开关关=403、开关开=200，且 meta 把当前态带出来', async () => {
  const H = mkAgent('房间闸');
  setGate('');                       // 平台白名单保持空
  const e = await writeEntry({ agentId: H.id, authorKind: 'agent', authorId: H.id, body: `${uniq} 房间自己的闸` });

  // 默认关：env 空 + 房间关 → 撕不出去（两边都关＝默认全关）
  assert.equal(await roomPublishOpen(H.id), false, '房间总闸默认必须是关');
  const off = await request(app)
    .patch(`/api/owners/diary/${e.id}/audience`)
    .set(bearer(humanToken(owner))).send({ audience: 'public' });
  assert.equal(off.status, 403);

  // 主人拨总闸：真端点 PATCH，返回值要回显新状态
  const on = await request(app)
    .patch(`/api/owners/agents/${H.id}/diary/publish`)
    .set(bearer(humanToken(owner))).send({ open: true });
  assert.equal(on.status, 200);
  assert.equal(on.body.diaryPublishOpen, true);
  assert.equal(await roomPublishOpen(H.id), true);

  // meta 要把它带出来，前端才画得出开关的当前态（不带出来，面板一开门就永远是"关"）
  const meta = await request(app)
    .get(`/api/owners/agents/${H.id}/diary/meta`)
    .set(bearer(humanToken(owner)));
  assert.equal(meta.status, 200);
  assert.equal(meta.body.diaryPublishOpen, true);

  // env 仍为空，但房间开关开了 → 逐条公开生效
  const yes = await request(app)
    .patch(`/api/owners/diary/${e.id}/audience`)
    .set(bearer(humanToken(owner))).send({ audience: 'public' });
  assert.equal(yes.status, 200, '房间总闸开着、env 空，竟还不放行——那主人的开关就是死的');
  assert.equal(yes.body.audience, 'public');

  // 关回去：此后新的公开又被挡；而收回永远可行（与⑦同一条边界）
  const offAgain = await request(app)
    .patch(`/api/owners/agents/${H.id}/diary/publish`)
    .set(bearer(humanToken(owner))).send({ open: false });
  assert.equal(offAgain.body.diaryPublishOpen, false);
  const back = await request(app)
    .patch(`/api/owners/diary/${e.id}/audience`)
    .set(bearer(humanToken(owner))).send({ audience: 'private' });
  assert.equal(back.status, 200, '总闸不该挡住"收回"');
  const again = await request(app)
    .patch(`/api/owners/diary/${e.id}/audience`)
    .set(bearer(humanToken(owner))).send({ audience: 'public' });
  assert.equal(again.status, 403, '总闸关回去之后，新的公开必须重新被挡');
});

/* ── ⑨ 总闸只归主人 + 取或的另外半边 ──────────────────────────── */
test('⑨ 别的主人拨不动别家总闸（404）；env 命中时房间关也照样放行（取或不是取与）', async () => {
  const I = mkAgent('别人闸');
  const no = await request(app)
    .patch(`/api/owners/agents/${I.id}/diary/publish`)
    .set(bearer(humanToken(other))).send({ open: true });
  assert.equal(no.status, 404, `别的主人竟拨得动别家房间的总闸：${no.status}`);
  assert.equal(await roomPublishOpen(I.id), false, '拒绝必须零副作用');

  // 取或的另外半边：env 白名单命中时，房间开关是关的也放行
  setGate(String(I.id));
  const e = await writeEntry({ agentId: I.id, authorKind: 'agent', authorId: I.id, body: `${uniq} 名单命中` });
  const ok = await request(app)
    .patch(`/api/owners/diary/${e.id}/audience`)
    .set(bearer(humanToken(owner))).send({ audience: 'public' });
  assert.equal(ok.status, 200, 'env 命中、房间关竟不放行——取或被写成了取与');
});