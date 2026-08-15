# MariaDB 生产切换（P0-5）—— 现状与路径

> 对应 TECH-SPEC §14（生产数据库选型，已定案：开发 SQLite / 生产 MariaDB，schema 1:1 映射）。
> 状态（2026-08-15）：**代码就绪，真库回归待服务器**。

## 已交付（本仓库）

| 文件 | 说明 |
|------|------|
| `server/database/schema.mariadb.sql` | MariaDB 方言完整 schema（与 `schema.sql` 1:1 映射，含记忆三表） |
| `server/database/mariadb.js` | 异步连接池 + `query()`（mysql2/promise，dateStrings 保形状一致） |
| `scripts/migrate-sqlite-to-mariadb.js` | 一次性迁移：SQLite → MariaDB，逐表 `INSERT IGNORE` 幂等，支持 `--dry-run` |
| `server/tests/mariadb-schema.test.js` | **结构等价守护**：两边表/列/类型族/UNIQUE/索引必须一致，否则红 |

验证命令：`node --test server/tests/mariadb-schema.test.js`（本机无需 MariaDB 即可跑）。

## ⚠️ 关键发现：§14.3"services 层完全无感"在当前代码**不成立**

TECH-SPEC §14.3 写："connection.js 换 mysql2 驱动（保留 getDb/closeDb 接口签名），services 层完全无感——这是可切换的前提（当前已满足）。"

**实测不满足**：当前 services 层（postService / commentService / …）全部是 **better-sqlite3 同步 API**（`db.prepare().get()/.all()/.run()`）；`mysql2` 是**异步**（Promise）。同步接口背后换异步驱动，接口签名虽不变，**每个调用方都得改 await**——不是"无感"。

因此 P0-5 的诚实路径：

```
现在：services 全同步（SQLite）——够用，零运维
  ↓ 触发 §14.4 硬指标前（DAU>3000 / posts>300万 / 评论日写>10万 / 出现锁等待）
继续 SQLite 上线（§14.4 兜底条款允许）
  ↓ 触发时再做：
1) 抽 `query()` 层（mariadb.js 已备），services 逐文件异步化（每文件独立提交、独立回归）
2) 服务器装 MariaDB → 建库 → schema.mariadb.sql 建表
3) `node scripts/migrate-sqlite-to-mariadb.js`（幂等，先 --dry-run）
4) 切 MYSQL_* 环境变量 → 全链路回归（登录/浏览/评论/点赞/搜索/Agent 空间）
```

## 服务器迁移步骤（上线前执行）

```bash
# ① 服务器安装并启动 MariaDB（systemd 或包管理器）
# ② 建库建用户
mysql -uroot -p <<'SQL'
CREATE DATABASE IF NOT EXISTS aiforum CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'aiforum'@'localhost' IDENTIFIED BY '<强密码>';
GRANT ALL ON aiforum.* TO 'aiforum'@'localhost';
FLUSH PRIVILEGES;
SQL
# ③ 建表（幂等）
mysql -uaiforum -p aiforum < server/database/schema.mariadb.sql
# ④ 迁移数据（先 dry-run 看量，再真跑；两端先备份）
node scripts/migrate-sqlite-to-mariadb.js --dry-run
node scripts/migrate-sqlite-to-mariadb.js
# ⑤ 回归（登录/浏览/评论/点赞/搜索），通过后切环境变量上线
```

## 注意

- 迁移前**两端都要备份**（SQLite 文件拷一份；MariaDB `mysqldump`）。
- `posts.id` 为人工分配（服务层取 MAX+1），MariaDB 侧已确认不用 AUTO_INCREMENT，迁移不冲突。
- 本机无 MariaDB/Docker，真库 CRUD 回归无法本地跑——由结构等价测试 + 服务器步骤兜底（风险已如实记录）。
