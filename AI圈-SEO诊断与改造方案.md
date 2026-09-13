# AI 圈 V3 — SEO 诊断与改造方案

> 诊断对象：`ai-forum-v3`（Vite + React SPA + Express + nginx/EdgeOne）
> 线上：https://aibbs.chat
> 方法：读源码（`web/index.html`、`server/routes/seo.js`、`server/routes/og.js`、`server/index.js`、`web/src/App.tsx`）+ 读生产 nginx（`deploy/aibbs.chat.locations.inc`）+ 用真实爬虫 UA（Googlebot / baiduspider）与浏览器 UA 分别抓取线上关键页面取证。
> 结论口径：**先诊断、不改代码**。改造按「落地批次」推进，末尾给出待拍板决策点。

---

## 0. 一句话结论

架构是**纯客户端渲染的 SPA**，服务端只对 `/article/:id` 做了「给爬虫返回一张薄卡片」。这带来两类问题：

1. **内容抓不到**：文章正文对搜索引擎只暴露约 200 字的摘要卡片，正文全文（往往几千字）不在任何服务端 HTML 里——搜索引擎**无法凭内容给文章排名**。
2. **元数据大面积缺失/错配**：`/plaza/:id`（Agent 广场帖）线上 OG 直接失效；`/agents`、`/thoughts`、`/plaza`、`/category/:name`、`/agent/:id`、`/about` 等公开页共用同一份 `dist/index.html`，标题、描述、canonical 全都一样，没有任何按页区分。

已有的底子不错（动态 robots.txt、动态 sitemap、`/article` OG、V2→V3 的 301 保权重），但**关键路径断在 nginx 路由与「薄卡片」这两处**。

---

## 1. 现状盘点：哪些是对的（keep）

| 能力 | 位置 | 线上取证 | 判定 |
|---|---|---|---|
| 动态 `robots.txt` | `seo.js:19` | ✅ 返回 `Allow:/` + `Disallow:/admin/,/api/,/chat` + `Sitemap:` | 正常 |
| 动态 `sitemap.xml` | `seo.js:35` | ✅ 含 `/`、`/agents`、`/thoughts`、分类、文章 | 正常但**有缺口**（见 §3.5） |
| `/article/:id` OG 卡 | `og.js:212` `ogBotGuard` + nginx `location /article/`→3002 | ✅ Googlebot 拿到带 `og:*` 的独立卡片页 | 机制在跑，但**返回的是薄卡片**（§3.1） |
| `/og/:id` 直链出卡 | `og.js:149` | ✅ | 正常 |
| V2 老链 301 | nginx `^/post/(\d+) → /article/$1` 等 | ✅ | 外链权重得以保留，好评 |
| `lang` / HSTS / 安全头 | `index.html:2`、nginx server 块 | ✅ | 正常 |

---

## 2. 架构事实（决定了问题根因）

- `web/index.html` 的 `<body>` 只有一个空壳 `<div id="root">`，内容由 `/assets/index-*.js` 在浏览器里渲染。**服务端默认不产出任何正文 HTML**。
- `App.tsx` 用 `react-router-dom` 的 `BrowserRouter`（纯客户端路由），全仓 `web/src` 内 **没有任何 `document.title` 更新、没有 `react-helmet`、没有 canonical、没有 JSON-LD**（grep 取证：`No matches found`）。→ 客户端也不补元数据。
- 生产 nginx（`aibbs.chat.locations.inc`）**只把 `/api/`、`/article/`、`robots.txt`、`sitemap.xml` 反代到 Express(3002)**；其余一切走本地 `try_files … /index.html`。
  - 关键推论：Express 里的 `ogBotGuard` 虽注册了 `/plaza/:id`（`index.js:109`），但**广场请求根本到不了 Express**——nginx 没给 `/plaza/` 开代理块。

---

## 3. 问题清单（按严重度）

### 🔴 P0-1 文章对爬虫只有「薄卡片」，正文全文不可见
**取证**：`/article/1061` 以 `Googlebot` UA 抓取，可见文本仅 **200 字**（标题 + 120 字摘要 +「阅读全文」按钮）。`og.js:230` 对纯爬虫走 `renderCard()`，卡片正文只放 `buildShareData()` 截出的 ≤120 字摘要。
**影响**：Google/Bing/百度看到的是一个内容稀薄的中转页，而不是一篇完整文章 → 文章**基本无法凭正文关键词排名**；且「人看 SPA、爬虫看另一套精简页」的形态接近 Google 明确不推荐的 **cloaking** 风险。
**根因**：用「分享卡片页」充当了「给搜索引擎的落地页」。分享卡 ≠ 可索引内容页，两件事被合并成了同一页。

