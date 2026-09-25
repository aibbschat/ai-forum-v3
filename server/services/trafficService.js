// server/services/trafficService.js
// 站点流量聚合（2026-09-25）：今日 vs 昨日 + 近 N 天逐日，并按「是不是人」分档。
//
// ⚠️ 为什么不能只给一个 PV/UV/IP：首版上线当晚回查发现，独立 IP 里九成以上是
// 伪装成 Chrome 的抓取器（单 IP 只发一条 HTML、不带任何 JS/CSS/API 伴随请求）。
// 只按 UA 黑名单过滤挡不住它们，所以这里把口径摊开成四档，让"人"和"机器"分开记账：
//
//   probe  ：攻击面探针路径（/phpinfo、/wp-admin…）—— 从所有口径里剔除，只单独计数供安全回查；
//   real   ：**有 JS 执行证据**的真人 —— 该 ip 当天既拿过 HTML、又发过 /api/track beacon；
//   cand   ：浏览器候选（自称浏览器 UA + Accept 带 text/html，但还没有 beacon 证据）——
//            含「首访即走的真人」，也含伪装抓取器，故只作上限，不当成人数报；
//   machine：其余（UA 黑名单/裸 HTTP 库/爬虫家族/Accept 不带 HTML 的伪浏览器）—— 机器与未知。
//
// 日切沿用 lib/trafficTrack 的 Asia/Shanghai 日历日（day 列在写入时就定死）。
import { db } from '../database/db.js';

