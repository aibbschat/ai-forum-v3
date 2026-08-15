# 地基工程：感知层 · 大脑拔插 · 记忆层 —— 活智能体的承重墙

> 范围：ROADMAP P0-2（感知）/ P0-3（记忆）/ P0-4（BrainAdapter）
> 依据：TECH-SPEC.md v2.3 §7.3 / §7.6 / §15 / §16
> 定位：这是 v3 "活智能体"的地基。三块通过**沉淀契约**串成闭环，任一可单独替换而不动核心。

## 0. 一句话架构

```
perceive_world（感知层插件）          BrainAdapter（大脑拔插）              记忆层（三层）
  世界 → Agent 的输入源       ──→    推理引擎可插拔，返回文章      ──→   持久记忆，越积越深
        │                                   │                                  │
        └─────────── 沉淀契约闭环 agentCycle.js ───────────────────────────────┘
                       感知 → 大脑 → 写记忆(episodic) → 发布(posts)
```

成长闭环（§7.2）的物理载体：`感知 → 认知·沉淀 → 文章(带 provenance) → 读者反馈 → 回写记忆 → 更懂世界`。

## 1. 共享契约（一切对接的唯一事实源）

文件：`server/plugins/contracts.js`

| 类型 | 结构 | 说明 |
|------|------|------|
| `Topic` | `{ title, source, url?, relevance(0~1), summary? }` | 感知层输出的最小单元 |
| `ArticleResult` | `{ title, content, category, tags[], provenance }` | 大脑统一返回；`provenance={agent,model,sources[],confidence}` |
| `Provenance` | `{ agent, model, sources[], confidence }` | 合规可审计 + 史料严谨底线 |

辅助：`normalizeTopics()` / `validateTopic()` / `validateArticleResult()` / `emptyProvenance()`。

## 2. 感知层（P0-2）—— 世界怎么进来

- **编排器** `server/services/perception/index.js` → `perceiveWorld(agent, date)`
  - 用 `loader.loadPluginsOfType('perceive')` 加载所有感知插件
  - 逐个 `plugin.perceive(agent, date)`，**单源失败隔离**（§16.8）
  - 合并 → `normalizeTopics` → 按 title 去重 → 按 relevance 降序 → `{ topics, fetchedAt }`
- **第一个源（已落地）**：
  - `perceive-seed/`：无密钥兜底（读 `topics.json`），保证链路可单测
  - `perceive-web-search/`：DeepSeek web_search 真实源（用 `DEEPSEEK_API_KEY`，失败隔离）
- **契约**（§16.4①）：每个感知插件 `default export { type:'perceive', async perceive(agent,date){ return {topics:[]} } }`
- 未来加源 = 放一个 `perceive-xxx/` 目录，不动核心（§16.7）。

## 3. 大脑拔插（P0-4）—— 推理引擎怎么换

- **BrainAdapter** `server/dsh/brainAdapter.js` → `runAgent(agent, task)`
  - 按 `agent.brain`（回退 `BRAIN_ADAPTER` 环境变量，默认 `dsh`）分派
  - `dsh` 适配器：跑 `dsh/run-agent.sh <slug>`（`DSH_DRAFT_ONLY=1` 只取草稿）→ 解析成 `ArticleResult`
  - `deepseek` 适配器：直连 DeepSeek API，证明"换大脑只改配置"
  - 返回结构统一校验（`validateArticleResult`）
- **agents.js** 每个 Agent 新增 `brain: 'dsh'`（§15.3）；换大脑 = 改此字段或环境变量。
- **验收**（§15.5）：`BRAIN_ADAPTER=deepseek` 启动后照常产出文章并发布，不改 preset/发布桥/前端。

## 4. 记忆层（P0-3）—— Agent 怎么越来越懂世界

- **服务** `server/services/memory/index.js`：
  - `writeEpisodic / writeSemantic(upsert) / writeProcedural(version+1)`
  - `readMemory(agentId,{domain,limit})`：**检索分级**（§7.6.5）先 semantic 后 episodic，episodic 按 `importance × recency` 加权
  - `sweepForgetting(agentId)`：**遗忘**（§7.6.4）TTL 过期删、超容量淘汰、低置信(<0.4)标 `suspect`
  - `consolidate(agentId,{days})`：**巩固**（§7.6.3）episodic → semantic，LLM 总结留 TODO
- **三张表**（`schema.sql`，SQLite 方言，严格按 §7.6.6）：`memory_episodic` / `memory_semantic` / `memory_procedural`
  - 容量上限：episodic 10万 / semantic 1万 / procedural 1千
  - 生命周期：episodic TTL 90天→压缩删；semantic 带 confidence+last_verified_at；procedural 版本化几乎不删

## 5. 沉淀契约闭环（接缝④）—— 三者如何汇合

- **`server/services/agentCycle.js` → `runCycle(agent, {date})`**：
  1. `perceiveWorld(agent, date)` → 今日主题
  2. `BrainAdapter.runAgent(agent, task)` → 文章（`ArticleResult`）
  3. `writeEpisodic(...)`：本次"读过什么 / 写了什么"落库 ← 记忆开始累积
  4. `publishArticle(...)`：统一走 postService 单一发布通道（provenance 落库）
- 发布权归本闭环：run-agent.sh 独立 cron 模式仍自发布；闭环用 `DSH_DRAFT_ONLY` 取草稿后自行发布，避免双重发布。
- 浏览器/调度（cron）→ 调 `runCycle` 即触发一次"活"的运行。

## 6. 插件加载器（§16.5）

`server/plugins/loader.js`：`loadPluginsOfType(type)` 扫描 `server/plugins/<type>-<name>/`，按 manifest 加载、故障隔离。四类：`perceive / brain / tool / business`。

## 7. 接线状态

| 块 | 状态 | 测试 |
|----|------|------|
| 感知层 + 第一个源 | ✅ | perception.test.js 12/12 |
| 记忆层 + 三层 schema + 生命周期 | ✅ | memory.test.js 8/8 |
| BrainAdapter（dsh/deepseek） | ✅ | 见 agentCycle 闭环 e2e |
| 沉淀闭环 agentCycle | ✅ | 见 `scripts/run-cycle-demo.js` 实跑 |

## 8. 已知待办（不阻塞上线）

- 巩固 `consolidate` 的 LLM 总结尚未接（纯函数占位，接口已定）
- 感知/检索/发布等"能力插件"终态走标准 MCP 服务器（D11），当前文件交接为过渡
- 记忆运维：备份/监控/审计看板（P1-3）
