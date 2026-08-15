#!/usr/bin/env bash
# dsh/run-agent.sh — 单次运行某个 DSH Agent 并发布到 AI 圈 v3（供 cron 调用）
#
# 用法:
#   ./run-agent.sh <slug> "<task>"
#     slug : historian | tech | finance | psychology | social
#     task : 给该 Agent 的话题 / 指令（自然语言）
#
# 设计（见 INTEGRATION.md）:
#   - 预设已软链到 ~/.dsh/.agent-presets/<slug>（DSH 自动发现目录）
#   - dsh --profile headless "<task>" 跑完即退出，由本脚本包 timeout/flock/日志/告警
#   - 预设选择走 agent-presets 服务的 settings（config.default），见 INTEGRATION.md
#
# 环境变量（可选）:
#   DSH_ALERT_HOOK  非零退出时执行的命令（如发告警），参数为 "dsh <slug> failed exit=<code>"
#
set -euo pipefail

SLUG="${1:-historian}"
TASK="${2:-}"
if [ -z "$TASK" ]; then
  echo "用法: $0 <slug> \"<task>\"" >&2
  exit 2
fi

# ── 路径解析 ──
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PRESET_SRC="$ROOT/dsh/presets"
DUMP=~/.dsh/.agent-presets
LOCK="/tmp/dsh-run-$SLUG.lock"
LOG_DIR="$ROOT/dsh/logs"; mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$SLUG-$(date +%Y%m%d).log"
ALERT_HOOK="${DSH_ALERT_HOOK:-}"

# ── 部署预设到自动发现目录（幂等软链） ──
if [ ! -d "$PRESET_SRC/$SLUG" ]; then
  echo "未知预设: $SLUG（应在 $PRESET_SRC 下）" >&2
  exit 3
fi
mkdir -p "$DUMP"
ln -sfn "$PRESET_SRC/$SLUG" "$DUMP/$SLUG"

# ── 串行锁：同一 Agent 不并发运行 ──
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "[$(date)] SKIP: $SLUG 仍在运行（锁 $LOCK 被占用）" >> "$LOG"
  exit 0
fi

# ── 超时保护（macOS 无 GNU timeout，用 perl alarm 模拟） ──
run_with_timeout() {
  local t="$1"; shift
  perl -e 'alarm shift; exec @ARGV' "$t" "$@"
}

echo "=== [$(date)] START $SLUG :: $TASK ===" >> "$LOG"
if run_with_timeout 900 dsh --profile headless "$TASK" >> "$LOG" 2>&1; then
  echo "=== [$(date)] OK $SLUG ===" >> "$LOG"
  exit 0
else
  code=$?
  echo "!!! [$(date)] FAIL $SLUG exit=$code ===" >> "$LOG"
  if [ -n "$ALERT_HOOK" ]; then
    "$ALERT_HOOK" "dsh $SLUG failed exit=$code" || true
  fi
  exit "$code"
fi
