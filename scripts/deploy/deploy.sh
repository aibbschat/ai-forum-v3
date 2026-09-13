#!/usr/bin/env bash
# scripts/deploy/deploy.sh — v3 部署（参照 pay-relay 模式：备份→拉代码→装依赖→构建→重启→健康检查）
# 在服务器运行目录执行；由 bare repo post-receive hook 调用（见同目录 post-receive）。
#
# 用法：bash scripts/deploy/deploy.sh [--skip-build]
set -euo pipefail

# 生产原生模块（better-sqlite3 等）必须用与运行时一致的 Node 22 编译，
# 否则 ABI 不匹配（NODE_MODULE_VERSION）。post-receive 的非交互 shell 可能
# 没有 node22，这里显式把已知安装路径前置。
export PATH="/opt/node22/bin:$HOME/.local/bin:$PATH"

APP_DIR="${APP_DIR:-/opt/ai-forum-v3}"
PM2_NAME="${PM2_NAME:-ai-forum-v3}"
BACKUP_DIR="$APP_DIR/backups"
KEEP_BACKUPS=10
SKIP_BUILD="${1:-}"

echo "=== [1/5] 备份当前版本 ==="
mkdir -p "$BACKUP_DIR"
BK="$BACKUP_DIR/backup_$(date +%Y%m%d_%H%M%S).tar.gz"
if [ -d "$APP_DIR/current" ]; then
  tar czf "$BK" -C "$APP_DIR" --exclude=backups --exclude=node_modules --exclude='web/dist' current
  ls -t "$BACKUP_DIR"/backup_*.tar.gz | tail -n +$((KEEP_BACKUPS+1)) | xargs -r rm -f
  echo "已备份: $BK（保留最近 $KEEP_BACKUPS 份）"
else
  echo "无 current 目录（首次部署），跳过备份"
fi

echo "=== [2/5] 更新代码 ==="
# 假定 post-receive 已把最新代码 checkout 到 current
cd "$APP_DIR/current"
git fetch origin main 2>/dev/null || true
git reset --hard origin/main

echo "=== [3/5] 依赖与构建 ==="
npm ci --omit=dev 2>/dev/null || npm install
# 根目录原生模块按当前 Node（22）重编译，避免 ABI 不匹配。
npm rebuild better-sqlite3 >/dev/null 2>&1 || true
# 各 MCP server 有独立 package.json/node_modules（含 MCP SDK；baijia 还依赖 better-sqlite3），
# 逐目录安装依赖。
for mcp_dir in mcp/*/; do
  if [ -f "${mcp_dir}package.json" ]; then
    (cd "$mcp_dir" && npm ci --omit=dev >/dev/null 2>&1 || npm install --omit=dev >/dev/null 2>&1)
  fi
done
if [ "$SKIP_BUILD" != "--skip-build" ]; then
  # 注意：web 构建需要 vite（devDependency），必须全量 npm ci，不能 --omit=dev
  (cd web && npm ci)
  (cd web && npx vite build)
fi

echo "=== [4/5] 环境变量 + 路径渲染 ==="
[ -f .env ] || { echo "!! 缺 .env（生产密钥！）"; exit 1; }
# 关键：生产必须 mariadb
grep -q '^DB_DRIVER=' .env || echo "DB_DRIVER=mariadb" >> .env
# SEO 规范站点根：canonical / og:url 需要绝对 https（否则按请求 Host 兜底可能在直连源站时吐 http）
grep -q '^SITE_PUBLIC_URL=' .env || echo "SITE_PUBLIC_URL=https://aibbs.chat" >> .env
grep -q '^MYSQL_' .env || { echo "!! .env 缺 MYSQL_* 连接配置"; exit 1; }
# 封面图目录：Nginx 以 alias 指向 $APP_DIR/covers（在 current 之外，跨版本不丢）。
# 代码默认是相对路径 ./covers（会落到 current/covers 而 Nginx 读不到），故部署时
# 必须显式落到共享目录，否则新生成的封面会 404。
grep -q '^COVERS_DIR=' .env || echo "COVERS_DIR=$APP_DIR/covers" >> .env
mkdir -p "$(grep -oE '^COVERS_DIR=.*' .env | head -1 | cut -d= -f2-)"
# 从模板渲染 cordis.patch.yml（把 __REPO_ROOT__ 等占位符换成当前部署目录）。
# 该文件含机器相关绝对路径，不入库（见 .gitignore），每次部署重新生成。
node scripts/render-patch.js

echo "=== [5/5] 重启 + 健康检查 ==="
pm2 restart "$PM2_NAME" || pm2 start server/index.js --name "$PM2_NAME" -i 1
sleep 3
# 健康检查端口以 .env 的 PORT 为准（v3 实际监听 3002，避免误判旧 prod 的 3001）
APP_PORT="$(grep -oE '^PORT=[0-9]+' .env 2>/dev/null | head -1 | cut -d= -f2)"
APP_PORT="${APP_PORT:-3002}"
HEALTH=$(curl -s -m 5 "http://127.0.0.1:${APP_PORT}/api/health" || echo '{"ok":false}')
echo "健康检查: $HEALTH"
case "$HEALTH" in
  *'"ok":true'*) echo "✅ 部署成功" ;;
  *) echo "❌ 健康检查未通过，建议 rollback.sh 回滚"; exit 1 ;;
esac
