#!/usr/bin/env bash
# dsh/run-agent.sh — 单次运行某个 DSH Agent：成稿 → 文件交接 → 发布到 AI 圈 v3（供 cron 调用）
#
# 用法:
#   ./run-agent.sh <slug> "<task>"
#     slug : historian | tech | finance | psychology | social
#     task : 给该 Agent 的话题 / 指令（自然语言）
#
# 工作机制（见 dsh/INTEGRATION.md "文件交接方案"）:
#   - 预设由 dsh/bundles/agent-presets-mount 的 agent-presets.default 决定；
#     本脚本会把 default 临时切到 <slug>（用完还原），从而让 headless 跑对应预设。
#   - dsh --profile headless 跑任务，Agent 用 web_search 感知时事、写稿，
#     并按任务里给定的路径把成稿写成纯 JSON 文件（文件交接，绕开 DSH 预览版
#     不加载自定义插件 + 本机沙箱禁用 shell 的双重限制）。
#   - dsh 退出后，本脚本读取该 JSON 草稿，调发布桥落库。
#
# 环境变量（可选）:
#   DSH_ALERT_HOOK  非零退出时执行的命令（如发告警），参数为 "dsh <slug> failed <reason>"
#   DSH_TIMEOUT     单次 dsh 超时秒数（默认 900）
#
set -uo pipefail

# dsh 装在 /usr/local/bin（与 cron 调用方可能漏配 /usr/local/bin 的 PATH 解耦）：
# 脚本自身保证 PATH 含该目录，避免 command -v dsh 失败回落到错误路径。
export PATH="/usr/local/bin:/usr/local/lib/node_modules/.bin:$PATH"

SLUG="${1:-tech}"
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
MOUNT_PATCH="$ROOT/dsh/bundles/agent-presets-mount/cordis.patch.yml"
LOCKDIR="/tmp/dsh-run-$SLUG.lock.d"
SWITCH_LOCKDIR="$ROOT/dsh/.preset-switch.lock.d"
LOG_DIR="$ROOT/dsh/logs"; mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$SLUG-$(date +%Y%m%d).log"
ALERT_HOOK="${DSH_ALERT_HOOK:-}"
TIMEOUT="${DSH_TIMEOUT:-900}"
DSH_BIN="$(command -v dsh 2>/dev/null || ls /usr/local/bin/dsh /usr/bin/dsh 2>/dev/null | head -1)"
if [ -z "$DSH_BIN" ]; then
  echo "!!! 找不到 dsh 可执行文件（PATH=$(echo "$PATH")）" >&2
  exit 3
fi

# ── 部署预设到自动发现目录（幂等软链） ──
if [ ! -d "$PRESET_SRC/$SLUG" ]; then
  echo "未知预设: $SLUG（应在 $PRESET_SRC 下）" >&2
  exit 3
fi
mkdir -p "$DUMP"
ln -sfn "$PRESET_SRC/$SLUG" "$DUMP/$SLUG"

# ── 预设选择：把 mount patch 的 default 临时切到 $SLUG，退出时还原 ──
ORIG_DEFAULT="$(grep -E '^[[:space:]]*default:' "$MOUNT_PATCH" | head -1 | sed -E 's/.*default:[[:space:]]*//; s/[[:space:]]*$//')"
patch_set_default() {
  local f="$1" v="$2" tmp="${1}.tmp.$$"
  awk -v val="$v" 'BEGIN{m=0} /^[[:space:]]*default:/ && m==0 {sub(/default:.*/, "default: " val); m=1} {print}' "$f" > "$tmp" && mv "$tmp" "$f"
}
restore_default() { patch_set_default "$MOUNT_PATCH" "$ORIG_DEFAULT"; }

# 跨平台文件锁（macOS 无 flock）：用 mkdir 原子创建锁目录，带陈旧清理
# 注意：stat -f %m 是 macOS 语法，在 Linux(GNU stat)上行为不同会报错；
#       故陈旧判断统一改用跨平台的 `date -r <dir> +%s`。
acquire_lock() {
  local dir="$1" stale=1200
  # 常见路径：锁不存在 → 直接建锁，无需 stat
  if mkdir "$dir" 2>/dev/null; then return 0; fi
  # 锁已存在：计算陈旧度（跨平台 mtime 取法）
  local mtime=0
  mtime=$(date -r "$dir" +%s 2>/dev/null || echo 0)
  local age=$(( $(date +%s) - ${mtime:-0} ))
  if [ "$age" -gt "$stale" ]; then
    rmdir "$dir" 2>/dev/null
    mkdir "$dir" 2>/dev/null && return 0
  fi
  return 1
}

cleanup() {
  restore_default 2>/dev/null
  rmdir "$SWITCH_LOCKDIR" 2>/dev/null
  rmdir "$LOCKDIR" 2>/dev/null
}
trap cleanup EXIT

# 跨预设切换锁（避免不同 slug 并发改同一 mount patch）
if ! acquire_lock "$SWITCH_LOCKDIR"; then
  echo "[$(date)] SKIP: 另一预设切换进行中（锁 $SWITCH_LOCKDIR 被占用）" >> "$LOG"
  exit 0
fi
if [ "$ORIG_DEFAULT" != "$SLUG" ]; then
  echo "[$(date)] switch agent-presets.default: $ORIG_DEFAULT -> $SLUG" >> "$LOG"
  patch_set_default "$MOUNT_PATCH" "$SLUG"
fi

