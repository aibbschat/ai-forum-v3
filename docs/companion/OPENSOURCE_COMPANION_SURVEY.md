# GitHub 全站「桌宠 / 私人 AI 伴侣」开源项目调研

> 调研日期：2026-08-22 ｜ 目的：为 ai-forum-v3 的「AI 伴侣」功能寻找可借鉴的**轻量虚拟形像引擎**与**伴侣架构范式**
> 前置结论（同会话前情）：DSH 库里的 `zealot00/dsh-pet` 渲染引擎本身没问题，但默认皮肤 `zhuangfangyi.sheet.png` 的 32 帧彼此像素差仅 0.5%~2%（idle/working/sleeping 首帧与 idle 完全相同，差=0.00），播放出来基本是静态图。→ **"会动与否"取决于素材是否有真实分镜，而非引擎。**

---

## 一、全站项目分类总览

| 项目 | GitHub | 星数 | 技术栈 | 轻量？ | 可商用？ | 对 v3 的借鉴点 |
|---|---|---|---|---|---|---|
| **CodePet** | `jnMetaCode/codepet` | 新 | 原生 JS + Electron | ✅ 极轻 | ✅ Apache-2.0 | **九宫格切 9 帧**动画范式，可直接套用来生成 v3 伴侣分镜素材 |
| **MofuPaw 萌爪** | `Estellanini/MofuPaw` | 新 | 原生 macOS Swift | ✅ 轻 | ⚠️ CC BY-NC-SA（非商业） | **7 态×8 帧真实精灵图分镜** + 完整伴侣架构（记忆/情绪/亲密度/主动对话） |
| **Live2DPet** | `x380kkm/Live2DPet` | 中 | Electron + Live2D | △ 中（含图片模式） | ✅ MIT | **图片文件夹作角色**：按"待机/说话/表情"分类 PNG，AI 驱动切换 → 轻量且真会动 |
| **OpenDesktop-Pet** | `HanLoney/OpenDesktop-Pet` | 中 | Electron + Live2D + GIF | △ 中 | 待核 | 三层记忆 + 自定义图片/GIF 角色 |
| **Open-LLM-VTuber** | `Open-LLM-VTuber/Open-LLM-VTuber` | ~11k | Python + Live2D | ❌ 重 | ✅ MIT（模型另计许可） | 模块化 LLM/ASR/TTS/Live2D/记忆可替换架构 |
| **AIRI** | `moeru-ai/airi` | 高 | Web/桌面 + Live2D/VRM | ❌ 重 | 待核 | 30+ LLM、长期记忆、可玩 Minecraft |
| **N.E.K.O.** | `Project-N-E-K-O/N.E.K.O` | 高 | 桌面 + Live2D/VRM/MMD | ❌ 重 | 待核（含 Steam 版） | 五层记忆/认知架构 + 插件商城 + 主动回忆 |
| **MiniCPM-Desk-Pet** | `OpenBMB/MiniCPM-Desk-Pet` | 中 | 端侧 1B 模型 App | △ 应用 | 待核 | 不烧 token 的端侧陪伴（已封装 App，非引擎） |
| **SillyTavern + KoboldCpp** | `SillyTavern/SillyTavern` | ~28k | 网页前端 + 本地后端 | ❌ 仅聊天 | AGPL-3.0 | **角色卡 / 人设管理**范式（非桌宠、非会动） |

---

## 二、最值得 v3 借鉴的三类

### A. 轻量「会动」形像范式（直接解决 dsh-pet 静态坑）

1. **CodePet 的「九宫格切 9 帧」**
   - 机制：用户传一张 3×3 九宫格图 → 自动切成 9 帧 → 循环播放成"会跳舞"的动画。单张图则静态。
   - 启示：**把"会动"简化为"多帧分镜素材"问题**。v3 伴侣生成原创角色时，只要让 AI 出一张"同一角色 9 个连续姿态"的九宫格，切帧即得真会动，无需 Live2D 几十 MB 模型。
   - 自带 9 只原创宠物（奶猫/麻薯/棉花精灵等），可参考其姿态设计语言。

