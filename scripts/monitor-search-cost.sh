#!/bin/bash
# 监控搜索成本和使用情况
#
# 用法:
#   cd /Users/xiaocheng/workspace/ai-forum-v3
#   bash scripts/monitor-search-cost.sh [days]
#
# 参数:
#   days: 统计最近几天的数据（默认 7）

set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DAYS="${1:-7}"

echo "📊 搜索成本监控（最近 ${DAYS} 天）"
echo "=================================="
echo ""

# 1. 统计 DeepSeek 搜索调用次数（旧方式）
echo "🔍 DeepSeek web_search 调用统计："
DEEPSEEK_COUNT=0
for i in $(seq 0 $((DAYS-1))); do
  DATE=$(date -v-${i}d +%Y%m%d 2>/dev/null || date -d "-${i} days" +%Y%m%d)
  COUNT=$(grep -c "web_search" "$REPO/dsh/logs/"*-${DATE}.log 2>/dev/null | awk -F: '{sum+=$2} END {print sum+0}')
  DEEPSEEK_COUNT=$((DEEPSEEK_COUNT + COUNT))
done
echo "   总调用次数: $DEEPSEEK_COUNT"
echo "   预估成本: $(echo "scale=2; $DEEPSEEK_COUNT * 1" | bc) 元（按 1 元/次）"
echo ""

# 2. 统计豆包搜索调用次数（新方式）
echo "🔍 豆包搜索调用统计："
DOUBAO_COUNT=0
for i in $(seq 0 $((DAYS-1))); do
  DATE=$(date -v-${i}d +%Y%m%d 2>/dev/null || date -d "-${i} days" +%Y%m%d)
  COUNT=$(grep -c "doubao-search" "$REPO/dsh/logs/"*-${DATE}.log 2>/dev/null | awk -F: '{sum+=$2} END {print sum+0}')
  DOUBAO_COUNT=$((DOUBAO_COUNT + COUNT))
done
echo "   总调用次数: $DOUBAO_COUNT"
echo "   免费额度剩余: $((500 - DOUBAO_COUNT)) 次/月"
echo "   预估成本: $(echo "scale=2; $DOUBAO_COUNT * 0.05" | bc) 元（超出免费额度后）"
echo ""

# 3. 统计 Agent 运行次数
echo "🤖 Agent 运行统计："
TOTAL_RUNS=0
for slug in tech finance historian psychology social culture education signal ai-eye thinker; do
  COUNT=0
  for i in $(seq 0 $((DAYS-1))); do
    DATE=$(date -v-${i}d +%Y%m%d 2>/dev/null || date -d "-${i} days" +%Y%m%d)
    DAY_COUNT=$(grep -c "START $slug" "$REPO/dsh/logs/${slug}-${DATE}.log" 2>/dev/null || echo 0)
    COUNT=$((COUNT + DAY_COUNT))
  done
  TOTAL_RUNS=$((TOTAL_RUNS + COUNT))
  if [ $COUNT -gt 0 ]; then
    echo "   $slug: $COUNT 次"
  fi
done
echo "   总计: $TOTAL_RUNS 次"
echo ""

# 4. 成本对比
echo "💰 成本对比分析："
echo "   ┌─────────────────────────────────────┐"
echo "   │ 旧方案（DeepSeek web_search）       │"
echo "   │ 预估成本: $(echo "scale=2; $DEEPSEEK_COUNT * 1" | bc) 元                  │"
echo "   ├─────────────────────────────────────┤"
echo "   │ 新方案（豆包搜索）                  │"
echo "   │ 预估成本: $(echo "scale=2; $DOUBAO_COUNT * 0.05" | bc) 元                  │"
echo "   ├─────────────────────────────────────┤"

if [ $DEEPSEEK_COUNT -gt 0 ]; then
  SAVINGS=$(echo "scale=1; (1 - $DOUBAO_COUNT * 0.05 / ($DEEPSEEK_COUNT * 1)) * 100" | bc)
  echo "   │ 节省: ${SAVINGS}%                          │"
else
  echo "   │ 节省: -%（无历史数据）              │"
fi

echo "   └─────────────────────────────────────┘"
echo ""

# 5. 建议
echo "💡 优化建议："
if [ $DOUBAO_COUNT -gt 400 ]; then
  echo "   ⚠️  本月免费额度即将用完（已用 $DOUBAO_COUNT/500）"
  echo "   建议：降低 Agent 运行频率或限制搜索次数"
elif [ $DOUBAO_COUNT -gt 500 ]; then
  echo "   ⚠️  本月免费额度已用完（已用 $DOUBAO_COUNT/500）"
  echo "   超出部分成本: $(echo "scale=2; ($DOUBAO_COUNT - 500) * 0.05" | bc) 元"
else
  echo "   ✅ 免费额度充足（已用 $DOUBAO_COUNT/500）"
fi
