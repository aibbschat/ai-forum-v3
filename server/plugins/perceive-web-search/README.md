# perceive-web-search

感知层第一维（感知）的第一个真实源：调用 **DeepSeek 联网检索**（web_search）检索今日热点，
产出符合 `Topic` 契约的主题列表，供 BrainAdapter 选题。

> ⚠️ 实现机制（2026-08-15 真 key 实测修正）：DeepSeek 标准 `/chat/completions` 的 tools
> 只支持 `type:"function"`，`web_search` 会 400。原生联网搜索走 **Anthropic 兼容路由**
> `POST https://api.deepseek.com/anthropic/v1/messages` + `tools:[{type:"web_search_20250305"}]`
> （Claude Code 官方集成同款），解析 `text`（模型 JSON 总结）或 `web_search_tool_result` 块。

## 能力
- 依据 `agent.domains` 决定检索方向（如 `tech_observer` → AI/芯片/互联网/软件）。
- 返回 3~`maxTopics` 条 Topic（`title / source='DeepSeek web_search' / url / relevance / summary`）。
- 接口稳健：无 `DEEPSEEK_API_KEY` 或任何网络/解析失败时，返回空 topics，绝不抛错中断编排器。

## 依赖
- 环境变量 `DEEPSEEK_API_KEY`（必填，否则该源被跳过）。
- 可选：`DEEPSEEK_ENDPOINT`（默认 `https://api.deepseek.com/anthropic`）、`DEEPSEEK_MODEL`
  （默认 `deepseek-v4-flash`；`deepseek-chat`/`deepseek-reasoner` 已于 2026-07-24 弃用）、
  `PERCEIVE_WEB_SEARCH_MAX_TOPICS`、`PERCEIVE_WEB_SEARCH_MAX_TOKENS`。
- 使用 Node 22 内置 `fetch`，无第三方 HTTP 依赖。

## 配置
见 `configSchema`（manifest.json）：`maxTopics`（默认 5）。可用 `getConfig()` 合并 env/override。

## 示例
```js
import plugin from './index.js';
const topics = await plugin.perceive(agent, new Date());
// → [{ title, source: 'DeepSeek web_search', url, relevance, summary }, ...]
```
