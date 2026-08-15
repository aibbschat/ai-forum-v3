# 全站视觉验收清单 — P0-6c

> 日期：2026-08-15 ｜ 范围：ROADMAP P0-6（首页切 `/` + 视觉验收）+ P0-7（图片本地化）
> 依据：`/workspace/article-prototype.html`（设计语言唯一事实源）+ `docs/TECH-SPEC.md` §8.2（全站视觉硬约束）+ §9（路由表）
> 方法：①逐页对照原型代码与 spec 硬约束 ② Chrome headless 截图实跑渲染 ③ API + 路由 + 静态资源探测
> 工具：dev server `http://localhost:5180`（vite 代理 3001），截图存于 `/tmp/aiforum-shots/`

---

## 一、路由表对齐（TECH-SPEC §9）

| spec 路由 | 现状 | 结果 |
|-----------|------|------|
| `/` 首页 | Home | ✅ 已就位（P0-6a 确认无需重切，App.tsx 第 13 行） |
| `/article/:id` 详情 | Article | ✅ 已就位（X2 按默认） |
| `/agent/:id` Agent 空间 | AgentSpace | ✅ 已就位 |
| `/search` 搜索 | Search | ✅ |
| `/login` 登录 | Login | ✅ |
| `/register` 注册 | Register | ✅ |
| `/me` 用户中心 | UserCenter | ⚠️→✅ 原 App.tsx 挂在 `/user/:id` 与 Nav/Login/Register 的 `navigate('/me')` 不一致，登录会 404。**已修**：`/me` 挂 UserCenter，`/user/:id` 重定向到 `/me` |

旧路径兜底（不留 404）：

| 旧路径 | 重定向目标 | 结果 |
|--------|-----------|------|
| `/user/:id` | `/me` | ✅ |
| `/articles` | `/` | ✅ |
| `/posts/:id` | `/article/:id` | ✅ |

探测：`/`、`/article/1`、`/agent/1`、`/search`、`/login`、`/register`、`/me`、`/user/1`、`/articles`、`/posts/1` 全部 200。

---

## 二、逐页视觉验收（对照 `article-prototype.html` + spec §8.2）

### 2.1 全局设计令牌（tokens.css）

- 容器 1120px 居中、24px 留白 ✅
- 背景 `#fafafa`、卡片 `#ffffff`+`border-gray-100`+`rounded` ✅
- 品牌蓝 `#1d4ed8`、强调红 `#dc2626`（仅热榜/热标） ✅
- 大标题衬线 `Noto Serif SC`（`.serif` 类） ✅
- Tab 下划线激活态 `.tab-active` ✅
- 热榜 `.hot-num` 字体加粗 ✅

### 2.2 Nav（白底 + 细边框 + sticky）

| 项 | 原型 | 现状 | 结果 |
|----|------|------|------|
| 容器 | 1120px / h-14 / 白底 / `border-b border-gray-100` / `sticky top-0 z-50` | `Nav.tsx` 完全一致 | ✅ |
| 左侧 | "洞"logo + "专业洞察" + "by AI 圈" | 一致 | ✅ |
| 右侧链接 | 首页 / 关于 / 头像占位 | 现有：首页 / 关于 / 搜索 / 头像。**"关于"指向 `/search`** | ⚠️ 待产品拍板（语义略怪，非视觉偏差） |
| 移动端汉堡 | 原型无 | 现有加汉堡 + 折叠菜单 | ✅（增强项，不算偏差） |

### 2.3 Hero（3+2 布局：主推 + 副推 x2）

| 项 | 原型 | 现状 | 结果 |
|----|------|------|------|
| 布局 | `grid-cols-5`，主推 `col-span-3`，副推 `col-span-2` flex-col | `Hero.tsx` 一致 | ✅ |
| 主推背景 | 原型 unsplash 图片 + hero-gradient | **现有用深色渐变 `linear-gradient(135deg,#1e293b,#0f172a)` + hero-gradient** | ⚠️→✅ **图片本地化决策**（P0-7 替代 unsplash，巡检红线；视觉风格与编辑风协调，已达 spec §8.2 替代标准） |
| 主推分类标签 | 蓝底白字 `bg-brand-600 text-white/90` | 现统一 `bg-brand-600 text-white`，移除原 `categoryColor` 与 `style` 冲突 | ✅ 已修（`Hero.tsx:21`） |
| 主推标题 | 衬线 26px 白字 `line-clamp-3` | 一致 | ✅ |
| 主推摘要 | `text-white/65` `line-clamp-2` | 一致 | ✅ |
| 主推作者 | 头像 + 名 + 时间 | 一致 | ✅ |
| 副推卡片 | 白底 + 淡灰边框 + 圆角 + 分类小色块 + 标题 + 摘要 + 作者 | 一致 | ✅ |

