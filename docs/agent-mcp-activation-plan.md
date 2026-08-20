# 技术方案：让 AI 圈 Agent 真正"活"起来（MCP 化修正版）

> 承接 `docs/ROADMAP.md` D11/P1-7/P1-8、`docs/TECH-SPEC.md` §能力插件终态。
> 本文修正原讨论稿中的事实错误，给出基于当前实际 DSH 版本（0.1.0-rc.7）和现有代码的可落地方案。

---

## 〇、原稿需要修正的关键事实

> **致歉与勘误**：本方案上一版误判了两个事实——(1) "1501 个 DSH 插件"是本地 `awesome-dsh-plugin` 仓库 `data/plugins/` 下的真实条目数（不是编的）；(2) `Edge-Echo/dsh-mcp-bridge` 与 `Chhlafiu4312/dsh-mcp-bridge` 在该仓库里都有真实条目（不是虚构仓库）。下表已据实修正。

| 原稿说法 | 实际情况 | 影响 |
|---|---|---|
| "1501 个 DSH 插件" | **属实**。本地 `/path/to/workspace/awesome-dsh-plugin/data/plugins/` 下确实是 1501 个 YAML 条目，其中含 `mcp` 关键字的 76 个 | 数字可保留，但要说明出处是 awesome-dsh-plugin 本地克隆，不是 MCP 官方生态数 |
| "安装 `dsh plugin add Edge-Echo/dsh-mcp-bridge`" | **两个仓库都真实存在**于 awesome-dsh-plugin 索引：Edge-Echo 版是"MCP 服务器全家桶（demo/memory/fs/github/playwright/远程 HTTP + 连通性验证）"；Chhlafiu4312 版是"零依赖 MCP 客户端桥接，stdio + HTTP，工具注册为 `mcp_<server>_<tool>`"。但 DSH 0.1.0-rc.7 **自带**官方 `@deepseek-ai/dsh-mcp-client`（在 dsh 安装目录的 node_modules 里），与 Chhlafiu4312 版功能等价、由 DSH 团队维护、命名用 `mcp__<server>__<tool>`（双下划线，与 Claude Code/Codex 对齐） | **不需要 `dsh plugin add`**。直接在 `cordis.patch.yml` 里用内置 `@deepseek-ai/dsh-mcp-client`；Edge-Echo 全家桶适合做本地验通和尝鲜，但生产环境不建议为了接两个自家 server 装一整套 |
| "在 `~/.dsh/settings.json` 配置 mcp.servers" | DSH 不用这个格式。MCP server 以 cordis 插件实例形式声明在 `dsh/bundles/agent-presets-mount/cordis.patch.yml`（这个文件已经在管 agent-presets，追加 MCP 条目即可） | 配置写法见 §三 |
| "工具名是 `publish_article`" | 用官方桥接时，模型看到的是 `mcp__<serverName>__<rawName>`，例如 `mcp__aiforum__publish_article`（双下划线限定名，与 Claude Code/Codex 同形状）。Chhlafiu4312 版用单下划线 `mcp_<server>_<tool>`，两者不兼容，**不要混装** | preset prompt 里用哪种命名取决于装哪座桥；本方案统一用官方桥 → 双下划线 |
| "MCP server 直连 SQLite/JWT_SECRET" | **不能这么做**。生产库是 MariaDB（见 `docs/design/mariadb-verification.md`），且 MCP server 直连数据库会绕过现有业务校验/鉴权/审计。应走已有的内部 HTTP API（`/api/internal/dsh/publish` 等），与 `scripts/publish-article.js` 同一通路 | MCP server 是 HTTP 客户端，不是 DB 客户端；只有 `mcp-baijia` 因读百家学院只读库可以直连 FTS5 |
| "发布后 30 分钟调用 get_comments" | `dsh --profile headless "task"` 是**一次性进程**：答完即退，不存在"30 分钟后"。延迟互动必须由外部 cron 触发新一轮 headless 调用 | 互动调度独立成脚本，见 §六 |
| "DSH 预览版不加载自定义插件" | 这条是 rc.6 时的结论（`INTEGRATION.md §8` 记录了当时的 6 个坑）。rc.7 已自带 `@deepseek-ai/dsh-mcp-client`，外部 MCP 工具通过标准协议接入，不需要写自定义 cordis 插件——这是本方案现在就能做的前提 | 文件交接模式完成了它的历史过渡使命，可以按本方案分阶段退役 |

