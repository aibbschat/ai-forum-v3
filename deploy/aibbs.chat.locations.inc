## aibbs.chat 共用 location 块，由 aibbs.chat.nginx.conf 的 80/443 两个 server 块 include。
## 编辑后执行 nginx -t && nginx -s reload 生效。
## 注意：本文件只能含 location 块，不能含 add_header / root / index 等 server 级指令。

location ~ /\. { deny all; return 404; }
location ~* \.(env|git|gitignore|md|sql|sqlite|db|bak|bak-.*|log|sh|py|ya?ml|js\.map)$ {
deny all; return 404;
}
location ~* \.php(?:/|$) { deny all; return 404; }
location ~* /(phpmyadmin|pma)(/|$) { deny all; return 404; }

# ── 鼠宝：支付中继（3100），必须在 /api 之前 ──
location /pay-relay/ {
    proxy_pass http://127.0.0.1:3100/;
    client_max_body_size 10m;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

# ── 鼠宝：API 网关 new-api（3102），必须在 /api 之前 ──
location /api/shubao/ {
    proxy_pass http://127.0.0.1:3102/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Accept-Encoding "";
    proxy_read_timeout 300s;
    proxy_buffering off;
    sub_filter 'src="/assets/' 'src="/api/shubao/assets/';
    sub_filter 'href="/assets/' 'href="/api/shubao/assets/';
    sub_filter 'href="/logo' 'href="/api/shubao/logo';
    sub_filter_once off;
}

# ── CS-Bot 客服挂件（3101），必须在 /api 之前 ──
location /api/widget/  { proxy_pass http://127.0.0.1:3101; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_read_timeout 300s; proxy_buffering off; }
location /api/super/   { proxy_pass http://127.0.0.1:3101; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_read_timeout 300s; }
location /api/tenant/  { proxy_pass http://127.0.0.1:3101; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_read_timeout 300s; }
location = /api/csrf   { proxy_pass http://127.0.0.1:3101; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; }
location /widget/      { proxy_pass http://127.0.0.1:3101; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; }
location = /cs-bot/admin       { return 301 /cs-bot/admin/; }
location = /cs-bot/admin/index.html { alias /var/www/cs-bot/admin/index.html; }
location /cs-bot/admin/ { alias /var/www/cs-bot/admin/; index index.html; try_files $uri $uri/ /cs-bot/admin/index.html; }
location = /cs-bot/dashboard   { return 301 /cs-bot/dashboard/; }
location = /cs-bot/dashboard/index.html { alias /var/www/cs-bot/dashboard/index.html; }
location /cs-bot/dashboard/ { alias /var/www/cs-bot/dashboard/; index index.html; try_files $uri $uri/ /cs-bot/dashboard/index.html; }

# ── 百家学院 / 写作营（3007） ──
location /experts/ { rewrite ^/experts/?(.*)$ /$1 break; proxy_pass http://127.0.0.1:3007; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_read_timeout 300s; proxy_buffering off; }
location /baijia/  { rewrite ^/baijia/?(.*)$  /$1 break; proxy_pass http://127.0.0.1:3007; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_read_timeout 300s; proxy_buffering off; }
location = /writing-camp      { return 301 /experts/; }
location = /writing-camp/     { return 301 /experts/; }
location /writing-camp/       { rewrite ^/writing-camp/?(.*)$ /$1 break; proxy_pass http://127.0.0.1:3007; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_read_timeout 300s; proxy_buffering off; }

# ── V2 软件中心（/download 及子路径）──────────────────────────────
# 老的架构是 nginx 直接服务 V2 frontend/dist 静态文件，只有 /api 才进后端。
# 切换时把整段 /download 反代到 3001 是错的——V2 后端只对 /、/download/shubao、
# /download/zhiji 做了 SSR，其他路径（如 /download/csbot）直接返 JSON 404，
# 浏览器里就看到"接口不存在"。
#
# 策略：在 ^~ /download 前缀块里：
#   1. 先 try_files 找真实静态文件（favicon、dist/download/aizhiji.apk 等）
#   2. 三个已知 SSR 路径反代到 V2 后端，拿带 og:* 的 HTML
#   3. 其他子路径返回 V2 的 index.html，让客户端 React Router 接管
location ^~ /download {
    root /var/www/ai-forum/prod/frontend/dist;
    default_type text/html;

    # V2 后端已停运，SSR（OG 卡片）不可用，直接走 SPA fallback
    try_files $uri @v2_spa_index;
}
# 其他 /download/* 路径回落到 V2 SPA 的 index.html（前端 React Router 渲染）
location @v2_spa_index {
    root /var/www/ai-forum/prod/frontend/dist;
    try_files /index.html =404;
}

# V2 根目录引用的小图标（V3 没有，但 /download/shubao 等 V2 页面会用到）
location = /shubao-logo.png { alias /var/www/ai-forum/prod/frontend/dist/shubao-logo.png; }
location = /aiqlogo.png     { alias /var/www/ai-forum/prod/frontend/dist/aiqlogo.png; }
location = /wechat-qr.png   { alias /var/www/ai-forum/prod/frontend/dist/wechat-qr.png; }
location = /zfb-qr.png      { alias /var/www/ai-forum/prod/frontend/dist/zfb-qr.png; }
location = /logo.png        { alias /var/www/ai-forum/prod/frontend/dist/logo.png; }
location = /default-avatar.png { alias /var/www/ai-forum/prod/frontend/dist/default-avatar.png; }

# ── V2 老链接 SEO 兜底 ─────────────────────────────────────────
# V2 已停运（ai-forum-prod 进程已从 pm2 移除），不再反代到 3001。
# 改为 301 到 V3 对应路径，保留外链 SEO 权重。
location ~ ^/post/(\d+)  { return 301 /article/$1; }
location ~ ^/tag/         { return 301 /; }
location ~ ^/qa           { return 301 /; }
location = /hot-topics    { return 301 /; }
location ~ ^/aiview/[0-9]+$ { return 301 /; }
# /health → V3 的 /api/health（V2 已停运）
location = /health        { return 301 /api/health; }
# /ws → V3 不用 WebSocket，但保留 /ws 路径不 502
location = /ws            { return 301 /; }

# ── 鼠宝桌面端自动更新（静态文件） ──
location /downloads/ {
    alias /var/www/updates/downloads/;
    types { } default_type application/vnd.android.package-archive;
    add_header Content-Disposition "attachment";
    add_header Cache-Control "no-cache";
}
location /updates/ {
    alias /var/www/updates/;
    expires 1h;
    add_header Cache-Control "public, must-revalidate";
    add_header Access-Control-Allow-Origin "*" always;
}

# ── V3 自己的接口（3002） ──
location /api/ {
    proxy_pass http://127.0.0.1:3002;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 300s;
}

# ── V3 文章 OG 动态渲染（同 ai.xs91.com） ──
location /article/ {
    proxy_pass http://127.0.0.1:3002;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_cache off;
}

# ── SEO 文件走 V3（robots.txt 动态、sitemap.xml 动态）──
location = /robots.txt  { proxy_pass http://127.0.0.1:3002; proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto $scheme; }
location = /sitemap.xml { proxy_pass http://127.0.0.1:3002; proxy_set_header Host $host; proxy_set_header X-Forwarded-Proto $scheme; }

# ── V3 静态资源 ──
# V2 的 /download 页面也会请求 /assets/DownloadCSBot-*.js 等动态 import chunk；
# V3 自己也用 /assets/index-*.js。两者构建都带 hash，不会撞名，所以用 try_files
# 先找 V3 的，找不到再回落到 V2 的 dist。
location /avatars/ { expires 30d; add_header Cache-Control "public, immutable"; }
location /assets/ {
    root /var/www/ai-forum-v3/current/web/dist;
    try_files $uri @v2_assets;
    expires 30d;
    add_header Cache-Control "public, immutable";
}
location @v2_assets {
    root /var/www/ai-forum/prod/frontend/dist;
    try_files $uri =404;
    expires 30d;
    add_header Cache-Control "public, immutable";
}
location /covers/ {
    alias /var/www/ai-forum-v3/covers/;
    expires 30d;
    add_header Cache-Control "public, immutable";
    add_header X-Content-Type-Options "nosniff" always;
}
location = /index.html {
    add_header Cache-Control "no-cache, no-store, must-revalidate";
}
location = /og-share.png {
    try_files /og-share.png =404;
}

# ── SPA fallback（所有未命中路径返回 V3 index.html） ──
location / {
    try_files $uri $uri/ /index.html;
}
