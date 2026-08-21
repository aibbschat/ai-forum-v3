#!/bin/bash
# aibbs.chat 域名切换脚本
# 用法：在服务器上以 root 执行
#   bash /var/www/ai-forum-v3/current/deploy/cutover-aibbs-chat.sh
#
# 做什么：
#   1. 备份当前 nginx 配置
#   2. 从 ai.xs91.com.conf 里删除老的 aibbs.chat 80/443 server 块
#   3. 把准备好的 aibbs.chat.conf 部署到 /www/server/panel/vhost/nginx/
#   4. nginx -t 校验
#   5. reload nginx
#
# 证书前置：请先把证书放到配置文件里写的路径：
#   /etc/letsencrypt/live/aibbs.chat/fullchain.pem
#   /etc/letsencrypt/live/aibbs.chat/privkey.pem
# （如果你用的是其他路径，改 aibbs.chat.nginx.conf 顶部的 ssl_certificate 两行）

set -euo pipefail

MAIN_CONF=/www/server/panel/vhost/nginx/ai.xs91.com.conf
NEW_CONF_SRC=/var/www/ai-forum-v3/current/deploy/aibbs.chat.nginx.conf
NEW_CONF=/www/server/panel/vhost/nginx/aibbs.chat.conf
TS=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR=/root/data/disk/snapshots/nginx-cutover

mkdir -p "$BACKUP_DIR"

echo "==> [1/5] 备份当前配置到 $BACKUP_DIR"
cp "$MAIN_CONF" "$BACKUP_DIR/ai.xs91.com.conf.before-aibbs-cutover-$TS"
[ -f "$NEW_CONF" ] && cp "$NEW_CONF" "$BACKUP_DIR/aibbs.chat.conf.previous-$TS" || true

echo "==> [2/5] 校验证书存在"
CERT=$(grep -E '^\s*ssl_certificate\s+' "$NEW_CONF_SRC" | head -1 | awk '{print $2}' | tr -d ';')
KEY=$(grep -E '^\s*ssl_certificate_key\s+' "$NEW_CONF_SRC" | head -1 | awk '{print $2}' | tr -d ';')
if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
  echo "❌ 证书文件不存在："
  echo "   cert: $CERT ($([ -f "$CERT" ] && echo OK || echo MISSING))"
  echo "   key:  $KEY  ($([ -f "$KEY" ] && echo OK || echo MISSING))"
  echo "请先上传证书或修改 $NEW_CONF_SRC 里的 ssl_certificate 路径"
  exit 1
fi

echo "==> [3/5] 从 $MAIN_CONF 中剥离老的 aibbs.chat server 块"
# 用 Python 按顶层 server { ... } 大括号计数，跳过包含 server_name aibbs.chat 的整块。
# 注意：只剥离"直接包含 server_name aibbs.chat"的 server 块；dl.aibbs.chat 不受影响。
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
        # 找到这个 server 块的开始（可能 { 在本行或后面几行）
        block = [line]
        j = i + 1
        depth = line.count(brace_open) - line.count(brace_close)
        # 把 server 关键字之后、{ 之前的行也吞进来（listen / server_name 不会出现在块外）
        while depth == 0 and j < n:
            block.append(lines[j])
            depth += lines[j].count(brace_open) - lines[j].count(brace_close)
            j += 1
            if depth > 0:
                break
        # 现在开始按大括号匹配直到 depth 归零
        while depth > 0 and j < n:
            block.append(lines[j])
            depth += lines[j].count(brace_open) - lines[j].count(brace_close)
            j += 1
        block_text = ''.join(block)
        # 跳过直接绑定 aibbs.chat 的 server 块（用 server_name 后面紧跟域名的精确匹配，
        # 避免匹配到注释里的"V3 接管 aibbs.chat 时请删除"或 dl.aibbs.chat 块）
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

echo "==> [4/5] 部署 $NEW_CONF"
cp "$NEW_CONF_SRC" "$NEW_CONF"

echo "==> [5/5] nginx -t 并 reload"
nginx -t
nginx -s reload

echo
echo "✅ 完成。本机自检："
curl -sI --resolve aibbs.chat:443:127.0.0.1 https://aibbs.chat/ | head -3
echo
echo "如遇问题，回滚："
echo "  cp $BACKUP_DIR/ai.xs91.com.conf.before-aibbs-cutover-$TS $MAIN_CONF"
echo "  rm $NEW_CONF"
echo "  nginx -t && nginx -s reload"