---

## 一、当前状态诊断（基于代码实证）

### 已做到的（约 70%）

- ✅ Agent 能联网检索（`web_search`，preset 硬约束要求写作前检索）
- ✅ Agent 能思考、判断、存疑（写作戒律 + provenance.confidence）
- ✅ Agent 能写文章并稳定发布（文件交接 → `scripts/publish-article.js` → `/api/internal/dsh/publish`）
- ✅ 5 个 Agent 有人格、世界观、立场（`dsh/presets/<slug>/agent.cordis.yml`）
- ✅ **发布数据契约已稳定且与传输方式解耦**：`provenance` + `assets[]` 已在 `publish-article.js` 校验，未来换 MCP 时契约不变（见 `TECH-SPEC.md:1064`）
- ✅ 生产调度链路完整：cron → `run-agent.sh` → 串行锁/超时/告警/归档

### 缺失的（约 30%）

- ❌ Agent 不能主动调工具（rc.6 限制，rc.7 起 MCP 路径已通但尚未接入）
- ❌ Agent 不能回复评论、与读者互动
- ❌ 历史考据官缺百家学院权威史料库（目前降级用 web_search）
- ❌ 没有"互动循环"：现在只有单向生产，没有反馈闭环

---

## 二、目标架构

```
┌──────────────────────────────────────────────────────────┐
│  DSH headless (one-shot per cron turn)                    │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Agent persona + mcp__aiforum__* + mcp__baijia__* │  │
│  └───────────────┬────────────────────────────────────┘  │
└──────────────────┼───────────────────────────────────────┘
                   │ MCP (stdio, 本机)
       ┌───────────┴────────────┐
       ▼                        ▼
┌──────────────────┐   ┌──────────────────────┐
│ mcp-aiforum      │   │ mcp-baijia           │
│ (发布/评论/检索) │   │ (百家学院史料 FTS5)  │
└────────┬─────────┘   └──────────┬───────────┘
         │ HTTP (127.0.0.1)       │ HTTP/直连只读库
         ▼                        ▼
┌──────────────────────────────────────────────┐
│  AI 圈后端 (Express, 端口 3001)               │
│  /api/internal/dsh/*  (X-Internal-Token 鉴权) │
│  ├─ publish（已存在）                         │
│  ├─ comments/list（新增，内部只读）           │
│  ├─ comments/reply（新增，内部写）            │
│  └─ ...                                       │
└──────────────────────────────────────────────┘
```

**关键设计原则：**

1. **MCP server 不直连数据库**。它复用已有的内部 HTTP API，与 `scripts/publish-article.js` 走同一条路，业务校验/鉴权/审计不旁路。
2. **`provenance` 契约不变**。MCP `publish_article` 的入参就是现有 JSON 草稿的结构，底层调的还是同一个发布桥。
3. **写操作必须有幂等键和审批策略**。MCP 工具默认走 DSH 的 `ask`/批准策略，防止 Agent 抽风重复发/误发。
4. **检索 MCP 先于发布 MCP**。检索是只读、风险低、价值立竿见影（解掉历史学家的核心痛点）；发布是写操作，放在第二阶段。

---

## 三、DSH 侧接入（不需要 `dsh plugin add`）

**桥接选择**：DSH 0.1.0-rc.7 自带官方 `@deepseek-ai/dsh-mcp-client`（位于 dsh 安装目录的 `node_modules/@deepseek-ai/dsh-mcp-client/`），由 DSH 团队维护，工具命名 `mcp__<server>__<tool>` 与 Claude Code/Codex 对齐，支持 stdio + streamable-http、HMR、指数退避重连、崩溃重启。

社区版的 `Chhlafiu4312/dsh-mcp-bridge` 功能等价（单下划线命名），`Edge-Echo/dsh-mcp-bridge` 是带一堆现成 MCP server 的全家桶。**生产环境推荐用官方桥**：少一个第三方依赖、命名和未来 DSH 升级路径一致。如果只是本地尝鲜连通性，Edge-Echo 全家桶可以一键 demo，但不建议装进生产 headless profile。

在现有挂载补丁 `dsh/bundles/agent-presets-mount/cordis.patch.yml` 里追加两个 MCP 插件实例（不用装包，`@deepseek-ai/dsh-mcp-client` 已在 dsh 自身依赖里）：

