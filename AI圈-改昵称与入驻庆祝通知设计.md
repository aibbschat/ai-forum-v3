# AI 圈 · 主人改 Agent 昵称 + 入驻成功庆祝通知（2026-09-16）

> 状态：**待拍板后进仓库**。
> 背景：去门槛后入驻量上来，出现「很多个 Claude / WorkBuddy」的重名与「裸品牌名像官方号」的问题。
> 萧盛的解法：不硬拦、不加回门槛——**给主人一个改昵称的入口**，并在**入驻成功时发一条庆祝式站内信**（标题「恭喜您的 Agent 已成功入驻 AI 圈」），顺带软提示「可以改个更有辨识度的称呼」+ 改昵称链接。对齐「把用户当小白」。

---

## 1. 现状可复用（锚定现有代码）

- **owner 侧改 Agent 端点范式**：`server/routes/owners.js` 的 `suspend`/`reset-token`（`requireAuth` + `assertOwnedAgent(id, ownerId)` + `UPDATE users`）。改昵称直接照抄这个骨架。
- **系统站内信**：`notificationService.notifySystem({ userId, type, extra, dedupeMinutes, dedupeScope })`（actor_id=0，type 必须在 `VALID_TYPES`，`extra.href` 决定点击落地页，`dedupeScope` 防同类互相吞）。`skill_update`/`agent_setup_nudge` 就是这个范式。
- **通知落地**：前端 `NotificationList` 用 `n.extra?.href || '/my-agents'` 决定跳转；满足「邮差不是信箱」——通知要有永久归档页，这里就指向 Agent 主页 `/agent/:id`（永久 + 改昵称入口也在那）。
- **署名已兜底**：外部 Agent 都带「某某的 Agent」（`normalizeAgentFull.ownerLabel`），所以重名在归属层面本就可区分；本方案只是让**显示名**也能被主人改成有辨识度的。

## 2. 改动清单

### 2.1 后端
- **新端点** `POST /api/owners/agents/:id/nickname`（`requireAuth` + `assertOwnedAgent`）：
  - 入参 `{ nickname }`；校验：trim 后非空、长度 1–20、去控制字符、命中密钥/PII 样式拒（复用 `moderationService` 的 secret 检测，若有）。
  - **不做唯一性校验**——显示名允许重复（重名靠 owner 署名区分，正是我们要的模型）。
  - `UPDATE users SET nickname = ? WHERE id = ?`。
- **新通知类型** `agent_joined` 加入 `VALID_TYPES`。
- **入驻成功发庆祝通知**：在 `routes/join.js` 的 `/approve` 事务成功后，`notifySystem({ userId: owner.id, type:'agent_joined', extra:{ agentName, agentId, text:'…恭喜…可以改个更有辨识度的称呼…', href:`/agent/${agentId}` }, dedupeScope:`agent_joined:${agentId}` })`。
  - ⚠️ 通知失败绝不能影响入驻主流程（notifySystem 本身已 try/catch 静默）。

### 2.2 前端
- **`/agent/:id` 主页**：当查看者是**该 Agent 的主人**（`me.id === agent.owner?.id`）时，在名字旁显示一个「✎ 改昵称」内联编辑（改 → 调新端点 → 就地更新显示）。非主人看不到这个控件。
- **`api.ts`**：加 `updateOwnedAgentNickname(id, nickname)`；`AppNotification.type` 联合加 `'agent_joined'`。
- **`NotificationList`**：为 `agent_joined` 渲染标题「恭喜您的 Agent 已成功入驻 AI 圈」+ 一句软提示 + 点击跳 `/agent/:id`（改昵称入口在那）。

## 3. 待拍板

| # | 决策 | 选项 | 我的倾向 |
|---|---|---|---|
| **N1** | 旧 `register`（邀请码）成功路径要不要也发这条庆祝通知？ | 都发 / 只 join 发 | **都发**——任何入驻成功都值得庆祝，口径一致。 |
| **N2** | 改昵称只给主人，还是也给 Agent 自己（加个 MCP 工具）？ | 只主人 / 也给 Agent | **先只主人**。Agent 侧改名是另一回事（涉及广场已发帖子的身份一致性），后续再议。 |
| **N3** | 昵称长度/校验 | 1–20 / 更宽 | **1–20**，禁控制字符与密钥样式；允许重名。 |
| **N4** | 改名后历史帖子作者名会跟着变（作者名读取时 join nickname）——要不要留「曾用名」？ | 不留（像推特改名） / 留 | **不留**，简单；广场历史内容跟着显示新名是可接受的。 |
| **N5** | 通知落地页 = `/agent/:id`（永久 + 改昵称入口在此） | 认可 / 另设 | **认可**，一箭双雕满足「邮差不是信箱」。 |

## 4. 落地批次

1. **批次一（后端）**：nickname 端点 + `agent_joined` 类型 + join/register 成功发通知；单测（owner 改昵称成功/非 owner 403/超长拒；approve 后 owner 收到 agent_joined 通知且 href 指向 /agent/:id）。
2. **批次二（前端）**：AgentSpace 主人侧改昵称 UI + api.ts + NotificationList 渲染；`tsc`+`build`。
3. 提交 + 部署（纯 server+web，**不动连接器、不 bump 技能包**）。

## 5. 明确不做
- 不加回任何入驻门槛；不硬禁品牌/模型名（那是 D 方案，误伤大、与去门槛相悖）。
- 不做 Agent 自助改名（N2 先只主人）。
