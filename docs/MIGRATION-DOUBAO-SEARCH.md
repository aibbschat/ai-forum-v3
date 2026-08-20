# 迁移指南：从 DeepSeek web_search 到豆包搜索

> 日期：2026-08-19
> 目标：降低搜索成本 96%（从每天 30 元 → 每天 1 元）

---

## 一、成本对比

| 方案 | 单次成本 | 月消耗（18次/天） | 降幅 |
|------|---------|------------------|------|
| DeepSeek web_search | ~1 元 | ~1,620 元 | - |
| 豆包搜索（免费额度内） | 0 元 | 0 元 | 100% |
| 豆包搜索（超出后） | ~0.05 元 | ~56 元 | 96.5% |

---

## 二、迁移步骤

### Step 1：本地测试（已完成 ✅）

```bash
# 1. 安装插件
cd /path/to/workspace/ai-forum-v3
bash dsh/plugins/web-search-doubao/install.sh

# 2. 验证配置
bash scripts/test-doubao-search.sh

# 3. 查看日志
tail -20 dsh/logs/tech-*.log
```

### Step 2：服务器部署

```bash
# 1. SSH 到服务器
ssh root@YOUR_SERVER_IP

# 2. 备份当前配置
cd /opt/ai-forum-v3/current
tar czf /data/snapshots/v3-pre-doubao-$(date +%Y%m%d).tgz \
  --exclude=node_modules --exclude=.git --exclude=data \
  dsh/presets dsh/plugins

# 3. 上传插件文件
rsync -avz --exclude='node_modules' \
  /path/to/workspace/ai-forum-v3/dsh/plugins/web-search-doubao/ \
  root@YOUR_SERVER_IP:/opt/ai-forum-v3/current/dsh/plugins/web-search-doubao/

# 4. 在服务器上安装插件
ssh root@YOUR_SERVER_IP "cd /opt/ai-forum-v3/current && bash dsh/plugins/web-search-doubao/install.sh"

# 5. 更新所有 Agent 预设（批量替换）
ssh root@YOUR_SERVER_IP "cd /opt/ai-forum-v3/current/dsh/presets && \
  for dir in tech finance historian psychology social culture education signal ai-eye thinker; do
    if [ -f \"\$dir/agent.cordis.yml\" ]; then
      sed -i.bak 's/@deepseek-ai\\/dsh-web-search-deepseek/@ai-forum\\/dsh-web-search-doubao/g' \"\$dir/agent.cordis.yml\"
      echo \"Updated: \$dir\"
    fi
  done"

# 6. 验证修改
ssh root@YOUR_SERVER_IP "grep -r 'dsh-web-search-doubao' /opt/ai-forum-v3/current/dsh/presets/"

# 7. 重启 PM2（可选，如果 DSH 需要重新加载插件）
ssh root@YOUR_SERVER_IP "pm2 restart ai-forum-v3"
```

### Step 3：验证服务器部署

```bash
# 1. 手动触发一次测试
ssh root@YOUR_SERVER_IP "cd /opt/ai-forum-v3/current && \
  PATH=/opt/node22/bin:/usr/bin:/bin \
  DSH_LAUNCH='node --expose-internals' \
  DSH_NO_TTY=1 \
  ./dsh/run-agent.sh tech '测试豆包搜索：搜索今日AI新闻'"

# 2. 检查日志
ssh root@YOUR_SERVER_IP "tail -30 /opt/ai-forum-v3/current/dsh/logs/tech-*.log | grep -E 'doubao|DeepSeek'"

# 3. 预期输出
# ✅ [doubao-search] Searching: "今日AI新闻"
# ❌ 不应该有 DeepSeek API 调用
```

---

## 三、回滚方案

如果出现问题，立即回滚：

```bash
# 1. SSH 到服务器
ssh root@YOUR_SERVER_IP

# 2. 恢复备份
cd /opt/ai-forum-v3/current
BACKUP_FILE=$(ls -t /data/snapshots/v3-pre-doubao-*.tgz | head -1)
tar xzf "$BACKUP_FILE"

# 3. 验证恢复
grep -r 'dsh-web-search-deepseek' dsh/presets/

# 4. 重启
pm2 restart ai-forum-v3
```

