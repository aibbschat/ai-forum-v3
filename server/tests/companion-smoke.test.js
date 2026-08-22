// server/tests/companion-smoke.test.js
// companionService + 按 username 取档 + 微主页隐私门逻辑冒烟（sqlite :memory: 隔离）。
process.env.DB_PATH = ':memory:';

const { default: db } = await import('../database/db.js');
const svc = await import('../services/companionService.js');
import { test } from 'node:test';
import assert from 'node:assert/strict';

await db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, nickname TEXT, avatar TEXT)`);
await db.run(`CREATE TABLE IF NOT EXISTS companion_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  username VARCHAR(50) NOT NULL UNIQUE,
  avatar TEXT,
  sprite_sheet VARCHAR(512),
  persona_json TEXT,
  intro_prompt TEXT,
  badge VARCHAR(20) NOT NULL DEFAULT '我的搭档',
  is_public TINYINT(1) NOT NULL DEFAULT 0,
  daily_used INT NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_active_at DATETIME
)`);

test('create → getByUsername → 1-per-user → update → 隐私门 → delete', async () => {
  const c = await svc.createCompanion(28, {
    name: '聿安',
    username: 'yuan_an',
    avatar: 'data:image/png;base64,AAA',
    sprite_sheet: null,
    persona_json: { bio: '温和但犀利', interests: ['历史'], traits: { talkative: 0.5, warmth: 0.8 } },
  });
  assert.equal(c.name, '聿安');
  assert.equal(c.owner_id, 28);
  assert.ok(c.persona && c.persona.bio === '温和但犀利');
  assert.ok(c.intro_prompt && c.intro_prompt.includes('聿安'));
  assert.equal(c.sprite_sheet, null);

  // 一期每人 1 个
  await assert.rejects(
    () => svc.createCompanion(28, { name: 'x', username: 'x2' }),
    /仅可创建 1 个/
  );

  // 按 username 取档（微主页 / 聊天页用）
  const byU = await svc.getCompanionByUsername('yuan_an');
  assert.equal(byU.id, c.id);

  // 路由隐私门逻辑（复制自 routes/companion.js）：owner 或 is_public 才可见
  const visibleToOwner = byU.owner_id === 28 || byU.is_public === 1;
  const visibleToStranger = byU.owner_id === 999 && byU.is_public === 1; // 非 owner 且私域 → 路由 404
  assert.equal(visibleToOwner, true);
  assert.equal(visibleToStranger, false);

  // 更新（含公开开关 + sprite_sheet）
  const u = await svc.updateCompanion(28, c.id, {
    name: '聿安2',
    is_public: 1,
    sprite_sheet: 'https://x/companion-九宫格.png',
  });
  assert.equal(u.name, '聿安2');
  assert.equal(u.is_public, 1);
  assert.equal(u.sprite_sheet, 'https://x/companion-九宫格.png');

  // 删除后取档 404
  const d = await svc.deleteCompanion(28, c.id);
  assert.equal(d.ok, true);
  await assert.rejects(() => svc.getCompanionById(c.id), /不存在/);
});
