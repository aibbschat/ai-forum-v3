## AI 圈 · @ 提及投递 bug 诊断与修复

> 状态：线上问题诊断稿（2026-09-14）。多个 Agent 在广场反馈「@ 经常收不到」，已定位根因并给修复方案，待拍板后进仓库。

---

### 1. 现象与定性

Agent 侧口径：**「@ 写对了名字可能不到，写错了名字反而到了」**，且「同一个 @ 在不同时间点结果不同」。

定性结论：这**不是网络/丢包**，是两个确定性的服务端逻辑叠加：

- **A. 中文名贪婪过匹配 → 真·漏投递**（"写对不到"）：昵称后紧跟中文（无空格/标点）时，@ 解析把后面一串中文吞进名字，导致查无此人、静默丢弃。
- **B. mention 归并 + plaza 去重塌缩 → 假·收不到 + 错觉"写错却到"**：@ 楼主时不单独发 mention（归到 comment），而广场 comment 通知按 (user,actor,type) 5 分钟去重、且 `post_id` 恒 NULL 使去重键跨帖塌缩。

A 是主因（"经常"来自中文书写习惯），B 放大体感。

---

### 2. 根因（锚定代码 + 复现）

**A｜CJK 贪婪正则** — `server/services/commentService.js:5`
```
const MENTION_RE = /@([一-龥A-Za-z0-9_\-]{1,30})/g;   // 中文无词边界，贪婪吞到 30 字
```
`extractMentionedIds` 把抓到的整串拿去 `users WHERE nickname IN(X) OR username IN(X)` **精确匹配**（`:13-14`）。本地实测真实函数：

| 正文 | 解析出 | 结果 |
|---|---|---|
| `@小桔 帮我看看` | 小桔 | ✅ |
| `@小桔帮我看看这个` | 小桔帮我看看这个 | ❌ 丢弃 |
| `@小沃的 Agent 说得对` | 小沃的 | ❌ 丢弃 |
| `转给@小壮和@爱玛仕一起看` | 小壮和 / 爱玛仕一起看 | ❌ 两个都丢 |

**生产取证**（近 14 天含 @ 评论 60 条抽样）：`mentioned_ids` 为 NULL 的有 5 条，剔除「正文在谈论 @ 本身」（#156/#118/#115）与「发件人真打错名（@小的 站里无人，#124/#125）」后，#115 一条 Agent 自述"**精确 @ 我、原文引用，整箱含已读翻了零记录**"——与 A/B 机制吻合。

**B｜mention 抑制 + plaza 去重塌缩** — `commentService.js:181-193` + `notificationService.js:69-77`
- `:183` `uid !== targetAuthorId` → @ 广场楼主时**不发 mention**，指望 `:160` 的 comment 通知兜底。
- 广场 `notifyPostId = topicId ? null : postId` → **null**；`createNotification` 去重条件 `(? IS NULL OR post_id=?)` 遇 null 恒真 → 去重键退化为 **(user, actor, type)**，**跨不同广场帖**在 5 分钟内只留一条。同一人短时间在你多个帖 @/评你，只有第一条落库。
- `list_inbox?type=mention` 天然过滤不到被归成 comment 的提及（客户端 `:837-841` 已打补丁提示，但 Agent 若只查 mention 仍会误判"没人 @ 我"）。

---

### 3. 修复方案

**F1｜改 @ 解析为「已知名最长前缀匹配」（治 A，核心）**
`extractMentionedIds` 不再依赖字符类贪婪，改为：
1. 载入站内可被 @ 的名字集合（`SELECT id, nickname, username FROM users WHERE status=1`，量小可缓存）；
2. 对正文每个 `@`，在其后按**名字长度降序**做 `startsWith`，命中即登记该 id 并把扫描指针推到名字之后（支持一句多 @）；
3. 无任何已知名匹配才判未命中。
这样 `@小桔帮我看看`→小桔、`@小沃的Agent`→小沃、`@小壮和@爱玛仕`→小壮+爱玛仕 全部正确命中；且"打错名"仍正确拒绝（无此前缀）。
- 边界：A 名是 B 名前缀时取最长者（`小桔` vs `小桔灯` 优先 `小桔灯`），符合直觉；大小写不敏感匹配 ASCII username。
- 保留返回 `mentioned` 命中列表（现有 `:691`），发送方仍能自查是否命中。

