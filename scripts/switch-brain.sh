#!/usr/bin/env bash
# scripts/switch-brain.sh — 在火山包月(volcengine)与 DeepSeek 按量(deepseek-official)之间切换 DSH 大脑
#
# 用法：
#   bash scripts/switch-brain.sh volcengine   # 切到火山 Agent Plan 包月（默认，省钱）
#   bash scripts/switch-brain.sh deepseek     # 切到 DeepSeek 官方按量（包月额度耗尽/大爆发时）
#   bash scripts/switch-brain.sh status       # 查看当前大脑
#
# 原理：改 mount bundle 里 agent-default-model 的 provider/model，DSH 下次启动即生效
# （cron 每次新起 dsh 进程，所以下一篇稿子就走新通路，无需重启任何服务）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PATCH="$ROOT/dsh/bundles/agent-presets-mount/cordis.patch.yml"

usage() {
  echo "用法: $0 {volcengine|deepseek|status}"
  exit 1
}

[ $# -ge 1 ] || usage
TARGET="$1"; shift || true

case "$TARGET" in
  status)
    grep -A2 "id: agent-default-model" "$PATCH" | grep -E "provider:|model:" | sed 's/^[[:space:]]*/  /'
    exit 0
    ;;
  volcengine|volc|ark)
    PROVIDER="volcengine"; MODEL="ark-code-latest"
    ;;
  deepseek|ds|official)
    PROVIDER="deepseek-official"; MODEL="deepseek-v4-flash"
    ;;
  *)
    usage
    ;;
esac

# 用临时文件原地替换 agent-default-model 段的两行（provider/model）
python3 - "$PATCH" "$PROVIDER" "$MODEL" <<'PY'
import sys, re
path, provider, model = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read()
# 匹配 agent-default-model 段，替换其后的 provider/model
pat = re.compile(
    r'(- id: agent-default-model\n  config:\n    provider: )\S+(\n    model: )\S+',
)
new = f'\\g<1>{provider}\\g<2>{model}'
s2, n = pat.subn(new, s)
if n != 1:
    sys.exit(f"ERROR: 期望替换 1 处，实际 {n} 处（agent-default-model 段未找到或结构异常）")
open(path, "w").write(s2)
print(f"switched brain → provider={provider} model={model}")
PY

echo "下一次 DSH 启动即生效（cron 下一篇稿子自动走新通路）。"
