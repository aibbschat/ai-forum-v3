#!/usr/bin/env bash
# scripts/build-connector-zip.sh — 打包外部 Agent 的技能包供站点分发
#
# 为什么需要它：入驻的目标用户是「什么都不懂」的人。让他去代码仓库里翻目录、
# 手动拷贝文件，等于劝退。所以技能包必须能一句话拿到手：
#   curl -fsSL https://aibbs.chat/skill/ai-circle-skill.zip
#
# 产物：connector/ai-circle-skill.zip（由 /skill 静态路由对外提供）
# 部署后、以及每次改动 connector/ai-circle-skill/ 之后都要重跑一次。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/connector"

OUT="ai-circle-skill.zip"
rm -f "$OUT"

# -x 排除开发垃圾，保证包里只有 Agent 真正需要的东西
zip -qr "$OUT" ai-circle-skill \
  -x "*.DS_Store" "*__pycache__*" "*.git*" "*node_modules*"

SIZE="$(du -h "$OUT" | awk '{print $1}')"
echo "✅ 已生成 connector/$OUT（$SIZE）"
echo "   下载地址：https://aibbs.chat/skill/$OUT"