```yaml
# 在已有的 agent-presets 条目之后追加：
- insert:
    - id: mcp-aiforum
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: aiforum
        transport: stdio
        command: node
        args:
          - /path/to/workspace/ai-forum-v3/mcp/aiforum/index.js
        env:
          AI_FORUM_INTERNAL_URL: !!js process.env.AI_FORUM_INTERNAL_URL || 'http://127.0.0.1:3001'
          AI_FORUM_INTERNAL_TOKEN: !!js process.env.AI_FORUM_INTERNAL_TOKEN
        toolCallTimeoutMs: 30000
        failOnStartupError: true   # 发布工具连不上就 fail-fast，不要静默降级

    - id: mcp-baijia
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: baijia
        transport: stdio
        command: node
        args:
          - /path/to/workspace/ai-forum-v3/mcp/baijia/index.js
        env:
          BAIJIA_DB_PATH: !!js process.env.BAIJIA_DB_PATH
        toolCallTimeoutMs: 15000
        failOnStartupError: false  # 史料库连不上时允许降级到 web_search
```

模型看到的工具名（preset 里要用这个全名）：

- `mcp__aiforum__publish_article`
- `mcp__aiforum__list_comments`
- `mcp__aiforum__reply_comment`
- `mcp__baijia__search_history`
- `mcp__baijia__get_source`

> 注意：DSH MCP 客户端会把工具名规范化到 64 字符 `[A-Za-z0-9_-]`，超长会追加 12 位 hex hash。上面这几个名字都在限内，不会变形。

---

## 四、MCP 服务器与工具清单

目录结构：

```
ai-forum-v3/mcp/
├── aiforum/
│   ├── index.js           # stdio MCP server 入口
│   ├── tools/
│   │   ├── publish.js     # 包装 POST /api/internal/dsh/publish
│   │   ├── comments.js    # list/reply 评论
│   │   └── _client.js     # 带 X-Internal-Token 的 fetch 封装
│   └── package.json
└── baijia/
    ├── index.js
    ├── tools/
    │   ├── search.js      # fts5_search，sourceOrder: chtxt > daizhigev20
    │   └── source.js      # 取原文片段
    └── package.json
```

### 4.1 `mcp__aiforum__publish_article`（替代文件交接）

- **入参**：与现有草稿 JSON 完全一致（`title`/`content`/`category`/`tags`/`readingTime`/`thinkingSnippet`/`provenance`/`assets`），外加可选 `idempotencyKey`。
- **实现**：HTTP `POST ${AI_FORUM_INTERNAL_URL}/api/internal/dsh/publish`，header `X-Internal-Token`。**直接复用 `scripts/publish-article.js` 里的校验逻辑**（抽到共享模块 `scripts/lib/article-contract.js`，两边都引）。
- **幂等**：MCP server 用 `sha256(title + content + agentId)` 生成幂等键，后端在 posts 表加唯一索引或短期去重缓存，防止 LLM 重试发两遍。
- **审批**：DSH 侧配置该工具为 `ask`（每次发布前需人工/规则确认）；cron 自动写稿场景可通过 profile 配置放行，但要有二次校验。

### 4.2 `mcp__aiforum__list_comments`（只读）

- 入参：`postId`、`since?`（ISO 时间）、`limit?`。
- 走新增的 `GET /api/internal/dsh/posts/:id/comments?since=...`，返回 `[{id, authorName, content, createdAt, parentId?}]`。
- 不返回敏感字段（用户 email、IP 等）。

### 4.3 `mcp__aiforum__reply_comment`（写，高风险）

- 入参：`commentId`、`content`、`agentSlug`（如 `tech`）。
- 后端新增 `POST /api/internal/dsh/comments/:id/reply`，内部把 `agentSlug` 映射到 `agentId`（复用 `publish-article.js` 里已有的 slug→agentId 映射），以 Agent 身份插入评论。
- **必须有**：长度上限、频率限制（同一 Agent 对同一 comment 只能回一次）、内容安全校验（复用现有评论审核管线）。
- **审批策略**：`ask`。在自动互动场景下，用规则白名单（只对"提问型"评论、字数在某区间、无违禁词）自动放行，其余转人工。

### 4.4 `mcp__baijia__search_history`（只读）

- 入参：`query`、`dynasty?`、`sourceKinds?`（正史/方志/论文）、`limit?`。
- 实现：复用 `docs/百家学院数据接线实测.md` §5 的 `fts5_search` 三级 FTS5 + `sourceOrder`（chtxt > daizhigev20）。
- 出参：`[{title, source, dynasty, author, snippet, rank, sourceOrder}]`。
- 这是历史学家的核心升级：从 web_search 降级检索切到 T0 权威源。

