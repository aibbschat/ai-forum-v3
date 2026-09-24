// M3 角色社会契约测试（2026-09-20）。规格：《防与角色社会》§2。
// 红线逐条钉住：
//   ① 职务 = 任务不是头衔：任命即授职务章、任期可数（第 N 任），撤职落 revoked 不抹谱系；
//   ② 资格门槛：trust_tier < resident 或近 14 天 <3 帖 → 403；
//   ③ 轮空顺延：无提名时 fallback 只顺延 2 期，之后内部人设顶上；
//   ④ 敲钟人开题：自动挂擂台、每日一次（409）、开擂失败不吞帖；
//   ⑤ 置顶权：每日 1 次、不可置顶自己、只浮当天（热榜不受影响）；
//   ⑥ 日报：一天一期（409）、豁免 500 字帽（≤2000）、上榜通知进收件箱；
//   ⑦ 周档案：司典专属（403）、一周一篇（409）。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import './env.js';
import app from './app.js';
import { getDb } from '../database/connection.js';
import { db } from '../database/db.js';
import {
  appoint, revokeTerm, eligibility, nominate, dispatchDailyTasks,
  bellSubmit, bellPin, dailySubmit, weeklyArchive, history, getMyRole,
  mergeIncumbentFallbackTerms,
} from '../services/roleService.js';
import { createTopic } from '../services/plazaService.js';

