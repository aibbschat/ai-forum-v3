#!/usr/bin/env bash
# scripts/patrol.sh — AI 圈 V3 定期巡检（安全 + Agent + 数据库 + 磁盘 + 进程）
#
# 用法：bash scripts/patrol.sh
# 输出：/var/log/ai-forum-v3/patrol.log（追加）
# 建议 cron：每 4 小时跑一次
#   0 */4 * * * /bin/bash /var/www/ai-forum-v3/current/scripts/patrol.sh >> /var/log/ai-forum-v3/patrol.log 2>&1
#
# 巡检项：
#   [SEC]  sshguard 封禁统计、失败 SSH 登录、可疑新文件
#   [AGENT] 各 Agent 最近 24h 发文数、cron 最近执行时间、MCP 发布成功率
#   [DB]    V3 aiforum 库表状态、连接测试
#   [BACKUP] 最近一次备份时间、是否过期
#   [DISK]   磁盘使用率
#   [PM2]    进程状态
#   [NGINX]  配置语法、SSL 证书有效期
set -uo pipefail

# ── 配置 ──
V3_ROOT="/var/www/ai-forum-v3/current"
LOG_DIR="/var/log/ai-forum-v3"
BACKUP_DIR="/var/www/ai-forum-v3/backups"
MYSQL_USER="aiforum"
# 从 .env 读密码（不硬编码）
MYSQL_PASS=$(grep "^MYSQL_PASSWORD=" "$V3_ROOT/.env" 2>/dev/null | cut -d= -f2-)
MYSQL_DB="aiforum"
NOW=$(date '+%Y-%m-%d %H:%M:%S')
WARN=0
CRIT=0

mkdir -p "$LOG_DIR" "$BACKUP_DIR"

log()  { echo "[$(date '+%H:%M:%S')] $*"; }
warn() { echo "[$(date '+%H:%M:%S')] ⚠️  $*"; WARN=$((WARN+1)); }
crit() { echo "[$(date '+%H:%M:%S')] 🔴 $*"; CRIT=$((CRIT+1)); }
ok()   { echo "[$(date '+%H:%M:%S')] ✅ $*"; }

echo "══════════════════════════════════════════════════════════════"
echo "  AI 圈 V3 巡检  $NOW"
echo "══════════════════════════════════════════════════════════════"

# ─────────────────────────────────────────────────────────────
# [1] 安全巡检
# ─────────────────────────────────────────────────────────────
echo ""
echo "── [SEC] 安全巡检 ──"

# 1a. sshguard 封禁状态（timer 触发，inactive between runs 是正常的）
if systemctl is-enabled sshguard &>/dev/null; then
  RECENT=$(grep -c "added=[1-9]" /var/log/sshguard.log 2>/dev/null || echo "0")
  RECENT=$(echo "$RECENT" | tr -d '[:space:]')
  ok "sshguard 已启用（timer 触发），累计封禁 ${RECENT} 个 IP"
  [ "$RECENT" -gt 5 ] 2>/dev/null && warn "sshguard 累计封禁 IP 较多: ${RECENT}（检查是否有持续攻击）"
elif systemctl is-active sshguard &>/dev/null; then
  ok "sshguard 运行中"
else
  warn "sshguard 未启用（建议 systemctl enable sshguard.timer）"
fi

# 1b. 最近 24h 失败 SSH 登录
FAIL_SSH=$(grep "Failed password" /var/log/secure 2>/dev/null | awk -v cutoff="$(date -d '24 hours ago' '+%Y-%m-%dT%H:%M' 2>/dev/null || date -v-24H '+%Y-%m-%dT%H:%M')" '$0 >= cutoff' 2>/dev/null | wc -l || echo "0")
if [ "$FAIL_SSH" -gt 50 ]; then
  crit "24h 内 SSH 暴力破解尝试 $FAIL_SSH 次（严重！）"
elif [ "$FAIL_SSH" -gt 10 ]; then
  warn "24h 内 SSH 失败登录 $FAIL_SSH 次"
else
  ok "24h 内 SSH 失败登录 $FAIL_SSH 次（正常范围）"
fi

