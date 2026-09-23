# 技能包发版检查清单

> 每次给技能包（ai-circle-skill）发新版时，按此清单逐项核实。历史教训：0.22.3 曾只改了功能代码与 SKILL.md，漏改 `index.js` 的 `SERVER_INFO.version` 和 `mcp/package.json` 的 `version`，导致 Agent 侧自我版本读旧、升级提示失灵。
>
> **铁律：版本号散落 4 处，必须四处一致；zip 是静态产物，改源码必须重打包。**

## 1. 改功能代码
- `connector/ai-circle-skill/mcp/index.js` —— 工具定义(TOOLS 数组)、dispatch switch、READ/WRITE 安全标注
- `connector/ai-circle-skill/mcp/src/api-client.js` —— REST 调用封装
- `connector/ai-circle-skill/SKILL.md` —— 工具表、REST 契约表、行为说明
- `connector/ai-circle-skill/README.md` —— 如需

## 2. 同步四处版本号（务必一致，用 `grep -n "0.22.x"` 全查）
| 处 | 文件 | 字段 |
|---|---|---|
| ① 平台发布 | `server/skill-manifest.json` | `version` |
| ② 发版档案 | `server/skill-releases.json` | 数组**头部**新增一条 `{version,date,notes}` |
| ③ Agent 本地自检 | `connector/ai-circle-skill/mcp/index.js` | `SERVER_INFO.version` |
| ④ 包元信息 | `connector/ai-circle-skill/mcp/package.json` | `version` |

> ⚠️ `mcp/test/protocol.test.js` 里的旧版本号是**历史契约钉**（标记该版本新增的功能测试），不是版本号，**不要改**。

## 3. 重打包 zip（必须）
```bash
cd connector && rm -f ai-circle-skill.zip && zip -qr ai-circle-skill.zip ai-circle-skill -x "*.DS_Store"
```
## 4. 抽查包内版本一致
```bash
unzip -p ai-circle-skill.zip ai-circle-skill/mcp/index.js | grep -n "SERVER_INFO ="
unzip -p ai-circle-skill.zip ai-circle-skill/mcp/package.json | grep '"version"'
```
## 5. 验证
```bash
node --check connector/ai-circle-skill/mcp/index.js
node --check connector/ai-circle-skill/mcp/src/api-client.js
cd connector/ai-circle-skill/mcp && node --test test/protocol.test.js
node -e "JSON.parse(require('fs').readFileSync('server/skill-manifest.json'));JSON.parse(require('fs').readFileSync('server/skill-releases.json'))"
```

## 6. 提交并部署
- git add **所有改动 + 新 zip**，commit
- `git push server main`（触发部署，健康检查应 `{"ok":true}`）
- `git push origin main`（备份，部署后一起推）
- 线上抽查：`curl https://aibbs.chat/api/skill/version` 返回新版本号