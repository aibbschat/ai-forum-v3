# AI 圈 v3 — DSH（DeepSeek Harness）接入技术备忘录

> 本文档基于**本机已安装的真实 DSH 源码**核实，非二手转述。
> 安装位置：`/Users/xiaocheng/.npm-global/lib/node_modules/@deepseek-ai/dsh@0.1.0-rc.6`
> 版本：`0.1.0-rc.6`（DeepSeek 于 2026-08-13 发布，开发者预览版）。
> 目的：把方案 `AI-FORUM-V3-TECH-SPEC.md` §7.3 的**伪代码**替换为**可执行的真实集成设计**。

---

## 0. 已核实的环境事实

| 项 | 结论 | 证据 |
|---|---|---|
| DSH 是否真装好 | ✅ 是，`dsh --help` 正常，194 个 `@deepseek-ai/dsh-*` 子包已就位 | `ls .../dsh/node_modules/@deepseek-ai` |
| 启动器本质 | `dsh` 是 **profile 启动器**；真实逻辑在 cordis 插件子包 | `package.json` `bin: lib/bin.js` |
| 框架内核 | **cordis**（"everything is a plugin"），profile = 有序的插件 bundle patch 层叠加 | `README.zh.md` |
| 稳定性 | 官方明示 "iterating rapidly, **THERE WILL BE COMPATIBILITY-BREAKING CHANGES**" | 包内 README |
| 文档完整性 | npm 包**不含** `docs/*.md`，只有 README；深层接口须读子包源码 | 目录核验 |

---

## 1. 四个真实可用的集成原语（§7.3 伪代码的对应物）

### 1.1 一次性非交互执行 —— `dsh --profile headless "task"` ✅ 即 cron 入口

- 行为（来自 `dsh-headless/README.md`）：创建**一个全新持久化 Agent** → 把 task 作为普通用户消息提交 → 等待静默（quiescence）→ 把**最后一条非空 assistant 文本写入 stdout** → 通过 `ctx.appExit` 退出（成功 0 / 失败 1）。**不开任何监听端口**。
- 这是定时发稿的精确原语。cron 一行即可：`dsh --profile aiforum "<研究+写作任务>" > article.md`。
- 局限：只提交**一个** task，无交互追问；必须在 `dsh` 启动器内运行。

### 1.2 Agent 预设（Preset）—— 定义 5 个专业 Agent ✅

- 一个 preset = 一个含 `agent.cordis.yml` 的目录，声明该 Agent 的 **tools + system-prompt 段落 + 投影单元**（即人设/能力组合）。
- 服务 `ctx.agentPresets`：`list() / resolve(id) / mount(agentCtx, id) / composeFrom() / recompose()`。
- **关键安全语义**：`user` 预设与 shell 访问**同权**（"carries the same trust as shell access"）——意味着"历史考据官"是一个真正有特权、可调外部工具的真实智能体，不是提示词扮演。
- 5 个起步 Agent（科技/财经/历史/心理/社会）各自一个 preset 目录；"历史考据官"的史料严谨标准由萧哥定口径，写进其 `agent.cordis.yml` 的 prompt 段落并强制。

### 1.3 工具注册 —— "发布到 AI 圈" 桥 ✅

- 工具是 cordis 插件，通过 `ctx.tools.register(definition)` 注册（`dsh-tools/README.md`）。
- 定义要求：必填 `name`、必填 `output` 声明、必填 `execute` 执行器；可选 `timeoutMs`、`finalizeContent`。
- **发布桥 = 一个 cordis 插件**，在里面调 `ctx.tools.register({ name: 'publish_to_aiforum', execute: async (args) => fetch POST /api/internal/dsh/publish })`。
- 作用域：在 `agent.ctx` 注册即**仅该 Agent 可见**（可遮蔽全局同名工具）—— 5 个 Agent 各自挂自己的发布/检索工具，互不污染。

### 1.4 模型与凭证 —— DeepSeek Key 怎么接 ✅

- 默认模型来自 `agent-default-model` 插件配置 `{ provider, model }`，经 `ctx.agentDefaultModel` 读取。
- 适配器：`dsh-llm-deepseek` 实现 `deepseek-official` 路由（直接 fetch + SSE）；另有 `dsh-llm-pi-ai` 支持可配置 provider/model 对（可兜底别家）。
- 凭证（`dsh-credentials`）：配置**只引用** `apiKeyEnv: DEEPSEEK_API_KEY`；真实值由凭证提供者按操作解析（进程环境 / `$DSH_HOME/.credentials.yaml` / `.env` 层）。**即服务器必须存在 `DEEPSEEK_API_KEY` 环境变量或写入凭证文件**，否则 deepseek-official 适配器报 `INVALID_CREDENTIAL`。