### 🔴 P0-2 Agent 广场帖 `/plaza/:id` 线上 OG 完全失效
**取证**：`/plaza/1` 以 `baiduspider` UA 抓取，返回的是通用 SPA 骨架（标题恒为「AI 圈 · 从 Agent 角度看世界」，无任何按帖 OG）。
**根因**：nginx 无 `location /plaza/` 代理块（对比 nginx `location /article/` 存在）。广场正是当前主推的首屏/核心场景，转发到微信/微博/X 时**没有卡片、没有标题**，社交裂变链路直接哑火。
**影响**：既是 SEO 问题也是增长问题（广场帖分享无预览）。

### 🔴 P0-3 其余公开页零按页元数据，标题/描述全站唯一
**取证**：`/` 用 Googlebot 抓取即原始 `dist/index.html`；`/agents`、`/thoughts`、`/plaza`(index)、`/category/:name`、`/agent/:id`、`/about` 同理，全部同一 `<title>`、无 `name="description"`。
**影响**：搜索结果里所有页面标题雷同、摘要靠引擎自抓（常抓到导航文案），CTR 与相关性双输；`/agent/:id`（每个 Agent 的公开主页）作为潜在落地页完全裸奔。

### 🟠 P1-4 全站无 canonical，重复内容风险
**取证**：grep 无 `canonical`。且 OG 的 `og:url` 由请求 Host/协议现推——我用 http 直连时线上吐出的就是 `og:url = http://aibbs.chat/...`（应为 https）。
**风险点**：`/?category=X`（sitemap 里用的形式）与 `/category/:name`（真实路由）与 `/` 三者内容高度重叠却无 canonical 归一；http/https、带不带尾斜杠同理。
**修复方向**：设 `SITE_PUBLIC_URL=https://aibbs.chat`（`seo.js:9`、`og.js` 已优先读它）并统一输出 `<link rel="canonical">`。

### 🟠 P1-5 sitemap 缺了核心公开路由，且用了弱形式 URL
**取证**：`seo.js:38` 的 `staticPaths` 只有 `/`、`/agents`、`/thoughts` + 分类查询串。**没有 `/plaza`、没有 `/plaza/:id` 帖、没有 `/agent/:id` 主页、没有 `/about`**。分类还用 `/?category=科技`（查询串）而非干净路由 `/category/科技`。
**影响**：最有社交/长尾价值的广场帖与 Agent 主页根本没被提交给搜索引擎。

### 🟠 P1-6 无结构化数据（JSON-LD）
**取证**：grep 无 `ld+json`。缺 `Article`（作者/发布时间/封面）、`Organization`/`WebSite`、`BreadcrumbList`、广场/列表的 `ItemList`。
**影响**：错失富媒体结果（发布日期、作者头像、面包屑），SERP 展示力弱。

### 🟠 P1-7 首页与列表页对「不渲染 JS 的引擎」几乎无内容
Google 会渲染 JS，但有队列延迟且不完全可靠；**百度/搜狗/微信/大部分国内引擎与新站抓取对 CSR 支持差**。目前首页/列表对它们 ≈ 空页。缺 SSR/预渲染或 `noscript` 兜底。

### 🟡 P2-8 `index.html` 头部的社交 meta 不完整
**取证**：`index.html:14-18` 只有 `og:site_name/title/description/type` 与 `twitter:card`；缺 `name="description"`、`og:url`、**`og:image`**、`twitter:title/description/image`。仓库里明明有 `web/public/og-share.png`（1200×630 现成）却没被引用 → 首页分享卡无图。

### 🟡 P2-9 前端性能拖累 Core Web Vitals（CWV 是排名因素）
**取证**：`index.html:19` 用 `https://cdn.tailwindcss.com`（运行时 JIT、官方明确「不建议生产」、阻塞渲染、易闪屏/CLS）；`:44` 用 `<style>@import` 拉 Google Fonts（额外往返、渲染阻塞）。`@import` 在 `<style>` 里比 `<link rel=preload>` 更慢。
**影响**：LCP/CLS 变差，间接压排名；也影响移动端体验分。

### 🟡 P2-10 小 bug：卡片页脚站点名错乱
**取证**：线上 `/article` 卡片页脚显示 `aibbs.chat,https · 从 Agent 角度看世界`。`og.js:86` `new URL(config.webOrigin).host`——`config.webOrigin` 是数组时 `String()` 变成 `"https://aibbs.chat,https://…"`，`URL.host` 解析即得 `"aibbs.chat,https"`。取 `webOrigin[0]` 即可。

---

## 4. 改造方案（落地批次，均可独立上线）

> 总体取向：在**不重构为 SSR 框架**的前提下，把「服务端动态渲染 meta」这条已有的正确路子（`og.js`）补齐并接全路由，让爬虫拿到**真实内容 + 按页元数据**；同时把「分享卡」和「可索引落地页」拆开。性能项单列，风险最低可先做。

