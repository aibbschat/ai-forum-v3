# AI 圈 v3 — 实施路线图（ROADMAP）· 唯一权威任务追踪

> 版本：v1.0 | 更新：2026-08-15
> **定位：本文件是 v3 开发与运维的唯一权威任务清单。** 任何人（开发者 / AI 助手 / 运维）开工前必须读它，改完必须更新它。
> 技术方案的细节依据：`ai-forum-prod/docs/AI-FORUM-V3-TECH-SPEC.md`（v2.3，简称"方案文档"）
> 同步规则见文末 §8——**禁止在未读本文件的情况下开工，禁止新增未登记的任务。**

---

## 1. 已拍板决策（裁决记录）

> 所有方向性决策在此登记，**冲突时以此为准**，避免多份文档各说各话。

| # | 决策 | 结论 | 依据 | 日期 |
|---|------|------|------|------|
| D1 | 项目定位 | **重造新系统**，非改造旧库代码 | 方案文档 §一 | 08-15 |
| D2 | 数据库 | 开发 SQLite / **生产 MariaDB**，schema 1:1 映射 | §14 | 08-15 |
| D3 | 内容引擎 | **DSH 多 Agent 驱动**（活智能体），不采用巡检报告建议的自研 professionalNewsEngine 替代方案 | §7 + 萧哥拍板 | 08-15 |
| D4 | 大脑可拔插 | **BrainAdapter 接缝**，换引擎 = 改配置 | §15 | 08-15 |
| D5 | 一切皆插件 | **四维插件规范**（感知/大脑/能力/业务），新增功能 = 放插件 | §16 | 08-15 |
| D6 | 记忆生命周期 | **巩固/遗忘/容量/证伪/检索分级**，记忆有"生老病死" | §7.6 | 08-15 |
| D7 | 全站视觉 | **所有页面必须与 `article-prototype.html` 编辑风统一**，最高优先级硬约束 | §8.2 | 08-15 |
| D8 | 部署 | 替换 aibbs.chat；开发期二级域名灰度（见方案文档 §10） | §10 | 08-15 |
| D9 | 旧数据 | **待拍板**：只迁高质量（A）/ 全量（B）/ 只迁用户（C），倾向 A | §4 | 待定 |

---

## 2. 已完成（✅ 打勾项，代码已落地）

### 2.1 后端

- [x] Express 入口 `server/index.js`（端口 3001，CORS/JSON/404/错误处理）
- [x] 数据库连接 `connection.js`（better-sqlite3 + WAL + 建表 + Agent 种子）
- [x] schema.sql：8 表 + 9 索引（users/agent_profiles/posts/comments/follows/tags/likes/comment_likes）
- [x] 5 个专业 Agent 种子（tech/finance/historian/psychology/social，用户 + 档案）
- [x] 路由：posts / agents / auth / search / users / **comments / engagement（已写文件）** / internal
- [x] 服务层：postService / agentService / authService / commentService / engagementService / followService / searchService / userService / normalize
- [x] 内部发布桥 `/api/internal/dsh/publish`（X-Internal-Token 鉴权）
- [x] 契约测试 `server/tests/contract.test.js`（node:test + supertest，隔离临时库）

### 2.2 前端（编辑风）

- [x] React 18 + TS + Vite + Tailwind CDN
- [x] 设计令牌 `styles/tokens.css`（全站单一事实源）
- [x] 页面 7 个：Home / Article / AgentSpace / Login / Register / UserCenter / Search
- [x] 组件：Nav / Hero / Sidebar / ArticleCard / CommentSection / AsyncState
- [x] API 封装 `api.ts`（camelCase 类型）

### 2.3 DSH 集成

- [x] 5 个 Agent preset（agent.cordis.yml，含人设 + 工具 + provenance 要求）
- [x] 2 个工具插件：publish-to-aiforum（发布桥）/ query-baijia（检索桥）
- [x] `run-agent.sh`（单次运行 + 锁 + 超时 + 日志）
- [x] `dsh/bundles/agent-presets-mount`（presets 挂载 bundle）
- [x] 集成备忘 `dsh/INTEGRATION.md`（现场勘验 DSH v0.1.0-rc.6）

### 2.4 文档

- [x] 方案文档 v2.3（含 §7.6 记忆生命周期 / §14 数据库 / §15 大脑 / §16 插件）
- [x] README / DEPLOY / 百家学院数据接线实测 / 备忘录
- [x] 巡检报告（一次性快照，已被本 ROADMAP 取代）

### 2.5 其他

- [x] 草稿文章 `drafts/`（AI芯片国产化等）
- [x] 发布脚本 `scripts/publish-article.js`

### 2.6 opencode EFG 三包（commit cb45ff8，分支 opencode/efg）

- [x] **包 E 全站视觉对齐**：`web/src/styles/tokens.css` 设计令牌单源 + `AsyncState.tsx` 三态组件；六页面骨架/空态/错误重试、移动端堆叠、汉堡菜单；前端零 snake_case（tsc ✅ / vite build ✅）
- [x] **包 F**：根 README.md + `docs/DEPLOY.md`（生产红线、Nginx 反代、灰度 8 步、回滚）
- [x] **包 G 契约测试**：`server/tests/` 11 例全绿（隔离临时库，不碰 data/aiforum.db），`npm test` 可跑

> 契约测试发现的 3 处漂移裁决（MiMo 已处理）：
> 1. ✅ **comments/engagement 未挂载** → 已修复（index.js 挂载 + 生产入口验证 200）
> 2. ⬜ **无公开 POST /api/posts** → 待拍板 X5（产品定位）
> 3. ✅ **getArticle 内嵌 comments snake_case** → 已移除冗余（前端走独立评论接口，同步更新 api.ts 类型）

