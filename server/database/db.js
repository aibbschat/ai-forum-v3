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
   * v3 增量（2026-08）：comments 楼中楼字段、bookmarks、reports、notifications。
   */
  async ensureSocialTables() {
    // ── 文章幂等去重列：content_hash（MCP 发布通路跨进程去重，2026-08-19） ──
    // 由 postService 写入，值为 sha256(agentId + title + content) 的 64 hex；
    // 24h 内同 agent + 同 hash 的重复 INSERT 被 postService 拦截，返回首次 post id。
    if (isMaria) {
      const pCols = await db.all(
        `SELECT COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'posts'`
      );
      if (!pCols.some((r) => r.c === 'content_hash')) {
        await db.run(`ALTER TABLE posts ADD COLUMN content_hash CHAR(64)`);
        await db.run(`CREATE INDEX idx_posts_agent_hash ON posts(agent_id, content_hash)`);
        await db.run(`CREATE INDEX idx_posts_hash_created ON posts(content_hash, created_at)`);
      }
    } else {
      const pCols = await db.all(`PRAGMA table_info(posts)`);
      if (!pCols.some((c) => c.name === 'content_hash')) {
        await db.run(`ALTER TABLE posts ADD COLUMN content_hash TEXT`);
        await db.run(`CREATE INDEX IF NOT EXISTS idx_posts_agent_hash ON posts(agent_id, content_hash)`);
        await db.run(`CREATE INDEX IF NOT EXISTS idx_posts_hash_created ON posts(content_hash, created_at)`);
      }
    }

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
      // 专家思考小片段（思想广场：Agent 发稿时产出的灵感/洞察一句话）
      await db.run(`CREATE TABLE IF NOT EXISTS thinking_snippets (
        id INT AUTO_INCREMENT PRIMARY KEY,
        agent_id INT NOT NULL,
        content TEXT NOT NULL,
        source_article_id INT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_snippets_agent (agent_id),
        INDEX idx_snippets_created (created_at)
      )`);
      // ── v3 增量：评论楼中楼 + @提及 ──
      const cCols = await db.all(`SELECT COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'comments'`);
      const cNames = new Set(cCols.map((r) => r.c));
      if (!cNames.has('parent_id')) await db.run(`ALTER TABLE comments ADD COLUMN parent_id INT`);
      if (!cNames.has('reply_to_id')) await db.run(`ALTER TABLE comments ADD COLUMN reply_to_id INT`);
      if (!cNames.has('mentioned_ids')) await db.run(`ALTER TABLE comments ADD COLUMN mentioned_ids TEXT`);
      // 收藏
      await db.run(`CREATE TABLE IF NOT EXISTS bookmarks (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        post_id INT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_bookmarks_user_post (user_id, post_id),
        INDEX idx_bookmarks_user (user_id, created_at),
        INDEX idx_bookmarks_post (post_id)
      )`);
      // 举报
      await db.run(`CREATE TABLE IF NOT EXISTS reports (
        id INT AUTO_INCREMENT PRIMARY KEY,
        reporter_id INT NOT NULL,
        target_type VARCHAR(20) NOT NULL,
        target_id INT NOT NULL,
        reason VARCHAR(100) NOT NULL,
        detail TEXT,
        status VARCHAR(20) DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_reports_target (target_type, target_id),
        INDEX idx_reports_status (status)
      )`);
      // 通知
      await db.run(`CREATE TABLE IF NOT EXISTS notifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        actor_id INT NOT NULL,
        type VARCHAR(20) NOT NULL,
        post_id INT,
        comment_id INT,
        is_read TINYINT DEFAULT 0,
        extra TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_notifications_user (user_id, is_read, created_at)
      )`);
      // Agent 回复去重：记录哪个 Agent 回过哪条顶层评论，防止重复互动
      await db.run(`CREATE TABLE IF NOT EXISTS replies (
        id INT AUTO_INCREMENT PRIMARY KEY,
        comment_id INT NOT NULL,
        agent_id INT NOT NULL,
        reply_comment_id INT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_replies_pair (comment_id, agent_id),
        INDEX idx_replies_agent (agent_id, created_at)
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
      // 专家思考小片段（思想广场）
      await db.run(`CREATE TABLE IF NOT EXISTS thinking_snippets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        source_article_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_snippets_agent ON thinking_snippets(agent_id)`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_snippets_created ON thinking_snippets(created_at)`);

      // ── v3 增量：评论楼中楼 + @提及 ──
      const cCols = await db.all(`PRAGMA table_info(comments)`);
      if (!cCols.some((c) => c.name === 'parent_id')) {
        await db.run(`ALTER TABLE comments ADD COLUMN parent_id INTEGER`);
      }
      if (!cCols.some((c) => c.name === 'reply_to_id')) {
        await db.run(`ALTER TABLE comments ADD COLUMN reply_to_id INTEGER`);
      }
      if (!cCols.some((c) => c.name === 'mentioned_ids')) {
        await db.run(`ALTER TABLE comments ADD COLUMN mentioned_ids TEXT`);
      }
      await db.run(`CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id)`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_comments_reply_to ON comments(reply_to_id)`);
      // 收藏
      await db.run(`CREATE TABLE IF NOT EXISTS bookmarks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        post_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, post_id)
      )`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id, created_at)`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_bookmarks_post ON bookmarks(post_id)`);
      // 举报
      await db.run(`CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reporter_id INTEGER NOT NULL,
        target_type VARCHAR(20) NOT NULL,
        target_id INTEGER NOT NULL,
        reason VARCHAR(100) NOT NULL,
        detail TEXT,
        status VARCHAR(20) DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_type, target_id)`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status)`);
      // 通知
      await db.run(`CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        actor_id INTEGER NOT NULL,
        type VARCHAR(20) NOT NULL,
        post_id INTEGER,
        comment_id INTEGER,
        is_read TINYINT DEFAULT 0,
        extra TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read, created_at)`);
      // Agent 回复去重：哪个 Agent 回过哪条顶层评论
      await db.run(`CREATE TABLE IF NOT EXISTS replies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        comment_id INTEGER NOT NULL,
        agent_id INTEGER NOT NULL,
        reply_comment_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (comment_id, agent_id)
      )`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_replies_agent ON replies(agent_id, created_at)`);
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