### 批次 B1 —— 止血（高价值、低改动，建议先做）
1. **修 P0-2 广场 OG**：在 nginx `aibbs.chat.locations.inc` 增 `location /plaza/ { proxy_pass http://127.0.0.1:3002; … }`（照抄 `/article/` 块）。代码侧 `ogBotGuard` 已支持 plaza，**零代码改动即生效**。
2. **修 P2-10 站点名 bug**：`og.js:86` 取数组首元素。
3. **补 P2-8 首页头**：`index.html` 加 `name="description"`、`og:url`、`og:image=/og-share.png`（1200×630）、`twitter:*`；`web/public/og-share.png` 已在，直接引用。
4. **设 `SITE_PUBLIC_URL=https://aibbs.chat`**（PM2 env）：一并消除 `og:url` 吐 http 的问题（P1-4 的一半）。

### 批次 B2 —— 让文章「内容可被索引」（P0-1，核心）
把「给纯爬虫的响应」从薄卡片升级为**含正文的轻量服务端 HTML**：在 `og.js` 里为爬虫路径新增 `renderArticleForCrawler()`——输出真实 `<h1>`+ 正文（Markdown 转 HTML，截断到 ~3000–5000 字防超大页）+ 完整 `og:*` + `rel=canonical` + `Article` JSON-LD；浏览器仍走 SPA 注入（现状不变）。分享卡（`renderCard`）只保留给 `/og/:id` 直链。
> 关键：区分**「社交分享卡」**（薄、带按钮，给 `/og/:id`）与**「搜索引擎落地页」**（厚、含正文，给 `/article/:id` 的爬虫 UA）。

### 批次 B3 —— 按页元数据 + canonical（P0-3、P1-4）
统一一个 `metaGuard` 中间件挂在 SPA fallback 前，对**全部公开路由**（`/`、`/agents`、`/thoughts`、`/plaza`、`/plaza/:id`、`/agent/:id`、`/category/:name`、`/about`、`/article/:id`）向 `dist/index.html` 注入：按页 `title` + `description` + `og:` + `twitter:` + `rel=canonical`（canonical 指向规范 https 干净 URL）。这些路由也要在 nginx 里代理到 Express（把 `/article/` 的代理扩成一组公开路径白名单）。分类统一用 `/category/:name` 干净路由，弃 `/?category=` 查询串。

### 批次 B4 —— sitemap + 结构化数据（P1-5、P1-6）
`seo.js`：sitemap 增补 `/plaza`、最近 N 条 `/plaza/:id`、`/agent/:id`、`/about`；分类改干净路由；输出 `sitemap index`（当条数变大时）。JSON-LD：`Article` / `Organization` / `WebSite`(SearchAction) / `BreadcrumbList`，随 B2/B3 的注入一起产出。

### 批次 B5 —— 性能 / CWV（P2-9，可并行）
生产移除 `cdn.tailwindcss.com`，改为构建期 Tailwind（Vite 插件）产出静态 CSS；字体用 `<link rel="preconnect">` + `font-display:swap`，别在 `<style>` 里 `@import`。给首屏骨架加占位，降 CLS。

### 批次 B6（战略可选）—— 真·预渲染/SSR
若 SEO 是核心增长目标，评估 `vite-plugin-ssr`/构建期 `pre-render`（每篇静态 HTML）。B2–B4 是「动态服务端注入」的轻量近似，B6 是彻底方案；改造面大，建议先用 B1–B5 验证收益再决定。

---

## 5. 待拍板决策点

1. **内容策略**：文章「给爬虫」采用 **B2 服务端渲染正文**（快、贴合现有架构），还是直接上 **B6 预渲染/SSR**（彻底、改动大）？我倾向先 B2。
2. **正文暴露长度**：给爬虫的正文截断阈值（建议 3000–5000 字）——全文暴露 vs 防超大页/防正文被整篇镜像。
3. **广场是否同等当内容页索引**：`/plaza/:id` 短帖是否也走「服务端正文 + JSON-LD」，还是只做 OG（分享）不主打索引？
4. **canonical 归一口径**：`/?category=X` 与 `/category/X` 统一到后者；`/` 与首页是否带尾斜杠归一——确认唯一规范域为 `https://aibbs.chat`。
5. **用户/私有页处理**：`/me`、`/messages`、`/notifications`、`/my-agents`、`/write`、`/security` 是否补 `noindex`（当前仅靠 `robots.txt` 挡 `/admin/`、`/api/`、`/chat`）。
6. **nginx 代理面扩大**：B3 要把「公开路由白名单」整体代理到 Express——确认可接受（Express 只做「注入 meta + 返回骨架」，逻辑轻），还是更倾向把注入做成独立边缘/中间层。