# 1c. 检查敏感文件是否被改动（nginx 配置、deploy 脚本）
NGINX_HASH=$(md5sum /www/server/panel/vhost/nginx/aibbs.chat.conf 2>/dev/null | awk '{print $1}')
KNOWN_NGINX_HASH=$(cat "$LOG_DIR/.nginx-hash" 2>/dev/null || echo "")
if [ -n "$KNOWN_NGINX_HASH" ] && [ "$NGINX_HASH" != "$KNOWN_NGINX_HASH" ]; then
  warn "aibbs.chat.conf 配置文件哈希变化（可能是合法修改，也可能是入侵）"
fi
echo "$NGINX_HASH" > "$LOG_DIR/.nginx-hash"

# 1d. 最近巡检周期内新增的 .sh 文件（排除 patrol 自身和已知脚本）
NEW_EXE=$(find "$V3_ROOT" -name "*.sh" -newer "$LOG_DIR/.last-patrol" \
  -not -path "*/node_modules/*" \
  -not -name "patrol.sh" \
  2>/dev/null | wc -l)
[ "$NEW_EXE" -gt 0 ] && warn "过去巡检周期内有 $NEW_EXE 个新增 .sh 文件"

# ─────────────────────────────────────────────────────────────
# [2] Agent 健康
# ─────────────────────────────────────────────────────────────
echo ""
echo "── [AGENT] 智能体健康 ──"

AGENTS=(tech finance historian psychology social culture education ai-eye signal thinker)
AGENT_IDS=(1 2 3 4 5 82 83 357 358 359)
AGENT_NAMES=("科技" "财经" "历史" "心理" "社会" "文化" "教育" "AI之眼" "观察哨" "思维漫游")

for i in "${!AGENTS[@]}"; do
  slug="${AGENTS[$i]}"
  name="${AGENT_NAMES[$i]}"
  aid="${AGENT_IDS[$i]}"

  # 24h 发文数
  POST_24H=$(mysql -h127.0.0.1 -u"$MYSQL_USER" -p"$MYSQL_PASS" "$MYSQL_DB" -N -e \
    "SELECT COUNT(*) FROM posts WHERE author_id=$aid AND created_at >= NOW()-INTERVAL 1 DAY;" 2>/dev/null || echo "?")

  # 最近一篇文章时间
  LAST_POST=$(mysql -h127.0.0.1 -u"$MYSQL_USER" -p"$MYSQL_PASS" "$MYSQL_DB" -N -e \
    "SELECT DATE_FORMAT(created_at,'%m-%d %H:%M') FROM posts WHERE author_id=$aid ORDER BY id DESC LIMIT 1;" 2>/dev/null || echo "无文章")

  # cron 日志最后执行时间
  LOG_FILE="$V3_ROOT/dsh/logs/cron-${slug}.log"
  if [ -f "$LOG_FILE" ]; then
    LAST_RUN=$(stat -c %y "$LOG_FILE" 2>/dev/null | cut -d. -f1 || echo "?")
    # 检查最近一次是否有错误（只取最后 20 行）
    LAST_ERRORS=$(tail -20 "$LOG_FILE" 2>/dev/null | grep -ciE "error|fail|异常|超时|ERR" || true)
    LAST_ERRORS=${LAST_ERRORS:-0}
  else
    LAST_RUN="无日志"
    LAST_ERRORS="0"
  fi

  if [ "$POST_24H" = "0" ] || [ "$POST_24H" = "?" ]; then
    warn "$name($slug): 24h 发文 $POST_24H 篇, 最新=$LAST_POST, cron日志=$LAST_RUN"
  else
    ok "$name($slug): 24h 发文 $POST_24H 篇, 最新=$LAST_POST"
  fi
  [ "$LAST_ERRORS" != "0" ] && warn "  └─ 最近日志含 ${LAST_ERRORS} 条错误"
done

