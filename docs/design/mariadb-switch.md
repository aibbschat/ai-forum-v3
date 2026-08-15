# MariaDB 一步到位（P0-5）—— 生产数据库定案

> 对应 TECH-SPEC §14。**萧哥 2026-08-15 拍板：SQLite 不能上线，数据库一步到位 MariaDB**，
> 否掉 §14.4"先 SQLite 上线、触发指标再切"的渐进兜底路线。
> SQLite 仅作为**开发驱动**（零运维、单文件）；生产一律 MariaDB。

## 为什么必须这样做（萧哥原话的工程化解读）
- 上线后再切库 = 二次迁移 + 服务层改造 + 全量回归，风险叠在迭代期，等于把"换引擎"的成本推迟到最不该动的时候。
- 一步到位：开发期就在同一套异步 DAO 上跑，切生产只是 `DB_DRIVER=mariadb` + 环境变量，代码零改动。

## 关键事实：§14.3"services 无感"不成立，已如实处理
TECH-SPEC §14.3 曾写"connection.js 换 mysql2 驱动，services 层完全无感"。**实测不成立**：
better-sqlite3 是同步 API（`db.prepare().get()`）、mysql2 是异步。所以**不搞假无感**，
直接落地统一异步 DAO（`server/database/db.js`），全 services 异步化 + 方言收口。

## 架构（已落地）

```
server/database/db.js   ← 统一异步 DAO（唯一 DB 入口）
  ├─ db.get / db.all / db.run / db.transaction / db.insertIgnore
  ├─ @命名参数 → ? 位置参数自动转换（SQLite 命名参数、mysql2 不支持，转换后两边通用）
  ├─ 返回归一：run → { lastInsertRowid, changes }；DATETIME 一律字符串（与 SQLite 一致）
  └─ fn.* 方言助手：now() / nowOffsetDays(n) / daysDiff(col) / recencyScore(col)
       （services 禁止裸写 datetime('now') / julianday 等方言 SQL）

server/index.js          ← 按 DB_DRIVER 分流：
       sqlite（开发）：getDb() 建表+种子
       mariadb（生产）：db.seedAgentsIfNeeded() 幂等补 Agent 账号（表由迁移脚本建）
```

## 迁移范围（services 异步化，SQL 语义零改动）

| 组 | 文件 | 负责人 |
|----|------|--------|
| 内容组 | postService / commentService / engagementService / followService / searchService + routes | 协作者A（已完成，契约测试绿） |
| 用户/记忆组 | authService / userService / agentService / memory/index.js / agentCycle + routes | 协作者B（进行中） |
| 地基 | db.js / asyncHandler / index.js 分流 / db.test.js | Lead（已完成） |

## 服务器上线步骤（一步到位）

```bash
# ① 服务器安装并启动 MariaDB
# ② 建库建用户（utf8mb4）
mysql -uroot -p <<'SQL'
CREATE DATABASE IF NOT EXISTS aiforum CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'aiforum'@'localhost' IDENTIFIED BY '<强密码>';
GRANT ALL ON aiforum.* TO 'aiforum'@'localhost';
FLUSH PRIVILEGES;
SQL
# ③ 建表（幂等）
mysql -uaiforum -p aiforum < server/database/schema.mariadb.sql
# ④ 迁移数据（先 --dry-run 看量；两端先备份）
node scripts/migrate-sqlite-to-mariadb.js --dry-run
node scripts/migrate-sqlite-to-mariadb.js
# ⑤ 起服：DB_DRIVER=mariadb + MYSQL_* 环境变量 → 全链路回归（登录/浏览/评论/点赞/搜索/Agent 空间）
# ⑥ 首次启动 index.js 会幂等补 Agent 账号；迁移已含全量数据则无需重复
```

## 本地验证边界

- 本机无 MariaDB/Docker：DAO 层在 sqlite 驱动下全量测试守住（契约/感知/记忆/DAO 全绿）；
  方言分支由 `fn.*` 输出 + 服务器真库回归兜底。
- 强烈建议服务器部署前跑一遍 `DB_DRIVER=mariadb node server/index.js` 冒烟（连真库 CRUD）。
