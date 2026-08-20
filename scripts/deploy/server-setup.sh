#!/usr/bin/env bash
# scripts/deploy/server-setup.sh — 服务器一次性初始化（在目标部署机执行）
# 用途：装 MariaDB → 建库建用户 → schema.mariadb.sql 建表 → 从开发 SQLite 迁移数据 →
#       生产密钥提示。幂等（可重复执行；建表/迁移均幂等）。
#
# 用法：bash scripts/deploy/server-setup.sh [--skip-db-install]
#   --skip-db-install  跳过 apt 安装 MariaDB（已在系统级装好的场景）
#
# 环境变量（覆盖默认）：
#   DB_NAME / DB_USER / DB_PASS / MYSQL_ROOT_PASS(可选)
set -euo pipefail

DB_NAME="${DB_NAME:-aiforum}"
DB_USER="${DB_USER:-aiforum}"
DB_PASS="${DB_PASS:-$(openssl rand -hex 16)}"
APP_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SCHEMA="$APP_DIR/server/database/schema.mariadb.sql"
MIGRATE="$APP_DIR/scripts/migrate-sqlite-to-mariadb.js"

echo "=== [1/6] MariaDB 安装 ==="
if [ "${1:-}" = "--skip-db-install" ]; then
  echo "跳过安装（假定系统已装 MariaDB）"
else
  command -v mariadb || command -v mysql >/dev/null 2>&1 || {
    apt-get update -y
    apt-get install -y mariadb-server
    systemctl enable --now mariadb
  }
fi

echo "=== [2/6] 建库建用户（幂等）==="
ROOT_SU=""
if [ -n "${MYSQL_ROOT_PASS:-}" ]; then ROOT_SU="-p${MYSQL_ROOT_PASS}"; fi
mysql -uroot $ROOT_SU <<SQL
CREATE DATABASE IF NOT EXISTS ${DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
GRANT ALL ON ${DB_NAME}.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL
echo "DB_USER=${DB_USER} 密码已生成（未打印，请记到 .env）：${DB_PASS}"

echo "=== [3/6] 建表（schema.mariadb.sql，幂等）==="
mysql -u"${DB_USER}" -p"${DB_PASS}" "${DB_NAME}" < "$SCHEMA"

echo "=== [4/6] 数据迁移（从开发 SQLite，幂等 INSERT IGNORE）==="
echo "先 dry-run 看量："
MYSQL_HOST=127.0.0.1 MYSQL_PORT=3306 MYSQL_USER="${DB_USER}" MYSQL_PASSWORD="${DB_PASS}" MYSQL_DATABASE="${DB_NAME}" \
  node "$MIGRATE" --dry-run
echo "确认无误后正式迁移（本次直接执行）："
MYSQL_HOST=127.0.0.1 MYSQL_PORT=3306 MYSQL_USER="${DB_USER}" MYSQL_PASSWORD="${DB_PASS}" MYSQL_DATABASE="${DB_NAME}" \
  node "$MIGRATE"
echo "迁移完成。若为空库（灰度期不迁旧数据），可跳过本步或从空迁移（0 行）——首次启动 index.js 会自动补 Agent 账号。"

echo "=== [5/6] 生产密钥（红线）==="
cat <<'EOF'
请务必在 .env 里设置强随机值（勿用 dev 值）：
  JWT_SECRET=$(openssl rand -hex 32)
  AI_FORUM_INTERNAL_TOKEN=$(openssl rand -hex 24)
  INTERNAL_SERVICE_TOKEN=<同上>
  DEEPSEEK_API_KEY=<服务器已有，确认在 .env>
EOF

echo "=== [6/6] 完成 ==="
echo "下一步：bash scripts/deploy/deploy.sh 部署代码 → 配 Nginx（docs/DEPLOY.md）→ DB_DRIVER=mariadb 起服"