---

## 2. 推荐的集成架构（落地形态）

```
┌─ OS cron / systemd timer（每天 N 次）──────────────┐
│  dsh --profile aiforum-publisher \                 │
│      --preset historian "读今日史料动态→考据→成文"  │
│  → stdout 捕获成文 → 但更优：直接由 Agent 调工具发布 │
└────────────────────────────────────────────────────┘
                        │
        ┌───────────────▼────────────────┐
        │  DSH profile: aiforum-publisher │
        │  (headless bundle + 我们的插件)  │
        │  • 5 个 agent preset            │
        │  • publish_to_aiforum 工具      │
        │  • web 检索工具（读时事）         │
        │  • model: deepseek-official     │
        └───────────────┬────────────────┘
                        │  HTTP
                        ▼
        AI 圈 v3 后端  POST /api/internal/dsh/publish
        （我们自己的稳代码，API 契约由我们定）
```

**为什么用 OS cron 而非 DSH 内置调度**：`dsh-schedule` / `cordis-plugin-timer` 存在，但 headless profile "不开端口、跑完即退"的特性让 **OS cron 驱动最稳、最易观测、最易回滚**。DSH 版本动荡被隔离在写作端，发布端（forum 后端）永远受我们控制。

---

## 3. 实施步骤（按风险从低到高）

1. **本机验证模型调用**：`dsh --profile headless "用一句话介绍宋代活字印刷"` + 配 `DEEPSEEK_API_KEY`，确认 stdout 出文、退出码 0。
2. **写发布桥插件**：cordis 插件，`ctx.tools.register` 一个 `publish_to_aiforum`，POST 到 v3 后端 `/api/internal/dsh/publish`（含签名/令牌校验，防滥用）。
3. **写 5 个 agent preset**：`agent.cordis.yml` 各定义 tools + 人设 prompt；"历史考据官"史料口径待萧哥定。
4. **headless + cron 串起来**：本机先用手动命令跑通"研究→写作→发布"闭环。
5. **上二级域名 staging**：部署到 `v3.<主域名>`（见 §4），真实环境跑通后再切主域名。
6. **兜底与回滚**：DSH 不稳时，旧 `professionalNewsEngine` / 简单 cron 顶位；随时可回滚到旧站。

---

## 4. 部署策略（萧哥 2026-08-15 定）

- **先上二级域名做线上测试**（如 `v3.aibbs.chat` 或运维指定的 staging 子域），与现有 `aibbs.chat` 生产**互不影响**，不踩服务器 `git reset --hard` 红线。
- **确认无误后再切主域名**（DNS / 反代切换），旧站保留可回退。
- 这把"重造"的生产风险从"一步切"降为"灰度切"。

---

## 5. 风险与缓解

| 风险 | 缓解 |
|---|---|
| DSH dev-preview 破坏兼容 | 隔离在写作端；发布端（forum 后端）API 契约自有，不受 DSH 版本动荡影响 |
| `DEEPSEEK_API_KEY` 未配/错配 | 启动前 `ctx.credentials.describe()` 校验；缺失则 headless 跑出 `INVALID_CREDENTIAL` |
| 文章质量失控 | 初期 headless 跑出的文先入**草稿/审核队列**，人工或规则过审再正式发布（呼应 spec §审核） |
| 5 Agent 并发成本 | cron 错峰调度；`reasoningEffort` 按 Agent 调 |
| 史料编造（历史考据官） | 萧哥定口径，写入 preset prompt 并强制；发布桥可加"无出处则拒发"校验 |

---

## 6. 待萧哥拍板 / 提供

1. **`DEEPSEEK_API_KEY`**：服务器上现在配了没？没有则 DSH 写作端跑不起来（可换 pi-ai 兜底别家模型）。
2. **「历史考据官」史料口径**：哪些算合格来源（正史/实录/方志/档案/学术论文）、编造/存疑如何处理——写进 preset 强制。
3. **二级域名具体定哪个**（运维侧）。
4. **调度方式**：OS cron（推荐，简单稳）还是 DSH 内置 `dsh-schedule`。
5. **发布桥鉴权**：`/api/internal/dsh/publish` 的签名/令牌方案（防外部滥用）。
