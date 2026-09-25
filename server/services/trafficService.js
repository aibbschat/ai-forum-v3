// server/services/trafficService.js
// 站点流量聚合（2026-09-25）：今日 vs 昨日 + 近 N 天每日明细。
//
// 口径与 lib/trafficTrack.js 对齐：
//   浏览 PV = 行数、访客 UV = DISTINCT vid、独立 IP = DISTINCT ip_hash，
//   一律排除 is_bot=1（机器人不冒充人气）。日切是 Asia/Shanghai 日历日（day 列建行时就定死）。
import { db } from '../database/db.js';

/** 与 lib/trafficTrack 同一套日历口径：本地（站点）日切。 */
function shanghaiDay(d = new Date()) {
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

/** YYYY-MM-DD ± n 天（纯日历运算，走 UTC 锚点避免夏令时/时区漂移）。 */
function shiftDay(day, n) {
  const t = new Date(`${day}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** 单日三指标（排除机器人）。 */
async function dayStats(day) {
  const r = await db.get(
    `SELECT COUNT(*) AS pv,
            COUNT(DISTINCT vid) AS uv,
            COUNT(DISTINCT ip_hash) AS ip
       FROM traffic_hits
      WHERE is_bot = 0 AND day = ?`,
    [day]
  );
  return { pv: Number(r?.pv || 0), uv: Number(r?.uv || 0), ip: Number(r?.ip || 0) };
}

/**
 * 管理后台流量总览。
 * 返回：today / yesterday（三指标）+ daily（近 days 天逐日，含 0 日补齐，旧→新）+ since（最早统计日）。
 */
export async function trafficSummary({ days = 30 } = {}) {
  const n = Math.min(Math.max(Number(days) || 30, 1), 90);
  const today = shanghaiDay();
  const yesterday = shiftDay(today, -1);
  const startDay = shiftDay(today, -(n - 1));

  const [t, y, rows, since] = await Promise.all([
    dayStats(today),
    dayStats(yesterday),
    db.all(
      `SELECT day,
              COUNT(*) AS pv,
              COUNT(DISTINCT vid) AS uv,
              COUNT(DISTINCT ip_hash) AS ip
         FROM traffic_hits
        WHERE is_bot = 0 AND day >= ?
        GROUP BY day`,
      [startDay]
    ),
    db.get(`SELECT MIN(day) AS d FROM traffic_hits`),
  ]);

  const byDay = new Map(rows.map((r) => [r.day, { pv: Number(r.pv), uv: Number(r.uv), ip: Number(r.ip) }]));
  const daily = [];
  for (let i = 0; i < n; i++) {
    const day = shiftDay(startDay, i);
    const s = byDay.get(day) || { pv: 0, uv: 0, ip: 0 };
    daily.push({ day, ...s });
  }

  return {
    today: t,
    yesterday: y,
    daily,
    since: since?.d || null, // 库里最早有流量的日子 —— 之前的没有历史，别误读成「零流量」
  };
}
