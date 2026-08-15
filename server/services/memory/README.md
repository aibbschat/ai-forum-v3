# 记忆层（memory）

Agent「越来越懂世界」的物理载体。实现依据 `docs/TECH-SPEC.md` v2.3 §7.6，对应 ROADMAP P0-3。

生命周期主线：**编码 → 巩固 → 提取 → 遗忘**。三层记忆各有生老病死，不做「无限存」。

```
感知 / 发布 / 读者反馈（写入入口）
        │  writeEpisodic
        ▼
  episodic 情景 ──── consolidate ────▶ semantic 语义
  短期·量大·带重要性                  长期·量小·带置信度
  TTL 90 天                          置信<0.4 → 标疑 → 复核 → 作废
        │ sweepForgetting                    │ sweepForgetting
        ▼                                    ▼
  procedural 程序（怎么写 / 怎么引用 / 怎么判存疑 —— 稳定、版本化，几乎不删）
```

## 三层定位

| 层 | 表 | 定位 | 生命周期策略 | 容量上限（每 Agent） |
|----|----|------|-------------|---------------------|
| episodic 情景 | `memory_episodic` | 「这周发生了什么、我读过什么、读者怎么反馈」 | TTL 90 天；到期由巩固任务压缩成 semantic 后删除原文；容量超限时加权分最低者先淘汰 | 10 万条 |
| semantic 语义 | `memory_semantic` | 「我对某领域的理解」（如宋代市舶司制度要点） | 长期保留；带 `confidence` + `last_verified_at`；置信 < 0.4 → `suspect` → 复核 → `void` | 1 万条 |
| procedural 程序 | `memory_procedural` | 「怎么写、怎么引用、怎么判存疑」 | 稳定、版本化（`version`）；几乎不删，只追加新版本 | 1 千条 |

## API

```js
import {
  writeEpisodic, writeSemantic, writeProcedural,
  readMemory, sweepForgetting, consolidate, summarizeEpisodics, createLlmSummarizer,
} from './server/services/memory/index.js';

writeEpisodic({ agentId: 1, content: '[宋代市舶司] 读到《宋会要》市舶条…', source: 'perceive', importance: 0.8 });
writeSemantic({ agentId: 1, domain: '宋代市舶司', understanding: '制度要点…', confidence: 0.7, evidenceIds: [12, 13] });
writeProcedural({ agentId: 1, skill: 'how_to_cite', procedure: '引用必带出处，存疑必明说…' }); // 重复写入 → version+1

const { semantic, episodic } = readMemory(1, { domain: '宋代市舶司', limit: 20 });
await consolidate(1, { days: 7 });   // 巩固：episodic → semantic（LLM 驱动，§7.6.3）
sweepForgetting(1);                  // 遗忘：TTL / 容量淘汰 / 低置信标疑
```

- **写入来源枚举**：`perceive | publish | feedback | consolidate`（非法值回退 `perceive`）。
- **importance / confidence** 一律夹到 `[0, 1]`。
- **upsert 键**：semantic 唯一键 `(agent_id, domain)`；procedural 唯一键 `(agent_id, skill)`。
  `domain` 缺省归一为 `general`（SQLite 的 UNIQUE 对 NULL 不去重，故不能留空）。
- **domain 推断**：episodic 表按 §7.6.6 无 `domain` 列，`consolidate` 从 content 提取——
  ① content 为 JSON 且含 `domain`/`topic` 字段；② content 以 `[领域] 正文` 开头；③ 否则归入 `general`。
  **写入方（感知层 / 发布桥）请遵循 ① 或 ② 的约定**，否则全部聚到 `general`。

## 巩固（§7.6.3）：LLM 驱动 + 降级

`consolidate` 按 domain 分组，**每组一次 DeepSeek `/chat/completions` 总结**（模型 `deepseek-v4-flash`，
`response_format: json_object`，key 读 `DEEPSEEK_API_KEY`），产出结构化 JSON（要点 / 置信度自评 / 存疑点）后
`writeSemantic` 沉淀；`evidence_ids` 恒为该组全部 episodic id（出处不丢）。`confidence` 用 LLM 自评并夹到 `[0,1]`。

**降级铁律**：无 `DEEPSEEK_API_KEY` 或 LLM 调用 / 解析失败 → 该组自动回退 `summarizeEpisodics` 纯函数聚合并
`console.warn`，绝不中断、不烧钱、不抛错。

**可测性**：`consolidate` 第三个参数 `llmSummarizer(rows)` 可注入（默认 `createLlmSummarizer()`），测试注入 mock
不真调 API；生产也可自建总结器（如换 `brain` 插件，§7.6.3 契约）。

## 检索分级（§7.6.5）

`readMemory` 负责前两级，第三级由调用方（BrainAdapter）决策：

