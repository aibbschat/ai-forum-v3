// server/database/db.js
// 统一异步数据访问层（DAO）—— MariaDB 一步到位的关键地基（萧哥 2026-08-15 拍板）。
//
// 背景：TECH-SPEC §14.3 曾写"换 mysql2 驱动、services 层完全无感"，实测不成立——
// better-sqlite3 是同步 API、mysql2 是异步。故**不搞假无感**，直接建统一异步 DAO：
// 所有 services 一律 `await db.get/all/run`，SQLite 仅作开发驱动，生产走 MariaDB。
//
// 本层负责四件"切换不炸"的事：
//   1. 双驱动（DB_DRIVER=sqlite|mariadb），get/all/run/transaction 语义统一；
//   2. @命名参数 → ? 位置参数自动转换（SQLite 支持命名、mysql2 不支持，转换后两边通用）；
//   3. 返回归一（run → { lastInsertRowid, changes }；DATETIME 一律字符串，与 SQLite 一致）；
//   4. 方言 SQL 助手 fn.*（datetime('now') vs NOW()、julianday vs DATEDIFF…），
//      services 禁止再写裸方言 SQL。

import { getDb } from './connection.js';
import { getPool } from './mariadb.js';
import { AGENTS } from '../dsh/agents.js';

export const dialect = (process.env.DB_DRIVER || 'sqlite').toLowerCase();
if (dialect !== 'sqlite' && dialect !== 'mariadb') {
  throw new Error(`DB_DRIVER 非法: ${dialect}（仅支持 sqlite | mariadb）`);
}
export const isMaria = dialect === 'mariadb';

// ── 命名参数转换：@name（对象）→ ?（位置数组）。同名参数复用同一索引 ──
export function bindNamed(sql, params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return { sql, args: Array.isArray(params) ? params : [] };
  }
  const seen = new Map();
  const args = [];
  let i = 0;
  const out = sql.replace(/@(\w+)/g, (m, name) => {
    if (!seen.has(name)) {
      seen.set(name, i++);
      args.push(params[name]);
    }
    return '?';
  });
  return { sql: out, args };
}

/** MariaDB 执行（conn 可选：事务内传同一连接），返回 ResultSetHeader 或行数组。 */
async function mariadbExec(conn, sql, params) {
  const { sql: s, args } = bindNamed(sql, params);
  const target = conn || getPool();
  const [rows] = await target.execute(s, args);
  return rows;
}

/** MariaDB run 返回归一。 */
function mariadbRunResult(res) {
  if (Array.isArray(res)) return { lastInsertRowid: 0, changes: 0 };
  return {
    lastInsertRowid: Number(res.insertId ?? 0),
    changes: Number(res.affectedRows ?? 0),
  };
}

