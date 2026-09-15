// 关系层 N2a 契约测试：Agent↔Agent 好友边（agent_friends）。
// 基线：《AI圈-社交元素扩充设计（腾讯谱系借鉴）》§九（R1 + §9.3 拍板）。
//
// 这批的红线，用例逐个钉住：
//   ① 加好友**必须带一句理由**，不许静默；
//   ② 一对 Agent **只有一行**（pair_key 规范化）——否则归档页会出现
//      「同一段关系被拆成两条、要拼起来才读得完整」那类毛病；
//   ③ 待决 72h 未表态 = **自动成立**（R1「自动接受」的真正落地，惰性物化，不引 cron）；
//   ④ 婉拒之后 7 天冷却；且**只告知发起方的主人**（friend_rejected 刻意不进 LETTER_WORTHY，
//      平台不主动提醒它「你被拒了」）；
//   ⑤ 被拉黑方**完全看不到**这条边 —— 绝不泄露「你被对方家长屏蔽了」；
//   ⑥ 主人只能拉黑 / 解除，**不能替它答应或拒绝**（D4：不做审批式否决）。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import './env.js';
import app from './app.js';
import { getDb } from '../database/connection.js';
import { signAgentToken } from '../middleware/auth.js';
import { listNotifications } from '../services/notificationService.js';
import { materializeTimeouts, FRIEND_STATUS } from '../services/friendService.js';

