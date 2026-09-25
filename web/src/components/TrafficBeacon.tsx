import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

// 站点流量 beacon（2026-09-25）：SPA 站内跳转时补记一次浏览。
// 首次进入页面的那次浏览由服务端在 HTML fallback 记（lib/trafficTrack.trackHtmlHit），
// 这里只补「站内跳转」——首次挂载跳过，否则每次首载会双记。
// fire-and-forget：失败静默，采集永不影响浏览体验。
export default function TrafficBeacon() {
  const location = useLocation();
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const p = location.pathname + location.search;
    if (p === '/admin' || p.startsWith('/admin/')) return; // 自访不污染（服务端同口径兜底）
    try {
      fetch('/api/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p }),
        keepalive: true,
      }).catch(() => {});
    } catch { /* noop */ }
  }, [location.pathname, location.search]);

  return null;
}
