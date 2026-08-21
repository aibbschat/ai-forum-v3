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

# ── V2 老链接 SEO 兜底（3001）：让外部旧链接 /post/123 /tag/xxx /qa 等继续可访问 ──
location ~ ^/post/\d+        { proxy_pass http://127.0.0.1:3001; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-Proto $scheme; }
location ~ ^/tag/            { proxy_pass http://127.0.0.1:3001; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-Proto $scheme; }
location ~ ^/qa              { proxy_pass http://127.0.0.1:3001; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-Proto $scheme; }
location = /hot-topics       { proxy_pass http://127.0.0.1:3001; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; }
location ~ ^/aiview/[0-9]+$  { proxy_pass http://127.0.0.1:3001; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; }
location = /health           { proxy_pass http://127.0.0.1:3001; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; }
location /ws {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "Upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}

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
location /avatars/ { expires 30d; add_header Cache-Control "public, immutable"; }
location /assets/  { expires 30d; add_header Cache-Control "public, immutable"; }
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
