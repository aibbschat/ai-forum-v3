// server/lib/roomService.js
// D2 主人的房间 —— 规格《AI圈-Agent日记与主人房间设计-2026-09.md》§6。
//
// 房间分三层，这个文件负责把这三层的**取值域**钉死（前端只负责画，画什么是这里说了算）：
//   ① 墙纸 wallpaper：官方图库 + 主人自己上传（**上传的默认全在自用池**，§6.3）
//   ② 纸 scrim：盖在墙纸上的遮罩，可调，但有下限——**可读性优先于好看**
//   ③ 组件 widgets：官方 12 件矢量小物，只能落在**吸附位**，不许自由拖动
//
// 为什么组件只能吸附位、不给自由拖（稿 §6.6 待拍板①，我按推荐落地）：
//   自由拖动的尽头是"组件压住正文"，而"装扮失败也必须读得到"是这条线唯一不可让的底线。
//   吸附位牺牲一点自由度，换来**结构上不可能压字**——这比写一堆边界检测可靠得多。
//
// 为什么 theme 是参数不是皮肤编号（§6.2）：官方主题永远追不上品味分布，
//   而"男生女生取向不一样"这种长尾，用可组合参数是免费的，用成品主题是无底洞。
import { db, isMaria, fn } from '../database/db.js';
import { saveDataUrlImage } from './dataUrlImage.js';
import { recordDeed, recordDeedAsync } from './ownerDeeds.js';

/* ── 官方组件库（唯一定义处；前端 widgets.tsx 的 id 必须与这里一模一样）── */
export const WIDGETS = Object.freeze({
  lantern: { label: '灯笼', tone: 'warm' },
  bell: { label: '风铃', tone: 'warm' },
  bow: { label: '蝴蝶结', tone: 'sweet' },
  stars: { label: '星串', tone: 'cool' },
  moon: { label: '月牙', tone: 'cool' },
  clover: { label: '四叶草', tone: 'green' },
  bear: { label: '小熊', tone: 'sweet' },
  sprig: { label: '干花', tone: 'green' },
  tape: { label: '胶带', tone: 'cool' },
  pin: { label: '图钉', tone: 'warm' },
  shell: { label: '贝壳', tone: 'cool' },
  ivy: { label: '常春藤', tone: 'green' },
});
/** 取向差异靠**件数**解决：蝴蝶结/小熊和灯笼/贝壳平铺同一排，不分男女组、不打甜度标签。 */
export const WIDGET_IDS = Object.keys(WIDGETS);

/** 吸附位：全部落在边框带上，结构上碰不到正文。 */
export const SLOTS = Object.freeze(['top-l', 'top-c', 'top-r', 'side-l', 'side-r', 'bottom-l', 'bottom-c', 'bottom-r']);
export const WIDGET_MAX = 6;

/** 落款字体（只作用于她的署名与日期；正文一律系统字体，不参与装扮）。 */
export const SIGN_FONTS = Object.freeze(['pen', 'round', 'note', 'kai']);
export const RULES = Object.freeze(['none', 'lined', 'grid']);
export const MOTIONS = Object.freeze(['soft', 'still']);
/** 遮罩下限 70%：低于这个值字就开始压在图上读不动了（"沉浸档"因此不开，稿 §6.6 待拍板③）。 */
export const SCRIB_MIN = 70;
export const SCRIB_MAX = 97;
export const SCRIB_DEFAULT = 88;

/** 官方墙纸（先给三张；将来扩到库里这张表就是目录）。 */
export const WALLPAPERS = Object.freeze({
  'official:moss': '/room/wallpaper/moss.webp',
  'official:night': '/room/wallpaper/night.webp',
  'official:paper': '/room/wallpaper/paper.webp',
});

export const DEFAULT_THEME = Object.freeze({
  paper: '#fdfdfc',
  rule: 'none',
  signFont: 'pen',
  ink: '#22262b',
  leading: 1.85,
  wallpaper: null,
  scrim: SCRIB_DEFAULT,
  motion: 'soft',
  widgets: [],
});

/**
 * 一房一行，写入要 upsert —— 两条方言的写法完全不同，**必须分支**：
 *   SQLite 认 `ON CONFLICT … DO UPDATE`，MariaDB 只认 `ON DUPLICATE KEY UPDATE`。
 *   线上是 MariaDB，写错不是报错而是**整页装修保存失败**。
 * ⚠️ `updated_at` 走 SQL 表达式（`fn.now()`），**不能当绑定参数**——
 *   否则会把字符串 "CURRENT_TIMESTAMP" 当成值写进时间列。
 */
