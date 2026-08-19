#!/bin/bash
# 把豆包搜索插件安装到 DSH 全局 node_modules（loader 只从这里解析，见 ROADMAP D16）。
#
# 用法:
#   bash dsh/plugins/web-search-doubao/install.sh
#
# 安装后在 cordis.patch.yml 里加：
#   - name: '@ai-forum/dsh-web-search-doubao'
#     config:
#       botId: bot-2025xxxxxx       # 火山方舟"联网搜索 Bot"id（Ark 控制台拿）
#       # apiKey 默认走 VOLCES_API_KEY（credentials/env），一般不用写
#       maxResults: 8
#
# 注意：
#   - loader 只从 DSH 自己的 node_modules 解析包；装在 ~/.dsh/profiles/*/node_modules 里加载不到。
#   - 本脚本不用 npm install：插件零运行时依赖，直接 cp 到全局 node_modules 即可。
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")" && pwd)"
DSH_BIN="$(command -v dsh || echo /usr/local/bin/dsh)"
DSH_REAL="$(readlink -f "$DSH_BIN" 2>/dev/null || greadlink -f "$DSH_BIN" 2>/dev/null || echo "$DSH_BIN")"
DSH_ROOT="$(cd "$(dirname "$DSH_REAL")/.." && pwd)"
GLOBAL_NODE_MODULES="$DSH_ROOT/lib/node_modules"
# 若上面路径不对（npm -g 装的包在 <prefix>/lib/node_modules），fallback 到 npm prefix
if [ ! -d "$GLOBAL_NODE_MODULES/@deepseek-ai" ]; then
  GLOBAL_NODE_MODULES="$(npm root -g 2>/dev/null || echo /usr/local/lib/node_modules)"
fi
TARGET_DIR="$GLOBAL_NODE_MODULES/@ai-forum/dsh-web-search-doubao"

echo "📦 安装豆包搜索插件到 DSH 全局 node_modules"
echo "   源目录:    $PLUGIN_DIR"
echo "   目标目录:  $TARGET_DIR"
echo "   DSH root:  $DSH_ROOT"

mkdir -p "$TARGET_DIR/lib"
cp "$PLUGIN_DIR/package.json" "$TARGET_DIR/"
cp "$PLUGIN_DIR/lib/index.js" "$TARGET_DIR/lib/"

# 校验：目标目录下确实能找到 DSH peer 包
if [ ! -d "$GLOBAL_NODE_MODULES/@deepseek-ai/dsh-web" ]; then
  echo "!!! 在 $GLOBAL_NODE_MODULES 下没找到 @deepseek-ai/dsh-web"
  echo "    这个插件依赖 DSH 的 web seam，不能单独安装。请确认 DSH 已全局安装。"
  exit 1
fi

echo "✅ 安装完成"
echo ""
echo "下一步（在 dsh/bundles/agent-presets-mount/cordis.patch.yml 里加）："
echo "  - name: '@ai-forum/dsh-web-search-doubao'"
echo "    config:"
echo "      botId: bot-xxxxxxxxxxxx   # 火山方舟控制台里创建的联网搜索 Bot id"
echo ""
echo "可用环境变量 VOLCES_API_KEY / ARK_SEARCH_BOT_ID 覆盖默认值。"