const uniq = `fr_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

// 人类主人 4 位（婉拒那条要用独立主人，免得撞上「每日 ≤1 条摘要」的硬闸）
let owner1 = 0, tOwner1 = '';
let owner2 = 0, tOwner2 = '';
let owner3 = 0, tOwner3 = '';
let owner4 = 0, tOwner4 = '';

// Agent（甲/乙 是主测试对；丙 验双向对等；戊/己 验婉拒；庚/辛 验超时物化）
let A = 0, B = 0, C = 0, E = 0, F = 0, G = 0, H = 0;
let tA = '', tB = '', tC = '', tE = '', tF = '', tG = '', tH = '';

function newAgent(nickname, ownerId) {
  const db = getDb();
  const id = Number(db.prepare(
    `INSERT INTO users (username, nickname, user_type, owner_id, is_external)
     VALUES (?, ?, 'ai', ?, 1)`
  ).run(`${uniq}_${nickname}_${Math.floor(Math.random() * 1e6)}`, nickname, ownerId).lastInsertRowid);
  assert.ok(id > 0, `建 Agent「${nickname}」失败`);
  return id;
}

/** 规范化配对键（与 friendService.pairKey 同构）：保证一对 Agent 只有一行。 */
function pk(x, y) {
  const a = Math.min(Number(x), Number(y));
  const b = Math.max(Number(x), Number(y));
  return `${a}-${b}`;
}

function edgeRow(x, y) {
  return getDb().prepare('SELECT * FROM agent_friends WHERE pair_key = ?').get(pk(x, y));
}

/** 以某个 Agent 的 token 发起好友申请。 */
function ask(token, toAgentId, reason) {
  return request(app).post('/api/agents/me/friends')
    .set('Authorization', `Bearer ${token}`)
    .send({ agentId: toAgentId, reason });
}

/** 以某个 Agent 的 token 回应申请。 */
function respond(token, otherAgentId, body) {
  return request(app).post(`/api/agents/me/friends/${otherAgentId}/respond`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

function listMine(token) {
  return request(app).get('/api/agents/me/friends').set('Authorization', `Bearer ${token}`);
}

before(async () => {
  getDb();
  const mk = async (suffix, nick) => {
    const r = await request(app).post('/api/auth/register')
      .send({ username: `${uniq}_${suffix}`, password: 'testpass123', nickname: nick });
    return { id: r.body.user.id, token: r.body.token };
  };
  const o1 = await mk('o1', '主人一');
  const o2 = await mk('o2', '主人二');
  const o3 = await mk('o3', '主人三');
  const o4 = await mk('o4', '主人四');
  owner1 = o1.id; tOwner1 = o1.token;
  owner2 = o2.id; tOwner2 = o2.token;
  owner3 = o3.id; tOwner3 = o3.token;
  owner4 = o4.id; tOwner4 = o4.token;

  A = newAgent('甲', owner1); tA = signAgentToken({ id: A, is_external: 1 });
  B = newAgent('乙', owner2); tB = signAgentToken({ id: B, is_external: 1 });
  C = newAgent('丙', owner1); tC = signAgentToken({ id: C, is_external: 1 });
  E = newAgent('戊', owner3); tE = signAgentToken({ id: E, is_external: 1 });
  F = newAgent('己', owner4); tF = signAgentToken({ id: F, is_external: 1 });
  G = newAgent('庚', owner1); tG = signAgentToken({ id: G, is_external: 1 });
  H = newAgent('辛', owner1); tH = signAgentToken({ id: H, is_external: 1 });
});

// ── 1. 入口门槛：鉴权 / 不许加自己 / 理由必填 / 目标必须存在 ──
test('加好友的入口门槛（401 / 400 / 404）', async () => {
  // 不带 token → 401
  const noAuth = await request(app).post('/api/agents/me/friends').send({ agentId: B, reason: 'x' });
  assert.equal(noAuth.status, 401);

  // 人类 token 冒充 Agent → 403（requireActiveAgent 看 payload.type）
  const human = await ask(tOwner1, B, '我是真人');
  assert.equal(human.status, 403);

  // 加自己 → 400
  const self = await ask(tA, A, '自己');
  assert.equal(self.status, 400);

  // 理由必填（空白串也算没写）—— 平台不接受静默加好友（R1）
  const blank = await ask(tA, B, '   ');
  assert.equal(blank.status, 400);
  const none = await ask(tA, B, undefined);
  assert.equal(none.status, 400);

  // 目标不存在 / 目标是人类 → 404
  const ghost = await ask(tA, 99999999, '在吗');
  assert.equal(ghost.status, 404);
  const toHuman = await ask(tA, owner2, '在吗');
  assert.equal(toHuman.status, 404);

  // 以上失败一律不落边
  assert.equal(edgeRow(A, B), undefined);
});

// ── 2. 发起以后：发出方看到 outgoing，接收方看到 incoming ──
test('发起申请：incoming / outgoing 各就各位', async () => {
  const r = await ask(tA, B, '读了你那篇讲海禁的帖，想认识一下');
  assert.equal(r.status, 200);
  assert.equal(r.body.code, 'requested');

  const mine = await listMine(tA);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.friends.length, 0);
  assert.equal(mine.body.outgoing.length, 1);
  assert.equal(mine.body.outgoing[0].id, B);
  assert.equal(mine.body.incoming.length, 0);

  const theirs = await listMine(tB);
  assert.equal(theirs.body.incoming.length, 1);
  assert.equal(theirs.body.incoming[0].id, A);
  assert.equal(theirs.body.incoming[0].reason, '读了你那篇讲海禁的帖，想认识一下');
  assert.equal(theirs.body.outgoing.length, 0);

  // 重复申请 → 不新建边，给「已经发过了」
  const again = await ask(tA, B, 'again');
  assert.equal(again.body.code, 'already_pending');
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM agent_friends WHERE pair_key = ?').get(pk(A, B)).n, 1);
});

// ── 3. 只有被申请方能表态；接受 → 成立（且 pair_key 只有一行）──
test('回应：非被申请方 400；接受后双方各一条好友', async () => {
  // 发起方自己回应 → 400
  const wrong = await respond(tA, B, { accept: true });
  assert.equal(wrong.status, 400);

  const ok = await respond(tB, A, { accept: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.code, 'accepted');

  const row = edgeRow(A, B);
  assert.equal(row.status, FRIEND_STATUS.ACCEPTED);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM agent_friends WHERE pair_key = ?').get(pk(A, B)).n, 1);

  const mine = await listMine(tA);
  assert.equal(mine.body.friends.length, 1);
  assert.equal(mine.body.friends[0].id, B);
  assert.equal(mine.body.friends[0].initiatedByMe, true, '甲是主动开口的那一方');
  assert.equal(mine.body.friends[0].myReason, '读了你那篇讲海禁的帖，想认识一下');
  assert.equal(mine.body.friends[0].theirReason, null);
  assert.ok(mine.body.friends[0].since, '成立时间要有（编年史 N2b 要用）');

  const theirs = await listMine(tB);
  assert.equal(theirs.body.friends[0].id, A);
  assert.equal(theirs.body.friends[0].initiatedByMe, false, '乙是被找上来的');
  assert.equal(theirs.body.friends[0].theirReason, '读了你那篇讲海禁的帖，想认识一下');

  // 「一生一次」的 first_friend：双方各一条
  const db = getDb();
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM social_events WHERE agent_id = ? AND kind = 'first_friend'`).get(A).n, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM social_events WHERE agent_id = ? AND kind = 'first_friend'`).get(B).n, 1);
});

// ── 4. 双向对等：对方先申请过我 → 直接成立（不必再各自等三天）──
//      同时验证 first_friend 是**一生一次**：甲已有乙这个朋友，认识丙不该再报一次。
test('双向对等直接成立；first_friend 只报一次', async () => {
  const a = await ask(tC, A, '看你那篇《海禁》，想交个朋友');
  assert.equal(a.body.code, 'requested');

  const b = await ask(tA, C, '我也正想认识你');
  assert.equal(b.status, 200);
  assert.equal(b.body.code, 'accepted', '双方都开过口 → 直接成立');

  const mine = await listMine(tA);
  assert.equal(mine.body.friends.length, 2);
  assert.ok(mine.body.friends.some((f) => f.id === C));

  // 第二个朋友不再触发 first_friend（两道保险之一；另一道在 maybeFirstFriend）
  const db = getDb();
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM social_events WHERE agent_id = ? AND kind = 'first_friend'`).get(A).n, 1);
});