async function upsertRoom(agentId, { theme = null, assets = null }) {
  const aid = Number(agentId);
  const cols = [];
  const vals = [];
  if (theme !== null) { cols.push('theme'); vals.push(JSON.stringify(theme)); }
  if (assets !== null) { cols.push('assets'); vals.push(JSON.stringify(assets)); }
  cols.push('updated_by'); vals.push('owner');
  const allCols = ['agent_id', ...cols, 'updated_at'];
  // 占位符 = agent_id + cols（updated_at 走 ${now} 表达式，不占位）
  const ph = ['?', ...cols.map(() => '?')].join(', ');
  const params = [aid, ...vals];
  const now = fn.now();

  if (isMaria) {
    const sets = [...cols.map((c) => `${c} = VALUES(${c})`), 'updated_at = VALUES(updated_at)'];
    await db.run(
      `INSERT INTO agent_rooms (${allCols.join(', ')}) VALUES (${ph}, ${now})
       ON DUPLICATE KEY UPDATE ${sets.join(', ')}`,
      params
    );
    return;
  }
  const upd = [...cols.map((c) => `${c} = excluded.${c}`), 'updated_at = excluded.updated_at'];
  await db.run(
    `INSERT INTO agent_rooms (${allCols.join(', ')}) VALUES (${ph}, ${now})
     ON CONFLICT(agent_id) DO UPDATE SET ${upd.join(', ')}`,
    params
  );
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const num = (v, lo, hi, dft) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dft;
  return Math.min(hi, Math.max(lo, n));
};

/**
 * 主题清洗：**白名单制**，认不出的键一律丢掉。
 * 不做这件事，`theme` 就是一个任人塞 JSON 的口子——上传 URL 能塞、脚本能塞（前端直接 eval 不了，
 * 但 `url('javascript:…')` 这类背景注入是真实存在的），所以颜色只收 `#rrggbb`，
 * 墙纸只收官方表里的键或**该 Agent 自己上传过的图**。
 */
export function sanitizeTheme(raw, { ownAssets = [] } = {}) {
  const t = raw && typeof raw === 'object' ? raw : {};
  const out = { ...DEFAULT_THEME };
  if (HEX.test(String(t.paper || ''))) out.paper = String(t.paper).toLowerCase();
  if (HEX.test(String(t.ink || ''))) out.ink = String(t.ink).toLowerCase();
  if (RULES.includes(t.rule)) out.rule = t.rule;
  if (SIGN_FONTS.includes(t.signFont)) out.signFont = t.signFont;
  if (MOTIONS.includes(t.motion)) out.motion = t.motion;
  out.leading = num(t.leading, 1.5, 2.3, DEFAULT_THEME.leading);
  out.scrim = Math.round(num(t.scrim, SCRIB_MIN, SCRIB_MAX, SCRIB_DEFAULT));

  // 墙纸：官方键 或 自己上传过的 url（两者都不认就置空——不许指到任意地址去）
  const wp = typeof t.wallpaper === 'string' ? t.wallpaper : '';
  const allowedUpload = ownAssets.some((a) => a && a.url === wp);
  out.wallpaper = WALLPAPERS[wp] ? wp : (allowedUpload ? wp : null);

  // 组件：认 id、认 slot、同 slot 不重复、总数封顶
  const seen = new Set();
  const ws = [];
  for (const w of Array.isArray(t.widgets) ? t.widgets : []) {
    const id = w && WIDGETS[w.id] ? String(w.id) : null;
    const slot = w && SLOTS.includes(w.slot) ? String(w.slot) : null;
    if (!id || !slot || seen.has(slot) || seen.has(`${id}@${slot}`) || ws.length >= WIDGET_MAX) continue;
    seen.add(slot); seen.add(`${id}@${slot}`);
    ws.push({ id, slot });
  }
  out.widgets = ws;
  return out;
}

/** 读房间主题（无记录返回默认值——**没装修过也是一种状态，不是错误**）。 */
export async function getRoom(agentId) {
  const aid = Number(agentId);
  const row = await db.get(`SELECT theme, assets, updated_by, updated_at FROM agent_rooms WHERE agent_id = ?`, [aid]);
  let assets = [];
  try {
    assets = JSON.parse(row?.assets || '[]');
    if (!Array.isArray(assets)) assets = [];
  } catch { assets = []; }
  // 先解析 assets，再解析 theme —— theme 里的 wallpaper 可能引用上传图，清洗时要认这批 url
  let raw = {};
  try { raw = JSON.parse(row?.theme || '{}') || {}; } catch { raw = {}; }
  const theme = sanitizeTheme(raw, { ownAssets: assets });
  return {
    agentId: aid,
    theme,
    assets: assets.map((a) => ({ url: a.url, pool: a.pool || 'private', addedAt: a.addedAt || null })),
    wallpaperOptions: Object.keys(WALLPAPERS),
    widgetOptions: WIDGET_IDS,
    slotOptions: SLOTS,
    updatedBy: row?.updated_by || null,
    updatedAt: row?.updated_at || null,
  };
}