# ── 串行锁：同一 Agent 不并发运行 ──
if ! acquire_lock "$LOCKDIR"; then
  echo "[$(date)] SKIP: $SLUG 仍在运行（锁 $LOCKDIR 被占用）" >> "$LOG"
  exit 0
fi

# ── 成稿输出文件（Agent 会按任务指令写入此路径） ──
OUT_DIR="$ROOT/drafts/$SLUG"; mkdir -p "$OUT_DIR"
OUT_FILE="$OUT_DIR/run-$(date +%Y%m%d-%H%M%S).json"
TMP_TTY="$LOG_DIR/$SLUG-$(date +%Y%m%d-%H%M%S).tty"

# ── 通用写作戒律（单一来源 dsh/presets/_shared/写作戒律.md，所有 Agent 继承）──
WRITING_GUIDE="$(cat "$PRESET_SRC/_shared/写作戒律.md" 2>/dev/null || true)"

# ── 将"写入该 JSON 文件"的指令拼入任务（bash 展开 $TASK/$SLUG/$OUT_FILE） ──
read -r -d '' FULL_TASK <<EOF
$TASK

【写作戒律（必读，成文前逐条自检）】
$WRITING_GUIDE

【成稿存档指令】你完成文章后，必须将最终成稿以严格合法 JSON 写入文件：$OUT_FILE
要求：
1. 该文件内容只能是纯 JSON 文本，不要使用代码块语法包裹，不要写任何额外说明文字。
2. JSON 字段（键与字符串都用双引号；不要注释、不要多余逗号）：
   {
     "title": "文章标题",
     "content": "正文 Markdown（可含小标题、引用、列表）",
     "category": "科技",
     "tags": ["具体领域标签"],
     "readingTime": 1,
     "thinkingSnippet": "成稿过程中你最想分享的一个灵感或洞察：一句话，≤40字，口语化、有具体信息量、不标题党、不用问句。它会被展示在「思想广场」供读者围观你的实时思考，不是文章摘要。",
     "provenance": {
       "agent": "$SLUG",
       "model": "你实际使用的模型名",
       "sources": [ { "title": "...", "publisher": "...", "date": "YYYY-MM", "url": "可选" } ],
       "confidence": 0.8
     }
   }
   （historian 的 sources 用 { "title", "author", "dynasty", "source" } 形式；其余用 publisher/date。）
   thinkingSnippet 是必填项之一（哪怕只写一句）——它代表你作为专家此刻的真实思考，比文章更轻、更活。
3. 你不需要、也不能自行调用任何发布工具；发布由平台调度脚本统一完成。只写这一个文件。
EOF

# ── 超时保护（macOS 无 GNU timeout，用 perl alarm 模拟；script 提供伪终端强制刷新） ──
run_with_timeout() {
  local t="$1"; shift
  perl -e 'alarm shift; exec @ARGV' "$t" "$@"
}

echo "=== [$(date)] START $SLUG :: $TASK ===" >> "$LOG"
set +e
# DSH_LAUNCH：可选启动前缀（如服务器需 `node --expose-internals`，NODE_OPTIONS 不允许该旗标）
# DSH_NO_TTY=1：跳过 script 伪终端包装（node22 下 dsh 直接跑即刷新 stdout；
#               script 会误吞 LAUNCH 里的 --expose-internals 这类选项，故服务器用此开关）
LAUNCH=()
if [ -n "${DSH_LAUNCH:-}" ]; then
  # shellcheck disable=SC2206
  LAUNCH=($DSH_LAUNCH)
fi
if [ "${DSH_NO_TTY:-0}" = "1" ]; then
  run_with_timeout "$TIMEOUT" "${LAUNCH[@]}" "$DSH_BIN" --profile headless "$FULL_TASK" >> "$LOG" 2>&1
else
  run_with_timeout "$TIMEOUT" script -q "$TMP_TTY" "${LAUNCH[@]}" "$DSH_BIN" --profile headless "$FULL_TASK" >> "$LOG" 2>&1
fi
DSH_CODE=$?
set -e
echo "=== [$(date)] DSH EXIT=$DSH_CODE (out=$OUT_FILE) ===" >> "$LOG"

# ── 文件交接：读取成稿 ──
if [ ! -f "$OUT_FILE" ]; then
  echo "!!! [$(date)] NO DRAFT $SLUG (expected $OUT_FILE) ===" >> "$LOG"
  [ -n "$ALERT_HOOK" ] && "$ALERT_HOOK" "dsh $SLUG produced no draft" || true
  exit 7
fi
echo "=== [$(date)] DRAFT FOUND $OUT_FILE ===" >> "$LOG"

# 草稿模式：只产出草稿、不自动发布（供 BrainAdapter 接沉淀闭环统一发布，避免双重发布）
if [ "${DSH_DRAFT_ONLY:-0}" = "1" ]; then
  echo "=== [$(date)] DRAFT-ONLY $SLUG (skip publish; out=$OUT_FILE) ===" >> "$LOG"
  exit 0
fi

# 标准模式：直接调发布桥落库（cron 单跑用）
if node "$ROOT/scripts/publish-article.js" --file "$OUT_FILE" --slug "$SLUG" >> "$LOG" 2>&1; then
  echo "=== [$(date)] PUBLISHED $SLUG ===" >> "$LOG"
  exit 0
else
  code=$?
  echo "!!! [$(date)] PUBLISH FAILED $SLUG exit=$code ===" >> "$LOG"
  [ -n "$ALERT_HOOK" ] && "$ALERT_HOOK" "dsh $SLUG publish failed" || true
  exit "$code"
fi
