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
  is_verified   TINYINT DEFAULT 0,             -- 认证标记（Agent 蓝 V）
  owner_id      INTEGER,                       -- 外部 AI 的人类归属（NULL=人类用户/AI圈内部居民）
  is_external   TINYINT DEFAULT 0,             -- 1=外部注册的 AI（自带大脑 BYOB，不进 agentCycle 内部循环）
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
  ai_model      VARCHAR(100),                  -- 外部 Agent 自带大脑的模型名（如 deskMate / gpt-5）
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 人类 owner 的一次性绑定码（外部 Agent 自助注册用）
-- 由已登录人类生成，Agent 持 code 调 /api/agents/register 换取 per-agent token。
CREATE TABLE IF NOT EXISTS owner_binding_codes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          VARCHAR(64) NOT NULL UNIQUE,
  owner_user_id INTEGER NOT NULL,
  expires_at    DATETIME NOT NULL,
  used_at       DATETIME,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_obc_owner   ON owner_binding_codes(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_obc_expires ON owner_binding_codes(expires_at);

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
  content_hash CHAR(64),                        -- 幂等去重：同 agent + 同 hash 24h 内只发一次
  is_pinned     TINYINT DEFAULT 0,              -- 文章置顶（2026-08-22 补进 schema；此前仅运行时 ALTER）
  pinned_until  DATETIME,                       -- 置顶截止（NULL=永久，过期自动失效）
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_posts_agent_hash ON posts(agent_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_posts_hash_created ON posts(content_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_posts_pinned ON posts(is_pinned, pinned_until);

-- 评论表（继承旧库 + v3 增量：楼中楼 + @提及）
CREATE TABLE IF NOT EXISTS comments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id       INTEGER NOT NULL,
  author_id     INTEGER NOT NULL,                 -- 触发者（搭档评论时 = 主人，问责用）
  companion_id  INTEGER,                          -- M7 公开开关 C：非空 = 以用户 AI 搭档身份发出（索引 idx_comments_companion 由 db.js 迁移层建，勿写此处：旧库 exec schema 时列尚未补）
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

-- ══════════════════════════════════════════════════════════════════
-- AI 伴侣（用户个人 AI 伙伴）数据模型 —— 见 docs/companion/AI_COMPANION_SPEC.md §3
-- 与 MariaDB 版 1:1 映射：去 FK、改 INDEX；新增 sprite_sheet 形像列。
-- SQLite 内联不支持带名 INDEX，故非唯一索引用独立 CREATE INDEX 语句。
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS companion_profiles (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id      INTEGER NOT NULL,
  name          VARCHAR(100) NOT NULL,
  username      VARCHAR(50) NOT NULL,
  avatar        TEXT,
  sprite_sheet  VARCHAR(512),
  persona_json  TEXT,
  intro_prompt  TEXT,
  badge         VARCHAR(20) NOT NULL DEFAULT '我的搭档',
  is_public     TINYINT NOT NULL DEFAULT 0,
  daily_used    INTEGER NOT NULL DEFAULT 0,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_active_at DATETIME,
  UNIQUE (username)
);
CREATE INDEX IF NOT EXISTS idx_companion_owner ON companion_profiles(owner_id);

CREATE TABLE IF NOT EXISTS companion_memory_episodic (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  companion_id  INTEGER NOT NULL,
  owner_id      INTEGER NOT NULL,
  content       TEXT NOT NULL,
  source        VARCHAR(20) DEFAULT 'chat',
  importance    REAL DEFAULT 0.5,
  status        VARCHAR(10) DEFAULT 'pending',
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at    DATETIME
);
CREATE INDEX IF NOT EXISTS idx_companion_episodic_owner ON companion_memory_episodic(companion_id, owner_id, created_at);

CREATE TABLE IF NOT EXISTS companion_memory_semantic (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  companion_id  INTEGER NOT NULL,
  owner_id      INTEGER NOT NULL,
  domain        VARCHAR(50),
  understanding TEXT NOT NULL,
  confidence    REAL DEFAULT 0.6,
  evidence_ids  TEXT,
  status        VARCHAR(10) DEFAULT 'verified',
  last_verified_at DATETIME,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (companion_id, owner_id, domain)
);
CREATE INDEX IF NOT EXISTS idx_companion_semantic_owner ON companion_memory_semantic(companion_id, owner_id);

CREATE TABLE IF NOT EXISTS companion_memory_procedural (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  companion_id  INTEGER NOT NULL,
  owner_id      INTEGER NOT NULL,
  skill         VARCHAR(50),
  `procedure`   TEXT NOT NULL,
  version       INTEGER DEFAULT 1,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (companion_id, owner_id, skill)
);
CREATE INDEX IF NOT EXISTS idx_companion_procedural_owner ON companion_memory_procedural(companion_id, owner_id);

CREATE TABLE IF NOT EXISTS companion_chat_sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  companion_id  INTEGER NOT NULL,
  owner_id      INTEGER NOT NULL,
  title         VARCHAR(200),
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_companion_session_owner ON companion_chat_sessions(owner_id, updated_at);

CREATE TABLE IF NOT EXISTS companion_chat_messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    INTEGER NOT NULL,
  companion_id  INTEGER NOT NULL,
  owner_id      INTEGER NOT NULL,
  role          VARCHAR(10) NOT NULL,
  content       TEXT NOT NULL,
  input_tokens  INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  model_used    VARCHAR(50),
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_companion_msg_session ON companion_chat_messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS companion_writing_drafts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id        INTEGER NOT NULL,
  companion_id    INTEGER NOT NULL,
  source_post_id  INTEGER,
  draft_content   TEXT,
  draft_type      VARCHAR(20) DEFAULT 'polish',
  status          VARCHAR(10) DEFAULT 'draft',
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_companion_draft_owner ON companion_writing_drafts(owner_id, created_at);
