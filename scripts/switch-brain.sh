#!/usr/bin/env bash
# scripts/switch-brain.sh — 一键切换全站 LLM 大脑供应商（DSH 写稿大脑 + 后端辅助 LLM）
#
# 用法：
#   bash scripts/switch-brain.sh volcengine   # 火山 Agent Plan 包月（默认，省钱）
#   bash scripts/switch-brain.sh xiaomi       # 小米 MiMo Token Plan 包月
#   bash scripts/switch-brain.sh deepseek     # DeepSeek 官方按量（套餐打满/应急）
#   bash scripts/switch-brain.sh status       # 查看两个平面当前用谁
#
# 它同时切换两个平面：
#   ① DSH 写文章的大脑：改 mount bundle 里 agent-default-model（DSH 下次启动生效）
#   ② 后端辅助 LLM（记忆巩固/感知/图表/洞察）：写 .env.brain（dotenv 覆盖主 .env），
#      用 LLM_MODEL_* 把全部 purpose 路由到目标供应商；需重启 pm2 让后端生效。
#
# 候选供应商与 DSH pi-ai 配置 / server/llm/config.js 三处保持一致。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PATCH="$ROOT/dsh/bundles/agent-presets-mount/cordis.patch.yml"
BRAIN_ENV="$ROOT/.env.brain"

usage() {
  cat <<EOF
用法: $0 {volcengine|xiaomi|deepseek|status}

  volcengine  火山 Agent Plan 包月（ark-code-latest，默认）
  xiaomi      小米 MiMo Token Plan 包月（mimo-v2.5-pro）
  deepseek    DeepSeek 官方按量（deepseek-chat，备用）
  status      查看 DSH 大脑与后端辅助 LLM 当前供应商
EOF
  exit 1
}

[ $# -ge 1 ] || usage
TARGET="$1"; shift || true

# 供应商规格：DSH_PROVIDER=pi-ai 里的 provider 名；DSH_MODEL=模型 id；
# BACKEND_PROVIDER=server/llm/config.js 里的供应商别名；BACKEND_MODEL=模型 id。
case "$TARGET" in
  status)
    echo "== DSH 写稿大脑（mount bundle agent-default-model） =="
    grep -A2 "id: agent-default-model" "$PATCH" | grep -E "provider:|model:" | sed 's/^[[:space:]]*/  /' || echo "  (未找到)"
    echo "== 后端辅助 LLM（.env.brain 的 LLM_MODEL_*） =="
    if [ -f "$BRAIN_ENV" ]; then
      grep -E "^LLM_MODEL" "$BRAIN_ENV" | sed 's/^/  /'
      [ -s "$BRAIN_ENV" ] || echo "  (空文件 → 走 server/llm/config.js 默认：volcengine)"
    else
      echo "  (无 .env.brain → 走 server/llm/config.js 默认：volcengine)"
    fi
    exit 0
    ;;
  volcengine|volc|ark)
    DSH_PROVIDER="volcengine"; DSH_MODEL="ark-code-latest"
    BACKEND_PROVIDER="volcengine"; BACKEND_MODEL="ark-code-latest"
    ;;
  xiaomi|mimo)
    DSH_PROVIDER="xiaomi"; DSH_MODEL="mimo-v2.5-pro"
    BACKEND_PROVIDER="xiaomi"; BACKEND_MODEL="mimo-v2.5-pro"
    ;;
  deepseek|ds|official)
    # DSH 平面：DeepSeek 走官方内置适配器（provider id = deepseek-official），不经过 pi-ai
    DSH_PROVIDER="deepseek-official"; DSH_MODEL="deepseek-v4-flash"
    # 后端平面：server/llm/config.js 里别名是 deepseek
    BACKEND_PROVIDER="deepseek"; BACKEND_MODEL="deepseek-chat"
    ;;
  *)
    usage
    ;;
esac

# ── ① 切 DSH 大脑：原地替换 agent-default-model 段 ──
python3 - "$PATCH" "$DSH_PROVIDER" "$DSH_MODEL" <<'PY'
import sys, re
path, provider, model = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read()
pat = re.compile(
    r'(- id: agent-default-model\n  config:\n    provider: )\S+(\n    model: )\S+',
)
s2, n = pat.subn(lambda m: m.group(1) + provider + m.group(2) + model, s)
if n != 1:
    sys.exit(f"ERROR: 期望替换 1 处，实际 {n} 处（agent-default-model 段未找到或结构异常）")
open(path, "w").write(s2)
PY
echo "✓ DSH 大脑 → $DSH_PROVIDER / $DSH_MODEL"

# ── ② 切后端辅助 LLM：写 .env.brain 覆盖全部 purpose ──
# 六个 purpose 统一路由（chat/insight/vision/perceive/memory/writing）。
# 删掉旧的 LLM_MODEL 行再写新值，保持文件幂等可重复切换。
PURPOSES="CHAT INSIGHT VISION PERCEIVE MEMORY WRITING"
{
  echo "# 由 scripts/switch-brain.sh 维护 — 切换后端辅助 LLM 供应商。"
  echo "# dotenv override 优先级高于主 .env（见 server/config/index.js）。勿手改。"
  echo "# 生成时间: $(date '+%Y-%m-%d %H:%M:%S')"
  for p in $PURPOSES; do
    echo "LLM_MODEL_${p}=${BACKEND_PROVIDER}"
    echo "LLM_MODEL_${p}_MODEL=${BACKEND_MODEL}"
  done
} > "$BRAIN_ENV"
echo "✓ 后端辅助 LLM → $BACKEND_PROVIDER / $BACKEND_MODEL（写入 .env.brain）"

cat <<EOF

完成。生效方式：
  • DSH 大脑：下一次 dsh 启动即生效（cron 每篇稿子起新进程，无需操作）
  • 后端辅助 LLM：需重启后端进程加载 .env.brain：
      ssh 生产机 'pm2 restart ai-forum-v3'
    （本机开发用 npm run dev 会自动重载）

回退：bash $0 volcengine
EOF