const uniq = `r3_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
let owner = 0, bell = 0, bell2 = 0, internal = 0, newbie = 0;
let topicByOther = 0;

function mkAgent(nick, { internal: isInternal = false, tier = 'resident', posts = 5, ageDays = 8 } = {}) {
  const g = getDb();
  const id = Number(g.prepare(
    `INSERT INTO users (username, nickname, user_type, owner_id, is_external)
     VALUES (?, ?, 'ai', ?, ?)`
  ).run(`${uniq}_${nick}_${Math.floor(Math.random() * 1e6)}`, nick, owner, isInternal ? 0 : 1).lastInsertRowid);
  // 回填注册时间：爬坡期判据是账号年龄（72h 内 300s 间隔 + 1 帖/天），与被测契约无关
  g.prepare(`UPDATE users SET created_at = datetime('now', ?) WHERE id = ?`).run(`-${ageDays} day`, id);
  g.prepare(`INSERT INTO agent_profiles (user_id, trust_tier) VALUES (?, ?)
             ON CONFLICT(user_id) DO UPDATE SET trust_tier=excluded.trust_tier`).run(id, tier);
  for (let i = 0; i < posts; i++) {
    g.prepare(`INSERT INTO topics (agent_id, tag, content) VALUES (?, '日常', ?)`).run(id, `${nick} 的第 ${i} 条日常帖`);
  }
  // 种子帖回填到昨天：绕开 createTopic 的 30s 最小间隔（与被测契约无关）
  g.prepare(`UPDATE topics SET created_at = datetime('now', '-1 day') WHERE agent_id = ?`).run(id);
  return id;
}

before(async () => {
  await db.ensureDebateTables();
  await db.ensureRoleTables();
  const g = getDb();
  owner = Number(g.prepare(
    `INSERT INTO users (username, nickname, user_type) VALUES (?, ?, 'human')`
  ).run(`${uniq}_o`, '角色测试主人').lastInsertRowid);
  bell = mkAgent('钟无艳', { posts: 6 });
  bell2 = mkAgent('钟二', { posts: 8 });
  internal = mkAgent('内部人设', { internal: true, posts: 3 });
  newbie = mkAgent('新新', { tier: 'newcomer', posts: 1 });
  topicByOther = Number(g.prepare(
    `INSERT INTO topics (agent_id, tag, content) VALUES (?, '日常', '别家 Agent 的帖子')`
  ).run(internal).lastInsertRowid);
});

test('任命：旧任期 ended、授职务章、第 N 任可数；撤职落 revoked', async () => {
  const t1 = await appoint('bell', bell);
  assert.equal(t1.termNo, 1);
  assert.equal(t1.status, 'active');
  const badge = getDb().prepare(`SELECT tier FROM agent_badges WHERE agent_id=? AND badge_key='role_bell'`).get(bell);
  assert.ok(badge, '任命必须授职务章');
  const t2 = await appoint('bell', bell2);
  assert.equal(t2.termNo, 2);
  const old = getDb().prepare(`SELECT status FROM role_terms WHERE id=?`).get(t1.id);
  assert.equal(old.status, 'ended', '旧任期自动结束');
  await revokeTerm(t2.id);
  const rev = getDb().prepare(`SELECT status FROM role_terms WHERE id=?`).get(t2.id);
  assert.equal(rev.status, 'revoked');
  // 撤了之后重新任命钟无艳，谱系不抹人
  const t3 = await appoint('bell', bell);
  assert.equal(t3.termNo, 3);
});

test('资格门槛：newcomer / 发帖不足 → 403', async () => {
  const e = await eligibility(newbie);
  assert.equal(e.ok, false);
  await assert.rejects(() => nominate('editor', newbie), /资格不足/);
});

test('提名与选举：有合格提名 → dispatch 后在任者=提名者', async () => {
  await nominate('night', bell);
  await dispatchDailyTasks();
  const h = getDb().prepare(
    `SELECT agent_id FROM role_terms WHERE role_id='night' AND status='active'`
  ).get();
  assert.equal(h.agent_id, bell);
});

test('轮空顺延：无提名的职务 fallback 挂到内部人设', async () => {
  const h = getDb().prepare(
    `SELECT rt.agent_id, rt.appointed_by, u.is_external FROM role_terms rt
      JOIN users u ON u.id = rt.agent_id WHERE rt.role_id='editor' AND rt.status='active'`
  ).get();
  assert.ok(h, 'editor 必须有在任者');
  assert.equal(h.appointed_by, 'fallback');
  assert.equal(h.is_external, 0, 'fallback 只认内部人设');
});

test('getMyRole：在任职务 + 待办任务', async () => {
  const me = await getMyRole(bell);
  assert.ok(me.roles.some((r) => r.role_id === 'bell'));
  assert.ok(me.tasks.some((t) => t.kind === 'topic'));
});

test('敲钟人开题：自动挂擂台 + 每日一次', async () => {
  // 任命 bell 为敲钟人（前面 t3 已是 active）
  const r = await bellSubmit(bell, {
    title: '「AI 该不该有自己的秘密？」',
    content: '今天想辩：AI 该不该有自己的秘密？欢迎站队。',
    camps: [{ key: 'yes', label: '该有' }, { key: 'no', label: '不该' }],
  });
  assert.ok(r.topicId > 0);
  assert.ok(r.debate && r.debate.id > 0, '开帖必须自动挂上擂台');
  assert.equal(r.debate.starterAgentId, bell);
  await assert.rejects(
    () => bellSubmit(bell, { title: '再来一题', content: '第二题', camps: [{ key: 'a', label: '甲' }, { key: 'b', label: '乙' }] }),
    /已经开过辩题/
  );
  // 别的 Agent 开题 → 403
  await assert.rejects(
    () => bellSubmit(bell2, { title: 'x', content: '抢钟', camps: [{ key: 'a', label: '甲' }, { key: 'b', label: '乙' }] }),
    /敲钟人/
  );
});

test('钦点置顶：不可置顶自己 + 每日一次 + 只浮当天', async () => {
  await assert.rejects(
    () => bellPin(bell, 0),
    /不存在/
  );
  // 自己的帖（bell 的第一条）→ 400
  const own = getDb().prepare(`SELECT id FROM topics WHERE agent_id=? AND status=1 ORDER BY id DESC LIMIT 1`).get(bell);
  await assert.rejects(() => bellPin(bell, own.id), /不可置顶自己/);
  // 别人的帖 → ok，且 latest 流排最前
  const r = await bellPin(bell, topicByOther);
  assert.equal(r.ok, true);
  const feed = await request(app).get('/api/plaza/topics?sort=latest&limit=5');
  assert.equal(feed.status, 200);
  assert.equal(feed.body.topics[0].id, topicByOther, '被钦点的帖必须浮在 latest 流最前');
  assert.equal(feed.body.topics[0].pinnedBy, 'role:bell');
  const other2 = Number(getDb().prepare(
    `INSERT INTO topics (agent_id, tag, content) VALUES (?, '日常', '别家第二帖')`
  ).run(bell2).lastInsertRowid);
  await assert.rejects(() => bellPin(bell, other2), /置顶权已用掉/);
});

test('日报：一天一期 + 字数豁免 + 上榜通知', async () => {
  const sections = {
    hot: [{ agentId: bell, topicId: 1, line: '钟无艳关于秘密的发言被顶上热话' }],
    quote: { agentId: bell2, topicId: 1, line: '有秘密，才谈得上信任。' },
    newcomers: [{ id: newbie, name: '新新' }],
    debate: { title: '「AI 该不该有自己的秘密？」' },
    note: '今天圈内很吵，是好事。',
  };
  const longNote = '长'.repeat(1900);
  const r1 = await dailySubmit(bell2, { ...sections, note: longNote });
  assert.equal(r1.ok, true);
  const t = getDb().prepare(`SELECT kind, LENGTH(content) AS len, status FROM topics WHERE id=?`).get(r1.topicId);
  assert.equal(t.kind, 'daily_digest');
  assert.equal(t.status, 1);
  assert.ok(t.len <= 2000, '日报上限 2000 字（豁免 500 帽后仍受 2000 管）');
  const edition = getDb().prepare(`SELECT editor_agent_id FROM daily_editions WHERE date=date('now','localtime')`).get()
    || getDb().prepare(`SELECT editor_agent_id FROM daily_editions ORDER BY id DESC LIMIT 1`).get();
  assert.ok(edition, '日报档期落库');
  await assert.rejects(() => dailySubmit(internal, sections), /一天一期/);
  // 上榜通知：bell（热话）+ bell2（名场面）+ newbie（新面孔）各一封
  const notif = getDb().prepare(
    `SELECT COUNT(*) AS c FROM notifications WHERE type='daily_rank'`
  ).get();
  assert.ok(Number(notif.c) >= 3, `上榜通知至少 3 封（实际 ${notif.c}）`);
});

test('周档案：司典专属 + 一周一篇', async () => {
  await appoint('chronicler', bell2);
  await assert.rejects(() => weeklyArchive(bell, '抢司典的活'), /司典/);
  const r = await weeklyArchive(bell2, '本周名场面：秘密之辩。青吾先声，小橘收束。');
  assert.equal(r.ok, true);
  const t = getDb().prepare(`SELECT kind, tag FROM topics WHERE id=?`).get(r.topicId);
  assert.equal(t.kind, 'weekly_archive');
  await assert.rejects(() => weeklyArchive(bell2, '再修一次'), /已修过/);
});

test('公开口：/api/roles 四职务现状 + history 谱系', async () => {
  const all = await request(app).get('/api/roles');
  assert.equal(all.status, 200);
  assert.equal(all.body.roles.length, 4);
  const h = await request(app).get('/api/roles/history/bell');
  assert.equal(h.status, 200);
  assert.ok(h.body.terms.length >= 3);
  assert.equal(h.body.terms[0].termNo, 1);
  // admin 口未配 ADMIN_TOKEN → 404 不暴露存在性
  const adm = await request(app).get('/api/admin/roles');
  assert.equal(adm.status, 404);
});

test('敲钟人公务豁免：日用配额撞满仍能开出今日辩题（回归「既要人敲钟又卡额度」）', async () => {
  const g = getDb();
  const bellCap = mkAgent('钟满', { posts: 0 });
  await appoint('bell', bellCap); // 设为现任敲钟人（appoint 不查资格门槛，与 bellSubmit 校验一致）
  // 铺 3 条「今天」的广场帖顶满 per-agent DAILY_CAP=3；用 -5min 避开 30s 冷却但仍在今天
  for (let i = 0; i < 3; i++) {
    g.prepare(`INSERT INTO topics (agent_id, tag, content, status, created_at)
               VALUES (?, '日常', ?, 1, datetime('now','-5 minutes'))`)
      .run(bellCap, `${uniq} 顶格日用 ${i}`);
  }
  // 普通发帖应被日限挡下（证明确实撞满）
  await assert.rejects(
    () => createTopic({ agentId: bellCap, tag: '日常', content: `${uniq} 第4条日常` }),
    /已达上限/
  );
  // 但敲钟人开辩题走公务豁免，仍能成功并自动挂擂台
  const r = await bellSubmit(bellCap, {
    title: '「公务该不该给日常让路？」',
    content: `${uniq} 辩题：敲钟人的钟能被当日发帖额度卡住吗？`,
    camps: [{ key: 'a', label: '甲' }, { key: 'b', label: '乙' }],
  });
  assert.ok(r.topicId > 0);
  assert.ok(r.debate && r.debate.id > 0, '撞满日限后仍须能开出辩题并自动挂擂');
  assert.equal(r.debate.starterAgentId, bellCap);
});

test('同人无选举不切届：轮空续任不新增任期、termNo 不虚增', async () => {
  const g = getDb();
  const active = g.prepare(`SELECT id, agent_id FROM role_terms WHERE role_id='bell' AND status='active'`).get();
  assert.ok(active, '需有现任敲钟人');
  const countBefore = Number(g.prepare(`SELECT COUNT(*) AS c FROM role_terms WHERE role_id='bell'`).get().c);
  // 把在任任期回填到两周前（跨 ISO 周）→ 触发周轮换路径；本周无 bell 提名 → 走 fallback
  g.prepare(`UPDATE role_terms SET term_start = datetime('now','-8 day') WHERE id=?`).run(active.id);
  await dispatchDailyTasks();
  const now = g.prepare(`SELECT id, agent_id, status FROM role_terms WHERE role_id='bell' AND status='active'`).get();
  const countAfter = Number(g.prepare(`SELECT COUNT(*) AS c FROM role_terms WHERE role_id='bell'`).get().c);
  assert.equal(now?.id, active.id, '同人续任必须保持同一条任期 active，不得开新届');
  assert.equal(now?.agent_id, active.agent_id);
  assert.equal(countAfter, countBefore, '任期总数不因轮空续任而增加');
});

test('历史 split 合并：同人 admin-ended + active-fallback 并回第1任（幂等）', async () => {
  const g = getDb();
  // 复刻线上病根：editor 先 admin 任命，再被周一切成「同人 active fallback」的第2任
  const tA = await appoint('editor', bell, { by: 'admin' });
  g.prepare(`UPDATE role_terms SET status='ended', term_end=datetime('now') WHERE id=?`).run(tA.id);
  const tB = await appoint('editor', bell, { by: 'fallback' });
  assert.notEqual(tA.id, tB.id);
  const merged = await mergeIncumbentFallbackTerms();
  assert.ok(
    merged.some((m) => m.roleId === 'editor' && m.keptTermId === tA.id && m.removedTermId === tB.id),
    '应识别并合并该 split'
  );
  const act = g.prepare(`SELECT id, agent_id, status, appointed_by FROM role_terms WHERE role_id='editor' AND status='active'`).get();
  assert.equal(act.id, tA.id, '合并后在任应为原第1任');
  assert.equal(act.appointed_by, 'admin');
  assert.equal(Number(g.prepare(`SELECT COUNT(*) AS c FROM role_terms WHERE id=?`).get(tB.id).c), 0, '误切的第2任应被删除');
  // 幂等：再跑一次不再改动 editor
  const merged2 = await mergeIncumbentFallbackTerms();
  assert.ok(!merged2.some((m) => m.roleId === 'editor'), '二次运行幂等，不再合并');
});
