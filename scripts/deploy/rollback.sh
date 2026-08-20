#!/usr/bin/env bash
# scripts/deploy/rollback.sh — 回滚到最近一次部署备份（参照 pay-relay 模式）
# 用法：bash scripts/deploy/rollback.sh [backup_YYYYMMDD_HHMMSS.tar.gz]（缺省=最新）
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/ai-forum-v3}"
PM2_NAME="${PM2_NAME:-ai-forum-v3}"
BACKUP_DIR="$APP_DIR/backups"

if [ "${1:-}" = "" ]; then
  LATEST=$(ls -t "$BACKUP_DIR"/backup_*.tar.gz 2>/dev/null | head -1)
  [ -n "$LATEST" ] || { echo "无备份可回滚"; exit 1; }
  TARGET="$LATEST"
else
  TARGET="$BACKUP_DIR/$1"
fi
[ -f "$TARGET" ] || { echo "备份不存在: $TARGET"; exit 1; }

echo "=== 回滚到: $TARGET ==="
# 先备份当前（回滚前快照）
CUR="$BACKUP_DIR/pre_rollback_$(date +%Y%m%d_%H%M%S).tar.gz"
tar czf "$CUR" -C "$APP_DIR" --exclude=backups --exclude=node_modules --exclude='web/dist' current
echo "当前状态已快照: $CUR"

# 恢复目标备份
rm -rf "$APP_DIR/current_bak"
mv "$APP_DIR/current" "$APP_DIR/current_bak"
mkdir -p "$APP_DIR/current"
tar xzf "$TARGET" -C "$APP_DIR"
# 备份里是 current 目录内容，还原目录名
mv "$APP_DIR/current_bak" "$APP_DIR/current_old_$(date +%s)" 2>/dev/null || true

cd "$APP_DIR/current"
npm ci --omit=dev 2>/dev/null || npm install
# web 构建需要 vite（devDependency），全量 npm ci
(cd web && npm ci 2>/dev/null || true)
(cd web && npx vite build) 2>/dev/null || echo "⚠️ 前端构建失败（老版本可能无 web/，忽略）"

pm2 restart "$PM2_NAME"
sleep 3
HEALTH=$(curl -s -m 5 "http://127.0.0.1:${PORT:-3001}/api/health" || echo '{"ok":false}')
echo "健康检查: $HEALTH"
case "$HEALTH" in
  *'"ok":true'*) echo "✅ 回滚成功" ;;
  *) echo "❌ 回滚后健康检查未通过，请人工介入"; exit 1 ;;
esac
