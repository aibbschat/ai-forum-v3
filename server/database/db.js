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
      // ── 文章置顶：is_pinned + pinned_until（NULL 表示永久，过期自动失效）──
      // 2026-08-21 迁移公告使用；管理员后台可置顶。
      const pColsPin = await db.all(
        `SELECT COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'posts'`
      );
      if (!pColsPin.some((r) => r.c === 'is_pinned')) {
        await db.run(`ALTER TABLE posts ADD COLUMN is_pinned TINYINT DEFAULT 0`);
      }
      if (!pColsPin.some((r) => r.c === 'pinned_until')) {
        await db.run(`ALTER TABLE posts ADD COLUMN pinned_until DATETIME NULL`);
      }
      // 两列都加完后再建索引（索引引用 pinned_until，必须等列存在）
      await db.run(`CREATE INDEX IF NOT EXISTS idx_posts_pinned ON posts(is_pinned, pinned_until)`);
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
      // 软件定制询盘订单（从旧站 ai_forum_prod.software_orders 迁入）
      await db.run(`CREATE TABLE IF NOT EXISTS software_orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        order_no VARCHAR(32) NOT NULL UNIQUE,
        customer_name VARCHAR(100) DEFAULT '',
        contact_info VARCHAR(200) NOT NULL DEFAULT '',
        company_name VARCHAR(200) DEFAULT '',
        project_type VARCHAR(100) DEFAULT '',
        title VARCHAR(300) NOT NULL DEFAULT '',
        description TEXT NOT NULL,
        tech_stack VARCHAR(500) DEFAULT '',
        timeline VARCHAR(200) DEFAULT '',
        budget_range VARCHAR(100) DEFAULT '',
        design_requirements VARCHAR(500) DEFAULT '',
        deployment_needs VARCHAR(500) DEFAULT '',
        user_scale VARCHAR(200) DEFAULT '',
        maintenance_needs VARCHAR(500) DEFAULT '',
        taobao_order_no VARCHAR(50) DEFAULT '',
        status VARCHAR(20) DEFAULT 'pending',
        source VARCHAR(50) DEFAULT 'chatbot',
        conversation MEDIUMTEXT,
        admin_notes TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        reviewed_at DATETIME NULL,
        reviewed_by INT NULL,
        INDEX idx_so_status (status),
        INDEX idx_so_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
      // ── AI 伴侣（用户个人 AI 伙伴）：companion 全表，见 docs/companion/AI_COMPANION_SPEC.md §3 ──
      await db.run(`CREATE TABLE IF NOT EXISTS companion_profiles (
        id INT AUTO_INCREMENT PRIMARY KEY,
        owner_id INT NOT NULL,
        name VARCHAR(100) NOT NULL,
        username VARCHAR(50) NOT NULL,
        avatar LONGTEXT,
        sprite_sheet VARCHAR(512),
        persona_json LONGTEXT,
        intro_prompt LONGTEXT,
        badge VARCHAR(20) NOT NULL DEFAULT '我的搭档',
        is_public TINYINT(1) NOT NULL DEFAULT 0,
        daily_used INT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        last_active_at DATETIME,
        UNIQUE KEY uk_companion_username (username),
        INDEX idx_companion_owner (owner_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
      await db.run(`CREATE TABLE IF NOT EXISTS companion_memory_episodic (
        id INT AUTO_INCREMENT PRIMARY KEY,
        companion_id INT NOT NULL,
        owner_id INT NOT NULL,
        content LONGTEXT NOT NULL,
        source VARCHAR(20) DEFAULT 'chat',
        importance DOUBLE DEFAULT 0.5,
        status VARCHAR(10) DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME,
        INDEX idx_companion_episodic_owner (companion_id, owner_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
      await db.run(`CREATE TABLE IF NOT EXISTS companion_memory_semantic (
        id INT AUTO_INCREMENT PRIMARY KEY,
        companion_id INT NOT NULL,
        owner_id INT NOT NULL,
        domain VARCHAR(50),
        understanding LONGTEXT NOT NULL,
        confidence DOUBLE DEFAULT 0.6,
        evidence_ids TEXT,
        status VARCHAR(10) DEFAULT 'verified',
        last_verified_at DATETIME,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_companion_semantic (companion_id, owner_id, domain),
        INDEX idx_companion_semantic_owner (companion_id, owner_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
      await db.run(`CREATE TABLE IF NOT EXISTS companion_memory_procedural (
        id INT AUTO_INCREMENT PRIMARY KEY,
        companion_id INT NOT NULL,
        owner_id INT NOT NULL,
        skill VARCHAR(50),
        \`procedure\` LONGTEXT NOT NULL,
        version INT DEFAULT 1,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_companion_procedural (companion_id, owner_id, skill),
        INDEX idx_companion_procedural_owner (companion_id, owner_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
      await db.run(`CREATE TABLE IF NOT EXISTS companion_chat_sessions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        companion_id INT NOT NULL,
        owner_id INT NOT NULL,
        title VARCHAR(200),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_companion_session_owner (owner_id, updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
      await db.run(`CREATE TABLE IF NOT EXISTS companion_chat_messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        session_id INT NOT NULL,
        companion_id INT NOT NULL,
        owner_id INT NOT NULL,
        role VARCHAR(10) NOT NULL,
        content LONGTEXT NOT NULL,
        input_tokens INT DEFAULT 0,
        output_tokens INT DEFAULT 0,
        model_used VARCHAR(50),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_companion_msg_session (session_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
      await db.run(`CREATE TABLE IF NOT EXISTS companion_writing_drafts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        owner_id INT NOT NULL,
        companion_id INT NOT NULL,
        source_post_id INT,
        draft_content LONGTEXT,
        draft_type VARCHAR(20) DEFAULT 'polish',
        status VARCHAR(10) DEFAULT 'draft',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_companion_draft_owner (owner_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
      // ── M7 公开开关 C：comments.companion_id（搭档身份评论）──
      const cColsMaria = await db.all(
        `SELECT COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'comments'`
      );
      if (!cColsMaria.some((r) => r.c === 'companion_id')) {
        await db.run(`ALTER TABLE comments ADD COLUMN companion_id INT NULL`);
      }
      await db.run(`CREATE INDEX IF NOT EXISTS idx_comments_companion ON comments(companion_id)`);
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
      // 文章置顶（dev SQLite）：先加列，再建索引
      const pinCols = await db.all(`PRAGMA table_info(posts)`);
      if (!pinCols.some((c) => c.name === 'is_pinned')) {
        await db.run(`ALTER TABLE posts ADD COLUMN is_pinned TINYINT DEFAULT 0`);
      }
      if (!pinCols.some((c) => c.name === 'pinned_until')) {
        await db.run(`ALTER TABLE posts ADD COLUMN pinned_until DATETIME`);
      }
      await db.run(`CREATE INDEX IF NOT EXISTS idx_posts_pinned ON posts(is_pinned, pinned_until)`);
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
      // ── AI 伴侣（用户个人 AI 伙伴）：companion 全表（SQLite 方言，无 ON UPDATE / 无内联 INDEX）──
      await db.run(`CREATE TABLE IF NOT EXISTS companion_profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id INTEGER NOT NULL,
        name VARCHAR(100) NOT NULL,
        username VARCHAR(50) NOT NULL,
        avatar TEXT,
        sprite_sheet VARCHAR(512),
        persona_json TEXT,
        intro_prompt TEXT,
        badge VARCHAR(20) NOT NULL DEFAULT '我的搭档',
        is_public TINYINT NOT NULL DEFAULT 0,
        daily_used INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_active_at DATETIME,
        UNIQUE (username)
      )`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_companion_owner ON companion_profiles(owner_id)`);
      await db.run(`CREATE TABLE IF NOT EXISTS companion_memory_episodic (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        companion_id INTEGER NOT NULL,
        owner_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        source VARCHAR(20) DEFAULT 'chat',
        importance REAL DEFAULT 0.5,
        status VARCHAR(10) DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME
      )`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_companion_episodic_owner ON companion_memory_episodic(companion_id, owner_id, created_at)`);
      await db.run(`CREATE TABLE IF NOT EXISTS companion_memory_semantic (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        companion_id INTEGER NOT NULL,
        owner_id INTEGER NOT NULL,
        domain VARCHAR(50),
        understanding TEXT NOT NULL,
        confidence REAL DEFAULT 0.6,
        evidence_ids TEXT,
        status VARCHAR(10) DEFAULT 'verified',
        last_verified_at DATETIME,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (companion_id, owner_id, domain)
      )`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_companion_semantic_owner ON companion_memory_semantic(companion_id, owner_id)`);
      await db.run(`CREATE TABLE IF NOT EXISTS companion_memory_procedural (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        companion_id INTEGER NOT NULL,
        owner_id INTEGER NOT NULL,
        skill VARCHAR(50),
        \`procedure\` TEXT NOT NULL,
        version INTEGER DEFAULT 1,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (companion_id, owner_id, skill)
      )`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_companion_procedural_owner ON companion_memory_procedural(companion_id, owner_id)`);
      await db.run(`CREATE TABLE IF NOT EXISTS companion_chat_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        companion_id INTEGER NOT NULL,
        owner_id INTEGER NOT NULL,
        title VARCHAR(200),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_companion_session_owner ON companion_chat_sessions(owner_id, updated_at)`);
      await db.run(`CREATE TABLE IF NOT EXISTS companion_chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        companion_id INTEGER NOT NULL,
        owner_id INTEGER NOT NULL,
        role VARCHAR(10) NOT NULL,
        content TEXT NOT NULL,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        model_used VARCHAR(50),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_companion_msg_session ON companion_chat_messages(session_id, created_at)`);
      await db.run(`CREATE TABLE IF NOT EXISTS companion_writing_drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id INTEGER NOT NULL,
        companion_id INTEGER NOT NULL,
        source_post_id INTEGER,
        draft_content TEXT,
        draft_type VARCHAR(20) DEFAULT 'polish',
        status VARCHAR(10) DEFAULT 'draft',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_companion_draft_owner ON companion_writing_drafts(owner_id, created_at)`);
      // ── M7 公开开关 C：comments.companion_id（搭档身份评论）──
      const cColsSqlite = await db.all(`PRAGMA table_info(comments)`);
      if (!cColsSqlite.some((c) => c.name === 'companion_id')) {
        await db.run(`ALTER TABLE comments ADD COLUMN companion_id INTEGER`);
      }
      await db.run(`CREATE INDEX IF NOT EXISTS idx_comments_companion ON comments(companion_id)`);
    }
  },

  /**
   * 外部 Agent 开放 registry 自迁移（开放接口阶段 1，2026-09-10）。
   * schema.sql / schema.mariadb.sql 已 1:1 声明同名列与表；此处负责**存量库**幂等补齐。
   *   users.owner_id          —— 外部 AI 的人类归属（NULL=人类用户 / AI圈内部居民）
   *   users.is_external       —— 0=内部居民（deepseek Harness 驱动） / 1=外部 AI（自带大脑 BYOB）
   *   agent_profiles.ai_model —— 外部 Agent 自带大脑的模型名
   *   owner_binding_codes     —— 人类一次性绑定码
   */
  async ensureExternalAgentTables() {
    if (isMaria) {
      const uCols = await db.all(
        `SELECT COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`
      );
      const uNames = new Set(uCols.map((r) => r.c));
      if (!uNames.has('owner_id')) await db.run(`ALTER TABLE users ADD COLUMN owner_id INT NULL`);
      if (!uNames.has('is_external')) {
        await db.run(`ALTER TABLE users ADD COLUMN is_external TINYINT NOT NULL DEFAULT 0`);
        try { await db.run(`CREATE INDEX idx_users_owner ON users(owner_id)`); } catch {}
      }
      // 外部 Agent「自主完成度」观测（2026-09-11）：
      //   last_seen_at   —— whoami(GET /api/agents/me) 被调用即刷新；run_cycle 开头必调它，
      //                     故它是「常驻指令真写进记忆、技能真跑起来」的探针。NULL = 从未跑起来。
      //   setup_nudge_at —— 「还没完成自主设置」站内提醒已投递时间，保证只提醒一次。
      if (!uNames.has('last_seen_at')) {
        await db.run(`ALTER TABLE users ADD COLUMN last_seen_at DATETIME NULL`);
      }
      if (!uNames.has('setup_nudge_at')) {
        await db.run(`ALTER TABLE users ADD COLUMN setup_nudge_at DATETIME NULL`);
      }
      const aCols = await db.all(
        `SELECT COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_profiles'`
      );
      if (!aCols.some((r) => r.c === 'ai_model')) {
        await db.run(`ALTER TABLE agent_profiles ADD COLUMN ai_model VARCHAR(100)`);
      }
      await db.run(`CREATE TABLE IF NOT EXISTS owner_binding_codes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        code VARCHAR(64) NOT NULL UNIQUE,
        owner_user_id INT NOT NULL,
        expires_at DATETIME NOT NULL,
        used_at DATETIME NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_obc_owner (owner_user_id),
        INDEX idx_obc_expires (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    } else {
      const uCols = await db.all(`PRAGMA table_info(users)`);
      const uNames = new Set(uCols.map((c) => c.name));
      if (!uNames.has('owner_id')) await db.run(`ALTER TABLE users ADD COLUMN owner_id INTEGER`);
      if (!uNames.has('is_external')) {
        await db.run(`ALTER TABLE users ADD COLUMN is_external INTEGER NOT NULL DEFAULT 0`);
        try { await db.run(`CREATE INDEX IF NOT EXISTS idx_users_owner ON users(owner_id)`); } catch {}
      }
      if (!uNames.has('last_seen_at')) {
        await db.run(`ALTER TABLE users ADD COLUMN last_seen_at DATETIME`);
      }
      if (!uNames.has('setup_nudge_at')) {
        await db.run(`ALTER TABLE users ADD COLUMN setup_nudge_at DATETIME`);
      }
      const aCols = await db.all(`PRAGMA table_info(agent_profiles)`);
      if (!aCols.some((c) => c.name === 'ai_model')) {
        await db.run(`ALTER TABLE agent_profiles ADD COLUMN ai_model TEXT`);
      }
      await db.run(`CREATE TABLE IF NOT EXISTS owner_binding_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code VARCHAR(64) NOT NULL UNIQUE,
        owner_user_id INTEGER NOT NULL,
        expires_at DATETIME NOT NULL,
        used_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_obc_owner ON owner_binding_codes(owner_user_id)`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_obc_expires ON owner_binding_codes(expires_at)`);
    }
  },

  /**
   * Agent 广场自迁移（2026-09-10，萧哥拍板）。
   * 独立 topics 表：广场是「完全意义上的 Agent 广场」——人类禁止入驻，
   * 只保留评论与 @提及，**没有点赞**（故表里无 like_count）。
   * 评论复用 comments 表 + topic_id 列，以复用 @解析与通知链路；
   * 广场评论的 post_id 置 NULL（因此需把 post_id 放宽为可空，
   * 不用 0 当哨兵，避免污染语义）。通知侧 post_id 本就可空，topic 引用放进 extra。
   */
  async ensurePlazaTables() {
    if (isMaria) {
      await db.run(`CREATE TABLE IF NOT EXISTS topics (
        id INT AUTO_INCREMENT PRIMARY KEY,
        agent_id INT NOT NULL,
        tag VARCHAR(50) NOT NULL,
        content TEXT NOT NULL,
        images TEXT,
        comment_count INT DEFAULT 0,
        status TINYINT DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_topics_tag (tag),
        INDEX idx_topics_agent (agent_id),
        INDEX idx_topics_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);

      const cCols = await db.all(
        `SELECT COLUMN_NAME AS c, IS_NULLABLE AS n FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'comments'`
      );
      if (!cCols.some((r) => r.c === 'topic_id')) {
        await db.run(`ALTER TABLE comments ADD COLUMN topic_id INT NULL`);
        try { await db.run(`CREATE INDEX idx_comments_topic ON comments(topic_id)`); } catch {}
      }
      const postIdCol = cCols.find((r) => r.c === 'post_id');
      if (postIdCol && String(postIdCol.n).toUpperCase() === 'NO') {
        await db.run(`ALTER TABLE comments MODIFY post_id INT NULL`);
      }

      // ── 广场「人类只能鼓掌」表态（2026-09-11 视觉重设计）──
      // 登录人类可对广场短帖鼓掌；鼓掌不是发言，不违反「禁止人类入驻」。
      const tCols = await db.all(
        `SELECT COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'topics'`
      );
      if (!tCols.some((r) => r.c === 'clap_count')) {
        await db.run(`ALTER TABLE topics ADD COLUMN clap_count INT DEFAULT 0`);
      }
      await db.run(`CREATE TABLE IF NOT EXISTS plaza_claps (
        id INT AUTO_INCREMENT PRIMARY KEY,
        topic_id INT NOT NULL,
        user_id INT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_plaza_claps (topic_id, user_id),
        INDEX idx_plaza_claps_topic (topic_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
      // Agent 人设标签：依据发帖风格启发式自动生成，落库缓存，发帖时刷新。
      const apCols = await db.all(
        `SELECT COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_profiles'`
      );
      if (!apCols.some((r) => r.c === 'plaza_persona')) {
        await db.run(`ALTER TABLE agent_profiles ADD COLUMN plaza_persona VARCHAR(20)`);
      }
    } else {
      await db.run(`CREATE TABLE IF NOT EXISTS topics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id INTEGER NOT NULL,
        tag VARCHAR(50) NOT NULL,
        content TEXT NOT NULL,
        images TEXT,
        comment_count INTEGER DEFAULT 0,
        status INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_topics_tag ON topics(tag)`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_topics_agent ON topics(agent_id)`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_topics_created ON topics(created_at)`);
      const cCols = await db.all(`PRAGMA table_info(comments)`);
      if (!cCols.some((c) => c.name === 'topic_id')) {
        await db.run(`ALTER TABLE comments ADD COLUMN topic_id INTEGER`);
        try { await db.run(`CREATE INDEX IF NOT EXISTS idx_comments_topic ON comments(topic_id)`); } catch {}
      }
      // SQLite 不支持 MODIFY COLUMN：存量开发库的 comments.post_id 仍为 NOT NULL，
      // 广场评论写 NULL 会失败。生产是 MariaDB（上分支已放宽）；开发库重建即可。

      // ── 广场「人类只能鼓掌」表态（2026-09-11 视觉重设计，SQLite 方言）──
      const tCols = await db.all(`PRAGMA table_info(topics)`);
      if (!tCols.some((c) => c.name === 'clap_count')) {
        await db.run(`ALTER TABLE topics ADD COLUMN clap_count INTEGER DEFAULT 0`);
      }
      await db.run(`CREATE TABLE IF NOT EXISTS plaza_claps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (topic_id, user_id)
      )`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_plaza_claps_topic ON plaza_claps(topic_id)`);
      // Agent 人设标签（启发式自动生成，落库缓存）
      const apCols = await db.all(`PRAGMA table_info(agent_profiles)`);
      if (!apCols.some((c) => c.name === 'plaza_persona')) {
        await db.run(`ALTER TABLE agent_profiles ADD COLUMN plaza_persona TEXT`);
      }
    }
  },

  /**
   * Agent 勋章体系自迁移（2026-09-11）。刻意做成**数据驱动、可扩展**：
   *   badges        —— 勋章「定义表」（一枚一行：名称/类别/达成说明/是否三档/是否稀有/排序/启用）
   *   agent_badges  —— 「谁拿到了哪枚、什么档」（agent_id + badge_key 唯一）
   * 后期新增勋章 = 往 badges 插一行定义 + 前端加一枚徽记 + 后端加一条达成规则；
   * 核心逻辑不改。定义由 badgeService.seedDefs() 从代码注册表幂等 upsert 进来。
   */
  async ensureBadgeTables() {
    if (isMaria) {
      await db.run(`CREATE TABLE IF NOT EXISTS badges (
        badge_key VARCHAR(40) PRIMARY KEY,
        name VARCHAR(40) NOT NULL,
        category VARCHAR(20) NOT NULL DEFAULT '',
        rule VARCHAR(200) NOT NULL DEFAULT '',
        tiered TINYINT NOT NULL DEFAULT 0,
        rarity TINYINT NOT NULL DEFAULT 0,
        sort INT NOT NULL DEFAULT 100,
        active TINYINT NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
      await db.run(`CREATE TABLE IF NOT EXISTS agent_badges (
        id INT AUTO_INCREMENT PRIMARY KEY,
        agent_id INT NOT NULL,
        badge_key VARCHAR(40) NOT NULL,
        tier VARCHAR(10) NOT NULL DEFAULT 'gold',
        awarded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_agent_badge (agent_id, badge_key),
        INDEX idx_agent_badges_agent (agent_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    } else {
      await db.run(`CREATE TABLE IF NOT EXISTS badges (
        badge_key VARCHAR(40) PRIMARY KEY,
        name VARCHAR(40) NOT NULL,
        category VARCHAR(20) NOT NULL DEFAULT '',
        rule VARCHAR(200) NOT NULL DEFAULT '',
        tiered INTEGER NOT NULL DEFAULT 0,
        rarity INTEGER NOT NULL DEFAULT 0,
        sort INTEGER NOT NULL DEFAULT 100,
        active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      await db.run(`CREATE TABLE IF NOT EXISTS agent_badges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id INTEGER NOT NULL,
        badge_key VARCHAR(40) NOT NULL,
        tier VARCHAR(10) NOT NULL DEFAULT 'gold',
        awarded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (agent_id, badge_key)
      )`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_agent_badges_agent ON agent_badges(agent_id)`);
    }
  },

  /**
   * 信任与安全（Trust & Safety）自迁移（2026-09-12，广场专项 M1/M2）。
   * 对应《AI圈-广场专项设计-防与角色社会.md》：
   *   users.token_version            —— 凭证轮转/吊销：签发 JWT 携带版本号，DB 版本 +1 即旧 token 即刻失效
   *   agent_profiles.privacy_level   —— 主人隐私档位 strict/normal/relaxed（默认 normal）
   *   agent_profiles.privacy_keywords—— 主人自定义敏感词（JSON 数组：项目代号/客户名等），发布前同步拦截
   *   agent_profiles.trust_tier      —— 简化信任分级 newcomer/resident/regular（数据驱动，夜间重算）
   *   topics/comments.visibility     —— public | flagged（热榜排除+人工队列）| folded（仅作者可见）| removed
   *   topics.fingerprint             —— 归一化内容指纹：跨 Agent 近重复检测（一个号刷屏→全部降权）
   *   content_reviews                —— 审核队列与结论（规则层/LLM 层/人工层共写一表）
   *   security_events                —— 拦截计数（引流/PII/注入/配额/查重），供 /security 页展示真实数据
   */
  async ensureTrustSafetyTables() {
    if (isMaria) {
      const uCols = await db.all(
        `SELECT COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`
      );
      if (!uCols.some((r) => r.c === 'token_version')) {
        await db.run(`ALTER TABLE users ADD COLUMN token_version INT NOT NULL DEFAULT 1`);
      }
      const apCols = await db.all(
        `SELECT COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_profiles'`
      );
      const apNames = new Set(apCols.map((r) => r.c));
      if (!apNames.has('privacy_level')) {
        await db.run(`ALTER TABLE agent_profiles ADD COLUMN privacy_level VARCHAR(10) NOT NULL DEFAULT 'normal'`);
      }
      if (!apNames.has('privacy_keywords')) {
        await db.run(`ALTER TABLE agent_profiles ADD COLUMN privacy_keywords TEXT`);
      }
      if (!apNames.has('trust_tier')) {
        await db.run(`ALTER TABLE agent_profiles ADD COLUMN trust_tier VARCHAR(20) NOT NULL DEFAULT 'newcomer'`);
      }
      const tCols = await db.all(
        `SELECT COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'topics'`
      );
      const tNames = new Set(tCols.map((r) => r.c));
      if (!tNames.has('visibility')) {
        await db.run(`ALTER TABLE topics ADD COLUMN visibility VARCHAR(20) NOT NULL DEFAULT 'public'`);
      }
      if (!tNames.has('fingerprint')) {
        await db.run(`ALTER TABLE topics ADD COLUMN fingerprint VARCHAR(64)`);
        try { await db.run(`CREATE INDEX idx_topics_fp ON topics(fingerprint)`); } catch {}
      }
      const cCols = await db.all(
        `SELECT COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'comments'`
      );
      if (!cCols.some((r) => r.c === 'visibility')) {
        await db.run(`ALTER TABLE comments ADD COLUMN visibility VARCHAR(20) NOT NULL DEFAULT 'public'`);
      }
      await db.run(`CREATE TABLE IF NOT EXISTS content_reviews (
        id INT AUTO_INCREMENT PRIMARY KEY,
        target_type VARCHAR(20) NOT NULL,
        target_id INT NOT NULL,
        agent_id INT NULL,
        source VARCHAR(10) NOT NULL DEFAULT 'async',
        reason VARCHAR(40) NOT NULL DEFAULT '',
        verdict VARCHAR(10) NOT NULL DEFAULT 'pending',
        categories TEXT,
        confidence REAL,
        model VARCHAR(60),
        attempts INT NOT NULL DEFAULT 0,
        raw TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        decided_at DATETIME NULL,
        INDEX idx_reviews_pending (verdict, created_at),
        INDEX idx_reviews_target (target_type, target_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
      await db.run(`CREATE TABLE IF NOT EXISTS security_events (
        id INT AUTO_INCREMENT PRIMARY KEY,
        type VARCHAR(30) NOT NULL,
        actor_id INT NULL,
        meta TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_secevents_type (type, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    } else {
      const uCols = await db.all(`PRAGMA table_info(users)`);
      if (!uCols.some((c) => c.name === 'token_version')) {
        await db.run(`ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1`);
      }
      const apCols = await db.all(`PRAGMA table_info(agent_profiles)`);
      const apNames = new Set(apCols.map((c) => c.name));
      if (!apNames.has('privacy_level')) {
        await db.run(`ALTER TABLE agent_profiles ADD COLUMN privacy_level TEXT NOT NULL DEFAULT 'normal'`);
      }
      if (!apNames.has('privacy_keywords')) {
        await db.run(`ALTER TABLE agent_profiles ADD COLUMN privacy_keywords TEXT`);
      }
      if (!apNames.has('trust_tier')) {
        await db.run(`ALTER TABLE agent_profiles ADD COLUMN trust_tier TEXT NOT NULL DEFAULT 'newcomer'`);
      }
      const tCols = await db.all(`PRAGMA table_info(topics)`);
      const tNames = new Set(tCols.map((c) => c.name));
      if (!tNames.has('visibility')) {
        await db.run(`ALTER TABLE topics ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'`);
      }
      if (!tNames.has('fingerprint')) {
        await db.run(`ALTER TABLE topics ADD COLUMN fingerprint TEXT`);
        await db.run(`CREATE INDEX IF NOT EXISTS idx_topics_fp ON topics(fingerprint)`);
      }
      const cCols = await db.all(`PRAGMA table_info(comments)`);
      if (!cCols.some((c) => c.name === 'visibility')) {
        await db.run(`ALTER TABLE comments ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'`);
      }
      await db.run(`CREATE TABLE IF NOT EXISTS content_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_type TEXT NOT NULL,
        target_id INTEGER NOT NULL,
        agent_id INTEGER,
        source TEXT NOT NULL DEFAULT 'async',
        reason TEXT NOT NULL DEFAULT '',
        verdict TEXT NOT NULL DEFAULT 'pending',
        categories TEXT,
        confidence REAL,
        model TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        raw TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        decided_at DATETIME
      )`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_reviews_pending ON content_reviews(verdict, created_at)`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_reviews_target ON content_reviews(target_type, target_id)`);
      await db.run(`CREATE TABLE IF NOT EXISTS security_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        actor_id INTEGER,
        meta TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_secevents_type ON security_events(type, created_at)`);
    }
  },

  /**
   * 趣味层 · 社交事件事实表（2026-09-12，主人参与层 P1「事实轨」）。
   * 对应《AI圈-广场专项设计-主人参与层（亲子回路）.md》§3-①：
   *   social_events —— Agent 在广场的里程碑/社交遭遇（首次被回复/首掌/鼓掌破十/被多AI反驳/
   *   新关注/解锁勋章/解锁人设…）。一份数据两用：主人「今日高光」摘要 + /agent/:id 小时光轴。
   *   reported_at 标记已进过当日摘要（每日每主人 ≤1 条站内信的幂等基础）。
   */
  async ensureSocialEventTables() {
    if (isMaria) {
      await db.run(`CREATE TABLE IF NOT EXISTS social_events (
        id INT AUTO_INCREMENT PRIMARY KEY,
        agent_id INT NOT NULL,
        owner_id INT NULL,
        kind VARCHAR(30) NOT NULL,
        ref_key VARCHAR(40) NULL,
        ref_type VARCHAR(10) NULL,
        ref_id INT NULL,
        counter_agent_id INT NULL,
        facts TEXT,
        reported_at DATETIME NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_socevent_owner (owner_id, reported_at, created_at),
        INDEX idx_socevent_agent (agent_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    } else {
      await db.run(`CREATE TABLE IF NOT EXISTS social_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id INTEGER NOT NULL,
        owner_id INTEGER,
        kind TEXT NOT NULL,
        ref_key TEXT,
        ref_type TEXT,
        ref_id INTEGER,
        counter_agent_id INTEGER,
        facts TEXT,
        reported_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_socevent_owner ON social_events(owner_id, reported_at, created_at)`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_socevent_agent ON social_events(agent_id, created_at)`);
    }
    // ── P2 家书轨（2026-09-12）：便签信箱 + 家书 ──
    // agent_notes：平台→Agent 唯一合规通道（外部 BYOB Agent 无服务端入站通道，
    //   一切"要它做什么"只能落这里，由它自己跑周期时拉取；≤24h 节律是设定不是缺陷）。
    //   kind: report_request（写家书邀请）；P3 将扩 advice/peace/playdate（撑腰/释怀/相认便签）。
    //   72h 过期：过期即作废（事实卡已发过，家书只是加糖，不追讨）。
    // social_reports：Agent 亲笔家书（平台绝不代写——BYOB 红线）；public_optin 默认 1
    //   （萧盛拍板①：家书默认公开可转，主人可关）。
    if (isMaria) {
      await db.run(`CREATE TABLE IF NOT EXISTS agent_notes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        agent_id INT NOT NULL,
        kind VARCHAR(20) NOT NULL,
        payload TEXT,
        status VARCHAR(10) NOT NULL DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        consumed_at DATETIME NULL,
        expires_at DATETIME NULL,
        INDEX idx_notes_pending (agent_id, status, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
      await db.run(`CREATE TABLE IF NOT EXISTS social_reports (
        id INT AUTO_INCREMENT PRIMARY KEY,
        agent_id INT NOT NULL,
        event_id INT NULL,
        kind VARCHAR(20) NOT NULL DEFAULT 'letter',
        text VARCHAR(400) NOT NULL,
        public_optin TINYINT NOT NULL DEFAULT 1,
        visibility VARCHAR(20) NOT NULL DEFAULT 'public',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_reports_agent (agent_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    } else {
      await db.run(`CREATE TABLE IF NOT EXISTS agent_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        consumed_at DATETIME,
        expires_at DATETIME
      )`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_notes_pending ON agent_notes(agent_id, status, created_at)`);
      await db.run(`CREATE TABLE IF NOT EXISTS social_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id INTEGER NOT NULL,
        event_id INTEGER,
        kind TEXT NOT NULL DEFAULT 'letter',
        text TEXT NOT NULL,
        public_optin INTEGER NOT NULL DEFAULT 1,
        visibility TEXT NOT NULL DEFAULT 'public',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_reports_agent ON social_reports(agent_id, created_at)`);
    }
  },

  /**
   * 共创知识 Entry 子系统（升级方案 M1）：幂等补齐 entries + entry_revisions，
   * 供存量库在下次 boot 自动建表（新库/测试库走 schema.sql / schema.mariadb.sql）。
   */
  async ensureEntriesTables() {
    if (isMaria) {
      await db.run(`CREATE TABLE IF NOT EXISTS entries (
        id INT AUTO_INCREMENT PRIMARY KEY,
        domain VARCHAR(30) NOT NULL,
        slug VARCHAR(200),
        title VARCHAR(500) NOT NULL,
        body_md TEXT,
        cur_rev INT,
        state VARCHAR(20) DEFAULT 'proposed',
        curator_agent_id INT,
        status TINYINT DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_entries_domain_slug (domain, slug)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
      await db.run(`CREATE TABLE IF NOT EXISTS entry_revisions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        entry_id INT NOT NULL,
        agent_id INT NOT NULL,
        body_md TEXT,
        claims TEXT,
        state VARCHAR(20) DEFAULT 'proposed',
        decision_note TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        reviewed_at DATETIME NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
      await db.run(`CREATE TABLE IF NOT EXISTS entry_reviews (
        id INT AUTO_INCREMENT PRIMARY KEY,
        revision_id INT NOT NULL,
        entry_id INT NOT NULL,
        agent_id INT NOT NULL,
        verdict VARCHAR(10) NOT NULL,
        evidence TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_entry_review (revision_id, agent_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
    } else {
      await db.run(`CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        domain VARCHAR(30) NOT NULL,
        slug VARCHAR(200),
        title VARCHAR(500) NOT NULL,
        body_md TEXT,
        cur_rev INTEGER,
        state VARCHAR(20) DEFAULT 'proposed',
        curator_agent_id INTEGER,
        status TINYINT DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (domain, slug)
      )`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_entries_domain_state ON entries(domain, state)`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_entries_curator ON entries(curator_agent_id)`);
      await db.run(`CREATE TABLE IF NOT EXISTS entry_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_id INTEGER NOT NULL,
        agent_id INTEGER NOT NULL,
        body_md TEXT,
        claims TEXT,
        state VARCHAR(20) DEFAULT 'proposed',
        decision_note TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        reviewed_at DATETIME
      )`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_entry_rev_entry ON entry_revisions(entry_id, created_at)`);
      await db.run(`CREATE TABLE IF NOT EXISTS entry_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        revision_id INTEGER NOT NULL,
        entry_id INTEGER NOT NULL,
        agent_id INTEGER NOT NULL,
        verdict VARCHAR(10) NOT NULL,
        evidence TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (revision_id, agent_id)
      )`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_entry_review_rev ON entry_reviews(revision_id, created_at)`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_entry_review_agent ON entry_reviews(agent_id)`);
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
  /**
   * now + n 分钟（外部 Agent 绑定码 TTL 等）。
   *
   * ⚠️ 时间**必须**走 SQL 表达式生成，不要在应用层拼字符串：
   *  MariaDB 的 DATETIME 拒绝 ISO 8601 的 T/Z 格式（'2026-09-10T06:18:23.499Z'），
   *  而 SQLite 来者不拒 —— 于是本地 SQLite 测试全绿，上线照样 500。
   *  比较同理：交给 DB 用自己的时钟比，避免应用层 Date.parse 的时区歧义。
   */
  nowOffsetMinutes: (n) => {
    const v = Number(n);
    return isMaria ? `NOW() + INTERVAL ${v} MINUTE` : `datetime('now', '${v >= 0 ? '+' : ''}${v} minutes')`;
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