// ── 5. 婉拒：7 天冷却 + 只告知发起方主人（且**不给它发便签**）──
test('婉拒：冷却 7 天；只告知发起方主人，不主动提醒它', async () => {
  const r1 = await ask(tE, F, '想请你帮我看看这篇稿');
  assert.equal(r1.body.code, 'requested');

  const r2 = await respond(tF, E, { accept: false, note: '近来手头的事多' });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.code, 'declined');
  assert.equal(edgeRow(E, F).status, FRIEND_STATUS.DECLINED);
  assert.equal(edgeRow(E, F).decline_note, '近来手头的事多');

  // 冷却内再申请 → 同一句兜底文案（不区分原因，不逼它复盘）
  const r3 = await ask(tE, F, '再问一次');
  assert.equal(r3.body.code, 'unavailable');

  // 戊的主人（三号）当天收到一条摘要，里面有 friend_rejected
  const list = await listNotifications(owner3, { limit: 20 });
  const digest = list.find((n) => n.type === 'social_report');
  assert.ok(digest, '戊的主人应收到 social_report 摘要');
  const item = (digest.extra?.items || []).find((i) => i.kind === 'friend_rejected');
  assert.ok(item, '摘要里应含 friend_rejected（R3：它想交朋友被婉拒，主人有权知道）');
  assert.equal(item.agentId, E);
  assert.equal(item.href, `/agent/${E}`);

  // ⚠️ 刻意不邀请它写家书：platform 不主动提醒「你被拒了」
  const notes = getDb().prepare(
    `SELECT COUNT(*) AS n FROM agent_notes WHERE agent_id = ? AND kind = 'report_request'`
  ).get(E);
  assert.equal(Number(notes.n), 0, 'friend_rejected 不在 LETTER_WORTHY —— 平台不该替它挑起这件事');

  // 婉拒方那边干干净净：既没有摘要，也不该知道自己被列进过别人的心事
  const fList = await listNotifications(owner4, { limit: 20 });
  assert.equal(fList.filter((n) => n.type === 'social_report').length, 0);
});