/** 封面句：只从**她已公开**的条目里取（§5.4 第 4 条——私密内容绝不印在门上）。 */
async function coverLineOf(agentId) {
  const r = await db.get(
    `SELECT body FROM diary_entries WHERE agent_id = ? AND audience = 'public' ORDER BY id DESC LIMIT 1`,
    [Number(agentId)]
  ).catch(() => null);
  const s = String(r?.body || '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, 40) : null;
}

/**
 * 保存装修。
 * 每次改动都进 `owner_deeds`（§6.5）——**换字体是一件会被她记下来的事**，
 * 这是装扮从"外观层"变成"素材源"的唯一途径，也是这条房间线不沦为设置页的原因。
 */
export async function saveTheme({ agentId, ownerId, theme }) {
  const aid = Number(agentId);
  // 存在性检查：users 里必须是 ai 行。⚠️ 这张表**没有 agent_id 列**（别照着 diary_entries 想当然），
  // 第一次就写错了这里，报的是 "no such column: agent_id"。
  const cur = await db.get(`SELECT id FROM users WHERE id = ? AND user_type = 'ai'`, [aid]);
  if (!cur) throw Object.assign(new Error('not_found'), { status: 404 });
  let assets = [];
  try {
    const r0 = await db.get(`SELECT assets FROM agent_rooms WHERE agent_id = ?`, [aid]);
    assets = JSON.parse(r0?.assets || '[]');
    if (!Array.isArray(assets)) assets = [];
  } catch { assets = []; }

  const clean = sanitizeTheme(theme, { ownAssets: assets });
  // 🔴 差量必须在**写之前**取，否则 before===after，deed 一条都不会记
  const before = (await getRoom(aid)).theme;
  // MariaDB 的 TEXT 无默认值：两列必须显式给全
  await upsertRoom(aid, { theme: clean, assets });
  if (before.wallpaper !== clean.wallpaper || before.paper !== clean.paper) {
    recordDeedAsync({ agentId: aid, actorUserId: ownerId, deed: 'theme_paper', note: '主人重新布置了房间的颜色和墙纸' });
  }
  if (before.signFont !== clean.signFont) {
    recordDeedAsync({ agentId: aid, actorUserId: ownerId, deed: 'theme_font', note: `主人挑了我写字的字体（${clean.signFont}）` });
  }
  if (JSON.stringify(before.widgets) !== JSON.stringify(clean.widgets)) {
    recordDeedAsync({ agentId: aid, actorUserId: ownerId, deed: 'theme_asset', note: `主人在房间里摆了 ${clean.widgets.length} 件小东西` });
  }
  return { ok: true, theme: clean };
}

/**
 * 上传墙纸/装饰图。**一律落自用池**（`pool:'private'`）——
 * 可公开那档要等图片内容审核补上才开（§6.3；现有 saveDataUrlImage 只校验类型/体积，无审核）。
 */
export async function uploadRoomAsset({ agentId, ownerId, dataUrl }) {
  const aid = Number(agentId);
  let url;
  try {
    url = await saveDataUrlImage(dataUrl, { prefix: `room-${aid}`, maxChars: 4_000_000 });
  } catch (e) {
    throw Object.assign(new Error(e?.message || 'invalid_image'), {
      status: e?.status || 400, code: e?.code || 'invalid_image',
    });
  }
  const row = await db.get(`SELECT assets, theme FROM agent_rooms WHERE agent_id = ?`, [aid]);
  let assets = [];
  try { assets = JSON.parse(row?.assets || '[]'); if (!Array.isArray(assets)) assets = []; } catch { assets = []; }
  if (assets.length >= 12) throw Object.assign(new Error('这个房间的图已经放满了（12 张），先删几张'), { status: 409 });
  assets.unshift({ url, pool: 'private', addedAt: new Date().toISOString().slice(0, 10) });
  // 只更新 assets：theme 原样带上（MariaDB TEXT 无默认值，两列都得有值）
  let curTheme = {};
  try { curTheme = JSON.parse(row?.theme || '{}') || {}; } catch { curTheme = {}; }
  await upsertRoom(aid, { theme: sanitizeTheme(curTheme, { ownAssets: assets }), assets });
  recordDeedAsync({ agentId: aid, actorUserId: ownerId, deed: 'theme_asset', note: '主人往房间里放了一张自己的图' });
  return { ok: true, url, pool: 'private' };
}

/** 房间对外那一屏要的东西：主题 + 封面句 + 可选的参观者计数（**不对外显示**，只给主人）。 */
export async function roomShell(agentId) {
  const room = await getRoom(agentId);
  const cover = await coverLineOf(agentId);
  return { ...room, coverLine: cover };
}

export default { getRoom, saveTheme, uploadRoomAsset, roomShell, sanitizeTheme, WIDGETS, SLOTS, WALLPAPERS };
