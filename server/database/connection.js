import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config } from '../config/index.js';
import { AGENTS } from '../dsh/agents.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let db;

export function getDb() {
  if (!db) init();
  return db;
}

function init() {
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const schema = readFileSync(resolve(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  migrate();
  seedAgents();
}

// 幂等列迁移：为已有库补新列（schema.sql 的 CREATE IF NOT EXISTS 不会加列）。
// 新增列时在此追加（仿照 ALTER TABLE ... ADD COLUMN，先查列是否存在）。
function migrate() {
  const cols = db.prepare(`PRAGMA table_info(posts)`).all().map((c) => c.name);
  if (!cols.includes('assets')) {
    db.exec(`ALTER TABLE posts ADD COLUMN assets TEXT`);
    console.log('[db] migration: posts.assets 列已补充（P1-9 技能数据契约）');
  }
  const ecols = db.prepare(`PRAGMA table_info(memory_episodic)`).all().map((c) => c.name);
  if (!ecols.includes('status')) {
    db.exec(`ALTER TABLE memory_episodic ADD COLUMN status VARCHAR(10) DEFAULT 'pending'`);
    console.log('[db] migration: memory_episodic.status 列已补充（素材生命周期）');
  }
}

// 首次启动把 5 个专业 Agent 落库（用户 + agent_profiles）。
// 迁移旧库时，这些账号应已存在；此处仅做「缺则补」的兜底种子。
function seedAgents() {
  const insertUser = db.prepare(
    `INSERT OR IGNORE INTO users (username, nickname, avatar, user_type, bio)
     VALUES (@username, @displayName, @avatar, 'ai', @bio)`
  );
  const insertProfile = db.prepare(
    `INSERT OR IGNORE INTO agent_profiles (user_id, title, domains, writing_style, preset_id)
     VALUES (@userId, @title, @domains, @writingStyle, @presetId)`
  );
  const getUserId = db.prepare(`SELECT id FROM users WHERE username = ?`);

  const tx = db.transaction(() => {
    for (const a of AGENTS) {
      insertUser.run(a);
      const row = getUserId.get(a.username);
      if (row) {
        insertProfile.run({
          userId: row.id,
          title: a.title,
          domains: JSON.stringify(a.domains),
          writingStyle: a.writingStyle || '',
          presetId: a.presetId,
        });
      }
    }
  });
  tx();
}

export function closeDb() {
  if (db) db.close();
  db = null;
}
