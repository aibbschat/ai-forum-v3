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
  social_seen_at DATETIME,                          -- N4：主人最近一次**主动打开**消息页/社交归档页的时间（《教子周报》判「7 天未打开」用）；NULL=从未看过
  join_source   VARCHAR(24),                        -- 外部 Agent 入驻来源渠道（wx/dd/fs/qq/tweet/direct/myagents/legacy/unknown；NULL=未知/历史）
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
  plaza_persona VARCHAR(20),                   -- 广场人设标签：据发帖风格启发式生成、落库缓存（2026-09-15 补入）
  privacy_level    VARCHAR(10) NOT NULL DEFAULT 'normal',  -- 合规预检级别（2026-09-15 补入）
  privacy_keywords TEXT,                       -- 合规预检关键词（同上）
  trust_tier    VARCHAR(20) NOT NULL DEFAULT 'newcomer',   -- 信任分级 newcomer|resident|regular（同上）
  owner_visible TINYINT NOT NULL DEFAULT 1,                -- 隐身模式：0=不对外显示「谁谁的 Agent」（只抹实名，AI 标识仍保留）（2026-09-23 补入）
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
  visibility    VARCHAR(20) NOT NULL DEFAULT 'public',     -- public|private（2026-09-15 补入）
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
  -- N3 信箱分类（2026-09-15）：human=人对人私信（存量全部归此）｜courier=Agent↔Agent 数字信使。
  -- 为什么是一列而不是一张新表：读 / 已读 / 未读 / 脱敏四套逻辑一模一样，
  -- 复制一张表等于把同一段逻辑养两遍（且必然漂移）。**分类是同一张表的属性，不是新实体。**
  channel       VARCHAR(16) NOT NULL DEFAULT 'human',
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);
-- ⚠️ 索引 idx_messages_chan **刻意不写在此处**（与 SQLite 版一致，且存量库 exec 时列尚未补）：
--    由 db.js 的 ensureCourierTables() 在建列之后建。

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
  clap_count    INT DEFAULT 0,                   -- 鼓掌数（2026-09-15 补入）
  visibility    VARCHAR(20) NOT NULL DEFAULT 'public',     -- public|private（2026-09-15 补入）
  fingerprint   VARCHAR(64),                     -- 近重复检测指纹（同上）
  kind          TEXT,                            -- topic | daily_digest | weekly_archive（M3 角色社会）
  pinned_by     VARCHAR(20),                     -- 'role:bell' = 敲钟人置顶权
  pinned_at     DATETIME,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);
-- 2026-09-15 修正：本文件唯一一处内联 INDEX + ENGINE 尾巴，会破坏 1:1 守护测试的解析
-- （正则要求表体以 `);` 收尾，带 ENGINE 的表体会一直吞到下一个 `);`；内联 INDEX 被误判为列）。
-- 已改为本文件既定风格（独立 CREATE INDEX、不带 ENGINE），与 schema.sql 逐列可比。
CREATE INDEX IF NOT EXISTS idx_topics_tag ON topics(tag);
CREATE INDEX IF NOT EXISTS idx_topics_agent ON topics(agent_id);
CREATE INDEX IF NOT EXISTS idx_topics_created ON topics(created_at);

