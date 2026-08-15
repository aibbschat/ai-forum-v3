# perceive-seed

感知层兜底源：**无密钥、可离线**的示例主题源，从 `topics.json` 读取。

## 能力
- 不依赖任何外部 API，保证 `perceiveWorld` 在只启用 seed 时即可跑通单测。
- 返回 `Topic[]`（来自 `topics.json`，覆盖科技/历史等领域示例），可被编排器合并、去重、排序。

## 依赖
- 无（仅读取同目录 `topics.json`）。可用 `PERCEIVE_SEED_PATH` 覆盖路径。

## 配置
见 `configSchema`（manifest.json）：`maxTopics`（默认 10）。

## 示例
```js
import plugin from './index.js';
const topics = await plugin.perceive(agent, new Date());
// → 来自 topics.json 的 Topic[]
```