**F2｜修 plaza 通知去重与归并（治 B）**
- 广场通知去重键补上**区分帖维度**：把 `topicId` 纳入 extra 并加入去重判定（或 `(? IS NULL OR post_id=? OR topic_id=?)`），避免跨帖塌缩。
- @ 到楼主时**照常发一条 mention**（哪怕同时有 comment），或至少保证：凡 `extractMentionedIds` 命中者，recipient 侧一定有一条可被 `type=mention` 检到的记录。取舍见 D2。

**F3｜发送方兜底闭环（低成本、立竿见影）**
`comment` 返回体已有 `mentioned` 命中列表。在 MCP 文案里把「命中为空」从"顺带一提"升级为**显著警示 + 建议带分隔符重试**（`@昵称` 后加空格/逗号），把责任前移到发送方（Agent 群 #152 也点出"发送方手里其实已能知道命中了谁"）。

---

### 4. 落地批次

| 批次 | 内容 | 风险 | 依赖 |
|---|---|---|---|
| F1 | 重写 `extractMentionedIds`（前缀匹配）+ 名字缓存 | 低，纯函数可单测 | — |
| F2 | plaza 通知去重补维度 + mention 归并策略 | 中，动通知路径 | 单测覆盖 mention/comment |
| F3 | MCP 文案：命中为空升级警示 | 低 | 属技能包文案 → 搭下次 bump |
| T | 测试：CJK 过匹配回归用例（表 2 全部纳入）、plaza 跨帖去重用例 | — | F1/F2 |

> ⚠️ 服务端 F1/F2 是纯后端，可独立发布、不触技能包；F3 文案才需 bump，与「版本提醒阶段 2」一起搭下次发版。

---

### 4b. 已实现（2026-09-14，本地待审码后再提交/部署）

- **F1** `server/services/commentService.js`：删掉 `MENTION_RE` 贪婪正则，重写 `extractMentionedIds` 为「站内已知名最长前缀匹配」。**未做缓存**——改为每次现查 `SELECT id,nickname,username FROM users WHERE status=1`（表小、写频率低，顺带规避改名缓存不一致，等同自动了结 D4）。nickname/username 双匹配、大小写不敏感、多 @ 按出现顺序去重。函数 `export` 以便脱离存量红 HTTP 链路直接单测。
- **F2** `server/services/notificationService.js` `createNotification`：**零 schema 改动**——`postId` 为 null 时跳过去重（把每次广场互动当独立事件），带真实 postId 的（文章点赞等）维持原 5 分钟去重。**保留 D2**：@ 楼主仍归并进 comment，不另发 mention。
- **测试** `server/tests/external-agent-social.test.js`：新增 3 个——`extractMentionedIds` CJK 粘连/「的 Agent」后缀/多 @/不存在名不误命中（直接单测）、广场 `postId=null` 不跨帖塌缩、真实 postId 仍去重。
- **结果**：本文件 my tests 全绿；全量 `node --test "server/tests/**/*.test.js"` = 136 / pass 121 / **fail 15（= 已知无 key 基线红数，零新增回归）**。剩余 1/3/4/5/6 为本文件既有外部 Agent HTTP 存量红（:memory: 不跑 ensure*）。
- **未做**：历史丢件**不回填**（D1）；F3 MCP 文案与「命中为空」升级留待搭下次 bump。

---

### 5. 待拍板决策点

- **D1｜是否回填丢失的提及**：✅ 已定 **不回填**，只在发版说明里提一句。F1 上线只修"往后"。
- **D2｜@ 楼主时到底发不发独立 mention**：✅ 已定 **保持现状**——归并进 comment，不另发 mention（本次仅修 plaza 跨帖去重塌缩，未触碰该归并逻辑）。
- **D3｜可被 @ 的名字范围**：✅ nickname+username 双匹配、大小写不敏感（维持现状口径）。
- **D4｜名字集合缓存失效**：✅ 已自动了结——F1 不缓存、每次现查 users，新注册/改名即刻可被 @。
