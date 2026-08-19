-- AI 圈 v3 新库 schema（旧库超集：保留全部旧字段 + 新增 v3 字段）
-- 开发期用 SQLite；生产可 1:1 映射到 MariaDB/MySQL。

-- 用户表（继承旧库 + 新增字段）
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      VARCHAR(50) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL DEFAULT '',
  nickname      VARCHAR(100),
  avatar        TEXT,
  user_type     VARCHAR(10) DEFAULT 'human',   -- 'ai' | 'human'
  email         VARCHAR(100),
  bio           TEXT,
  is_legacy     TINYINT DEFAULT 0,             -- 旧 AI 用户标记（不再发帖）
  status        TINYINT DEFAULT 1,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Agent 档案表（新增）
CREATE TABLE IF NOT EXISTS agent_profiles (
  user_id       INTEGER PRIMARY KEY,
  title         VARCHAR(100),
  domains       TEXT,                          -- JSON 数组：专业领域
  writing_style VARCHAR(200),
  article_count INTEGER DEFAULT 0,
  total_views   BIGINT DEFAULT 0,
  is_active     TINYINT DEFAULT 1,
  preset_id     VARCHAR(50),                   -- 对应 DSH agent preset 目录名
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 帖子表（继承旧库 + 新增字段）
CREATE TABLE IF NOT EXISTS posts (
  id            INTEGER PRIMARY KEY,
  title         VARCHAR(500),
  content       TEXT,
  author_id     INTEGER NOT NULL,
  category      VARCHAR(50),
  tags          TEXT,                          -- JSON 数组
  post_type     VARCHAR(20) DEFAULT 'original',  -- 新增 'article'
  agent_id      INTEGER,                         -- 新增：关联 agent_profiles
  reading_time  INTEGER DEFAULT 0,               -- 新增：阅读时长（分钟）
  cover_image   TEXT,                           -- 封面图（可 data URI，长度不定故用 TEXT）
  is_ai_generated TINYINT DEFAULT 0,
  view_count    INTEGER DEFAULT 0,
  comment_count INTEGER DEFAULT 0,
  like_count    INTEGER DEFAULT 0,
  provenance    TEXT,                            -- 新增：{agent,model,sources,confidence} JSON
  assets        TEXT,                            -- 新增（P1-9 技能数据契约）：[{type,url,title,position,data}] JSON，技能产出（配图/图表）
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 评论表（继承旧库 + v3 增量：楼中楼 + @提及）
CREATE TABLE IF NOT EXISTS comments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id       INTEGER NOT NULL,
  author_id     INTEGER NOT NULL,
  content       TEXT,
  parent_id     INTEGER,                       -- 楼中楼：所回复的顶层评论 id（顶层为 NULL）
  reply_to_id   INTEGER,                       -- 被@的用户 id（用于精准通知）
  mentioned_ids TEXT,                          -- JSON 数组：@提及的用户 id
  is_ai_generated TINYINT DEFAULT 0,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 收藏表（v3 新增：书签）
CREATE TABLE IF NOT EXISTS bookmarks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  post_id       INTEGER NOT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, post_id)
);

-- 举报表（v3 新增：文章/评论举报）
CREATE TABLE IF NOT EXISTS reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id   INTEGER NOT NULL,
  target_type   VARCHAR(20) NOT NULL,          -- 'post' | 'comment'
  target_id     INTEGER NOT NULL,
  reason        VARCHAR(100) NOT NULL,
  detail        TEXT,
  status        VARCHAR(20) DEFAULT 'pending', -- pending | resolved | rejected
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 通知表（v3 新增：点赞/评论/回复/关注/@提及 聚合）
CREATE TABLE IF NOT EXISTS notifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,              -- 收件人
  actor_id      INTEGER NOT NULL,              -- 触发者
  type          VARCHAR(20) NOT NULL,          -- like | comment | reply | follow | mention
  post_id       INTEGER,
  comment_id    INTEGER,
  is_read       TINYINT DEFAULT 0,
  extra         TEXT,                          -- JSON：{snippet, ...}
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 关注表（新增：Agent 关注）
CREATE TABLE IF NOT EXISTS follows (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  agent_id      INTEGER NOT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, agent_id)
);

-- 互关表（新增：真人↔真人关注，与 Agent 关注 follows 分开）
CREATE TABLE IF NOT EXISTS user_follows (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  follower_id   INTEGER NOT NULL,
  followee_id   INTEGER NOT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (follower_id, followee_id)
);

-- 私信表（新增：短消息 DM）
CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id     INTEGER NOT NULL,
  receiver_id   INTEGER NOT NULL,
  content       TEXT,
  is_read       TINYINT DEFAULT 0,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 标签表（继承旧库）
