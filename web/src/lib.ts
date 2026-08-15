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
