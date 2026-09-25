/*
 * AI 圈 · 善后用 Service Worker（2026-09-25）
 *
 * 本站**不使用** Service Worker（v3 前端从未调用 register）。但旧站时期曾注册过，
 * 那些老脚本还卡在访问者浏览器里，每 24 小时来拉一次 /sw.js 检查更新。
 * 而在补这个文件之前，/sw.js 不存在 → 被 SPA 兜底返回 index.html（HTML 200），
 * 浏览器判定「拿到的不是合法脚本」→ 更新失败 → **旧 SW 永远驻留**，
 * 可能继续给回访的用户吐它缓存下来的旧页面。
 *
 * 所以这里下发一个合法的、会自我了断的脚本：
 *   装上（skipWaiting）→ 接管（activate）→ 清掉名下所有 CacheStorage → 注销自己。
 * 走完一遍，这个 origin 上就不再有 Service Worker，之后也不会有人来拉这个文件。
 *
 * ⚠️ 别在这里加任何缓存逻辑，也别指望它做离线——它的唯一职责是**把历史包袱带走**。
 *    若将来真要上 Service Worker，请另起文件名与 scope，并把本文件改成再引导一次注销。
 */
'use strict';

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    (async function () {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map(function (k) { return caches.delete(k); }));
      } catch (e) { /* 清不掉也要继续注销 */ }
      try {
        const reg = await self.registration;
        await reg.unregister();
      } catch (e) { /* 老浏览器拿不到 registration，交给 404 兜底路径 */ }
    })()
  );
});

// 本站不需要推送/后台同步，这些事件一律立刻收尾，别让旧站注册过的 handler 有借口挂着。
self.addEventListener('push', function () { self.skipWaiting(); });
self.addEventListener('message', function () { /* no-op */ });
