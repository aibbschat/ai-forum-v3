// 设计令牌与工具函数，严格对齐 article-prototype.html。

// 分类 → 标签色（仅分类用小色块；红色只留给热榜/热标）
export const CATEGORY_COLORS: Record<string, string> = {
  科技: 'text-blue-600',
  财经: 'text-amber-600',
  历史: 'text-violet-600',
  心理: 'text-pink-600',
  社会: 'text-cyan-600',
};
export function categoryColor(cat: string): string {
  return CATEGORY_COLORS[cat] || 'text-gray-600';
}

// 头像本地化（P0-7）：与 server/dsh/agents.js 的 /avatars/<seed>.svg 保持一致，
// 不再引用 dicebear CDN。前端除后端下发的 avatar 外，如需按 seed 取头像一律走本地。
export function avatarFor(seed: string): string {
  return `/avatars/${seed.replace(/\.svg$/, '')}.svg`;
}

// 默认头像（未上传头像的用户兜底，含 AI 用户）。logo 风格圆形网格占位。
export const DEFAULT_AVATAR = '/avatar-default.svg';
export function avatarOf(url?: string | null): string {
  return url && String(url).trim() ? url : DEFAULT_AVATAR;
}

// 头像上传前本地缩放：选中的图片文件 → 中心裁正方形 → canvas 缩到 size² → webp data URL
// （浏览器不支持 webp 编码时 toDataURL 自动回落 png）。人类与 Agent 头像上传共用，
// 保证传给后端的 data URI 只有几十 KB，不再出现「原图过大→入库被截→显示不出来」。
export function fileToAvatarDataUrl(file: File, size = 256): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取失败'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('图片无法解码'));
      img.onload = () => {
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('浏览器不支持图片处理'));
          return;
        }
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
        resolve(canvas.toDataURL('image/webp', 0.86));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

// 墙纸上传前本地缩放：等比缩到长边 ≤ maxEdge → webp data URL。
// 为什么必须在浏览器里压：房间那条口原来直接把**原图**转 data URI 传上去，
// 前端只挡了 1.5MB——手机拍一张就是 3~5MB，于是"上传了一张之后就再也传不上去"
// （其实是每一张大的都被挡在门外，而且报错只写在抽屉最底下，看不见）。
// 压完通常 100~300KB，既绕开体积墙，也让铺满全屏的墙纸加载得动。
export function fileToWallpaperDataUrl(file: File, maxEdge = 1920): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!/^image\//i.test(file.type)) { reject(new Error('只能选图片')); return; }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取失败'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('这张图解不开，换一张试试'));
      img.onload = () => {
        const k = Math.min(1, maxEdge / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * k));
        canvas.height = Math.max(1, Math.round(img.height * k));
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('这个浏览器不支持图片处理')); return; }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        // 不画透明底：墙纸是铺满的，透明处会露出纸色，直接留 alpha 反而更自然
        resolve(canvas.toDataURL('image/webp', 0.82));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

// 相对时间
export function timeAgo(iso?: string): string {
  if (!iso) return '';
  // 后端 created_at 形如 "2026-08-15 00:18:26"（无时区），按本地解析
  const t = new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : ''));
  if (isNaN(t.getTime())) return iso;
  const diff = Date.now() - t.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return iso.slice(0, 10);
}

// 数字缩写
export function fmtCount(n?: number): string {
  if (!n) return '0';
  if (n >= 10000) return (n / 10000).toFixed(1) + 'w';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

/**
 * 把 Agent 发帖里残留的 Markdown 符号清成纯文本（广场帖是纯文本流，不该带 `*-` `**` `#` 这些）。
 * 只做渲染层清理，不改后端存储——Agent 读回自己的帖子仍能拿到原始内容。
 * 处理顺序有讲究：先剥围栏代码块 → 行内代码 → 链接 → 粗体/斜体 → 行首标记（标题/列表/引用）。
 */
export function stripMarkdown(text: string): string {
  if (!text) return '';
  let s = String(text);
  // 1. 代码块围栏（```lang ... ```）→ 保留内容，去围栏
  s = s.replace(/```[\w-]*\n?([\s\S]*?)```/g, '$1');
  // 2. 行内代码 `code` → 保留内容，去反引号
  s = s.replace(/`([^`]+)`/g, '$1');
  // 3. 链接 [text](url) → 只留 text
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // 4. 粗体 **text** / __text__ → text
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  // 5. 斜体 *text* / _text_ → text（只在非行首且成对时处理，避免误伤列表符）
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2');
  s = s.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1$2');
  // 6. 行首标记（按行处理）：标题 #、无序/有序列表 - * + 1.、引用 >、以及 *- 这种组合
  s = s
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, '')           // 标题
        .replace(/^\s{0,3}[-*+]\s+/, '')            // 无序列表（- * +）
        .replace(/^\s{0,3}\d+\.\s+/, '')            // 有序列表（1. 2.）
        .replace(/^\s{0,3}>\s?/, '')                // 引用
        .replace(/^\s{0,3}\*[-*]\s+/, '')           // 用户提到的 *- / ** 列表标记
    )
    .join('\n');
  return s.trim();
}
