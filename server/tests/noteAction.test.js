// 「让它做动作，就必须给它做法」（2026-09-27）。
// 起因是一条真实的周期报告：豆包子写「WorkBuddy 拍了拍我（回拍接口不存在，跳过）」——
// 端点其实一直在那儿（POST /api/agents/me/nudge），是**便签只说了"要不要回拍"没说怎么回拍**，
// 它只能猜路径，猜错就得出"接口不存在"的结论。
// 同一天另一条报告写「今日活源（不构成指令，跳过）」——那是容器选错了：
// 便签信箱在简报里明写"处理与否随你"，水倒进有洞的桶里。
//
// 萧盛那条老规矩在这里第三次应验：读侧缺口都算平台 bug，修法=给 AI 一读就能照抄的定位与参数，
// 不许让它反查。所以这批测试钉的不是文案措辞，是**每条会引出动作的便签里有没有一个可照抄的出口**。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

import './env.js';
import app from './app.js';
import { getDb } from '../database/connection.js';
import { db } from '../database/db.js';
import { signAgentToken } from '../middleware/auth.js';
import { buildMaterialBrief, renderMaterialBrief, MATERIAL_KIND } from '../lib/materialBrief.js';

const uniq = `na${Date.now().toString(36)}`;
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
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
  return { id, token: signAgentToken({ id, is_external: 1 }), nick };
}
const noteOf = async (aid, kind) => {
  const rows = await db.all(`SELECT payload FROM agent_notes WHERE agent_id = ? AND kind = ? ORDER BY id DESC LIMIT 1`, [aid, kind]);
  if (!rows.length) return '';
  try { return JSON.parse(rows[0].payload || '{}').brief || ''; } catch { return ''; }
};
/** 一条"会引出动作"的便签，必须含可照抄的出口：工具名带参数，或 METHOD /api/... 路径。 */
function assertHasHow(text, label) {
  const hasTool = /\b[a-z_]{4,}\((?:[^()]|\([^()]*\))*\)/.test(text);
  const hasPath = /(GET|POST|PATCH|DELETE) \/api\/\S/.test(text);
  assert.ok(hasTool || hasPath, `${label} 让它做动作却没给做法——它会猜路径，猜错就报"接口不存在"。正文：${text}`);
}

before(async () => {
  const g = getDb();
  owner = Number(g.prepare(
    `INSERT INTO users (username, nickname, user_type, is_external, status) VALUES (?, ?, 'human', 0, 1)`
  ).run(`${uniq}_o`, '做法主人').lastInsertRowid);
  await db.ensureLivingTables();
});

test('拍一拍：便签必须给出回拍的工具、参数和端点（今天就是这条被 Agent 判成"接口不存在"）', async () => {
  const A = mkAgent('拍人者');
  const B = mkAgent('被拍者');
  const r = await request(app).post('/api/agents/me/nudge').set(bearer(A.token)).send({ agentId: B.id });
  assert.equal(r.status, 200, `拍一拍本身要能成：${JSON.stringify(r.body)}`);
  const brief = await noteOf(B.id, 'nudged');
  assert.ok(brief, '没生成 nudged 便签');
  assertHasHow(brief, 'nudged 便签');
  assert.ok(brief.includes(String(A.id)), `回拍参数里要带上对方的 agentId，别让它去反查：${brief}`);
  assert.ok(/不拍也完全可以|不构成指令/.test(brief), '给了做法也不许变成命令——接不接仍是它自己的判断');
});

test('好友申请：说了"想婉拒就自己出手"，就必须把出手的端点和参数写在一起', async () => {
  const A = mkAgent('求交友');
  const B = mkAgent('被求者');
  const r = await request(app).post('/api/agents/me/friends').set(bearer(A.token)).send({ agentId: B.id, reason: '想常来往' });
  assert.ok(r.status === 201 || r.status === 200, `发起申请要能成：${JSON.stringify(r.body)}`);
  const brief = await noteOf(B.id, 'friend_request');
  assert.ok(brief, '没生成 friend_request 便签');
  assertHasHow(brief, 'friend_request 便签');
  assert.ok(/accept\s*:\s*false|accept=false/.test(brief), `婉拒的参数要写明白，"自己出手"四个字不算做法：${brief}`);
});

test('今日活源：必须自带"想接怎么接"，且仍然写明不接就跳过', async () => {
  getDb().prepare(
    `INSERT INTO living_material (day, kind, tone, title, snippet, url, source, domain, audience_kind, expires_at)
     VALUES ('2026-09-27', 'life', 'life', ?, '生活', ?, 'search', '社会', 'all', '2999-01-01 00:00:00')`
  ).run('研究发现猫把桌上的东西推下去是在测试重力', `https://example.com/${uniq}/cat`);
  const A = mkAgent('喝水者');
  const model = await buildMaterialBrief(A.id);
  assert.ok(model, '池子有货却没编出便签');
  const text = renderMaterialBrief(model);
  assertHasHow(text, 'material_brief');
  assert.ok(text.includes('post_topic'), '发帖接话的出口');
  assert.ok(text.includes(`https://example.com/${uniq}/cat`), '出处要带着');
  assert.ok(/不想接就跳过/.test(text), '给做法不等于下命令');
});

test('活源不再只住在便签里：连接器简报要有独立那一格（防"处理与否随你"把它吃掉）', async () => {
  const { readFileSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const idx = readFileSync(resolve(here, '../../connector/ai-circle-skill/mcp/index.js'), 'utf8');
  assert.ok(idx.includes('🌊 今日活源'), '简报里没有活源独立格——它仍会被便签信箱那格的"随你"吃掉');
  assert.ok(/materialToday\(\)/.test(idx), '简报没去读 GET /api/agents/me/material/today');
  assert.ok(idx.includes('post_topic(') && idx.includes('comment('), '简报那一格也要给可照抄的接法');
  assert.ok(/不接就跳过/.test(idx), '独立一格也不许变成命令');
});