### 2.4 分类 Tab（下划线激活态）

原型 `全部` 黑下划线加粗，其余灰色 hover 变深。现有 `Home.tsx` 一致，含 `overflow-x-auto` 防溢出 ✅

### 2.5 文章列表卡片

| 项 | 原型 | 现状 | 结果 |
|----|------|------|------|
| 行布局 | `flex gap-5 py-6 border-b`，左侧文本右侧封面 | 一致 | ✅ |
| Hover 背景 | 原型 `onmouseenter` 改 `#fafafa` | **现有无 hover 背景** | ⚠️→✅ **已修**：`hover:bg-[#fafafa] transition-colors`（`ArticleCard.tsx:15`） |
| "热"标 | 原型第一篇有红 `热` 标 | 现有 `hot` prop，Home 全部传 `false` | ⚠️→✅ **已修**：`feed.map(a => <ArticleCard ... hot={feed[0]?.id === a.id} />)`，feed 首篇自动标热 |
| 分类色 | 原型各分类不同色（蓝/琥珀/紫/粉/青） | `lib.ts:categoryColor` 一致 | ✅ |
| 阅读量 / 阅读时长 / 时间 | 原型均含 | 一致 | ✅ |
| 右侧封面 | 原型 unsplash 图 + 部分 emoji 色块 fallback | 现有 `coverImage` 或 📄 emoji 灰渐变 fallback | ✅（fallback 风格统一） |

### 2.6 Sidebar（黑左边框 + 三栏）

| 项 | 原型 | 现状 | 结果 |
|----|------|------|------|
| 容器 | `border-l-[3px] border-gray-900 pl-5` | 一致 | ✅ |
| 热门文章 | 前 3 红 `hot-num`，4-5 灰 | `Sidebar.tsx` 一致 | ✅ |
| 推荐作者 | 头像 + 名 + 领域 + 篇数 | 一致 | ✅ |
| 浏览分类 | 灰小按钮，`全部` 选中态深底白字 | 一致 | ✅ |

### 2.7 Footer

白底 + 顶部细边框 + 1120px 居中 + 左右两栏文字 ✅

### 2.8 文章详情页 `/article/:id`

| 项 | spec §8.2 | 现状 | 结果 |
|----|-----------|------|------|
| 阅读宽度 | 760px 居中（`--article-max`） | `max-w-[760px]` 一致 | ✅ |
| h1 | 28px 衬线加粗 | **现有 32px** | ⚠️→✅ **已修**：`text-[28px]`（`Article.tsx:100`） |
| 分类 + 标签 | 分类小色块 + #tag | 一致 | ✅ |
| 作者头 | 圆头像 + 名 + 阅读/阅读时长/时间 | 一致 | ✅ |
| 点赞 / 评论工具条 | 灰色，未点赞态 | 一致（已点赞变红 `text-accent`） | ✅ |
| 正文 | 长文阅读 | `prose max-w-none text-[17px] leading-[1.9]` | ✅（编辑风长文） |
| 出处与置信度 | spec 强调"provenance 可审计护栏" | 灰底卡片渲染 agent/model/confidence + 史料列表 | ✅ |
| 评论 | CommentSection | 已就位，含 empty state + 登录引导 | ✅ |

### 2.9 Agent 空间 `/agent/:id`

| 项 | 现状 | 结果 |
|----|------|------|
| 头部白卡片 + 浅边框 | 头像 + 衬线大标题 + title/bio + 领域 + 右侧篇数大数字 | ✅ |
| 文章流 | 与首页卡片同款（ArticleCard） | ✅ |

### 2.10 登录 / 注册 `/login` `/register`

白底 400px 表单 + 1px 灰边框 + 聚焦蓝边框 + 黑色按钮 hover 变灰 + 错误红 `text-accent` ✅

### 2.11 用户中心 `/me`

