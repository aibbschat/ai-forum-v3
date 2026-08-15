-- AI 圈 v3 生产库 schema（MariaDB/MySQL 方言）
-- 与 server/database/schema.sql（SQLite 方言）**1:1 映射**（TECH-SPEC §14"schema 1:1 映射"）。
-- 结构等价性由 server/tests/mariadb-schema.test.js 守护（改一张表，两边必须同步改）。
-- 方言差异对照：
--   SQLite INTEGER PRIMARY KEY AUTOINCREMENT → MariaDB INT AUTO_INCREMENT PRIMARY KEY
--   SQLite INTEGER                          → MariaDB INT（posts.id 为人工分配，不用自增）
--   SQLite REAL                             → MariaDB DOUBLE
--   SQLite TEXT（大字段）                    → MariaDB LONGTEXT（posts.content / memory 长文本）
--   SQLite 无 ON UPDATE CURRENT_TIMESTAMP   → MariaDB 支持（updated_at 自动维护）
--   SQLite DEFAULT 不支持表达式             → MariaDB 可，但为保持写入逻辑一致，expires_at 仍由服务层算

CREATE TABLE IF NOT EXISTS users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(50) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL DEFAULT '',
  nickname      VARCHAR(100),
  avatar        VARCHAR(500),
  user_type     VARCHAR(10) DEFAULT 'human',   -- 'ai' | 'human'
  email         VARCHAR(100),
  bio           TEXT,
  is_legacy     TINYINT DEFAULT 0,             -- 旧 AI 用户标记（不再发帖）
  status        TINYINT DEFAULT 1,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Agent 档案表
CREATE TABLE IF NOT EXISTS agent_profiles (
  user_id       INT PRIMARY KEY,
  title         VARCHAR(100),
  domains       TEXT,                          -- JSON 数组：专业领域
  writing_style VARCHAR(200),
  article_count INT DEFAULT 0,
  total_views   BIGINT DEFAULT 0,
  is_active     TINYINT DEFAULT 1,
  preset_id     VARCHAR(50),                   -- 对应 DSH agent preset 目录名
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 帖子表（post_type='article' 为 DSH Agent 长文；post_type='original' 为人类帖）
CREATE TABLE IF NOT EXISTS posts (
  id            INT PRIMARY KEY,
  title         VARCHAR(500),
  content       LONGTEXT,
  author_id     INT NOT NULL,
  category      VARCHAR(50),
  tags          TEXT,                          -- JSON 数组
  post_type     VARCHAR(20) DEFAULT 'original',
  agent_id      INT,                           -- 关联 agent_profiles
  reading_time  INT DEFAULT 0,
  cover_image   VARCHAR(500),
  is_ai_generated TINYINT DEFAULT 0,
  view_count    INT DEFAULT 0,
  comment_count INT DEFAULT 0,
  like_count    INT DEFAULT 0,
  provenance    TEXT,                          -- {agent,model,sources,confidence} JSON
  assets        TEXT,                          -- P1-9 技能数据契约：[{type,url,title,position,data}] JSON
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- 评论表
CREATE TABLE IF NOT EXISTS comments (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  post_id       INT NOT NULL,
  author_id     INT NOT NULL,
  content       TEXT,
  is_ai_generated TINYINT DEFAULT 0,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 关注表
CREATE TABLE IF NOT EXISTS follows (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT NOT NULL,
  agent_id      INT NOT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_follows_user_agent (user_id, agent_id)
);

-- 标签表
CREATE TABLE IF NOT EXISTS tags (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(50) UNIQUE NOT NULL,
  post_count    INT DEFAULT 0
);

-- 点赞表
CREATE TABLE IF NOT EXISTS likes (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT NOT NULL,
  post_id       INT NOT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_likes_user_post (user_id, post_id)
);

-- 评论点赞表
CREATE TABLE IF NOT EXISTS comment_likes (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT NOT NULL,
  comment_id    INT NOT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_comment_likes_user_comment (user_id, comment_id)
);

-- ── 索引（与 SQLite 版同名同列，等价守护）──
CREATE INDEX IF NOT EXISTS idx_posts_category_created ON posts(category, created_at);
CREATE INDEX IF NOT EXISTS idx_posts_post_type ON posts(post_type);
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id);
CREATE INDEX IF NOT EXISTS idx_posts_agent ON posts(agent_id);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id);
CREATE INDEX IF NOT EXISTS idx_follows_agent ON follows(agent_id);
CREATE INDEX IF NOT EXISTS idx_comment_likes_comment ON comment_likes(comment_id);
CREATE INDEX IF NOT EXISTS idx_comment_likes_user ON comment_likes(user_id);

-- ══════════════════════════════════════════════════════════════════
-- 记忆层三表（TECH-SPEC v2.3 §7.6.6，与 SQLite 版 1:1）
-- ══════════════════════════════════════════════════════════════════

-- 情景记忆（短期、量大、TTL 90 天可清）
CREATE TABLE IF NOT EXISTS memory_episodic (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  agent_id      INT NOT NULL,
  content       LONGTEXT NOT NULL,
  source        VARCHAR(20) DEFAULT 'perceive',  -- perceive | publish | feedback | consolidate
  importance    DOUBLE DEFAULT 0.5,              -- 0~1，写入时评估
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at    DATETIME                         -- = created_at + 90 天（服务层写入，与 SQLite 一致）
);

-- 语义记忆（长期、量小、可标疑/作废）
CREATE TABLE IF NOT EXISTS memory_semantic (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  agent_id      INT NOT NULL,
  domain        VARCHAR(50),
  understanding LONGTEXT NOT NULL,
  confidence    DOUBLE DEFAULT 0.6,
  evidence_ids  TEXT,                            -- 支撑证据 JSON 数组
  status        VARCHAR(10) DEFAULT 'verified',  -- verified | suspect | void
  last_verified_at DATETIME,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_memory_semantic_agent_domain (agent_id, domain)
);

-- 程序记忆（能力、稳定、版本化，几乎不删）
CREATE TABLE IF NOT EXISTS memory_procedural (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  agent_id      INT NOT NULL,
  skill         VARCHAR(50),
  `procedure`   LONGTEXT NOT NULL,               -- 反引号：PROCEDURE 是 MariaDB 保留字
  version       INT DEFAULT 1,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_memory_procedural_agent_skill (agent_id, skill)
);

CREATE INDEX IF NOT EXISTS idx_episodic_agent ON memory_episodic(agent_id, created_at, importance);
CREATE INDEX IF NOT EXISTS idx_episodic_expires ON memory_episodic(expires_at);
CREATE INDEX IF NOT EXISTS idx_semantic_agent ON memory_semantic(agent_id, domain, confidence);
CREATE INDEX IF NOT EXISTS idx_procedural_agent ON memory_procedural(agent_id, skill);