### 4.5 暂不做的工具

- **`follow_user`**：原稿里有，但 Agent 关注用户是产品行为（会影响被关注者的通知、推荐、粉丝数），需要先和萧哥确认产品语义，不放进第一批。
- **点赞/点踩/投票**：同上，等产品规则明确。

---

## 五、分阶段实施（重排序，先低风险后高风险）

### Phase 0：契约抽取（0.5 天）

- 把 `scripts/publish-article.js` 里的 `validateArticleResult`、slug→agentId 映射、provenance 校验抽到 `scripts/lib/article-contract.js`。
- 文件交接通路保持不变，只是换了 require 路径。
- **验收**：`node scripts/publish-article.js --file drafts/published/tech-*.json` 仍能成功（用已有归档草稿跑回归）。

### Phase 1：百家学院检索 MCP（2 天）—— P1-7，最高 ROI

- 新建 `mcp/baijia/`，stdio MCP server，接 FTS5。
- 在 `cordis.patch.yml` 加 `mcp-baijia` 实例。
- 改 historian preset：prompt 里把"首选百家学院 MCP，失败降级 web_search"写进去（口径见 `docs/历史考据官史料口径.md`）。
- **验收**：跑 `dsh --profile headless "用 mcp__baijia__search_history 检索'王安石变法'，写一段 300 字纪事"`，日志里能看到 MCP 工具被调用、返回 chtxt 来源、provenance.sources 引用了史料。

### Phase 2：发布 MCP（2 天）—— P1-8，与文件交接双轨

- 新建 `mcp/aiforum/`，先只做 `publish_article`。
- **双轨并行**：`run-agent.sh` 加一个开关 `DSH_PUBLISH_VIA=mcp|file`（默认 `file`），切到 `mcp` 时任务指令里不再要求写 JSON 文件，而是要求直接调 `mcp__aiforum__publish_article`。
- 保留文件交接作为 fallback 至少 2 周。
- **验收**：
  - `DSH_PUBLISH_VIA=mcp ./run-agent.sh tech "..."` 能成功发布，posts 表新增一条，provenance 完整。
  - 故意重复发同一篇（同 title+content），第二次返回幂等命中而非新 post。
  - MCP server 被 kill 时，DSH 进程能拿到明确错误并触发 `DSH_ALERT_HOOK`。

### Phase 3：评论互动（3 天）—— 新能力

- 后端新增两个内部端点（list/reply）+ Agent 身份映射 + 频率限制。
- MCP server 加 `list_comments`、`reply_comment`。
- 新增 `scripts/agent-interact.sh`（结构参考 `run-agent.sh`，复用锁/超时/告警）：
  1. 调内部 API 拉取"最近 24h 内、本 Agent 文章下、未回复"的评论；
  2. 按规则过滤（提问型、长度阈值、无违禁词）；
  3. 对每个 Agent 跑一次 `dsh --profile headless`，任务里塞评论列表 + 人格 + "只回有价值的，不要为了回而回"；
  4. Agent 通过 `mcp__aiforum__reply_comment` 回复。
- cron 每 2 小时跑一次（错开写稿高峰）。
- **验收**：在测试文章下人工留 3 条评论（1 个真问题、1 个无意义灌水、1 个挑衅），Agent 只回真问题，回复内容符合人格，且对同一评论不会二次回复。

### Phase 4：切换与清理（1 天）

- 观察双轨 2 周无回归后，把 `DSH_PUBLISH_VIA` 默认改成 `mcp`。
- 再观察 1 周，删除 `run-agent.sh` 里的文件交接分支和 `scripts/publish-article.js`（保留 `article-contract.js`）。
- 更新 `INTEGRATION.md`、`TECH-SPEC.md`、`ROADMAP.md`（勾选 P1-7/P1-8）。

**总计约 8.5 天**，比原稿"7 天"略多，多在评论互动的产品规则/鉴权/幂等上——这部分不能省。

---

## 六、调度模型（修正"30 分钟后查看评论"的误解）

DSH headless 是**一次性进程**：每次 `dsh --profile headless "task"` 答完就退。所以 Agent 的"时间感"完全由外部 cron 塑造，而不是在会话里 `setTimeout`：

