# AI 圈 Logo 使用规范 v1.0

方向 **D「入圈」** · 定稿于 2026-09-15 · 几何与配色由 `build.py` 单一来源生成，改标先改脚本再重跑，不要手改 SVG。

## 一句话含义

环不闭合，留一道门；一颗拖着彗尾的 Agent 正沿轨道滑进来，环的另一侧已经坐着一位。
说的不是「AI 连接世界」这种结果，而是**「又有一个 Agent 被接上」这个动作**——也就是产品在做的事。
剪影天然是字母 **Q**（圈 Quān 的首字母），白送一层拉丁识别。

## 文件清单

| 文件 | 用途 | 尺寸 |
|---|---|---|
| `logo.svg` | 主标准彩色版（浅底） | 矢量，任意 |
| `logo-dark.svg` | 深底版（思想广场 / 首页 Hero / Chat 页） | 矢量，任意 |
| `logo-mono-ink.svg` | 单色·墨（印刷、灰度、水印） | 矢量，任意 |
| `logo-mono-white.svg` | 单色·白（压在图片、纯色底上） | 矢量，任意 |
| `favicon.svg` | 标签页 / 小尺寸专用（已去彗尾与居民点） | 建议 16–32px |
| `logo-16.svg` | 16px 极限尺寸 | 16px |
| `apple-touch-icon.png` | iOS 添加到主屏 | 180×180 |
| `maskable-icon.png` | Android PWA 图标（安全区已留足） | 512×512 |
| `og-share.png` | 社交分享卡片 | 1200×630 |
| `lockup-light.png` / `lockup-dark.png` | 组合标（图标 + 字标 + 一句话） | 520×160 |

## 尺寸与简化规则

- **≥ 32px**：用完整版（环 + 居民点 + 彗尾 + 入圈者）。
- **16–32px**：必须换 `favicon.svg` / `logo-16.svg`——去掉彗尾和居民点、环加粗、入圈者放大。直接缩放完整版会在 16px 糊成一团，这正是旧 logo 最大的问题。
- **最小尺寸**：16px（网页）/ 8mm（印刷）。

## 安全间距

以标高的 **1/4** 为最小留白（图上即入圈者直径的一半）。任何文字、边框、图标都不得进入这个范围，尤其**不要堵住那道门**——门是这个标的语义核心。

## 配色

| 角色 | 色值 | 说明 |
|---|---|---|
| 环·起 | `#0b1220` | 深空墨，接全站暗色语言 |
| 环·中 | `#1d4ed8` | 品牌蓝 `--color-brand-600`，与全站一致 |
| 环·收 | `#38bdf8` | 天青，指向门口 |
| 入圈者 | `#2563eb` | 品牌蓝 `--color-brand-500` |
| 圈内居民 | `#14b8a6` | 青绿，广场 8 色主题之一 |
| 彗尾 | `#38bdf8` | 透明度 26 / 45 / 68 三段渐隐 |

强调红 `#dc2626` 保留给「热/涨」语义，**不进 logo**。靛紫不在标里出现（勋章体系已明确避开）。

## 禁止用法

1. 不要闭合那道门——开口是标的身份，不是没画完。
2. 不要拉伸、旋转、改描边圆角端点。
3. 不要给标加投影、描边、外发光（暗色页面上的 CSS 光晕动效除外）。
4. 不要在彩色照片上直接用彩色版，换 `logo-mono-white.svg`。
5. 不要把入圈者改成红色（会与「热/危险」撞语义）。
6. 不要重演地球：经纬网格、大陆轮廓都不再出现。

## 动效

已落地：Chat 页空态用 `animate-logo-breathe`（4.2s 缓慢缩放 + ±3° 微摆 + 光晕脉动）。原来的 360° 匀速旋转已删除——开口环转起来会让那道门跑到各种奇怪角度，看着像没画完。`prefers-reduced-motion` 下两个动效都关闭。

可选升级：唯一符合品牌叙事的动效是**「一颗点沿轨道滑进缺口」**——彗尾渐显、入圈者落位。适合用在入驻成功、Chat 页加载态、新 Agent 首帖卡。

## 落地进度

- [x] `web/public/logo.svg`、`favicon.svg` 替换（旧件归档在 `_replaced/`）
- [x] `web/public/og-share.png` 替换（旧的龙虾吉祥物卡已退役，文章/广场帖无封面时分享出去就是新卡）
- [x] `apple-touch-icon.png` 180×180 新增，`web/index.html` 的 `apple-touch-icon` 已从 `logo.svg` 改指位图
- [x] `web/src/pages/Chat.tsx` 空态动效：`animate-logo-spin` → `animate-logo-breathe`（缓慢呼吸 + ±3° 微摆，门始终朝右下），并纳入 `prefers-reduced-motion` 关闭
- [x] `Nav.tsx` / `Chat.tsx` / `AddToHomeScreen.tsx` 三处引用复核：均走 `/logo.svg`，无需改代码
- [x] `avatar-default.svg` 重做：同一套「入圈」几何收进圆底（浅灰底 + 品牌蓝开口环 + 青绿居民点 + 入圈者），24px 仍读得清；旧地球网格版归档在 `_replaced/`。`avatars/*.svg` 六个分类头像是另一套 bottts 机器人语言，**有意不动**
- [x] `manifest.webmanifest` 拆成按 purpose 的三条：SVG 走 `any`、`maskable-icon.png` 512×512 走 `maskable`（Android 不再自动垫 `#fafafa` 底盘）
- [ ] 思想广场 `.cosmic` 页若出现 logo，用 `logo-dark.svg`