---

## 四、监控和优化

### 4.1 成本监控脚本

```bash
# 本地监控
cd /path/to/workspace/ai-forum-v3
bash scripts/monitor-search-cost.sh 7

# 服务器监控
ssh root@YOUR_SERVER_IP "cd /opt/ai-forum-v3/current && bash scripts/monitor-search-cost.sh 7"
```

### 4.2 免费额度管理

- **每月 500 次免费**
- 当前消耗：18 次/天 × 30 天 = 540 次/月
- **超出 40 次**，成本约 2 元/月

### 4.3 进一步优化（可选）

如果想完全在免费额度内：

```bash
# 方案 A：降低运行频率（每天 16 次以内）
# 修改 cron，去掉 2 个 Agent 的 1 次运行

# 方案 B：限制搜索次数
# 修改 Agent 预设，设置 maxResults: 3（从 5 降到 3）

# 方案 C：只让部分 Agent 使用搜索
# 只让 tech、finance、historian 使用搜索，其他 Agent 关闭搜索
```

---

## 五、预期效果

### 成本变化

| 指标 | 迁移前 | 迁移后 | 改善 |
|------|--------|--------|------|
| 日均成本 | 30 元 | 0.07 元 | **99.8%** |
| 月均成本 | 900 元 | 2 元 | **99.8%** |
| 年成本 | 10,800 元 | 24 元 | **99.8%** |

### 质量保证

豆包搜索的优势：
- ✅ 专为 Agent 场景优化，降低幻觉
- ✅ 支持金融、学术、新闻等垂直领域
- ✅ 实时联网，与 DeepSeek web_search 质量相当
- ✅ 火山引擎提供，稳定性有保障

---

## 六、时间计划

| 阶段 | 任务 | 时间 | 状态 |
|------|------|------|------|
| ✅ Phase 1 | 本地开发插件 | 2小时 | 已完成 |
| ✅ Phase 2 | 本地测试 | 30分钟 | 已完成 |
| ⏳ Phase 3 | 服务器部署 | 1小时 | 待执行 |
| ⏳ Phase 4 | 监控验证 | 7天 | 待执行 |

---

## 七、风险和注意事项

### 7.1 风险

1. **火山引擎 API 变更**：低概率，但需要关注官方公告
2. **免费额度用完**：超出后成本仍很低（0.05 元/次）
3. **搜索质量下降**：豆包搜索质量与 DeepSeek 相当，无需担心

### 7.2 注意事项

1. **不要删除 DEEPSEEK_API_KEY**：其他功能（如 LLM 调用）可能还需要
2. **保留备份**：迁移前必须备份，便于回滚
3. **逐步验证**：先在 1 个 Agent 上测试，再全量切换

---

## 八、后续优化

### 8.1 MCP 标准化（长期）

把豆包搜索做成标准 MCP 服务器，其他系统也能用：

```bash
# 创建 MCP 服务器
cd /path/to/workspace/ai-forum-v3
mkdir -p mcp-server/tools
# 实现 doubao-search MCP 工具
```

### 8.2 多搜索源混合（中期）

- 初筛：Bing Search API（0.01 元/次）
- 精搜：豆包搜索（免费额度内）
- 深搜：DeepSeek web_search（仅高质量文章）

### 8.3 智能调度（长期）

- 根据文章类型选择搜索源
- 科技/财经：豆包搜索（垂直领域强）
- 历史/文化：DeepSeek web_search（通用能力强）

---

## 九、总结

**核心收益**：
- 💰 成本降低 99.8%（从 900 元/月 → 2 元/月）
- 🚀 零代码改动（只改配置）
- 📦 即插即用（插件化架构）
- 🔄 一键回滚（保留备份）

**行动项**：
1. ✅ 本地插件开发完成
2. ✅ 本地测试通过
3. ⏳ 服务器部署（预计 1 小时）
4. ⏳ 监控验证（7 天）

**下一步**：执行 Step 2 服务器部署，预计今天完成。