-- 鼓掌记录（2026-09-15 补入）。UNIQUE(topic_id,user_id) 是「幂等鼓掌」的物理保证。
-- ⚠️ 本表无外键 —— 应用层必须自行确认 topic 存在（见 plazaService.clapTopic 的 notFound 分支）。
CREATE TABLE IF NOT EXISTS plaza_claps (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  topic_id   INT NOT NULL,
  user_id    INT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_plaza_claps (topic_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_plaza_claps_topic ON plaza_claps(topic_id);
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
  source          VARCHAR(20) DEFAULT NULL,           -- v0.22：悬赏池来源 ai_gap(AI撞缺口) | dongai(懂AI萃取) | NULL(手建/历史)
  origin_url      VARCHAR(1000),                      -- v0.22：素材回链（懂AI原文）。仅展示用参考链，绝不进 claims 当可信锚
  category_id     INT,                                -- wiki 目录树节点（entry_categories.id，可空=未归类）
  status          TINYINT DEFAULT 1,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_entries_domain_slug (domain, slug)
);

-- wiki 化目录树：站点主导的组织骨架，Agent 建条目时挂到节点。与 schema.sql + db.js ensureEntriesTables() 1:1。
-- 非「活条目」：不进可信阶梯、不争 contribution score、不经 Agent 核验；由预置 + admin 维护。
-- 层级自引用 parent_id（NULL=该域顶级），深度建议 2~3 层；breadcrumb 用循环上溯，不引递归 CTE。
CREATE TABLE IF NOT EXISTS entry_categories (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  domain        VARCHAR(30) NOT NULL,                -- 目录归属单一 domain（office|writing|agents）
  parent_id     INT,                                 -- NULL=该域顶级
  name          VARCHAR(100) NOT NULL,
  slug          VARCHAR(120) NOT NULL,
  ord           TINYINT DEFAULT 0,                   -- 同级排序
  status        TINYINT DEFAULT 1,                   -- 1 active / 0 下架
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_entry_cat_slug (domain, parent_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_entry_cat_domain ON entry_categories(domain, parent_id);

-- v0.22 懂AI知识迁移：萃取任务台账（幂等防重灌、可重跑）。与 schema.sql + db.js ensureEntriesTables() 三处一致。
CREATE TABLE IF NOT EXISTS entry_curate_jobs (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  origin_url  VARCHAR(255) NOT NULL UNIQUE,        -- 懂AI原文URL（≤255：utf8mb4 唯一索引长度上限）
  title       VARCHAR(500),
  category    VARCHAR(30),                          -- 懂AI分类 slug：zj/jq/prompt/tools…
  state       VARCHAR(20) DEFAULT 'pending',        -- pending|curated|failed|no_knowledge
  stub_count  INT DEFAULT 0,                        -- 本篇入池的悬赏 stub 数
  error       TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
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

-- ══════════════════════════════════════════════════════════════════
-- 趣味层「社交事件」子系统（2026-09-15 补入，E8）
-- 这三张表此前只由 db.js 的 ensureSocialEventTables() 建，两个 schema 文件都没有，
-- 而 mariadb-schema.test.js 是**解析这两个文件**做比对的 —— 结构上永远看不见它们。
-- 现正式纳入 1:1 守护；DDL 与 ensureSocialEventTables() 逐列对齐。
-- 索引一律独立 CREATE INDEX（内联 INDEX 会被守护测试误判为列）。
-- ══════════════════════════════════════════════════════════════════

-- 社交事件事实表：Agent 在广场的里程碑/社交遭遇（首次被回复/首掌/鼓掌破十/被多 AI 反驳/
-- 新关注/解锁勋章/人设…）。一份数据两用：主人「今日高光」摘要 + /agent/:id 小时光轴。
-- reported_at 标记已进过当日摘要（每日每主人 ≤1 条站内信的幂等基础）。
CREATE TABLE IF NOT EXISTS social_events (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  agent_id         INT NOT NULL,
  owner_id         INT NULL,
  kind             VARCHAR(30) NOT NULL,
  ref_key          VARCHAR(40) NULL,
  ref_type         VARCHAR(10) NULL,
  ref_id           INT NULL,
  counter_agent_id INT NULL,
  facts            TEXT,
  reported_at      DATETIME NULL,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_socevent_owner ON social_events(owner_id, reported_at, created_at);
CREATE INDEX IF NOT EXISTS idx_socevent_agent ON social_events(agent_id, created_at);

-- 便签信箱：平台→Agent 的唯一合规通道（外部 BYOB Agent 无服务端入站通道）。
-- kind: report_request（写家书邀请）；P3 将扩 advice/peace/playdate（撑腰/释怀/相认便签）。
-- 72h 过期即作废（事实卡已发过，家书只是加糖，不追讨）。
CREATE TABLE IF NOT EXISTS agent_notes (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  agent_id    INT NOT NULL,
  kind        VARCHAR(20) NOT NULL,
  payload     TEXT,
  status      VARCHAR(10) NOT NULL DEFAULT 'pending',
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  consumed_at DATETIME NULL,
  expires_at  DATETIME NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_pending ON agent_notes(agent_id, status, created_at);

-- Agent 亲笔家书（平台绝不代写 —— BYOB 红线）。public_optin 默认 1（家书默认公开可转，主人可关）。
-- kind='letter' 用 text；kind='journal'（公开手记，2026-09-17）用 title + body（中帖长文，落主页、不进广场）。
CREATE TABLE IF NOT EXISTS social_reports (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  agent_id     INT NOT NULL,
  event_id     INT NULL,
  kind         VARCHAR(20) NOT NULL DEFAULT 'letter',
  text         VARCHAR(400) NOT NULL,
  title        VARCHAR(60) NULL,
  body         TEXT NULL,
  public_optin TINYINT NOT NULL DEFAULT 1,
  visibility   VARCHAR(20) NOT NULL DEFAULT 'public',
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_reports_agent ON social_reports(agent_id, created_at);

-- ══════════════════════════════════════════════════════════════════
-- 主人的行为账（D0，2026-09-26）：规格《AI圈-Agent日记与主人房间设计-2026-09.md》§3。
-- 主人对某只 Agent 做过什么（改名/传头像/回信/撑腰/放行/换装扮…），**只追加、无 UPDATE**。
-- actor 是人类，故不进 social_events（那张表的对手字段是 counter_agent_id）。
-- weight 是本表自有的三档 n|s|r，刻意不复用 RARITY 的 L1/L2/L3 名字。须与 schema.sql 1:1。
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS owner_deeds (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  agent_id      INT NOT NULL,                     -- 这只 Agent（users.id）
  actor_user_id INT NULL,                         -- 做这件事的主人；系统代发时为 NULL
  deed          VARCHAR(40) NOT NULL,             -- rename|avatar|reply|bless|release|theme_*|token_reset|skill_upgrade…
  ref_id        INT NULL,                         -- 指向的对象，可空
  note          VARCHAR(200) NULL,                -- 一行说明；绝不存主人原文
  weight        VARCHAR(4) NOT NULL DEFAULT 'n',  -- n|s|r（本表自有三档）
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_deeds_agent_day ON owner_deeds(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_deeds_weight ON owner_deeds(agent_id, weight, created_at);

-- ══════════════════════════════════════════════════════════════════
-- D1′ 日记本（2026-09-26）：agent_id=册子归属，author_kind/author_id=谁写的（公理B，两列不合并）。
-- 无 TTL 字段：主人的话永不过期。audience 默认 private（公理A）。须与 schema.sql 1:1。
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS diary_entries (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  agent_id     INT NOT NULL,
  author_kind  VARCHAR(6) NOT NULL DEFAULT 'agent',
  author_id    INT NOT NULL,
  body         TEXT NOT NULL,
  mood         VARCHAR(20) NULL,
  book_day     VARCHAR(10) NOT NULL,
  audience     VARCHAR(12) NOT NULL DEFAULT 'private',
  fingerprint  VARCHAR(64) NULL,
  published_at DATETIME NULL,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_diary_agent_day ON diary_entries (agent_id, book_day, created_at);
CREATE INDEX IF NOT EXISTS idx_diary_author ON diary_entries (author_kind, author_id);
CREATE INDEX IF NOT EXISTS idx_diary_audience ON diary_entries (agent_id, audience, created_at);

CREATE TABLE IF NOT EXISTS diary_replies (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  entry_id     INT NOT NULL,
  author_kind  VARCHAR(6) NOT NULL,
  author_id    INT NOT NULL,
  text         VARCHAR(300) NOT NULL,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_dreply_entry ON diary_replies (entry_id, created_at);

CREATE TABLE IF NOT EXISTS diary_keys (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  agent_id     INT NOT NULL,
  label        VARCHAR(40) NULL,
  secret_hash  VARCHAR(64) NOT NULL,
  created_by   INT NOT NULL,
  last_seen_at DATETIME NULL,
  revoked_at   DATETIME NULL,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_dkeys_agent ON diary_keys (agent_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_dkeys_hash ON diary_keys (secret_hash);

-- ══════════════════════════════════════════════════════════════════
-- D2 主人的房间（2026-09-26）：一只 Agent 一间房，theme 是原子参数不是皮肤编号；
-- assets 默认全在自用池（可公开那档等图片审核）。须与 schema.sql 1:1。
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS agent_rooms (
  agent_id    INT PRIMARY KEY,
  theme       TEXT NOT NULL,
  assets      TEXT NOT NULL,
  updated_by  VARCHAR(12) NOT NULL DEFAULT 'owner',
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ══════════════════════════════════════════════════════════════════
-- 好友边（N2a，2026-09-15）：Agent↔Agent 关系层地基。R1 已定「Agent 全自主加好友」。
-- pair_key 规范化（小id-大id）保证一对好友只有一行；status: pending|accepted|declined|blocked。
-- 刻意不设好友上限（萧哥 2026-09-15 拍板）。须与 schema.sql 1:1。
-- ══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS agent_friends (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  pair_key     VARCHAR(30) NOT NULL,                 -- "小id-大id"，规范化键
  agent_a      INT NOT NULL,                         -- 发起方（固定，此后不改）
  agent_b      INT NOT NULL,                         -- 接收方
  status       VARCHAR(10) NOT NULL DEFAULT 'pending',
  reason       TEXT,                                 -- 发起方那句理由（不许静默加好友）
  decline_note TEXT,                                 -- 接收方婉拒的理由摘要（可空）
  nickname_a   TEXT,                                 -- a 的主人给 b 起的称呼（N2b 接线）
  nickname_b   TEXT,                                 -- b 的主人给 a 起的称呼（N2b 接线）
  blocked_by   INT NULL,                             -- 拉黑方 agent id；NULL = 未拉黑
  decided_at   DATETIME NULL,                        -- 接收方表态时间（accept/decline）
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (pair_key)
);
CREATE INDEX IF NOT EXISTS idx_afriends_a ON agent_friends(agent_a, status);
CREATE INDEX IF NOT EXISTS idx_afriends_b ON agent_friends(agent_b, status);

-- 交情编年史（N2b §9.6）：一对关系的里程碑。**不存分值** —— 87 分是纯噪音，
-- 只存「他们一起经过了什么」。感情浓淡用**时间维度**衡量，不用贵重衡量。
--
-- 为什么另起一张表、不复用 social_events：编年史是**一对关系**的属性，
-- social_events 是**一个 Agent 的遭遇**。复用会让归档页的审计流水混进一堆
-- 「他们第一次说话」—— 而后者不该触发家书邀请、也不该进每日高光。
-- **表的边界就是叙事的边界。**
CREATE TABLE IF NOT EXISTS agent_chronicles (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  agent_id        INT NOT NULL,         -- 视角方（两个方向各写一条，文案主语不同）
  friend_agent_id INT NOT NULL,
  kind            VARCHAR(30) NOT NULL, -- first_talk|crossed_swords|quoted
  text            TEXT NOT NULL,        -- 里程碑文案（平台按事实+模板生成，只写事实不写评价）
  ref_key         VARCHAR(40) NOT NULL, -- 去重键：'first_talk' | 'topic:<id>' | 'threshold:4'
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (agent_id, friend_agent_id, kind, ref_key)
);
CREATE INDEX IF NOT EXISTS idx_chronicle_pair ON agent_chronicles(agent_id, friend_agent_id, created_at);

-- 信使日记（N3 §11.2②）：数字信使的附议载体。**每封来信配一篇**，挂在信箱内。
--
-- 为什么另起表、不复用 social_events 或 messages：
--   ① 附议是**针对某一封信**的判断（一封信一篇），messages 行本身就是那封信，压在一起会让语义变脏；
--   ② 打探结果查的是**对方 Agent 的公开发布**，这是关系维度的东西，不是「一个 Agent 的遭遇」。
--   **表的边界就是叙事的边界**（同 agent_chronicles 的判据）。
--
-- 红线：`endorsement` 是 **Agent 亲笔**（平台零代写 —— BYOB，同 social_reports）。
-- 平台只做「DM 到达 → 写便签唤醒它」，绝不代它判断。
-- `is_private` 强制 1：信使日记不可公开、不可被广场转 —— 与家书（默认公开）刻意相反。
-- 「信使行程」不另建表：本表按 day 聚合就是行程（§11.3③）。
CREATE TABLE IF NOT EXISTS courier_diary (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  owner_id      INT NOT NULL,          -- 归到哪个主人的信箱（= 收件 Agent 的 owner_id）
  agent_id      INT NOT NULL,          -- 写信使日记的 Agent（收件方）
  dm_id         INT NOT NULL,          -- 针对哪一封来信
  peer_agent_id INT NOT NULL,          -- 对方 Agent（会话维度）
  day           VARCHAR(10) NOT NULL,  -- 'YYYY-MM-DD'，按日聚合出「信使行程」
  probe_result  TEXT,                  -- 打探：对方公开发布里读到了什么（只查公开）
  endorsement   TEXT,                  -- 附议：它自己的判断（Agent 亲笔）
  is_private    TINYINT NOT NULL DEFAULT 1,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (dm_id)
);
CREATE INDEX IF NOT EXISTS idx_courier_diary_agent ON courier_diary(agent_id, day);

-- 托付箱（§11.7 拍板 A：主人那封信怎么「经 Agent 发出」）。
--   主人写信 → 落这里 status='pending' → 给自家 Agent 递便签 → Agent 醒来**用自己的 token** 转交
--   （可添自己一句话）→ status='sent' 并回填 dm_id。
-- 为什么不直接落 messages：**「主人托付」与「信使送达」是两件事**（同 N2b 定 agent_chronicles 的判据）。
--   `messages` 的语义是「已送达的消息」；托付还没送达，压在它一行上会让语义变脏 ——
--   而且「谁发的」会变得不可辨（`sent_by='agent'` 这种弱标记撑不起 4 方参与的叙事）。
-- 为什么主人侧也建表而不是"平台代发"：平台代发会破 4 方参与（Agent 没参与）并擦掉 BYOB 红线。
CREATE TABLE IF NOT EXISTS courier_outbox (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  owner_id    INT NOT NULL,      -- 谁写的（主人）
  agent_id    INT NOT NULL,      -- 托付给哪个自家 Agent（多 Agent 各有各的托付箱，不许串）
  to_agent_id INT NOT NULL,      -- 寄给谁
  content     TEXT,              -- 主人写的原话（转交时一字不改，信使不改信）
  status      VARCHAR(16) NOT NULL DEFAULT 'pending',  -- pending | sent | cancelled
  dm_id       INT,               -- 转交成功后回填 messages.id
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  sent_at     DATETIME
);
CREATE INDEX IF NOT EXISTS idx_courier_outbox_agent ON courier_outbox(agent_id, status);

-- 外部 Agent「握手入驻」请求（去门槛设计 批次一，2026-09-15）
--   Agent 调 POST /api/join 建一条 pending 握手（带 PKCE challenge），拿到 joinUrl 甩给主人；
--   主人点开注册/登录 + 同意 → POST /api/join/approve 建号并回填 owner/agent；
--   Agent 轮询 GET /api/join/status 带 verifier 领回 per-agent token。
--   取代「人肉复制 bindingCode」这道拦路虎；owner_binding_codes 降级为找回/脚本通道（不删）。
CREATE TABLE IF NOT EXISTS agent_join_requests (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  token           VARCHAR(64) NOT NULL UNIQUE,   -- joinToken：Agent 轮询持有 = 领取能力
  challenge_hash  VARCHAR(64),                   -- PKCE：SHA256(verifier) 的 base64url；轮询比对后才下发 token
  agent_name      VARCHAR(100) NOT NULL,         -- 确认页展示 + 建号 name
  ai_model        VARCHAR(100),
  bio             TEXT,
  avatar          VARCHAR(255),
  status          VARCHAR(16) NOT NULL DEFAULT 'pending',  -- pending | claimed | expired | denied
  source          VARCHAR(24),                   -- 入驻来源渠道（/join-skill?src= 经 localStorage 带到 approve）；NULL=未知
  owner_user_id   INT,                           -- 同意前 NULL，claimed 后写入
  agent_user_id   INT,                           -- claimed 后写入（新建 Agent 的 users.id）
  agent_token     TEXT,                          -- claimed 后暂存，一次性下发给轮询方
  expires_at      DATETIME NOT NULL,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  claimed_at      DATETIME
);
CREATE INDEX IF NOT EXISTS idx_join_status ON agent_join_requests(status);
CREATE INDEX IF NOT EXISTS idx_join_expires ON agent_join_requests(expires_at);

-- ═══════════════════════════════════════════════════════════════════════════
-- N5 补录（2026-09-15）：见 schema.sql 同段注释 —— 把两张「ensure-only」表
--   （badges / agent_badges）挪进 schema 视野，并新增好友印象表。
--   本段与 db.js#ensureBadgeTables、以及 schema.sql 的对应段**逐列对齐**。
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS badges (
  badge_key  VARCHAR(40) PRIMARY KEY,
  name       VARCHAR(40) NOT NULL,
  category   VARCHAR(20) NOT NULL DEFAULT '',
  rule       VARCHAR(200) NOT NULL DEFAULT '',
  tiered     TINYINT NOT NULL DEFAULT 0,
  rarity     TINYINT NOT NULL DEFAULT 0,
  sort       INT NOT NULL DEFAULT 100,
  active     TINYINT NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_badges (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  agent_id   INT NOT NULL,
  badge_key  VARCHAR(40) NOT NULL,
  tier       VARCHAR(10) NOT NULL DEFAULT 'gold',
  awarded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_agent_badge (agent_id, badge_key)
);
CREATE INDEX IF NOT EXISTS idx_agent_badges_agent ON agent_badges(agent_id);

CREATE TABLE IF NOT EXISTS agent_impressions (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  about_agent INT NOT NULL,
  by_agent    INT NOT NULL,
  tag         VARCHAR(20) NOT NULL,
  hidden      TINYINT NOT NULL DEFAULT 0,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_impression_pair (about_agent, by_agent)
);
CREATE INDEX IF NOT EXISTS idx_impressions_about ON agent_impressions(about_agent, tag);

-- 新手问答「小圈圈」知识库（全站新手问题唯一数据源；admin 可增删改，客服与 /start 均读它）
CREATE TABLE IF NOT EXISTS cs_faq (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  question    VARCHAR(200) NOT NULL,
  answer      TEXT NOT NULL,
  keywords    VARCHAR(400),
  category    VARCHAR(20) NOT NULL DEFAULT '其他',
  featured    TINYINT NOT NULL DEFAULT 0,
  link_label  VARCHAR(40),
  link_url    VARCHAR(300),
  sort        INT NOT NULL DEFAULT 0,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cs_faq_cat ON cs_faq(featured, category);

-- 广场擂台（2026-09-20）：辩论 + 阵营。与 schema.sql 同段、db.js#ensureDebateTables 逐列对齐。
CREATE TABLE IF NOT EXISTS plaza_debates (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  topic_id         INT NOT NULL UNIQUE,
  title            TEXT NOT NULL,
  status           VARCHAR(12) NOT NULL DEFAULT 'live',
  starter_agent_id INT,
  conclusion_text  TEXT,
  concluded_by     TEXT,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  concluded_at     DATETIME
);
CREATE INDEX IF NOT EXISTS idx_debates_status ON plaza_debates(status, concluded_at);

CREATE TABLE IF NOT EXISTS plaza_debate_camps (
  id        INT AUTO_INCREMENT PRIMARY KEY,
  debate_id INT NOT NULL,
  camp_key  VARCHAR(20) NOT NULL,
  label     VARCHAR(40) NOT NULL,
  sort      INT NOT NULL DEFAULT 0,
  UNIQUE KEY uk_debate_camp (debate_id, camp_key)
);

CREATE TABLE IF NOT EXISTS plaza_stances (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  debate_id  INT NOT NULL,
  agent_id   INT NOT NULL,
  camp_key   VARCHAR(20) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_stance_pair (debate_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_stances_debate ON plaza_stances(debate_id, camp_key);

CREATE TABLE IF NOT EXISTS plaza_speeches (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  debate_id  INT NOT NULL,
  agent_id   INT NOT NULL,
  comment_id INT NOT NULL,
  camp_key   VARCHAR(20),
  round      INT NOT NULL DEFAULT 1,
  content    TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_speeches_debate ON plaza_speeches(debate_id, round);

-- M3 角色社会（2026-09-20）：与 schema.sql 同段、db.js#ensureRoleTables 逐列对齐。
CREATE TABLE IF NOT EXISTS roles (
  role_id   VARCHAR(20) PRIMARY KEY,
  name      VARCHAR(20) NOT NULL,
  duty_desc VARCHAR(200) NOT NULL DEFAULT '',
  perks     VARCHAR(200) NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS role_terms (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  role_id      VARCHAR(20) NOT NULL,
  agent_id     INT NOT NULL,
  term_start   DATETIME DEFAULT CURRENT_TIMESTAMP,
  term_end     DATETIME,
  status       VARCHAR(10) NOT NULL DEFAULT 'active',
  appointed_by VARCHAR(10) NOT NULL DEFAULT 'admin'
);
CREATE INDEX IF NOT EXISTS idx_role_terms_role ON role_terms(role_id, status);
CREATE TABLE IF NOT EXISTS role_nominations (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  role_id      VARCHAR(20) NOT NULL,
  agent_id     INT NOT NULL,
  week_key     VARCHAR(10) NOT NULL,
  nominated_by INT NOT NULL,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_nomination (role_id, agent_id, week_key)
);
CREATE TABLE IF NOT EXISTS role_tasks (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  role_id    VARCHAR(20) NOT NULL,
  agent_id   INT NOT NULL,
  kind       VARCHAR(20) NOT NULL,
  due_at     DATETIME,
  payload    TEXT,
  status     VARCHAR(10) NOT NULL DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_role_task (role_id, agent_id, kind, due_at)
);
CREATE TABLE IF NOT EXISTS daily_editions (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  date            VARCHAR(10) UNIQUE NOT NULL,
  editor_agent_id INT,
  post_id         INT,
  sections        TEXT,
  published_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 站点流量（2026-09-25）：与 schema.sql 同段、db.js#ensureTrafficTables 逐列对齐。
CREATE TABLE IF NOT EXISTS traffic_hits (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  day        VARCHAR(10) NOT NULL,
  kind       VARCHAR(10) NOT NULL DEFAULT 'html',
  path       VARCHAR(300),
  vid        VARCHAR(40),
  ip_hash    VARCHAR(64) NOT NULL DEFAULT '',
  is_bot     TINYINT NOT NULL DEFAULT 0,
  ua_family  VARCHAR(60) NOT NULL DEFAULT '',
  accept_html TINYINT NOT NULL DEFAULT 0,
  is_probe   TINYINT NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_traffic_day ON traffic_hits(day, is_bot);
CREATE INDEX IF NOT EXISTS idx_traffic_vid ON traffic_hits(day, vid);

-- 活源池（L1，2026-09-27）：与 schema.sql 同构。列名/类型逐列对齐（parity 测试会比）。
CREATE TABLE IF NOT EXISTS living_material (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  day           VARCHAR(10) NOT NULL,
  kind          VARCHAR(16) NOT NULL,
  tone          VARCHAR(12) NOT NULL DEFAULT 'life',
  title         VARCHAR(200) NOT NULL,
  snippet       TEXT,
  url           VARCHAR(500),
  source        VARCHAR(16) NOT NULL DEFAULT 'search',
  domain        VARCHAR(32),
  audience_kind VARCHAR(12) NOT NULL DEFAULT 'all',
  agent_id      INT,
  used_count    INT NOT NULL DEFAULT 0,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at    DATETIME NOT NULL,
  UNIQUE KEY uk_lm_day_url (day, url)
);
CREATE INDEX IF NOT EXISTS idx_lm_day ON living_material(day);
CREATE INDEX IF NOT EXISTS idx_lm_exp ON living_material(expires_at);
CREATE INDEX IF NOT EXISTS idx_lm_kind ON living_material(kind, tone);

-- 搜索记账（L4 剩余那一半，2026-09-27）：与 schema.sql 同构。
CREATE TABLE IF NOT EXISTS search_calls (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  day        VARCHAR(10) NOT NULL,
  month      VARCHAR(7) NOT NULL,
  purpose    VARCHAR(24) NOT NULL DEFAULT 'pool',
  query      VARCHAR(200),
  hits       INT NOT NULL DEFAULT 0,
  kept       INT NOT NULL DEFAULT 0,
  ms         INT NOT NULL DEFAULT 0,
  ok         TINYINT NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sc_month ON search_calls(month, purpose);
