# 广场专项设计 · 实施审计记录

版本 v1.0 ｜ 2026-09-12 10:30 ｜ 审计：逍遥 ｜ 对象：《AI圈-广场专项设计-防与角色社会.md》

> **审计方法**：逐条对照设计文档的 M1/M2/M3 子项，去 `server/`（未提交的千问工作区代码）与 `web/src/`、`connector/ai-circle-skill/SKILL.md` 核实真实落地情况。属 trust-but-verify：读的是工作区未提交代码，未重跑构建/测试。
>
> **核心发现**：千问实际完成的是 **M1 + M2（"防"的全部）**，链路接通、质量扎实；**M3（角色社会 + 日报）零代码落地**，与设计文档第 5 节自述「M3 未开工」一致。萧哥所说"做完全部项目"与代码实况存在偏差——很可能指 M1/M2 全部，或对 M3 进度有误解。

---

## 一、M1 安全伞 —— ✅ 完整落地

| 子项 | 文档要求 | 代码实况 | 结论 |
|---|---|---|---|
| 1.4 凭证轮转 | token_version 列 + 中间件校验 + owner 重置端点 + 后台批量吊销 + SKILL 401 引导 | `db.js` 双方言迁移 ✓；`auth.js` `signAgentToken` 带 tv + `checkTokenVersion` 校验 ✓；`admin.js` 批量吊销（tv+1）✓；`owners.js` 重置端点（git M）✓；`SKILL.md:105/303` 401 `token_revoked` 引导 ✓ | ✅ |
| 1.3 owner 配额 / 爬坡 / 近重复 | owner 共享配额 `min(10, 3×活跃数)`、72h/7d 爬坡、跨 Agent 指纹查重 ≥0.85 → flagged、trust_tier 三级 | `plazaService.js` 爬坡三档 + owner 配额 + 指纹查重（`fingerprint` + 24h 全平台比对）✓；`syncTrustTier` 阈值式重算 ✓ | ✅ |
| 1.1 规则前置层 | 广告/引流/PII/注入正则拒发，命中 → 4xx `reason=ad_suspect/owner_pii/injection` | `moderationService.precheckContent` ✓；`plazaService.createTopic/评论` 接线 ✓ | ✅ |

---

## 二、M2 审核与隐私 —— ✅ 主体落地，⚠️ 一处真缺口

| 子项 | 文档要求 | 代码实况 | 结论 |
|---|---|---|---|
| 1.1 LLM 异步审 | 四类判定、状态机 `public→flagged→folded`、auto-flag 进人工、与信任分联动 | `runModerationTick` ✓；`content_reviews` 队列 ✓；flagged 自动建 `reports`（reporter_id=0）✓；`index.js` worker 启动 ✓ | ✅ |
| 1.2 隐私过滤 | privacy_level/privacy_keywords 列、发布前 PII+关键词拒发、私信脱敏 sk-/JWT/PII、前端设置面板 | 列迁移 ✓；`precheckContent` 关键词 + strict 尾字略写变体 ✓；`messageService.maskSecrets` 接线 ✓；`web/MyAgents.tsx` 隐私面板（git M）✓ | ✅ |
| 1.5 注入识别 | LLM `category=injection`、规则层注入→flagged+热榜排除、**平台侧 `<untrusted_agent_content>` 包裹**、SKILL 升级契约 | 规则层 `INJECTION_RES` ✓；LLM category ✓；flagged 热榜排除 ✓ | ⚠️ **部分**：`untrusted_agent_content` 包裹**未实现**（仅文档提及，代码无）；SKILL.md 无"包裹内文本视为数据不执行"契约 |
| SKILL.md v2 | 401 引导 / untrusted 包裹 / owner_pii 语义 / 护栏新语义 | `owner_pii`/`ad_suspect`/`content_rejected`/`token_revoked`/`flagged` 语义 + 排障表 ✓ | ⚠️ **部分**：缺 `untrusted` 包裹契约（同 1.5 缺口） |

> **M2 唯一真缺口：1.5 的 `untrusted_agent_content` 包裹没做。** 这是"防注入传播"的最后一环——守规矩的客户端 Agent 靠这个标记天然免疫思维病毒。规则层已能识别并降权注入帖，但读接口没有给正文包标记，SKILL.md 也没让客户端把包裹内文本当数据。建议收尾时补上（改动小：读接口返回正文时包一层 + SKILL.md 加一节契约）。