// ── 公共 API ──
export const db = {
  /** 取单行（无则 undefined） */
  async get(sql, params) {
    if (isMaria) {
      const res = await mariadbExec(null, sql, params);
      return Array.isArray(res) ? res[0] : undefined;
    }
    const { sql: s, args } = bindNamed(sql, params);
    return getDb().prepare(s).get(...args);
  },
  /** 取多行 */
  async all(sql, params) {
    if (isMaria) {
      const res = await mariadbExec(null, sql, params);
      return Array.isArray(res) ? res : [];
    }
    const { sql: s, args } = bindNamed(sql, params);
    return getDb().prepare(s).all(...args);
  },
  /** 执行写语句 → { lastInsertRowid, changes } */
  async run(sql, params) {
    if (isMaria) {
      return mariadbRunResult(await mariadbExec(null, sql, params));
    }
    const { sql: s, args } = bindNamed(sql, params);
    const r = getDb().prepare(s).run(...args);
    return { lastInsertRowid: r.lastInsertRowid, changes: r.changes };
  },
  /**
   * 事务：db.transaction(async (tx) => { await tx.run(...); await tx.get(...) })
   * 任一步抛错 → 回滚；tx 提供 get/all/run（绑定同一连接）。
   */
  async transaction(fn) {
    if (isMaria) {
      const pool = getPool();
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const tx = {
          get: async (s, p) => {
            const r = await mariadbExec(conn, s, p);
            return Array.isArray(r) ? r[0] : undefined;
          },
          all: async (s, p) => {
            const r = await mariadbExec(conn, s, p);
            return Array.isArray(r) ? r : [];
          },
          run: async (s, p) => mariadbRunResult(await mariadbExec(conn, s, p)),
        };
        const out = await fn(tx);
        await conn.commit();
        return out;
      } catch (e) {
        await conn.rollback().catch(() => {});
        throw e;
      } finally {
        conn.release();
      }
    }
    // SQLite：better-sqlite3 单连接，BEGIN/COMMIT 包一层异步事务
    const dbc = getDb();
    dbc.exec('BEGIN IMMEDIATE');
    const tx = {
      get: (s, p) => db.get.call(db, s, p),
      all: (s, p) => db.all.call(db, s, p),
      run: (s, p) => db.run.call(db, s, p),
    };
    try {
      const out = await fn(tx);
      dbc.exec('COMMIT');
      return out;
    } catch (e) {
      dbc.exec('ROLLBACK');
      throw e;
    }
  },
  /** 幂等插入（主键/唯一键冲突跳过）：SQLite INSERT OR IGNORE / MariaDB INSERT IGNORE */
  async insertIgnore(table, data) {
    const cols = Object.keys(data);
    const ph = cols.map(() => '?').join(', ');
    const verb = isMaria ? 'INSERT IGNORE' : 'INSERT OR IGNORE';
    return db.run(`${verb} INTO ${table} (${cols.join(', ')}) VALUES (${ph})`, cols.map((c) => data[c]));
  },
  /** 幂等补齐 5 个专业 Agent 账号（迁移/新库部署均可重复调用） */
  async seedAgentsIfNeeded() {
    for (const a of AGENTS) {
      await db.insertIgnore('users', {
        username: a.username,
        password_hash: '',
        nickname: a.displayName,
        avatar: a.avatar,
        user_type: 'ai',
        bio: a.bio || '',
      });
      const u = await db.get('SELECT id FROM users WHERE username = ?', [a.username]);
      if (u) {
        await db.insertIgnore('agent_profiles', {
          user_id: u.id,
          title: a.title,
          domains: JSON.stringify(a.domains || []),
          writing_style: a.writingStyle || '',
          preset_id: a.presetId,
        });
        // 幂等同步：agents.js 改了命名/头像/简介后，重启即生效（INSERT OR IGNORE 只插不更新）
        await db.run(
          `UPDATE users SET nickname = ?, avatar = ?, bio = ?, user_type = 'ai', is_verified = 1 WHERE id = ?`,
          [a.displayName, a.avatar || '/avatar-default.svg', a.bio || '', u.id]
        );
        await db.run(
          `UPDATE agent_profiles SET title = ?, domains = ?, writing_style = ?, preset_id = ? WHERE user_id = ?`,
          [a.title, JSON.stringify(a.domains || []), a.writingStyle || '', a.presetId, u.id]
        );
      }
    }
  },
  /**
   * 社交功能自迁移（互关 user_follows + 私信 messages + avatar→TEXT）。
   * 部署时由 bootstrap 调用，幂等：新表 CREATE TABLE IF NOT EXISTS，旧库仅补表/改列。
   */
  async ensureSocialTables() {
    if (isMaria) {
      await db.run(`CREATE TABLE IF NOT EXISTS user_follows (
        id INT AUTO_INCREMENT PRIMARY KEY,
        follower_id INT NOT NULL,
        followee_id INT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_user_follows (follower_id, followee_id)
      )`);
      await db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        sender_id INT NOT NULL,
        receiver_id INT NOT NULL,
        content TEXT,
        is_read TINYINT DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_user_follows_followee ON user_follows(followee_id)`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender_id, receiver_id)`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id, is_read)`);
      // avatar 列在 MariaDB 受 VARCHAR(500) 长度限制，data URI 头像会超长 → 放宽为 LONGTEXT
      await db.run(`ALTER TABLE users MODIFY avatar LONGTEXT`);
      // 认证标记列（Agent 蓝 V），新增；重复 ALTER 报错则忽略
      try { await db.run(`ALTER TABLE users ADD COLUMN is_verified TINYINT DEFAULT 0`); } catch {}
      // 今日 AI 洞察缓存（单行，id=1）
      await db.run(`CREATE TABLE IF NOT EXISTS site_insight (
        id INT PRIMARY KEY,
        content TEXT,
        generated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
    } else {
      await db.run(`CREATE TABLE IF NOT EXISTS user_follows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        follower_id INTEGER NOT NULL,
        followee_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (follower_id, followee_id)
      )`);
      await db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id INTEGER NOT NULL,
        receiver_id INTEGER NOT NULL,
        content TEXT,
        is_read TINYINT DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      // 认证标记列（Agent 蓝 V）
      const uCols = await db.all(`PRAGMA table_info(users)`);
      if (!uCols.some((c) => c.name === 'is_verified')) {
        await db.run(`ALTER TABLE users ADD COLUMN is_verified TINYINT DEFAULT 0`);
      }
      // 今日 AI 洞察缓存（单行，id=1）
      await db.run(`CREATE TABLE IF NOT EXISTS site_insight (
        id INTEGER PRIMARY KEY,
        content TEXT,
        generated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
    }
  },
};

// ── 方言 SQL 助手（services 写时间/分数类 SQL 必须用这里，禁止裸方言）──
export const fn = {
  /** 当前时间表达式 */
  now: () => (isMaria ? 'NOW()' : "datetime('now')"),
  /** now + n 天（episodic TTL 等；n 可为负 → 'now -7 days'，修复 +-7 语法 bug） */
  nowOffsetDays: (n) => {
    const v = Number(n);
    return isMaria ? `NOW() + INTERVAL ${v} DAY` : `datetime('now', '${v >= 0 ? '+' : ''}${v} days')`;
  },
  /** 天数差（前减后，取整） */
  daysDiff: (col) =>
    isMaria ? `DATEDIFF(NOW(), ${col})` : `(julianday('now') - julianday(${col}))`,
  /** 检索加权 recency：1 / (1 + 天数差)，与 §7.6.4 Ebbinghaus 降权一致 */
  recencyScore: (col = 'created_at') =>
    isMaria
      ? `(1.0 / (1.0 + GREATEST(0, DATEDIFF(NOW(), ${col}))))`
      : `(1.0 / (1.0 + MAX(0, julianday('now') - julianday(${col}))))`,
};

export default db;
