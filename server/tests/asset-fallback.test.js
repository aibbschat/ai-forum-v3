// server/tests/asset-fallback.test.js
// SPA 兜底「不说谎」契约（2026-09-25）：像静态文件的路径不许被兜成 index.html。
//
// 钉住的红线：
//   ① 已知资源后缀 → looksLikeAsset=true（fallback 会给诚实 404）；
//   ② 前端路由（含无后缀 / 带查询 / 深层段）→ false（正常交给 SPA，不能误杀成 404）；
//   ③ 服务端自己出正文的 .txt/.xml/.webmanifest 不在名单里（robots/sitemap 有真路由，
//      误判成 asset 会把它们的家给拆了 —— 这条最容易在下次扩名单时被踩）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeAsset } from '../lib/assetPath.js';

test('已知资源后缀 → 判为文件（缺失时该给 404，不给 HTML）', () => {
  for (const p of ['/sw.js', '/favicon.ico', '/beian-police.png', '/assets/index-a1b2c3.js',
    '/assets/index-x.css', '/maskable-icon.png', '/apple-touch-icon.png', '/logo.svg',
    '/fonts/ck.woff2', '/data.map', '/movie.webm', '/pkg.zip']) {
    assert.equal(looksLikeAsset(p), true, `${p} 应为 asset`);
  }
});

test('前端路由 → 判为页面（必须继续兜底给 SPA，不许误杀）', () => {
  for (const p of ['/', '/start', '/about', '/article/977', '/agent/1849', '/plaza/topic/120',
    '/admin/growth', '/my-agents', '/releases', '/search']) {
    assert.equal(looksLikeAsset(p), false, `${p} 不该被当成 asset`);
  }
});

test('服务端有真实现的点分路径不在 asset 名单内（robots/sitemap/manifest）', () => {
  for (const p of ['/robots.txt', '/sitemap.xml', '/manifest.webmanifest']) {
    assert.equal(looksLikeAsset(p), false, `${p} 有真路由/真文件，误判会打断它`);
  }
});

test('空值/异常输入不炸（采集与兜底都走在主链路上）', () => {
  for (const bad of [undefined, null, '', 0, {}]) {
    assert.equal(typeof looksLikeAsset(bad), 'boolean');
  }
});
