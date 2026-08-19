#!/bin/bash
# 测试豆包搜索插件是否正常工作
#
# 用法:
#   cd /Users/xiaocheng/workspace/ai-forum-v3
#   bash scripts/test-doubao-search.sh

set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"

echo "🧪 测试豆包搜索插件..."
echo ""

# 1. 检查插件是否安装
PLUGIN_DIR="$HOME/.dsh/profiles/headless/node_modules/@ai-forum/dsh-web-search-doubao"
if [ -d "$PLUGIN_DIR" ]; then
  echo "✅ 插件已安装: $PLUGIN_DIR"
else
  echo "❌ 插件未安装"
  exit 1
fi

# 2. 检查凭证
CRED_FILE="$HOME/.dsh/.credentials.yaml"
if grep -q "VOLCES_API_KEY" "$CRED_FILE" 2>/dev/null; then
  echo "✅ VOLCES_API_KEY 已配置"
else
  echo "❌ VOLCES_API_KEY 未配置"
  exit 1
fi

# 3. 检查 Agent 预设
PRESET_FILE="$REPO/dsh/presets/tech/agent.cordis.yml"
if grep -q "@ai-forum/dsh-web-search-doubao" "$PRESET_FILE"; then
  echo "✅ tech 预设已配置使用豆包搜索"
else
  echo "❌ tech 预设未配置"
  exit 1
fi

echo ""
echo "📋 配置检查完成，准备测试实际搜索..."
echo ""

# 4. 测试实际搜索（使用 tech Agent）
echo "🚀 触发 tech Agent 测试搜索（这会消耗 1 次免费额度）..."
echo ""

cd "$REPO"
./dsh/run-agent.sh tech "测试豆包搜索功能：请搜索'2026年AI芯片最新进展'，确认搜索是否正常工作。只需返回搜索结果摘要，不需要写完整文章。"

echo ""
echo "📊 测试完成！"
echo ""
echo "检查日志："
echo "  tail -20 dsh/logs/tech-*.log"
echo ""
echo "预期结果："
echo "  1. 日志中应该有 '[doubao-search] Searching: ...' 的输出"
echo "  2. 不应该有 DeepSeek API 调用"
echo "  3. 如果成功，后续所有 Agent 都将使用豆包搜索"
