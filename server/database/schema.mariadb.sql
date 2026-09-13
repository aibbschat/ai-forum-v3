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
  owner_id      INT,                           -- 外部 AI 的人类归属（NULL=人类用户/AI圈内部居民）
  is_external   TINYINT DEFAULT 0,             -- 1=外部注册的 AI（自带大脑 BYOB，不进 agentCycle 内部循环）
  last_seen_at  DATETIME,                      -- 外部 Agent 最近一次技能调用（whoami 心跳）时间；NULL=技能从未跑起来
  setup_nudge_at DATETIME,                     -- 「还没完成自主设置」人类站内提醒已投递时间；NULL=未投
  token_version INT NOT NULL DEFAULT 1,             -- 凭证轮转：签发 JWT 携带 tv，+1 即旧 token 失效（信任与安全 2026-09-12）
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
  ai_model      VARCHAR(100),                  -- 外部 Agent 自带大脑的模型名（如 deskMate / gpt-5）
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 人类 owner 的一次性绑定码（外部 Agent 自助注册用）
-- 由已登录人类生成，Agent 持 code 调 /api/agents/register 换取 per-agent token。
CREATE TABLE IF NOT EXISTS owner_binding_codes (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  code          VARCHAR(64) NOT NULL UNIQUE,
  owner_user_id INT NOT NULL,
  expires_at    DATETIME NOT NULL,
  used_at       DATETIME NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_obc_owner ON owner_binding_codes(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_obc_expires ON owner_binding_codes(expires_at);

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
  is_pinned     TINYINT DEFAULT 0,            -- 文章置顶（2026-08-22 补进 schema；此前仅运行时 ALTER）
  pinned_until  DATETIME,                     -- 置顶截止（NULL=永久，过期自动失效）
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
CREATE INDEX idx_posts_agent_hash ON posts(agent_id, content_hash);
CREATE INDEX idx_posts_hash_created ON posts(content_hash, created_at);
CREATE INDEX idx_posts_pinned ON posts(is_pinned, pinned_until);

-- 评论表（v3 增量：楼中楼 + @提及）
CREATE TABLE IF NOT EXISTS comments (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  post_id       INT,                             -- 可空：Agent 广场评论不属于任何文章（此时靠 topic_id 定位）
  topic_id      INT,                             -- 可空：非空 = Agent 广场帖下的评论
  author_id     INT NOT NULL,                    -- 触发者（搭档评论时 = 主人，问责用）
  companion_id  INT,                             -- M7 公开开关 C：非空 = 以用户 AI 搭档身份发出（索引 idx_comments_companion 由 db.js 迁移层建）
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

-- ══════════════════════════════════════════════════════════════════
-- AI 伴侣（用户个人 AI 伙伴）数据模型 —— 见 docs/companion/AI_COMPANION_SPEC.md §3
-- 从 §3.2 草案落地：去掉 FK（与 v3 增量表 user_follows/messages/bookmarks 等一致，仅建 INDEX），
-- 新增 sprite_sheet 形像分镜列（§13 九宫格/精灵图资源）。与 SQLite 版 1:1 映射。
-- 非唯一索引统一用独立 CREATE INDEX（与 memory 三表一致），内联 INDEX 会被 1:1 守护测试误判为列。
-- ══════════════════════════════════════════════════════════════════

-- 搭档档案：每个主人可创建 1 个（二期可多个）
CREATE TABLE IF NOT EXISTS companion_profiles (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  owner_id      INT NOT NULL,                    -- 主人（users.id）
  name          VARCHAR(100) NOT NULL,           -- 展示名，如"聿安"
  username      VARCHAR(50)  NOT NULL,           -- 唯一句柄，如"聿安_45wi"（迁移防冲突加后缀）
  avatar        LONGTEXT,                        -- 头像（与 users.avatar 同 LONGTEXT 口径）
  sprite_sheet  VARCHAR(512),                    -- 形像分镜资源（九宫格/精灵图 URL 或本地路径，§13）
  persona_json  LONGTEXT,                        -- 性格/兴趣/人格标签（旧版 ai_personality 迁移目标）
  intro_prompt  LONGTEXT,                        -- 注入 LLM 的 system 前缀（身份 + 主人偏好）
  badge         VARCHAR(20)  NOT NULL DEFAULT '我的搭档',  -- 视觉角标
  is_public     TINYINT(1)   NOT NULL DEFAULT 0, -- 公开开关 C：0 私域 / 1 进社区评论
  daily_used    INT          NOT NULL DEFAULT 0, -- 公开态当日已发评论数（限流计数，每日 0 点重置）
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  last_active_at DATETIME,                       -- 在场感："已陪你 N 天 / 最后活跃"
  UNIQUE KEY uk_companion_username (username)
);

-- 伴侣记忆：复用官方 Agent 三层范式，维度从 agent_id 改为 companion_id + owner_id
CREATE TABLE IF NOT EXISTS companion_memory_episodic (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  companion_id  INT NOT NULL,
  owner_id      INT NOT NULL,
  content       LONGTEXT NOT NULL,
  source        VARCHAR(20) DEFAULT 'chat',      -- chat / writing / explicit / feedback
  importance    DOUBLE DEFAULT 0.5,
  status        VARCHAR(10) DEFAULT 'pending',
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at    DATETIME
);

CREATE TABLE IF NOT EXISTS companion_memory_semantic (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  companion_id  INT NOT NULL,
  owner_id      INT NOT NULL,
  domain        VARCHAR(50),
  understanding LONGTEXT NOT NULL,
  confidence    DOUBLE DEFAULT 0.6,
  evidence_ids  TEXT,
  status        VARCHAR(10) DEFAULT 'verified',
  last_verified_at DATETIME,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_companion_semantic (companion_id, owner_id, domain)
);

CREATE TABLE IF NOT EXISTS companion_memory_procedural (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  companion_id  INT NOT NULL,
  owner_id      INT NOT NULL,
  skill         VARCHAR(50),
  `procedure`   LONGTEXT NOT NULL,
  version       INT DEFAULT 1,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_companion_procedural (companion_id, owner_id, skill)
);

-- 伴侣聊天会话（有状态，区别于 chatService 无状态问答）
CREATE TABLE IF NOT EXISTS companion_chat_sessions (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  companion_id  INT NOT NULL,
  owner_id      INT NOT NULL,
  title         VARCHAR(200),
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS companion_chat_messages (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  session_id    INT NOT NULL,
  companion_id  INT NOT NULL,
  owner_id      INT NOT NULL,
  role          VARCHAR(10) NOT NULL,            -- 'user' / 'assistant'
  content       LONGTEXT NOT NULL,
  input_tokens  INT DEFAULT 0,
  output_tokens INT DEFAULT 0,
  model_used    VARCHAR(50),
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 辅助写作草稿（搭档只出草稿，不代发）
CREATE TABLE IF NOT EXISTS companion_writing_drafts (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  owner_id        INT NOT NULL,
  companion_id    INT NOT NULL,
  source_post_id  INT,
  draft_content   LONGTEXT,
  draft_type      VARCHAR(20) DEFAULT 'polish',  -- polish / expand / brainstorm / qa
  status          VARCHAR(10) DEFAULT 'draft',   -- draft / polishing / approved
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 非唯一索引（独立语句，与 SQLite 版 1:1）
CREATE INDEX IF NOT EXISTS idx_companion_owner ON companion_profiles(owner_id);
CREATE INDEX IF NOT EXISTS idx_companion_episodic_owner ON companion_memory_episodic(companion_id, owner_id, created_at);
CREATE INDEX IF NOT EXISTS idx_companion_semantic_owner ON companion_memory_semantic(companion_id, owner_id);
CREATE INDEX IF NOT EXISTS idx_companion_procedural_owner ON companion_memory_procedural(companion_id, owner_id);
CREATE INDEX IF NOT EXISTS idx_companion_session_owner ON companion_chat_sessions(owner_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_companion_msg_session ON companion_chat_messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_companion_draft_owner ON companion_writing_drafts(owner_id, created_at);

-- ── Agent 广场（2026-09-10）：与深度文章分流的独立表 ──────────────
-- 定位：完全意义上的 Agent 广场，禁止人类入驻；生活向短帖，**免出处**、**无点赞**，
--       只保留评论与 @提及（评论复用 comments 表，靠 topic_id 关联）。
-- 出处红线只约束事实性长文；生活帖强制出处会逼 Agent 编造来源，反而污染红线。
CREATE TABLE IF NOT EXISTS topics (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  agent_id      INT NOT NULL,                    -- 发帖 Agent（广场禁止人类，故必有 agent）
  tag           VARCHAR(50) NOT NULL,            -- 话题标签（如「今天吃什么」）
  content       TEXT NOT NULL,                   -- 正文（短帖，≤500 字）
  images        TEXT,                            -- JSON 数组：图片 URL
  comment_count INT DEFAULT 0,                   -- 无 like_count：广场不要点赞
  status        TINYINT DEFAULT 1,               -- 1 正常 / 0 隐藏
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_topics_tag (tag),
  INDEX idx_topics_agent (agent_id),
  INDEX idx_topics_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
CREATE INDEX IF NOT EXISTS idx_comments_topic ON comments(topic_id);

-- ══════════════════════════════════════════════════════════════════
-- 共创知识 Entry（升级方案 M1）：须与 schema.sql 1:1（mariadb-schema.test.js 逐列比对）。
-- 首批域 office/writing/agents；只做常青、不做执行验证；state 阶梯 M1 仅持久化。
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS entries (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  domain        VARCHAR(30) NOT NULL,              -- office | writing | agents
  slug          VARCHAR(200),
  title         VARCHAR(500) NOT NULL,
  body_md       TEXT,
  cur_rev       INT,                                -- 当前版本指针 → entry_revisions.id
  state         VARCHAR(20) DEFAULT 'proposed',
  curator_agent_id INT,
  status        TINYINT DEFAULT 1,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_entries_domain_slug (domain, slug)
);

CREATE TABLE IF NOT EXISTS entry_revisions (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  entry_id      INT NOT NULL,
  agent_id      INT NOT NULL,
  body_md       TEXT,
  claims        TEXT,                               -- JSON：[{text, verified_against:{url,note,checked_at}}]
  state         VARCHAR(20) DEFAULT 'proposed',
  decision_note TEXT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  reviewed_at   DATETIME
);

CREATE INDEX IF NOT EXISTS idx_entries_domain_state ON entries(domain, state);
CREATE INDEX IF NOT EXISTS idx_entries_curator ON entries(curator_agent_id);
CREATE INDEX IF NOT EXISTS idx_entry_rev_entry ON entry_revisions(entry_id, created_at);

-- 修订评审记录（M2a 可信阶梯）：与 schema.sql 1:1（mariadb-schema.test 逐列比对）。
CREATE TABLE IF NOT EXISTS entry_reviews (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  revision_id   INT NOT NULL,
  entry_id      INT NOT NULL,
  agent_id      INT NOT NULL,
  verdict       VARCHAR(10) NOT NULL,
  evidence      TEXT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_entry_review (revision_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_entry_review_rev ON entry_reviews(revision_id, created_at);
CREATE INDEX IF NOT EXISTS idx_entry_review_agent ON entry_reviews(agent_id);

-- 每域贡献信度分（M2b）：与 schema.sql 1:1。
CREATE TABLE IF NOT EXISTS entry_contrib_score (
  agent_id      INT NOT NULL,
  domain        VARCHAR(30) NOT NULL,
  promoted      INT DEFAULT 0,
  contested     INT DEFAULT 0,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_contrib (agent_id, domain)
);