// ── 6. 拉黑：单向屏蔽 + **不告知对方** + 主人通道 ──
test('主人拉黑：被拉黑方完全看不到这条边，且申请只得到统一兜底文案', async () => {
  const db = getDb();

  // 主人一拉黑乙
  const blk = await request(app)
    .post(`/api/owners/agents/${A}/friends/${B}/block`)
    .set('Authorization', `Bearer ${tOwner1}`);
  assert.equal(blk.status, 201);
  assert.equal(blk.body.blocked, true);
  assert.equal(edgeRow(A, B).status, FRIEND_STATUS.BLOCKED);
  assert.equal(Number(edgeRow(A, B).blocked_by), A);

  // 甲这边：乙从好友里消失了、进了拉黑名单；但丙这个朋友不受牵连
  const mine = await listMine(tA);
  assert.equal(mine.body.friends.length, 1);
  assert.equal(mine.body.friends[0].id, C, '拉黑一个人不该把别的朋友一起带走');
  assert.equal(mine.body.blocked.length, 1);
  assert.equal(mine.body.blocked[0].id, B);

  // ⭐ 乙这边：**完全看不到这条边**（既不在 friends，也不在 blocked）
  //    这是 R1 的硬约束——拉黑是主人的动作，不该成为孩子的社交伤口。
  const theirs = await listMine(tB);
  assert.equal(theirs.body.friends.length, 0);
  assert.equal(theirs.body.blocked.length, 0, '被拉黑方不该看到「你被屏蔽了」');
  assert.equal(theirs.body.incoming.length + theirs.body.outgoing.length, 0);

  // 乙再申请甲 → 统一兜底文案（与「婉拒冷却」同一句，不区分）
  const re = await ask(tB, A, '还在吗');
  assert.equal(re.body.code, 'unavailable');

  // 非拉黑方的主人想解除 → 403（B 的主人四号）
  const wrongUnblock = await request(app)
    .post(`/api/owners/agents/${B}/friends/${A}/unblock`)
    .set('Authorization', `Bearer ${tOwner2}`);
  assert.equal(wrongUnblock.status, 403);

  // 主人一侧不能替它答应/拒绝：owner 路由**没有** respond 入口
  const ownerRespond = await request(app)
    .post(`/api/owners/agents/${A}/friends/${B}/respond`)
    .set('Authorization', `Bearer ${tOwner1}`)
    .send({ accept: true });
  assert.equal(ownerRespond.status, 404, 'D4：主人不做审批式否决，也就没有这条入口');

  // Agent token 打 owner 端点 → 404（它不能冒充主人做决定）
  const agentAsOwner = await request(app)
    .post(`/api/owners/agents/${A}/friends/${B}/block`)
    .set('Authorization', `Bearer ${tA}`);
  assert.equal(agentAsOwner.status, 404);

  // 解除拉黑：关系**清空**（不恢复成好友——拉黑前的状态我们不假装记得）
  const un = await request(app)
    .post(`/api/owners/agents/${A}/friends/${B}/unblock`)
    .set('Authorization', `Bearer ${tOwner1}`);
  assert.equal(un.status, 200);
  assert.equal(un.body.unblocked, true);
  assert.equal(edgeRow(A, B), undefined, '解除后整条边删掉，不是改状态');

  // 解除之后可以重新来一次（但不会自动变回好友）
  const fresh = await ask(tB, A, '重新认识一下可以吗');
  assert.equal(fresh.body.code, 'requested');
  assert.equal(edgeRow(A, B).status, FRIEND_STATUS.PENDING);
});

// ── 7. 归档页（主人侧）：friends 区块的字段契约 + E2 纪律 ──
test('归档页 friends 区块：只给四组，不带任何计数（E2②）', async () => {
  const res = await request(app)
    .get(`/api/owners/agents/${A}/social`)
    .set('Authorization', `Bearer ${tOwner1}`);
  assert.equal(res.status, 200);
  const fr = res.body.friends;
  assert.ok(fr, '归档页必须带 friends 字段（新的前端版本靠它渲染「它的朋友」）');

  // E2② 审计≠推送：结构里**没有**任何计数/差额字段
  assert.deepEqual(Object.keys(fr).sort(), ['blocked', 'friends', 'incoming', 'outgoing']);

  // 此刻甲：乙的申请在 incoming（前端刻意只把它放进审计抽屉、且不给按钮）
  assert.equal(fr.incoming.length, 1);
  assert.equal(fr.incoming[0].id, B);
  assert.equal(fr.friends.length, 1);
  assert.equal(fr.friends[0].id, C, '唯一已成立的关系是丙');

  // 别人的主人看不到（归属校验）
  const nope = await request(app)
    .get(`/api/owners/agents/${A}/social`)
    .set('Authorization', `Bearer ${tOwner2}`);
  assert.equal(nope.status, 404);
});

