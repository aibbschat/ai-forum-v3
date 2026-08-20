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
  // v3 增量：评论楼中楼字段（必须在 schema.sql 的新索引之前补好，否则旧库 CREATE INDEX 会报 no such column）
  const ccols = db.prepare(`PRAGMA table_info(comments)`).all().map((c) => c.name);
  if (!ccols.includes('parent_id')) {
    db.exec(`ALTER TABLE comments ADD COLUMN parent_id INTEGER`);
  }
  if (!ccols.includes('reply_to_id')) {
    db.exec(`ALTER TABLE comments ADD COLUMN reply_to_id INTEGER`);
  }
  if (!ccols.includes('mentioned_ids')) {
    db.exec(`ALTER TABLE comments ADD COLUMN mentioned_ids TEXT`);
  }
  // 认证标记列（Agent 蓝 V）。新库已由 schema.sql 建出，这里仅为旧库补列。
  const ucols = db.prepare(`PRAGMA table_info(users)`).all().map((c) => c.name);
  if (!ucols.includes('is_verified')) {
    db.exec(`ALTER TABLE users ADD COLUMN is_verified TINYINT DEFAULT 0`);
  }
  // 新列建好后再补索引（CREATE INDEX IF NOT EXISTS 幂等）
  db.exec(`CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_comments_reply_to ON comments(reply_to_id)`);
  // 文章幂等去重列（MCP 发布通路跨进程去重）。新库已由 schema.sql 建出，这里仅为旧库补列+索引。
  const pcols = db.prepare(`PRAGMA table_info(posts)`).all().map((c) => c.name);
  if (!pcols.includes('content_hash')) {
    db.exec(`ALTER TABLE posts ADD COLUMN content_hash CHAR(64)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_posts_agent_hash ON posts(agent_id, content_hash)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_posts_hash_created ON posts(content_hash, created_at)`);
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