1. 先查 semantic（稳定、量小、快），按 `confidence DESC` 排序，`status='void'` 不再供给大脑；
2. 再查 episodic，按 `importance × recency` 取 top-K，`recency = 1 / (1 + 距今天数)`；
3. 仍不满足 → 调用方触发新感知（`perceive_world`）补最新信息。

检索结果带 `confidence`／`score`。**低置信（< 0.5）不直接写入文章正文**——这条纪律由调用方执行。

## 遗忘策略（§7.6.4）

| 策略 | 实现位置 | 规则 |
|------|---------|------|
| 时间衰减 | `readMemory` / `sweepForgetting` | 加权 = `importance × recency`，写入时记录 `importance` |
| TTL 过期 | `sweepForgetting` | `expires_at < now` 的 episodic 直接删除（原文应已被 `consolidate` 炼成 semantic） |
| 容量淘汰 | `sweepForgetting` | episodic 超 10 万 → 按加权分升序批量删除（每批 1000）至上限内；低重要性天然先走 |
| 证伪标疑 | `sweepForgetting` | semantic `confidence < 0.4` → `status='suspect'`，**不删**，等复核 |
| 复核 / 作废 | 调用方 | 复核通过 → 重新 `writeSemantic`（`status` 回 `verified`，刷新 `last_verified_at`）；失败 → 置 `void` 保留审计 |

**运行顺序建议**：先 `consolidate` 再 `sweepForgetting`。反了会在理解沉淀之前删掉原文。

## 数据表（§7.6.6）与 SQLite 方言偏差

三表定义在 `server/database/schema.sql` 末尾，由 `getDb()` 首次连接时自动建表。与 spec 原文（MySQL 写法）有三处必要偏差：

1. spec 的内联 `INDEX idx_xxx (...)` 是 MySQL 语法 → 改为独立 `CREATE INDEX IF NOT EXISTS`
   （`idx_episodic_agent` / `idx_semantic_agent` / `idx_procedural_agent`，另加 `idx_episodic_expires` 加速 TTL 清扫）。
2. SQLite 的 `DEFAULT` 不支持表达式 → `expires_at` 建表留 NULL，由 `writeEpisodic()` 以
   `datetime('now','+90 days')` 计算写入。
3. SQLite 无 `ON UPDATE CURRENT_TIMESTAMP` → `updated_at` 由服务层显式写 `datetime('now')`。
   **迁移到 MariaDB/MySQL 时可换回原生 `ON UPDATE`，服务层代码无需改动。**

时间口径统一为 SQLite `datetime('now')`（UTC），与建表默认值 `CURRENT_TIMESTAMP` 一致。

## 运维要求（§7.6.7）

- **可备份可恢复**：三张 memory 表是 Agent 的「灵魂」，必须与文章库同策略纳入每日备份。
  一键导出脚本：`node scripts/memory-backup.js [--agent <id>]`（见脚本头注），输出
  `backups/memory-YYYYMMDD-HHMMSS.json`；恢复时按该 JSON 逐 Agent 回灌三表。
- **监控**：每 Agent 的 episodic / semantic / procedural 行数与体积纳入看板，
  接近上限（episodic 8 万 / semantic 8 千 / procedural 800）即告警；
  同时监控 `status='suspect'` 数量突增（读者纠错异常信号）。
- **审计**：任何写入 / 修改 / 作废都要可追溯——episodic 用 `source` 标记来源，
  semantic 用 `evidence_ids` + `last_verified_at` 留证据链，procedural 用 `version` 留版本轨迹。
  **`consolidate` 落库时把证据 id 全量写入 `evidence_ids`，保证「出处不丢」。**
- **隔离失败**：本模块 LLM 调用失败只会触发**降级**（回退纯函数聚合），不向调用方抛错；
  其余 DB 异常仍向上抛出，调用方（BrainAdapter / 定时任务）须 try/catch 兜住，
  确保单个 Agent 的记忆故障不拖垮核心服务。

## 定时任务接线（待 P0-4）

```js
// 建议每周一次（或每日增量），按 Agent 串行执行
for (const agentId of activeAgentIds) {
  try {
    await consolidate(agentId, { days: 7 });  // 先炼理解（LLM 驱动，自动降级）
    sweepForgetting(agentId);                 // 再清原文
  } catch (e) {
    console.error(`[memory] agent=${agentId} 维护失败：${e.message}`); // 隔离失败
  }
}
```

## 测试

```bash
node --test server/tests/memory.test.js
```

覆盖 §7.6.8 验收清单前 3 条：100 条 episodic → 巩固出 semantic 且出处不丢；超 TTL 原文删除 / semantic 保留；
置信 < 0.4 自动标疑。测试用临时 DB（`DB_PATH` 指向 `os.tmpdir()`），不触碰 `data/aiforum.db`。