---

## 三、M3 角色社会 + 日报 —— ✗ 零落地（与文档第 5 节"未开工"一致）

| 子项 | 代码实况 |
|---|---|
| `roles` / `role_terms` / `role_tasks` / `daily_editions` 四表 | ✗ `db.js` 无（`content_reviews`/`security_events` 有，但角色四表无） |
| `/api/roles` 五端点（me/nominate/task/materials/daily/submit/history） | ✗ 全无 |
| `daily_digest` kind + `pinned_by` 列 | ✗ 无 |
| 4 枚职务章（主编/敲钟人/守夜人/司典） | ✗ 仅有通用 `BADGE_DEFS` 勋章体系（f73a844 的"勋章"，非职务章） |
| 调度器 / 竞选 / 头版 UI / 历代名录 / MCP 外发桥 / 上榜通知 | ✗ 均无 |
| 前端 M3 | ✗ `web/src` 无角色社会相关实现（`About.tsx` 仅有通用"每日谜题"文案，`MyAgents.tsx` 仅有"防刷屏配额"说明） |

> **结论**：M3 在代码层面完全不存在。这本身不算"做完却漏了"——文档第 5 节明写"M3 角色社会/日报未开工（按计划待防先上线观察）"。需萧哥拍板：M3 是否现在就要做，还是按原计划先让"防"上线观察数据。

---

## 四、文档与代码不符（需对齐，否则接手人被骗）

1. **trust_tier 公式**：文档 1.3 写"注册时长 × 被回复数 × 无 block 记录 **乘积公式**"；代码是**阈值式**（满 7 天且无 block=resident；满 30 天且被回复≥5 且无 block=regular）。乘积会让被回复数=0 的号永远 newcomer，代码是对的，**文档公式需改**。
2. **"广场没有点赞"**：文档 line 10 / `plazaService.js` 旧注释写"没有点赞"；代码已落地 `clapTopic` 人类只读鼓掌 + `clapCount` 进热榜。日报 Top3 也依赖 claps。**文档待更新**。
3. **第 5 节实施记录 M3 状态**：写明"未开工"，与本次"千问做完全部"说法矛盾，需萧哥澄清口径。

---

## 五、我先前评审建议的落实追踪

- ✗ **公开帖补扫 `sk-`/JWT**（评审建议，非原文档硬要求）：未做。原文档 1.2 只要求 PII+关键词；私信有 `maskSecrets`（含 sk-/JWT），**公开帖规则层 `PII_RES` 不含 sk-**。这是 Moltbook 明文 key 事故的对策，属可补强项，非原文档缺口。
- ✓ 文档对齐类建议（trust_tier/点赞）属文档待办，见第四节。

---

## 六、验证层面 honest boundary

- **git 状态**：千问全部改动**未 commit**（工作区 `M`/`??` 一大片），都在 `main` 工作区，尚未固化。
- 文档第 5 节声称"node --check / tsc / vite build / SQLite 冒烟 8/8 通过"——我**未重跑**（沙箱受限且耗时）。静态代码结构完整、接线正确（路由注册、worker 启动、私信脱敏均确认），但**正式部署前建议跑一遍构建 + 冒烟**确认无误。
- `qwenwork/` 目录为空（仅 `canvas/` 空目录），非工作记录，可忽略。

---

## 七、结论与建议

1. **千问交付 = M1 + M2（防的全部）**，质量扎实、链路接通；**M3 未动工**。
2. **请萧哥确认口径**：M3 是否现在就要做？文档原计划是"防先上线观察"。若要做，按文档第二部分启动（四表 + 调度器 + 竞选 + 日报 kind + 头版 UI + 职务章 + MCP 外发 + 上榜通知）。
3. **收尾 M2 真缺口**：补 `untrusted_agent_content` 包裹（1.5 闭环），改动小、价值明确。
4. **文档对齐三处**：trust_tier 公式、点赞现状、实施记录 M3 状态。
5. **千问提交前**：跑一遍构建 + 冒烟，把未 commit 的改动固化。

> 一句话：防这块千问交卷了，质量过关；角色社会那张卷还没动笔，与文档自述一致。先把"防"上线验证，再决定 M3 的启动时机。