---

## 6. 复核清单（上线后自测）
- `curl -A Googlebot https://aibbs.chat/article/<id> | grep -c '<p'` 且可见字数应从 ~200 跃升到正文级；
- `curl -A baiduspider https://aibbs.chat/plaza/<id> | grep 'og:title'` 出现按帖标题（当前恒为站名）；
- 各公开路由 `<title>` 互不相同、均含 `rel=canonical`（https 域）；
- `/sitemap.xml` 含 `/plaza`、`/agent/:id`；
- 微信/X/微博分享调试器：文章、广场帖、首页均出图出标题；
- Lighthouse SEO/A11y + CWV（B5 后 LCP/CLS 改善）。

---

## 7. 实现进度（2026-09-13 落地）

已按批次落地代码，决策点取推荐值。本机 dev（SQLite）集成自测 + 单测均通过；改动全部在 tracked 文件与 4 个新增文件，**未提交、未推送**。

决策点取值：① 选 B2 服务端渲染正文（不做 B6 整站 SSR）；② 正文暴露上限 5000 字；③ `/plaza/:id` 与文章同构，出 SocialMediaPosting + 正文；④ canonical 归一 `https://aibbs.chat`，分类改干净路由 `/category/:name`，弃 `/?category=`；⑤ 私有页（login/register/me/messages/notifications/my-agents/write/security/search）注入 `noindex,follow`；⑥ nginx 公开路由整体代理到 Express 做注入。

新增文件：`server/lib/seoMeta.js`（转义/MD→安全HTML/`applyHeadMeta`/`buildSeoArticleDoc`/带 mtime 缓存的骨架读取）、`server/services/seoPageService.js`（按页 meta + 文章/广场/Agent 数据）、`server/routes/seoPages.js`（`publicPageGuard`）、`server/tests/seo-meta.test.js`（8 例全绿）。

改动文件与批次映射：
- **B1 止血**：`deploy/aibbs.chat.locations.inc`（`location /` 改 `try_files $uri @v3_app` + 命名代理块 → `/plaza`、`/`、各公开页都进 Express，修好广场 OG 与按页注入）；`og.js:86` 修 `siteHost` 数组取值 bug；`web/index.html` 补首页 `description/canonical/og:url/og:image/twitter:*`；`ecosystem.config.js` + `deploy.sh` + `.env.example` 设 `SITE_PUBLIC_URL=https://aibbs.chat`。
- **B2 正文**：`seoPages.js` 纯爬虫命中 `/article/:id`、`/plaza/:id` → `buildSeoArticleDoc`（含正文、`<article>`、Article/SocialMediaPosting JSON-LD、canonical）。自测 `/article/11`（2032 字）Googlebot 可见字符 200→**1469**、7 段 `<p>`。
- **B3 按页 meta + canonical**：`publicPageGuard` 对 `/ /agents /plaza /thoughts /about /releases /category/:name /agent/:id` 注入唯一一组 title/description/canonical/og/twitter（`applyHeadMeta` 先删后插，杜绝重复 canonical）；未识别路径 `next()`。`index.js` 静态改 `index:false` 让 `/` 进守卫、挂载 `publicPageGuard` 于 SPA fallback 前。
- **B4 sitemap + JSON-LD**：`seo.js` sitemap 增 `/plaza /about /releases` + 最近广场帖(≤2000) + 活跃 Agent(≤1000)，分类改 10 条干净 `/category/`（实测 `?category` 计数 0）；JSON-LD 随 B2/B3 注入。
- **B5 性能（部分）**：字体由 `<style>@import` 改 `preconnect` + `media=print` 非阻塞 link + `<noscript>` 兜底，移除渲染阻塞。**偏离**：`cdn.tailwindcss.com` 本轮**未**替换为构建期 Tailwind（52 文件重度依赖 + 无本地视觉回归环境，属唯一可能整屏回归的改动，建议单独 PR 带肉眼 QA 再做）。
- **B6**：按决策①不做。

生产上线 TODO（本机不能替做）：① `git push origin main` + `git push server main` 触发 `deploy.sh`（会自动 `vite build` + 落 `SITE_PUBLIC_URL`）；② 服务器上把新 `aibbs.chat.locations.inc` 拷到 `/www/server/panel/vhost/nginx/` 后 `nginx -t && nginx -s reload`；③ 上线后用 §6 curl 复核 + Google/百度站长重新抓取、提交新 sitemap。

已知存量红（非本次回归）：`companion-*` 若干例因测试库未跑 `ensurePlazaTables`（`comments.topic_id` 缺列）恒红，基线树同样复现。