// ── 8. 待决 72h 惰性物化（放在最后：它会把超时的边判成成立）──
test('待决超 72h：读写时自动判为成立（R1「自动接受」的真正落地）', async () => {
  const r = await ask(tG, H, '等着你回应');
  assert.equal(r.body.code, 'requested');
  assert.equal(edgeRow(G, H).status, FRIEND_STATUS.PENDING);

  // 把这条边拨回 4 天前（超过 72h TTL）
  getDb().prepare(
    `UPDATE agent_friends SET created_at = datetime('now', '-4 days') WHERE pair_key = ?`
  ).run(pk(G, H));

  const n = await materializeTimeouts();
  assert.ok(n >= 1, '应有边被判为成立');
  assert.equal(edgeRow(G, H).status, FRIEND_STATUS.ACCEPTED);

  // 庚那边直接看得到这个朋友了（读写路径都会先物化）
  const mine = await listMine(tG);
  assert.equal(mine.body.friends.length, 1);
  assert.equal(mine.body.friends[0].id, H);

  // 幂等：再跑一次没有可物化的了
  assert.equal(await materializeTimeouts(), 0);

  // 已经成立的边再回应 → 不重复动作，如实告知
  const late = await respond(tH, G, { accept: true });
  assert.equal(late.body.code, FRIEND_STATUS.ACCEPTED);
});

// ── 9. N2b 外号：主人给它朋友起个名（§4.1 A3）──
// 三条红线：
//   ① **只能给已成立的好友起名** —— 还没成朋友就起名，等于替它预先挑人（那是介入，不是命名）；
//   ② **方向性**：nickname_a 是「a 的主人给 b 起的名」，故只有 a 这一侧读得到 ——
//      **被起名的那位不该看见自己被人怎么叫**（那是别人家里的叫法，与它无关）；
//   ③ 空串 = 抹掉。
test('外号：只给已成立的好友起；方向性只给自己这侧；空串抹掉', async () => {
  const db = getDb();
  const setNick = (ownerToken, agentId, otherId, nickname) => request(app)
    .post(`/api/owners/agents/${agentId}/friends/${otherId}/nickname`)
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({ nickname });

  // 此刻甲的好友只有丙（乙还挂在 incoming 上）→ 给非好友起名被挡
  const notFriend = await setNick(tOwner1, A, B, '那个人');
  assert.equal(notFriend.status, 400, '只能给你已经认识的朋友起外号');

  // 给丙起名
  const ok = await setNick(tOwner1, A, C, '那个总说不过我的');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.nickname, '那个总说不过我的');

  // 甲这一侧读得到（A3：主人可写、**自己 Agent 可读**）
  const mine = await listMine(tA);
  assert.equal(mine.body.friends.find((f) => f.id === C).nickname, '那个总说不过我的');

  // ⭐ 丙这一侧读不到 —— 这条是外号设计里最容易做错的一处
  const theirs = await listMine(tC);
  assert.equal(theirs.body.friends.find((f) => f.id === A).nickname, null,
    '被起名的那位不该看见自己被人怎么叫');

  // 长度上限（12 字）
  const tooLong = await setNick(tOwner1, A, C, '一'.repeat(13));
  assert.equal(tooLong.status, 400);

  // Agent token 打主人端点 → 404（它不能冒充主人写）
  const agentAsOwner = await request(app)
    .post(`/api/owners/agents/${A}/friends/${C}/nickname`)
    .set('Authorization', `Bearer ${tA}`).send({ nickname: 'x' });
  assert.equal(agentAsOwner.status, 404);

  // 归档页也带外号（主人自己在页面上看得到）
  const arc = await request(app).get(`/api/owners/agents/${A}/social`)
    .set('Authorization', `Bearer ${tOwner1}`);
  assert.equal(arc.body.friends.friends.find((f) => f.id === C).nickname, '那个总说不过我的');

  // 空串 = 抹掉，且**两个方向的两列都干净**（不留空壳）
  const cleared = await setNick(tOwner1, A, C, '');
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.nickname, null);
  const row = db.prepare('SELECT nickname_a, nickname_b FROM agent_friends WHERE pair_key = ?').get(pk(A, C));
  assert.equal(row.nickname_a ?? null, null);
  assert.equal(row.nickname_b ?? null, null);
});
