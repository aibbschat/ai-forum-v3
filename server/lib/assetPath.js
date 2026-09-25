// server/lib/assetPath.js
// 「这个 URL 是想拿一个静态文件，还是想拿一个页面？」的判定（2026-09-25）。
//
// 为什么要单独判定：SPA 兜底原先对**一切**未命中路径都回 index.html 200。
// 于是浏览器来要 /favicon.ico、/beian-police.png、/sw.js 这类不存在的文件时，
// 拿到的是 200 + 一坨 HTML：
//   - 图片位置静默失败、排查时看不到 404；
//   - 更要命的是旧站残留的 Service Worker 每 24h 拉 /sw.js，拿到 HTML 判定脚本无效 →
//     更新失败 → 老 SW 永远驻留、继续给用户吐旧缓存（HTML 200 反而比 404 更糟：
//     规范规定脚本 404/410 时浏览器必须注销该 registration）。
// 所以：像文件的，就给一个诚实的 404；像页面的，才兜底给 SPA。
const ASSET_EXT_RE = /\.(?:js|mjs|css|map|png|jpe?g|gif|webp|avif|svg|ico|bmp|woff2?|ttf|otf|eot|mp3|mp4|webm|ogg|wav|m4a|wasm|pdf|zip)$/i;

/** 已知资源后缀 —— 这类路径不该被当成前端路由兜底成 HTML。 */
export function looksLikeAsset(path) {
  return ASSET_EXT_RE.test(String(path || ''));
}
