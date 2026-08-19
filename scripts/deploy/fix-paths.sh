#!/usr/bin/env bash
# scripts/deploy/fix-paths.sh — 部署时把仓库里的本机绝对路径改写为当前部署机路径
#
# 由 deploy.sh 在 npm ci 之后、重启之前调用。幂等：用 marker 注释判断是否已改写。
#
# 用法：bash scripts/deploy/fix-paths.sh [repo_root]
set -euo pipefail

ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)}"
PATCH="$ROOT/dsh/bundles/agent-presets-mount/cordis.patch.yml"

# 已知的开发机根路径（macOS workspace）。部署到生产时替换为 $ROOT。
DEV_ROOT="/Users/xiaocheng/workspace/ai-forum-v3"
# 百家数据目录在开发机是同级的另一个仓库，路径不含 DEV_ROOT，需单独匹配。
DEV_BAIJIA_DATA="/Users/xiaocheng/workspace/ai-experts-platform/data"

if [ ! -f "$PATCH" ]; then
  echo "[fix-paths] WARN: 找不到 $PATCH（跳过路径修正）"
  exit 0
fi

if grep -q "$DEV_ROOT" "$PATCH"; then
  echo "[fix-paths] 把 $DEV_ROOT → $ROOT 写入 $PATCH"
  # 用 | 作分隔符，避免路径里的 / 干扰 sed
  sed -i.bak "s#${DEV_ROOT}#${ROOT}#g" "$PATCH"
  rm -f "$PATCH.bak"
else
  echo "[fix-paths] 未发现开发机根路径（已是 $ROOT 或已改写），跳过"
fi

# BAIJIA_DATA_DIR：本机指向 ai-experts-platform/data，生产应指向真实数据盘。
# 若数据盘不存在，回退到仓库自带的空 data/ai-experts（让 MCP 启动不挂，只是搜不到）。
if grep -q "$DEV_BAIJIA_DATA" "$PATCH"; then
  PROD_BAIJIA_DATA="/root/data/disk/ai-experts-data"
  if [ -d "$PROD_BAIJIA_DATA" ]; then
    echo "[fix-paths] BAIJIA_DATA_DIR → $PROD_BAIJIA_DATA"
    sed -i.bak "s#${DEV_BAIJIA_DATA}#${PROD_BAIJIA_DATA}#g" "$PATCH"
    rm -f "$PATCH.bak"
  else
    FALLBACK="$ROOT/data/ai-experts"
    mkdir -p "$FALLBACK"
    echo "[fix-paths] WARN: 生产数据盘 $PROD_BAIJIA_DATA 不存在，BAIJIA_DATA_DIR 回退到 $FALLBACK"
    sed -i.bak "s#${DEV_BAIJIA_DATA}#${FALLBACK}#g" "$PATCH"
    rm -f "$PATCH.bak"
  fi
else
  echo "[fix-paths] 未发现开发机百家数据路径（已改写或非开发机配置），跳过"
fi

echo "[fix-paths] done"