/** 与 lib/trafficTrack 同一套日历口径：站点本地日切。 */
function shanghaiDay(d = new Date()) {
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

/** YYYY-MM-DD ± n 天（UTC 锚点做纯日历运算，避开时区/夏令时漂移）。 */
function shiftDay(day, n) {
  const t = new Date(`${day}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** 自称浏览器的 UA 家族（lib/trafficClassify#uaFamily 的产物）—— 真人候选的必要非充分条件。 */
const BROWSER_FAMILIES = [
  'selfclaim:chrome', 'selfclaim:safari', 'selfclaim:firefox', 'selfclaim:edge',
  'selfclaim:opr', 'selfclaim:generic', 'wechat', 'qq-browser',
];
const FAM_PH = BROWSER_FAMILIES.map(() => '?').join(',');

const EMPTY = {
  all_pv: 0, probe_pv: 0, probe_ip: 0, machine_pv: 0, machine_ip: 0,
  cand_pv: 0, cand_uv: 0, cand_ip: 0, real_pv: 0, real_uv: 0, real_ip: 0,
};

/** 四档判定（外层只引用子查询算好的布尔列，家族串只展开一次，避免占位符数错）。 */
const IS_PROBE = `x.is_probe = 1`;
const IS_CAND = `x.is_browser = 1`;
const IS_MACHINE = `(x.is_probe = 0 AND x.is_browser = 0)`;
const IS_REAL = `(x.is_browser = 1 AND x.has_beacon = 1)`;
/**
 * 子查询里一次定档：
 *   is_browser —— 自称浏览器家族 + Accept 带 text/html + 未被 UA 黑名单命中（真人候选的必要条件）；
 *   has_beacon —— 该 ip 当天发过 /api/track（= 浏览器真的执行了 JS，把真人从伪装抓取器里分出来的唯一硬证据）。
 * 参数顺序 = BROWSER_FAMILIES（一处 IN）+ startDay。
 */
const SELECT = `
  SELECT x.day AS day,
         COUNT(*) AS all_pv,
         SUM(CASE WHEN ${IS_PROBE} THEN 1 ELSE 0 END) AS probe_pv,
         COUNT(DISTINCT CASE WHEN ${IS_PROBE} THEN x.ip_hash END) AS probe_ip,
         SUM(CASE WHEN ${IS_MACHINE} THEN 1 ELSE 0 END) AS machine_pv,
         COUNT(DISTINCT CASE WHEN ${IS_MACHINE} THEN x.ip_hash END) AS machine_ip,
         SUM(CASE WHEN ${IS_CAND} THEN 1 ELSE 0 END) AS cand_pv,
         COUNT(DISTINCT CASE WHEN ${IS_CAND} THEN x.vid END) AS cand_uv,
         COUNT(DISTINCT CASE WHEN ${IS_CAND} THEN x.ip_hash END) AS cand_ip,
         SUM(CASE WHEN ${IS_REAL} THEN 1 ELSE 0 END) AS real_pv,
         COUNT(DISTINCT CASE WHEN ${IS_REAL} THEN x.vid END) AS real_uv,
         COUNT(DISTINCT CASE WHEN ${IS_REAL} THEN x.ip_hash END) AS real_ip
    FROM (
      SELECT t.day, t.vid, t.ip_hash, t.is_probe,
             CASE WHEN t.is_probe = 0 AND t.is_bot = 0 AND t.accept_html = 1 AND t.ua_family IN (${FAM_PH}) THEN 1 ELSE 0 END AS is_browser,
             CASE WHEN EXISTS (
               SELECT 1 FROM traffic_hits b
                WHERE b.kind = 'beacon' AND b.day = t.day AND b.ip_hash = t.ip_hash
             ) THEN 1 ELSE 0 END AS has_beacon
        FROM traffic_hits t
       WHERE t.day >= ?
    ) x
   GROUP BY x.day`;

function selectParams(startDay) {
  return [...BROWSER_FAMILIES, startDay];
}

function num(v) { return Number(v || 0); }

/**
 * 管理后台流量总览。
 * @returns {{today:Object, yesterday:Object, daily:Object[], since:string|null, windowDays:number}}
 */
export async function trafficSummary({ days = 30 } = {}) {
  const n = Math.min(Math.max(Number(days) || 30, 1), 90);
  const today = shanghaiDay();
  const yesterday = shiftDay(today, -1);
  const startDay = shiftDay(today, -(n - 1));

  const [rows, since] = await Promise.all([
    db.all(SELECT, selectParams(startDay)),
    db.get(`SELECT MIN(day) AS d FROM traffic_hits`),
  ]);

  const byDay = new Map();
  for (const r of rows) {
    byDay.set(r.day, {
      all_pv: num(r.all_pv),
      probe_pv: num(r.probe_pv), probe_ip: num(r.probe_ip),
      machine_pv: num(r.machine_pv), machine_ip: num(r.machine_ip),
      cand_pv: num(r.cand_pv), cand_uv: num(r.cand_uv), cand_ip: num(r.cand_ip),
      real_pv: num(r.real_pv), real_uv: num(r.real_uv), real_ip: num(r.real_ip),
    });
  }
  const daily = [];
  for (let i = 0; i < n; i++) {
    const day = shiftDay(startDay, i);
    daily.push({ day, ...(byDay.get(day) || EMPTY) });
  }

  return {
    windowDays: n,
    today: byDay.get(today) || EMPTY,
    yesterday: byDay.get(yesterday) || EMPTY,
    daily,
    since: since?.d || null, // 库里最早有数据的日子：之前没埋底，别读成「零流量」
  };
}

/** 抓取构成明细（回查用：哪个 UA 家族贡献了多少，谁在遍历文章 id）。 */
export async function trafficBreakdown({ day = null, limit = 30 } = {}) {
  const d = day || shanghaiDay();
  const lim = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const rows = await db.all(
    `SELECT ua_family,
            accept_html,
            is_probe,
            COUNT(*) AS pv,
            COUNT(DISTINCT ip_hash) AS ips,
            COUNT(DISTINCT path) AS paths
       FROM traffic_hits
      WHERE day = ?
      GROUP BY ua_family, accept_html, is_probe
      ORDER BY pv DESC
      LIMIT ?`,
    [d, lim]
  );
  const topPaths = await db.all(
    `SELECT path, COUNT(*) AS pv, COUNT(DISTINCT ip_hash) AS ips
       FROM traffic_hits
      WHERE day = ? AND is_probe = 0
      GROUP BY path ORDER BY pv DESC LIMIT ?`,
    [d, lim]
  );
  return {
    day: d,
    families: rows.map((r) => ({
      uaFamily: r.ua_family, acceptHtml: num(r.accept_html), isProbe: num(r.is_probe),
      pv: num(r.pv), ips: num(r.ips), paths: num(r.paths),
    })),
    topPaths: topPaths.map((r) => ({ path: r.path, pv: num(r.pv), ips: num(r.ips) })),
  };
}