2. **MofuPaw 的「7 态×8 帧精灵图」**
   - 状态机：待机 / 行走 / 睡觉 / 开心 / 进食 / 跳跃 / 拖拽，每态 8 帧真实分镜。
   - 启示：**状态维度比帧数更重要**。v3 伴侣只需 idle(呼吸)/thinking(思考晃动)/speaking(说话嘴部)/done(完成撒花)/sleeping(入睡) 5 态，每态 6~8 帧真实分镜即可「活」起来。
   - 这是 Swift 原生、非 web，但**动画素材范式（spritesheet 分镜）可直接移植**到之前的 dsh-pet 渲染引擎。

3. **Live2DPet 的「图片文件夹」模式**
   - 不用 Live2D 模型，上传 PNG 文件夹，给每张标"待机/说话/表情"，AI 情绪系统自动切换。
   - 启示：**最轻的"会动" = 3~5 张不同表情/姿态的 PNG 做状态切换**（非逐帧动画，但观感已是"活的角色"）。可作为 v3 伴侣的兜底轻量方案。

### B. 伴侣「架构范式」（记忆/情绪/主动互动，对照规格书补强）

- **MofuPaw** 的模块划分几乎就是 v3 伴侣规格书的成熟样板：
  - 长期记忆（记住喜好/昵称/历史对话）
  - 8 种情绪状态，依用户情绪调整行为
  - 主动对话（按里程碑/情绪/习惯主动找用户）
  - 5 级亲密度系统（初识→默契）
  - 4 种性格（温柔/活泼/安静/调皮）+ 情境气泡
- **Open-LLM-VTuber / AIRI / N.E.K.O.** 的共识：**LLM / 语音 / 形象 / 记忆 四层模块化、可独立替换**——与 v3 规格书 §10「伴侣大模型路由」的 purpose 化设计思路一致。

### C. 重量级（短期不做，仅记录）

- Live2D 全家桶（Open-LLM-VTuber / AIRI / N.E.K.O. / Live2DPet / OpenDesktop-Pet）：真"表情+动作+说话"会动，但每模型 10~50MB、吃 WebGL、Live2D 模型版权严格（官方样例需标注、商用 IP 禁用）。用户已明确「太重了没必要」，故不纳入 v3 一期。

---

## 三、版权红线（务必遵守，v3 是公开商用站点）

| 项目/素材 | 风险 |
|---|---|
| MofuPaw | **CC BY-NC-SA 4.0 非商业** → 不能上线 v3，仅个人 Mac 可用或参考其设计 |
| CodePet 宠物立绘 | Apache-2.0 代码可商用，但其 9 只立绘需确认是否原创可商用 |
| dsh-pet 默认 `zhuangfangyi` | 游戏（明日方舟风格）二创同人，作者声明仅个人使用、勿商用 |
| Live2D 官方样例模型 | 免费商用需标注著作权；商用 IP（宝可梦/绝区零/胡桃等）绝对禁用 |
| N.E.K.O. / AIRI 自带 Live2D | 多为 IP 角色，不能上线 |

**结论**：v3 伴侣上线**必须自托管原创/已授权角色素材**，引擎可借鉴 CodePet/MofuPaw 的轻量分镜范式，但素材一律自产。

---

## 四、对 v3 伴侣落地的行动建议

1. **形像素材范式定型**：放弃"单张静态图+CSS 微动"和"Live2D 重型"，采用 **「多帧真实分镜 spritesheet」**（MofuPaw 7态×8帧 / CodePet 九宫格切帧 思路）。下一步生成 v3 原创伴侣角色时，**务必输出"同一角色多姿态分镜"**，而非单图，才能真会动。
2. **渲染引擎复用 dsh-pet**：前情已剥离 DSH 耦合、封装 `createCompanionPet()`，引擎可用；缺的只是"有分镜的素材"。
3. **架构对照补强规格书**：把 MofuPaw 的「记忆/情绪/亲密度/主动对话/情境气泡」模块映射进 `AI_COMPANION_SPEC.md` 对应章（记忆系统、主动通知、人设），作为成熟范式参考。

---

## 五、待萧哥拍板

- 是否将本调研的「形像引擎选型参考（A 类轻量范式）」与「架构对照（B 类）」**merge 进 `AI_COMPANION_SPEC.md`** 作为独立章节？
- 下一步是直接用 AI 生成**第一只 v3 原创伴侣的多姿态分镜 spritesheet**（走 CodePet/MofuPaw 范式），替换 dsh-pet 默认皮肤验证真会动？
