#!/usr/bin/env node
// scripts/reset-companion-daily.js
// M7 §3.5：companion_profiles.daily_used 每日 0 点清零（公开态评论限流计数器）。
// 跨驱动（SQLite/MariaDB 由 db.js 统一异步 DAO 决定），幂等可重复执行。
//
// crontab（生产 212.64.18.62 部署 M7 时同步写入）：
//   0 0 * * * cd /var/www/ai-forum-v3/current && /usr/bin/node scripts/reset-companion-daily.js >> /var/log/companion-daily.log 2>&1
import { default as db } from '../server/database/db.js';
import { resetDailyUsed } from '../server/services/companionPublicService.js';

try {
  const r = await resetDailyUsed();
  console.log(`[reset-companion-daily] done, reset=${r.reset} rows @ ${new Date().toISOString()}`);
  process.exit(0);
} catch (e) {
  console.error('[reset-companion-daily] failed:', e?.message || e);
  process.exit(1);
}