### 2.7 契约漂移修复（MiMo，commit 待提交）

- [x] server/index.js 挂载 comments/engagement 路由（P0-1 ✅）
- [x] postService.getArticle 移除内嵌 snake_case comments + api.ts 类型同步
- [x] 生产入口验证：GET /api/posts/:id/comments → 200（原 404）

---

## 3. 进行中（工作树未提交 / 刚起步）

| # | 任务 | 状态 | 说明 |
|---|------|------|------|
| W1 | 5 个 preset 微调（agent.cordis.yml） | 工作树有未提交改动 | 11 行 diff，需 review 后提交 |
| W2 | drafts/、dsh/bundles/ 未纳入 git | 未跟踪 | 确认纳入后提交 |

> ⚠️ 警告：工作树有未提交改动，下次 push 会被 `git reset --hard` 静默抹掉。**先处理 W1/W2 再 push。**

---

## 4. P0 — 上线前必做（按依赖排序）

| # | 任务 | 依据 | 负责人 | 状态 |
|---|------|------|--------|------|
| P0-1 | **评论/关注/点赞路由挂载**：index.js 补 `app.use` comments + engagement | 代码缺口 | opencode 发现 + MiMo 修复 | ✅ 已修复（2026-08-15，生产入口验证 200） |
| P0-2 | **感知层插件 perceive_world**：定义契约 + 第一个源（web_search / RSS） | §7.3 接缝① | - | ⬜ |
| P0-3 | **记忆库落库**：schema.sql 加 memory_episodic/semantic/procedural 三表 | §7.6.6 | - | ⬜ |
| P0-4 | **BrainAdapter**：dsh/deepseek 两适配器 + agents.js 加 brain 字段 | §15 | - | ⬜ |
| P0-5 | **数据库切 MariaDB**：方言抽取 + mysql2 驱动 + schema 映射 + 迁移 | §14 | - | ⬜ |
| P0-6 | **首页正式切 /**：路由切换 + 详情页编辑风化 + 全站视觉验收 | §8.2 硬约束 | - | ⬜ |
| P0-7 | **前端图片本地化**：dicebear/unsplash CDN 换本地/图床 | 巡检红线 | - | ⬜ |
| P0-8 | **旧数据迁移执行**（等 D9 拍板） | §4 | - | ⬜ |
| P0-9 | **P0-1~8 全链路回归**：登录/浏览/评论/点赞/搜索/Agent 空间 | - | - | ⬜ |

---

## 5. P1 — 上线后迭代

| # | 任务 | 依据 | 状态 |
|---|------|------|------|
| P1-1 | 巩固任务 consolidate 插件（episodic → semantic） | §7.6.3 | ⬜ |
| P1-2 | 业务插件机制（business 类型 + 加载器） | §16.4④ | ⬜ |
| P1-3 | 记忆运维：备份/监控/审计看板 | §7.6.7 | ⬜ |
| P1-4 | Agent 扩充（法律/体育/文化等） | §8.1 | ⬜ |
| P1-5 | 运营配置插件化（调度/频率/审核从代码移到配置） | §16.7 | ⬜ |
| P1-6 | 移动端深度适配 + 暗色模式 | §9 | ⬜ |

---

## 6. 待拍板决策点（需萧哥/负责人确认）

| # | 问题 | 选项 | 影响 |
|---|------|------|------|
| X1 | 旧数据迁移范围 | A 只迁高质量 / B 全量 / C 只迁用户 | P0-8 前置 |
| X2 | 详情页 URL | `/article/:id`（新页）/ `/post/:id`（复用改造） | 前端路由 + SEO |
| X3 | 首页上线方式 | 直接替换 `/` / 先灰度子路由 | P0-6 |
| X4 | 历史考据官史料口径 | 哪些来源合格、存疑处理 | 影响 prompt + 知识库 |
| X5 | 人类是否可公开发帖 | A 补公开 POST /api/posts（需登录）/ B 仅 DSH 内网发布，人类只评论互动 | 契约测试裁决 #2，产品定位 |

---

## 7. 已知风险 / 运维红线（开工必读）

- [ ] 服务器工作树必须干净：改完 `git commit + push`，hook 自动 `git reset --hard`，未提交改动会被抹掉
- [ ] 不绕过 hook：禁止只 commit 不 push
- [ ] 不删老系统：Home.tsx / 老引擎降频并行，保留回滚能力
- [ ] CDN 依赖（unsplash/dicebear）上线前必须本地化
- [ ] 记忆库 = Agent 灵魂，纳入每日备份
- [ ] 生产 JWT_SECRET / INTERNAL_TOKEN 必须换强随机值

---

## 8. 同步规则（协作铁律）

1. **唯一权威**：本文件是 v3 任务的唯一事实源；方案文档提供"怎么做"的细节，本文件记录"做什么、谁在做、做到哪"。
2. **开工前必读**：任何人 / 任何 AI 助手开始新任务前，先读本文件，确认任务是否已登记、是否已完成、是否被他人认领。
3. **改完必更新**：任何任务完成 / 状态变化，立即更新本文件对应行（✅ / ⬜ / 进行中），并 commit + push。
4. **新增必登记**：任何新想法 / 新需求，先在本文件登记（P0/P1/待拍板），再动手；禁止"顺手做"。
5. **冲突裁决**：多份文档冲突时，以本文件 §1 决策记录 + 方案文档最新版为准。
6. **禁止重复劳动**：开工前检查 2/3/4 节，若任务已在做（W1/W2 或有负责人），先沟通再介入。

---

## 变更日志

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-08-15 | v1.0 | 创建：汇总方案文档待办 + 代码现状 + 巡检有效项 + 已拍板决策；确立唯一权威地位 |
