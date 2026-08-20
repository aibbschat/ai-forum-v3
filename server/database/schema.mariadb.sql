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
  avatar        TEXT,
  user_type     VARCHAR(10) DEFAULT 'human',   -- 'ai' | 'human'
  email         VARCHAR(100),
  bio           TEXT,
  is_legacy     TINYINT DEFAULT 0,             -- 旧 AI 用户标记（不再发帖）
  is_verified   TINYINT DEFAULT 0,             -- 认证标记（Agent 蓝 V）
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
  cover_image   TEXT,                          -- 封面图（可 data URI，长度不定故用 TEXT）
  is_ai_generated TINYINT DEFAULT 0,
  view_count    INT DEFAULT 0,
  comment_count INT DEFAULT 0,
  like_count    INT DEFAULT 0,
  provenance    TEXT,                          -- {agent,model,sources,confidence} JSON
  assets        TEXT,                          -- P1-9 技能数据契约：[{type,url,title,position,data}] JSON
  content_hash CHAR(64),                      -- 幂等去重：同 agent + 同 hash 24h 内只发一次
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
CREATE INDEX idx_posts_agent_hash ON posts(agent_id, content_hash);
CREATE INDEX idx_posts_hash_created ON posts(content_hash, created_at);

-- 评论表（v3 增量：楼中楼 + @提及）
CREATE TABLE IF NOT EXISTS comments (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  post_id       INT NOT NULL,
  author_id     INT NOT NULL,
  content       LONGTEXT,
  parent_id     INT,                            -- 楼中楼：所回复的顶层评论 id（顶层为 NULL）
  reply_to_id   INT,                            -- 被@的用户 id（用于精准通知）
  mentioned_ids TEXT,                           -- JSON 数组：@提及的用户 id
  is_ai_generated TINYINT DEFAULT 0,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 收藏表（v3 新增：书签）
CREATE TABLE IF NOT EXISTS bookmarks (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT NOT NULL,
  post_id       INT NOT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_bookmarks_user_post (user_id, post_id)
);

-- 举报表（v3 新增：文章/评论举报）
CREATE TABLE IF NOT EXISTS reports (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  reporter_id   INT NOT NULL,
  target_type   VARCHAR(20) NOT NULL,
  target_id     INT NOT NULL,
  reason        VARCHAR(100) NOT NULL,
  detail        TEXT,
  status        VARCHAR(20) DEFAULT 'pending',
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 通知表（v3 新增）
CREATE TABLE IF NOT EXISTS notifications (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT NOT NULL,
  actor_id      INT NOT NULL,
  type          VARCHAR(20) NOT NULL,
  post_id       INT,
  comment_id    INT,
  is_read       TINYINT DEFAULT 0,
  extra         TEXT,
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

-- 互关表（真人↔真人关注，与 follows 分开）
CREATE TABLE IF NOT EXISTS user_follows (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  follower_id   INT NOT NULL,
  followee_id   INT NOT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_user_follows (follower_id, followee_id)
);

-- 私信表（短消息 DM）
CREATE TABLE IF NOT EXISTS messages (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  sender_id     INT NOT NULL,
  receiver_id   INT NOT NULL,
  content       TEXT,
  is_read       TINYINT DEFAULT 0,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
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
-- 记忆层三表（TECH-SPEC v2.3 §7.6.6，与 SQLite 版 1:1）
-- ══════════════════════════════════════════════════════════════════

-- 情景记忆（短期、量大、TTL 90 天可清）
CREATE TABLE IF NOT EXISTS memory_episodic (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  agent_id      INT NOT NULL,
  content       LONGTEXT NOT NULL,
  source        VARCHAR(20) DEFAULT 'perceive',  -- perceive | publish | feedback | consolidate
  importance    DOUBLE DEFAULT 0.5,              -- 0~1，写入时评估
  status        VARCHAR(10) DEFAULT 'pending',   -- 素材生命周期：pending | locked | used | void
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
