#!/bin/bash
# aibbs.chat 域名切换脚本
# 用法：在服务器上以 root 执行
#   bash /var/www/ai-forum-v3/current/deploy/cutover-aibbs-chat.sh
#
# 做什么：
#   1. 备份当前 nginx 配置
#   2. 从 ai.xs91.com.conf 里删除老的 aibbs.chat 80/443 server 块
#   3. 把准备好的 aibbs.chat.conf + aibbs.chat.locations.conf 部署到 /www/server/panel/vhost/nginx/
#   4. nginx -t 校验
#   5. reload nginx
#
# 架构说明：
#   用户 → 腾讯云 EdgeOne（边缘证书自动续期）→ HTTP 回源 → 本服务器 :80
#   源站不需要签 aibbs.chat 证书；80 端口直接服务 V3，不做 80→443 跳转。
#   同时保留 :443 块（复用现有 ai.xs91.com 证书），应对协议跟随回源或临时直连排障。
#   EdgeOne 如校验源站证书会因 SAN 不匹配失败，请在 EdgeOne 控制台关闭"源站证书校验"。

set -euo pipefail

MAIN_CONF=/www/server/panel/vhost/nginx/ai.xs91.com.conf
DEPLOY_DIR=/var/www/ai-forum-v3/current/deploy
NEW_CONF_SRC=$DEPLOY_DIR/aibbs.chat.nginx.conf
LOCATIONS_SRC=$DEPLOY_DIR/aibbs.chat.locations.conf
NEW_CONF=/www/server/panel/vhost/nginx/aibbs.chat.conf
LOCATIONS_CONF=/www/server/panel/vhost/nginx/aibbs.chat.locations.conf
TS=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR=/root/data/disk/snapshots/nginx-cutover

mkdir -p "$BACKUP_DIR"

echo "==> [1/5] 备份当前配置到 $BACKUP_DIR"
cp "$MAIN_CONF" "$BACKUP_DIR/ai.xs91.com.conf.before-aibbs-cutover-$TS"
[ -f "$NEW_CONF" ] && cp "$NEW_CONF" "$BACKUP_DIR/aibbs.chat.conf.previous-$TS" || true
[ -f "$LOCATIONS_CONF" ] && cp "$LOCATIONS_CONF" "$BACKUP_DIR/aibbs.chat.locations.conf.previous-$TS" || true

echo "==> [2/5] 校验部署文件存在"
[ -f "$NEW_CONF_SRC" ]   || { echo "❌ 缺少 $NEW_CONF_SRC"; exit 1; }
[ -f "$LOCATIONS_SRC" ]  || { echo "❌ 缺少 $LOCATIONS_SRC"; exit 1; }
echo "   ✓ 两个 conf 都在"

# 检查 443 块使用的证书（复用 ai.xs91.com 的，不需要 aibbs.chat 专用证书）
CERT=$(grep -E '^\s*ssl_certificate\s+' "$NEW_CONF_SRC" | head -1 | awk '{print $2}' | tr -d ';')
if [ ! -f "$CERT" ]; then
  echo "⚠️  443 块复用的证书不存在：$CERT（仅影响协议跟随 HTTPS 回源；HTTP 回源不受影响）"
fi

echo "==> [3/5] 从 $MAIN_CONF 中剥离老的 aibbs.chat server 块"
python3 - "$MAIN_CONF" "$MAIN_CONF.new" <<'PY'
import sys, re
src, dst = sys.argv[1], sys.argv[2]
with open(src) as f:
    lines = f.readlines()

out = []
i = 0
n = len(lines)
server_start = re.compile(r'^\s*server\b')
brace_open = '{'
brace_close = '}'

while i < n:
    line = lines[i]
    if server_start.match(line):
        block = [line]
        j = i + 1
        depth = line.count(brace_open) - line.count(brace_close)
        while depth == 0 and j < n:
            block.append(lines[j])
            depth += lines[j].count(brace_open) - lines[j].count(brace_close)
            j += 1
            if depth > 0:
                break
        while depth > 0 and j < n:
            block.append(lines[j])
            depth += lines[j].count(brace_open) - lines[j].count(brace_close)
            j += 1
        block_text = ''.join(block)
        if re.search(r'server_name\s+aibbs\.chat\s*;', block_text):
            i = j
            continue
        out.extend(block)
        i = j
    else:
        out.append(line)
        i += 1

with open(dst, 'w') as f:
    f.writelines(out)
PY

if ! grep -qE '^\s*server_name\s+aibbs\.chat\s*;' "$MAIN_CONF.new"; then
  echo "   ✓ 已从主配置移除 aibbs.chat 443/80 server 块"
else
  echo "⚠️ 主配置里还能找到 server_name aibbs.chat，请手工检查"
fi
echo "   dl.aibbs.chat 块保留：$(grep -c 'server_name dl.aibbs.chat' "$MAIN_CONF.new") 处"
mv "$MAIN_CONF.new" "$MAIN_CONF"

echo "==> [4/5] 部署新配置"
cp "$NEW_CONF_SRC"  "$NEW_CONF"
cp "$LOCATIONS_SRC" "$LOCATIONS_CONF"
echo "   ✓ $NEW_CONF"
echo "   ✓ $LOCATIONS_CONF"

echo "==> [5/5] nginx -t 并 reload"
nginx -t
nginx -s reload

echo
echo "✅ 完成。本机自检："
echo "--- HTTP（EdgeOne 回源走这个）---"
curl -sI --resolve aibbs.chat:80:127.0.0.1 http://aibbs.chat/ | head -3
echo "--- /api/health via HTTP ---"
curl -s --resolve aibbs.chat:80:127.0.0.1 http://aibbs.chat/api/health
echo
echo
echo "接下来在腾讯云 EdgeOne 控制台："
echo "  1. 确认 aibbs.chat 源站指向 212.64.18.62"
echo "  2. 回源协议选 HTTP（不要选 HTTPS 或协议跟随）"
echo "  3. 若用协议跟随，把\"源站证书校验\"关掉（源站证书 SAN 只有 ai.xs91.com）"
echo
echo "回滚命令（出问题时执行）："
echo "  cp $BACKUP_DIR/ai.xs91.com.conf.before-aibbs-cutover-$TS $MAIN_CONF"
echo "  rm -f $NEW_CONF $LOCATIONS_CONF"
echo "  nginx -t && nginx -s reload"