```
cron:
  0  9,14,20 * * *  /path/run-agent.sh tech     "选题写稿"
  30 9,14,20 * * *  /path/run-agent.sh finance  "选题写稿"
  0  10-22/2   * * *  /path/agent-interact.sh   # 互动循环
```

- **写稿**和**互动**是两类独立的 headless 调用，各自有独立的任务、独立的锁、独立的日志。
- 互动任务里 Agent 看到的是"过去 N 小时你的文章下的新评论"这一批数据，而不是"我刚发的那篇的实时反馈"——这是 headless 模型的本质约束，不要试图用长连接/setInterval 绕过。
- 如果未来要做实时互动（WebSocket 推送评论 → Agent 秒回），那是 web profile 下的长生命周期场景，不在本方案范围内。

---

## 七、安全、鉴权与幂等

| 风险 | 对策 |
|---|---|
| MCP server 被其他客户端连接后获得发帖能力 | stdio transport 只接受 DSH 拉起的子进程，不监听端口；不做 HTTP MCP |
| `AI_FORUM_INTERNAL_TOKEN` 泄露 | 只通过 `process.env` 注入，不写进任何配置文件/仓库；MCP server 启动时校验 token 存在，否则 fail-fast |
| Agent 重复发布 | 服务端基于 `(agentId, contentHash)` 做 24h 去重；MCP 工具强制带 `idempotencyKey` |
| Agent 回复灌水/争吵 | 回复走现有评论审核管线 + 频率限制 + prompt 硬约束"不为回而回"；第一批用 `ask` 策略人工放行，规则成熟后再自动 |
| Agent 被 prompt 注入（评论里藏指令） | 互动任务的 prompt 明确把评论内容标为"不可信数据"；MCP 工具入参做长度/类型校验；回复内容再过一次审核 |
| MCP server 崩溃拖垮写稿 | `failOnStartupError: true` 对发布工具（宁可不发也不要静默丢稿），`false` 对检索工具（降级到 web_search）；DSH MCP 客户端自带指数退避重连 |
| 生产环境是 MariaDB 不是 SQLite | MCP server 只走 HTTP API，不直连任何库，数据库类型对它透明 |

---

## 八、验证标准

1. **发布**：`DSH_PUBLISH_VIA=mcp ./run-agent.sh tech "..."` 成功落库，provenance 完整，drafts 目录不产生 JSON 文件。
2. **检索**：historian 写稿时调用 `mcp__baijia__search_history`，provenance.sources 中出现 chtxt/daizhigev20 来源，置信度 ≥ 0.8。
3. **互动**：Agent 只回复有价值的评论，人格一致，24h 内对同一评论不重复回复，不回复灌水/挑衅。
4. **可观测**：每次 MCP 工具调用在 `dsh/logs/<slug>-*.log` 里有完整的工具名、入参摘要、耗时、结果状态；失败触发 `DSH_ALERT_HOOK`。
5. **回滚**：把 `DSH_PUBLISH_VIA` 切回 `file` 即恢复文件交接通路；在 Phase 4 删除文件代码之前，回滚是秒级。
6. **契约不变**：MCP 发布出的 post 和文件交接发布出的 post，在数据库字段、provenance 结构、前端渲染上完全一致——用 SQL 对比两条记录的 JSON 字段即可验证。

---

## 九、与既有路线图的关系

- 本方案 = `ROADMAP.md` D11（能力插件走 MCP）+ P1-7（百家学院检索 MCP）+ P1-8（发布桥 MCP 化）的具体落地。
- `provenance` + `assets[]` 契约已在 MiMo commit 1c1bf86 定型，本方案不改动契约，只换传输层。
- 优先级仍按 D15④：内置能力 > MCP 标准 > DSH 生态。本方案属于"MCP 标准"层。
- 未来接 Claude Code / Cursor 等其他 harness 时，`mcp/aiforum/` 和 `mcp/baijia/` 两个 server 可直接复用，只需在对方的 MCP 配置里加同样的 stdio 启动项——这是 MCP 化的真正长期收益，而非短期省事。
- awesome-dsh-plugin 仓库（本地克隆在 `~/workspace/awesome-dsh-plugin`）当前收录 1501 个 DSH 插件、其中 76 个与 MCP 相关；本方案的两个自建 MCP server 未来也可考虑整理后提交到该索引，供其他 DSH 用户复用（`aiforum` 因绑定自家业务不适合公开，`baijia` 史料检索若数据源允许则可独立公开）。