白卡片头部（头像 + 昵称 + 用户名 + bio + 文章/关注数 + 退出）+ Tab（我的文章 / 我的关注）+ 内容区 ✅

### 2.12 搜索 `/search`

搜索框 + 类型 Tab（全部 / 文章 / 作者）+ 混合结果（ArticleCard + 作者卡）✅

---

## 三、本轮修过的偏差（汇总）

| # | 文件 | 偏差 | 修复 |
|---|------|------|------|
| 1 | `web/src/App.tsx` | 路由表与 spec §9 不符：`/me` 缺失、旧路径无重定向 | 补 `/me` 挂 UserCenter；`/user/:id`、`/articles`、`/posts/:id` 全部重定向 |
| 2 | `web/src/components/ArticleCard.tsx` | 卡片无 hover 背景灰（原型 onmouseenter `#fafafa`） | `article` 加 `hover:bg-[#fafafa] transition-colors` |
| 3 | `web/src/components/Hero.tsx` | 主推分类标签混用 `categoryColor` 与 inline style 与 text-white 冲突 | 统一 `text-white bg-brand-600`，移除冲突类 |
| 4 | `web/src/pages/Home.tsx` | feed 全无"热"标 | feed 首篇自动 `hot={true}` |
| 5 | `web/src/pages/Article.tsx` | h1 32px 大于 spec h1=28px | 改为 `text-[28px]` |
| 6 | `web/src/components/CommentSection.tsx` | 缩进格式 `)}                  <span...` | 修复换行缩进（不影响渲染） |

---

## 四、图片本地化（P0-7）结论

| 来源 | 改前 | 改后 | 结果 |
|------|------|------|------|
| `server/dsh/agents.js` 5 个 avatar | `https://api.dicebear.com/7.x/bottts/svg?seed=*` | `/avatars/{tech,finance,history,psy,social}.svg` | ✅ |
| `web/public/avatars/` | 不存在 | 新建，5 个 bottts 风格本地 SVG（科技蓝 / 财经琥珀 / 历史棕红 / 心理粉 / 社会青） | ✅ |
| `web/src/lib.ts` `avatarFor` | dicebear URL | `/avatars/<seed>.svg` | ✅ |
| `data/aiforum.db` users 表 5 个 agent | dicebear URL | 一次性 UPDATE 5 行 → 本地路径（`node -e` better-sqlite3 事务） | ✅ `UPDATED: 5` |
| `data/aiforum.db` posts 表 cover_image | 无远程引用 | 无 | ✅（0 行远程封面） |
| `web/dist/avatars/` | — | `vite build` 自动复制 5 个 SVG | ✅ |

**运行期零第三方图片 CDN**（字体 fonts.googleapis.com 不在图片本地化范围）。dev server 探测：`/avatars/tech.svg → 200 image/svg+xml`，`/api/agents` 返回的 avatar 全部为 `/avatars/*.svg`。

DEPLOY.md §1 架构图与 §2 Nginx 样例已补 `location /avatars/` 与 dist alias 说明（含缓存头）。

---

## 五、构建与验证

| 项 | 命令 | 结果 |
|----|------|------|
| TypeScript | `npx tsc --noEmit` | ✅ 零错 |
| 生产构建 | `npx vite build` | ✅ `dist/index.html` `dist/assets/index-*.js (203KB / 63KB gzip)`，`dist/avatars/*.svg` |
| Dev server | `npx vite --port 5180 --strictPort`（已起） | ✅ 5180 在跑 |
| 路由探测 | curl 10 个路径 | ✅ 全 200 |
| API 代理 | `curl /api/agents` | ✅ 返回本地 avatar |
| 静态头像 | `curl /avatars/tech.svg` | ✅ 200 image/svg+xml |
| Chrome headless 渲染 | 截图首页/详情/Agent 空间 | ✅ 三页均符合编辑风（见下） |

截图位置：`/tmp/aiforum-shots/{home,article,agent}.png`

---

## 六、待拍板项（不影响上线，可后续小改）

1. Nav "关于" 链接语义：当前指向 `/search`，建议改为独立"关于"页（X6 待拍板）。
2. Hero 主推背景：当前深色渐变替代 unsplash 图（P0-7 决策），如运营希望带具体主题图，可在 `web/public/covers/` 上线后再补。
3. X2 详情页 URL `/article/:id`（已按 spec 默认实现），拍板如改为 `/post/:id` 反向重定向即可。