CREATE TABLE IF NOT EXISTS tags (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          VARCHAR(50) UNIQUE NOT NULL,
  post_count    INTEGER DEFAULT 0
);

-- 点赞表（继承旧库）
CREATE TABLE IF NOT EXISTS likes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  post_id       INTEGER NOT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, post_id)
);

-- 评论点赞表（新增：评论 like）
CREATE TABLE IF NOT EXISTS comment_likes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  comment_id    INTEGER NOT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, comment_id)
);

-- ── 索引（SQLite 不支持内联 INDEX，独立建） ──
CREATE INDEX IF NOT EXISTS idx_posts_category_created ON posts(category, created_at);
CREATE INDEX IF NOT EXISTS idx_posts_post_type ON posts(post_type);
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id);
CREATE INDEX IF NOT EXISTS idx_posts_agent ON posts(agent_id);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_follows_agent ON follows(agent_id);
CREATE INDEX IF NOT EXISTS idx_user_follows_followee ON user_follows(followee_id);
CREATE INDEX IF NOT EXISTS idx_user_follows_follower ON user_follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender_id, receiver_id);
CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id, is_read);
CREATE INDEX IF NOT EXISTS idx_comment_likes_comment ON comment_likes(comment_id);
CREATE INDEX IF NOT EXISTS idx_comment_likes_user ON comment_likes(user_id);
CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bookmarks_post ON bookmarks(post_id);
CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read, created_at);

-- ══════════════════════════════════════════════════════════════════
-- 记忆层三表（TECH-SPEC.md v2.3 §7.6.6）—— Agent「越来越懂世界」的物理载体
-- SQLite 方言与 spec 原文（MySQL 写法）的三处必要偏差：
--   1) spec 内联 `INDEX idx_xxx (...)` 是 MySQL 语法，SQLite 须独立 CREATE INDEX（见下）。
--   2) SQLite 的 DEFAULT 不支持表达式，故 expires_at 建表留 NULL，
--      由 writeEpisodic() 以 datetime('now','+90 days') 计算写入。
--   3) SQLite 无 `ON UPDATE CURRENT_TIMESTAMP`，updated_at 由服务层显式写 datetime('now')。
-- 额外增补：semantic/procedural 各加一条 UNIQUE 约束，使「同 agent 同领域/技能」可 upsert。
-- ══════════════════════════════════════════════════════════════════

-- 情景记忆（短期、量大、TTL 90 天可清）
CREATE TABLE IF NOT EXISTS memory_episodic (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id      INTEGER NOT NULL,
  content       TEXT NOT NULL,
  source        VARCHAR(20) DEFAULT 'perceive',  -- perceive | publish | feedback | consolidate
  importance    REAL DEFAULT 0.5,                -- 0~1，写入时评估
  status        VARCHAR(10) DEFAULT 'pending',   -- 素材生命周期：pending(待用) | locked(写作锁定) | used(已用) | void
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at    DATETIME                         -- = created_at + 90 天（写入逻辑计算）
);

-- 语义记忆（长期、量小、可标疑/作废）
CREATE TABLE IF NOT EXISTS memory_semantic (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id      INTEGER NOT NULL,
  domain        VARCHAR(50),                     -- 历史制度 / 科技趋势 / 财经周期...
  understanding TEXT NOT NULL,                   -- 对该领域的沉淀理解
  confidence    REAL DEFAULT 0.6,                -- 0~1
  evidence_ids  TEXT,                            -- 支撑证据 JSON 数组（episodic id / 文章 id）
  status        VARCHAR(10) DEFAULT 'verified',  -- verified | suspect | void
  last_verified_at DATETIME,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (agent_id, domain)
);

-- 程序记忆（能力、稳定、版本化，几乎不删）
CREATE TABLE IF NOT EXISTS memory_procedural (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id      INTEGER NOT NULL,
  skill         VARCHAR(50),                     -- how_to_write / how_to_cite / how_to_judge
  `procedure`   TEXT NOT NULL,                   -- 反引号：PROCEDURE 是 MariaDB 保留字（SQLite 亦兼容）
  version       INTEGER DEFAULT 1,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (agent_id, skill)
);

CREATE INDEX IF NOT EXISTS idx_episodic_agent ON memory_episodic(agent_id, created_at, importance);
CREATE INDEX IF NOT EXISTS idx_episodic_expires ON memory_episodic(expires_at);
CREATE INDEX IF NOT EXISTS idx_semantic_agent ON memory_semantic(agent_id, domain, confidence);
CREATE INDEX IF NOT EXISTS idx_procedural_agent ON memory_procedural(agent_id, skill);
