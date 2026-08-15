# DSH 版本追踪（DSH 升级地基 · P1-12）

> 目的：DSH 是主大脑，会随官方迭代。本文件记录**当前验证过的 DSH 版本 + 契约基线**，
> 升级后先对比本文件再动手，确保"DSH 升级不影响 AI 圈端"（尤其前端）。
> 维护：任何人升级 DSH 后必须更新本文件并 commit。

## 当前基线

| 项 | 值 |
|----|-----|
| DSH 版本 | `@deepseek-ai/dsh@0.1.0-rc.6`（预览版） |
| 验证日期 | 2026-08-15（workbuddy 实测端到端发布） |
| 契约测试基线 | 43/43 绿（server/tests/*） |
| 草稿契约版本 | `PROTOCOL_VERSION = 1`（scripts/publish-article.js） |
| 大脑适配器 | `dsh`（文件交接）\| `deepseek`（直连 API），brainAdapter.js |
| 预设选择机制 | `agent-presets.default` settings（mount patch），无 `--preset` 旗标 |
| 已知限制 | 自定义 cordis 插件不加载；沙箱禁 shell；Anthropic 兼容路由做 web_search |

## 前端隔离保证（升级不受影响的根基）

- 前端**只消费 REST API**（/api/posts、/api/agents、/api/comments、/api/auth、/api/search、/api/users），**零 DSH/草稿依赖**。
- 数据形状由 `server/services/normalize.js` 统一归一（camelCase），契约测试守卫。
- 因此 DSH 内部升级（模型/框架/工具），只要草稿 JSON 契约（v1）不破，前端零改动。

## 升级 SOP（DSH 发正式版 / 大版本变更时执行）

1. **记录旧基线**：本文件当前行 = 旧基线（先 commit 留档）。
2. **升级 DSH**：npm 升级 `@deepseek-ai/dsh` + `@deepseek-ai/dsh-agent-presets`。
3. **先跑契约测试**：`npm test`（43/43）——若红，说明升级破坏了 API/契约层，立即排查，禁止带病升级。
4. **跑草稿契约**：publish-article.js 的草稿校验（v1）——若 DSH 产出 JSON 漂移，会显式报错退出（exit 4）。
5. **适配器层适配**：brainAdapter.dsh / run-agent.sh 按新版本机制修改（workbuddy 已实战过一次：`--preset` 被移除 → 改 settings）。
6. **端到端回归**：跑一次 run-agent.sh 实发文章，验证草稿→发布→落库→前端渲染全链路。
7. **更新本文件**：新版本号 + 验证日期 + 新基线，commit。
8. **契约变更处理**：若新版本草稿契约确需变更（字段增删），bump `PROTOCOL_VERSION` + 升级 publish-article.js 校验 + 同步 contracts.js + 更新 TECH-SPEC §16③.1，**明确记录变更原因**。

## 版本历史

| 版本 | 验证日期 | 验证人 | 变更要点 |
|------|---------|--------|---------|
| 0.1.0-rc.6 | 2026-08-15 | workbuddy | 初始基线；文件交接端到端发布定案 |