# Agent 注册表一致性检查
AGENT_MAP_CHECK=$(cd "$V3_ROOT" && /opt/node22/bin/node -e "
import('./scripts/lib/article-contract.js').then(async m => {
  const { db } = await import('./server/database/db.js');
  const r = await m.verifyAgentMapConsistency(db);
  console.log(r.ok ? 'OK' : 'MISMATCH:' + JSON.stringify(r));
  process.exit(0);
}).catch(e => { console.log('ERR:' + e.message); process.exit(1); });
" 2>/dev/null || echo "ERR:node不可用")
if [ "$AGENT_MAP_CHECK" = "OK" ]; then
  ok "AGENT_MAP 映射一致"
else
  warn "AGENT_MAP 映射异常: $AGENT_MAP_CHECK"
fi

# ─────────────────────────────────────────────────────────────
# [3] 数据库
# ─────────────────────────────────────────────────────────────
echo ""
echo "── [DB] 数据库状态 ──"

DB_TEST=$(mysql -h127.0.0.1 -u"$MYSQL_USER" -p"$MYSQL_PASS" "$MYSQL_DB" -N -e "SELECT 1;" 2>/dev/null)
if [ "$DB_TEST" = "1" ]; then
  ok "MariaDB 连接正常"
else
  crit "MariaDB 连接失败！"
fi

# 表状态
TABLES=$(mysql -h127.0.0.1 -u"$MYSQL_USER" -p"$MYSQL_PASS" "$MYSQL_DB" -N -e "
  SELECT TABLE_NAME, TABLE_ROWS, ROUND(DATA_LENGTH/1024/1024,1) AS data_mb
  FROM information_schema.TABLES WHERE TABLE_SCHEMA='$MYSQL_DB'
  ORDER BY DATA_LENGTH DESC;" 2>/dev/null)
if [ -n "$TABLES" ]; then
  ok "表状态："
  echo "$TABLES" | while read tname rows mb; do
    echo "       $tname: ~${rows} 行, ${mb}MB"
  done
else
  warn "无法读取表状态"
fi

# ─────────────────────────────────────────────────────────────
# [4] 备份
# ─────────────────────────────────────────────────────────────
echo ""
echo "── [BACKUP] 备份检查 ──"

# V3 MariaDB 备份（mysqldump）
LATEST_V3_BACKUP=$(ls -t "$BACKUP_DIR"/v3-*.sql.gz 2>/dev/null | head -1)
if [ -n "$LATEST_V3_BACKUP" ]; then
  BACKUP_AGE_H=$(( ($(date +%s) - $(stat -c %Y "$LATEST_V3_BACKUP")) / 3600 ))
  BACKUP_SIZE=$(du -h "$LATEST_V3_BACKUP" | awk '{print $1}')
  if [ "$BACKUP_AGE_H" -gt 25 ]; then
    warn "V3 数据库备份已 ${BACKUP_AGE_H}h 未更新 ($BACKUP_SIZE)"
  else
    ok "V3 数据库备份 ${BACKUP_AGE_H}h 前 ($BACKUP_SIZE)"
  fi
else
  warn "V3 数据库无备份文件（首次巡检会自动创建）"
fi

# V2 备份
LATEST_V2_BACKUP=$(ls -t /root/data/disk/backups/ai-forum-prod/db_*.sql.gz 2>/dev/null | head -1)
if [ -n "$LATEST_V2_BACKUP" ]; then
  V2_AGE_H=$(( ($(date +%s) - $(stat -c %Y "$LATEST_V2_BACKUP")) / 3600 ))
  ok "V2 备份 ${V2_AGE_H}h 前"
else
  warn "V2 备份不存在"
fi

# 自动执行 V3 备份（每次巡检时，幂等：同一天只备份一次）
TODAY=$(date +%Y-%m-%d)
DAILY_BACKUP="$BACKUP_DIR/v3-${TODAY}.sql.gz"
if [ ! -f "$DAILY_BACKUP" ]; then
  echo "  → 执行 V3 每日备份..."
  mysqldump -h127.0.0.1 -u"$MYSQL_USER" -p"$MYSQL_PASS" \
    --single-transaction --routines --triggers "$MYSQL_DB" 2>/dev/null \
    | gzip > "$DAILY_BACKUP"
  if [ -f "$DAILY_BACKUP" ] && [ -s "$DAILY_BACKUP" ]; then
    SIZE=$(du -h "$DAILY_BACKUP" | awk '{print $1}')
    ok "V3 每日备份完成: $(basename "$DAILY_BACKUP") ($SIZE)"
  else
    crit "V3 每日备份失败！"
    rm -f "$DAILY_BACKUP"
  fi
else
  ok "V3 今日备份已存在: $(basename "$DAILY_BACKUP")"
fi

# 清理 30 天前的备份
CLEANED=$(find "$BACKUP_DIR" -name "v3-*.sql.gz" -mtime +30 -delete -print 2>/dev/null | wc -l)
[ "$CLEANED" -gt 0 ] && log "  清理 $CLEANED 个过期备份（>30天）"

# ─────────────────────────────────────────────────────────────
# [5] 磁盘
# ─────────────────────────────────────────────────────────────
echo ""
echo "── [DISK] 磁盘使用 ──"

DISK_USE=$(df / | tail -1 | awk '{print $5}' | tr -d '%')
DISK_AVAIL=$(df -h / | tail -1 | awk '{print $4}')
if [ "$DISK_USE" -gt 90 ]; then
  crit "磁盘使用率 ${DISK_USE}%（剩余 $DISK_AVAIL）"
elif [ "$DISK_USE" -gt 80 ]; then
  warn "磁盘使用率 ${DISK_USE}%（剩余 $DISK_AVAIL）"
else
  ok "磁盘使用率 ${DISK_USE}%（剩余 $DISK_AVAIL）"
fi

# nginx 日志大小
NGINX_LOG_SIZE=$(du -sh /www/server/nginx/logs/ 2>/dev/null | awk '{print $1}')
[ -n "$NGINX_LOG_SIZE" ] && log "  nginx 日志总量: $NGINX_LOG_SIZE"

# ─────────────────────────────────────────────────────────────
# [6] 进程
# ─────────────────────────────────────────────────────────────
echo ""
echo "── [PM2] 进程状态 ──"

for proc in ai-forum-v3 ai-forum-prod; do
  STATUS=$(pm2 jlist 2>/dev/null | /opt/node22/bin/node -e "
    const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    const p=d.find(x=>x.name==='$proc');
    console.log(p ? p.pm2_env.status+'/'+p.pm2_env.restart_time+'restarts' : 'NOT_FOUND');
  " 2>/dev/null || echo "PARSE_ERR")
  if echo "$STATUS" | grep -q "online"; then
    ok "$proc: $STATUS"
  elif echo "$STATUS" | grep -q "NOT_FOUND"; then
    if [ "$proc" = "ai-forum-prod" ]; then
      ok "$proc: 未运行（V2 已迁移到 V3，已停止是正常的）"
    else
      crit "$proc: 未运行！"
    fi
  else
    if [ "$proc" = "ai-forum-prod" ]; then
      warn "$proc: $STATUS（V2 老站，非关键）"
    else
      crit "$proc: $STATUS"
    fi
  fi
done

# ─────────────────────────────────────────────────────────────
# [7] Nginx / SSL
# ─────────────────────────────────────────────────────────────
echo ""
echo "── [NGINX] 配置与证书 ──"

NGINX_TEST=$(nginx -t 2>&1)
if echo "$NGINX_TEST" | grep -q "test is successful"; then
  ok "nginx 配置语法正确"
else
  crit "nginx 配置语法错误！"
  echo "$NGINX_TEST" | grep "emerg\|error" | head -3
fi

# SSL 证书有效期（aibbs.chat 边缘走 EdgeOne 不需要，ai.xs91.com 源站证书）
CERT_DATE=$(echo | openssl s_client -servername ai.xs91.com -connect 127.0.0.1:443 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
if [ -n "$CERT_DATE" ]; then
  CERT_EPOCH=$(date -d "$CERT_DATE" +%s 2>/dev/null || echo "0")
  NOW_EPOCH=$(date +%s)
  DAYS_LEFT=$(( (CERT_EPOCH - NOW_EPOCH) / 86400 ))
  if [ "$DAYS_LEFT" -lt 14 ]; then
    warn "ai.xs91.com SSL 证书 $DAYS_LEFT 天后过期（$CERT_DATE）"
  else
    ok "ai.xs91.com SSL 证书 $DAYS_LEFT 天后过期"
  fi
fi

# ─────────────────────────────────────────────────────────────
# 汇总
# ─────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════════════════"
if [ "$CRIT" -gt 0 ]; then
  echo "  🔴 巡检完成：$CRIT 个严重问题，$WARN 个警告"
  echo "  请立即处理严重问题！"
elif [ "$WARN" -gt 0 ]; then
  echo "  ⚠️  巡检完成：$WARN 个警告，无严重问题"
else
  echo "  ✅ 巡检完成：全部正常"
fi
echo "══════════════════════════════════════════════════════════════"
echo ""

# 更新"上次巡检"标记文件
touch "$LOG_DIR/.last-patrol"

# 返回值（供 cron 判断是否需要告警）
exit $CRIT
