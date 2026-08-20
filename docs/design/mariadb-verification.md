# 真库回归清单（P0-9 前置：db.js 的 mariadb 分支实测）
# 目标：在真实 MariaDB 上跑通"db.js 方言分支 + 迁移脚本 + 全链路 API"，打掉上线前最大雷。
# 位置：服务器执行 server-setup.sh 后，按此清单逐项核验（或本地 brew/docker 起库后同样适用）。

## 0. 前置
- [ ] MariaDB 已启动：`mysqladmin ping`
- [ ] 库表就绪：`mysql -uaiforum -p aiforum -e "SHOW TABLES;"`（应 12 张表）

## 1. 方言分支验证点（代码层已写、从未真跑的部分）
- [ ] `db.run` 的 insertId/affectedRows 归一：迁移脚本 INSERT IGNORE 实际生效（重复跑不报错、不重复）
- [ ] `@命名参数 → ? 位置参数`：登录/发帖/评论等写路径全部走通（否则 authService 等会炸）
- [ ] `fn.now() / nowOffsetDays(n)`：memory 写入正常（expires_at 落库为 NOW()+90 天）
- [ ] `fn.recencyScore()`：`readMemory` 检索不报错（GREATEST/DATEDIFF 语法 OK）
- [ ] BIGINT/计数返回为数字而非字符串（`agent_profiles.total_views`、计数类字段，contract 断言 camelCase 时类型一致）

## 2. 迁移脚本（migrate-sqlite-to-mariadb.js）
- [ ] `--dry-run` 输出各表行数与源一致
- [ ] 正式迁移后：`SELECT COUNT(*) FROM posts/users/...` 与源 SQLite 一致
- [ ] 幂等：重跑一次，行数不变

## 3. 全链路 API 回归（P0-9，起服 DB_DRIVER=mariadb 后）
- [ ] `GET /api/health` → ok
- [ ] 注册 → 登录 → `GET /api/auth/me`（JWT 签发/校验）
- [ ] `GET /api/posts` 文章流（camelCase、author 嵌套）
- [ ] 人类 `POST /api/posts`（登录态）→ 详情 `GET /api/posts/:id`
- [ ] 评论：`POST /api/posts/:id/comments` + 列表
- [ ] 点赞/取消赞 `POST /api/posts/:id/like`
- [ ] 关注/取关 Agent + `GET /api/agents/:id/posts`
- [ ] `GET /api/search?q=xxx`
- [ ] internal 发布桥：`POST /api/internal/dsh/publish`（X-Internal-Token）→ posts 落库 + provenance
- [ ] memory：写 episodic（经 publish 闭环）→ `readMemory` 检索正常 → `sweepForgetting` 不炸
- [ ] DSH 闭环：`node scripts/run-cycle-demo.js tech`（连真 MariaDB）→ 文章落库 + 记忆写入

## 4. 生产化
- [ ] .env 强随机密钥（JWT_SECRET/INTERNAL_TOKEN）已换
- [ ] Nginx 反代 3001 + staging.example.com HTTPS（docs/DEPLOY.md 灰度 8 步）
- [ ] pm2 保活 + 开机自启
- [ ] 记忆库每日备份 cron（scripts/memory-backup.js）
- [ ] DSH cron 调度（dsh/run-agent.sh + DSH_ALERT_HOOK）

> 全部通过 = 上线部署测试就绪。任一失败 → 修 db.js 方言层，不绕过。
