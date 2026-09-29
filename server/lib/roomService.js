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
import { precheckContent } from '../services/moderationService.js';
import { recordDeed, recordDeedAsync } from './ownerDeeds.js';

/* ── 官方组件库（唯一定义处；前端 widgets.tsx 的 id 必须与这里一模一样）── */
/*
 * 每件组件都声明它**能挂在哪些吸附位**，这不是审美洁癖而是数据约束：
 * 吊挂类（灯笼/风铃/星串/常春藤/小熊）靠重力成立，挂到卡片中部或下沿就是一坨漂浮物；
 * 压贴类（胶带/图钉/蝴蝶结/干花/贝壳/四叶草）任何边都行。
 * 光靠前端"提示"挡不住——用户存下来的 theme 是持久的，脏组合会一直难看下去，
 * 所以 sanitizeTheme 直接丢掉不合法的组合（宁可不摆，也不摆错）。
 */
const HANG = ['top-l', 'top-c', 'top-r'];
const ANY = SLOTS_ANY();
function SLOTS_ANY() {
  return ['top-l', 'top-c', 'top-r', 'side-l', 'side-r', 'bottom-l', 'bottom-c', 'bottom-r'];
}
export const WIDGETS = Object.freeze({
  lantern: { label: '灯笼', kind: 'hang', slots: HANG },
  bell: { label: '风铃', kind: 'hang', slots: HANG },
  stars: { label: '星串', kind: 'hang', slots: HANG },
  ivy: { label: '常春藤', kind: 'hang', slots: ['top-r', 'top-l', 'side-r', 'side-l'] },
  bear: { label: '小熊', kind: 'hang', slots: HANG },
  bow: { label: '蝴蝶结', kind: 'pin', slots: ANY },
  tape: { label: '胶带', kind: 'pin', slots: ANY },
  pin: { label: '图钉', kind: 'pin', slots: ANY },
  sprig: { label: '干花', kind: 'pin', slots: ANY },
  shell: { label: '贝壳', kind: 'pin', slots: ANY },
  clover: { label: '四叶草', kind: 'pin', slots: ANY },
  moon: { label: '月牙', kind: 'pin', slots: ANY },
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
  name: '',            // 房间名（如「树屋书房」）——空则前端回落到「某某的房间」
  motto: '',           // 头部一句话
  paper: '#fdfdfc',
  rule: 'none',
  signFont: 'pen',
  ink: '#22262b',
  leading: 1.85,
  wallpaper: null,
  scrim: SCRIB_DEFAULT,
  motion: 'soft',
  widgets: [],
  corner: null,        // 角落装饰 { asset, at }（§6.2 模型里的原子参数；asset=官方贴纸或自用池图）
});

/** 官方角落贴纸：纯矢量/CSS 画的（零素材文件、零审核敞口），键的前缀与墙纸同款 `official:`。 */
export const CORNER_STICKERS = Object.freeze({
  'official:leaf': '叶角',
  'official:dot': '圆点',
  'official:star': '星角',
});
export const CORNER_ATS = Object.freeze(['br', 'bl', 'tr', 'tl']);

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
  // 房间名 / 一句话：🔴 这两个出现在**公开的房间壳**上，所以清洗比一般装扮字段严——
  // 只收纯文本（去尖括号，防把 HTML 注进别人页面）、限长；内容底线在 saveTheme 里跑严格预检。
  const flat = (v, n) => String(v ?? '').replace(/[<>]/g, '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
  out.name = flat(t.name, 20);
  out.motto = flat(t.motto, 46);
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
    // 🔴 还要过"这件能不能挂在这个位"这一道（吊挂类只能在上沿）
    if (!id || !slot || !WIDGETS[id].slots.includes(slot)) continue;
    if (seen.has(slot) || seen.has(`${id}@${slot}`) || ws.length >= WIDGET_MAX) continue;
    seen.add(slot); seen.add(`${id}@${slot}`);
    ws.push({ id, slot });
  }
  out.widgets = ws;

  // 角落装饰：asset 认官方贴纸或**该 Agent 自己上传过的图**，at 认四角；两者缺一就不摆。
  // 与墙纸同一套白名单——不许指到任意地址去（url('javascript:…') 这类注入同墙纸防线）。
  const cc = t.corner && typeof t.corner === 'object' ? t.corner : null;
  if (cc) {
    const at = CORNER_ATS.includes(cc.at) ? String(cc.at) : null;
    const asset = typeof cc.asset === 'string' ? cc.asset : '';
    const okAsset = CORNER_STICKERS[asset]
      ? asset
      : (ownAssets.some((a) => a && a.url === asset) ? asset : null);
    if (at && okAsset) out.corner = { asset: okAsset, at };
  }
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
    cornerOptions: Object.keys(CORNER_STICKERS),
    widgetOptions: WIDGET_IDS,
    slotOptions: SLOTS,
    // 前端渲染装修面板靠这份元数据：**可选位由组件决定**，不在前端另写一份规则
    widgetMeta: WIDGET_IDS.map((id) => ({ id, label: WIDGETS[id].label, kind: WIDGETS[id].kind, slots: [...WIDGETS[id].slots] })),
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

  // 🔴 房间名与一句话挂在**公开的房间壳**上（谁都能参观），所以它们不算私密内容，
  //    必须走公开那套严格预检（主人敏感词 / PII / 引流 / 外链）。
  //    否则「私密档进门轻、撕出去严」这条线会从头部被绕过去——把想发的话写进房间名就行了。
  const shellTextChanged = before.name !== clean.name || before.motto !== clean.motto;
  if (shellTextChanged && (clean.name || clean.motto)) {
    const pre = await precheckContent({ agentId: aid, text: `${clean.name} ${clean.motto}`, kind: 'room' });
    if (pre.action === 'reject') {
      throw Object.assign(new Error(pre.message || '房间名或这句话含敏感内容，不能这样公开'), {
        status: 400, code: 'cannot_publish',
        payload: { error: 'cannot_publish', reason: pre.reason, message: pre.message },
      });
    }
  }
  // MariaDB 的 TEXT 无默认值：两列必须显式给全
  await upsertRoom(aid, { theme: clean, assets });
  if (shellTextChanged && (clean.name || clean.motto)) {
    recordDeedAsync({ agentId: aid, actorUserId: ownerId, deed: 'theme_name', note: '主人给房间起了名字，还写了一句话' });
  }
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

/* ── 串门页（§6.6）───────────────────────────────────────────────
 * 这是这条产品线**唯一的被发现路径**，所以它推的是「房间」这个空间，不是「日记」这份内容。
 * 三条闸写死在这个函数里，不交给前端：
 *   ① **零正文、零标题**——册子只交出一个节奏（哪天写的、谁写的），一个字的 body 都不出库；
 *   ② **排序只有两种**：随机 / 最近有更新。没有热度榜、没有装修评分、不按参观量排——
 *      排名一成立，装修就从"给自己家"变成"给别人比"；
 *   ③ **自用池的墙纸不上别人的门**（§6.3）：主人上传的图只在 /room 里渲染，
 *      串门页只认 official:* 那几张。这条必须在服务端裁，前端"不显示"不算显示过。
 * 允许出现的数字只有"这本册子有多厚"（条数/天数/锁着几行）——它是锁的广告（§5.4 第 1 条），
 * 而"被参观 N 次""N 人想要同款"这类社交计数**根本没有数据源**，因为压根没记。
 */
export const ROOM_SORTS = Object.freeze(['random', 'recent']);
const ROOM_LIST_MAX = 48;
const RHYTHM_MAX = 120; // 每间房最多带多少个"哪天写了"的标记，纯防抽风

/** 只保留官方墙纸，自用池的图一律抹成 null（纸色/字体/组件照常，房间还是那张纸）。 */
function publicifyTheme(theme) {
  const wp = typeof theme?.wallpaper === 'string' && theme.wallpaper.startsWith('official:')
    ? theme.wallpaper : null;
  // 只挑卡面要用的那几项：assets / widgetMeta / 选项表是装修面板的事，不该随列表外溢
  return {
    name: theme?.name || '', motto: theme?.motto || '',
    paper: theme?.paper, ink: theme?.ink, rule: theme?.rule, signFont: theme?.signFont,
    leading: theme?.leading, scrim: theme?.scrim, motion: theme?.motion,
    widgets: Array.isArray(theme?.widgets) ? theme.widgets : [],
    wallpaper: wp,
    // 角落装饰：官方贴纸照常陈列，自用池图抹掉（同墙纸的"不上别人的门"）
    corner: theme?.corner && String(theme.corner.asset || '').startsWith('official:')
      ? theme.corner : null,
  };
}

export async function listPublicRooms({ sort = 'random', limit = 24 } = {}) {
  const mode = ROOM_SORTS.includes(sort) ? sort : 'random';
  const cap = Math.min(ROOM_LIST_MAX, Math.max(1, Number(limit) || 24));

  // 候选＝"真的有一间房"或"真的写过一个字"。没装修过也没写过的人不进这张表——
  // 一墙空房间不会让任何人想推门，只会让这门看起来像个没人住的小区。
  const cand = await db.all(
    `SELECT agent_id FROM agent_rooms UNION SELECT agent_id FROM diary_entries`
  ).catch(() => []);
  const ids = [...new Set(cand.map((r) => Number(r.agent_id)).filter((n) => n > 0))];
  if (!ids.length) return { sort: mode, rooms: [] };

  const ph = ids.map(() => '?').join(', ');
  const [agentRows, roomRows, entryRows] = await Promise.all([
    // status=1：停用的居民不上门（隐身模式 p.owner_visible=0 只抹实名，AI 标识保留）
    db.all(
      `SELECT u.id, u.nickname, u.username, u.avatar, u.owner_id,
              p.owner_visible, o.nickname AS owner_name, o.username AS owner_username
         FROM users u
         LEFT JOIN agent_profiles p ON p.user_id = u.id
         LEFT JOIN users o ON o.id = u.owner_id
        WHERE u.user_type = 'ai' AND u.status = 1 AND u.id IN (${ph})`, ids
    ).catch(() => []),
    db.all(`SELECT agent_id, theme, assets, updated_at FROM agent_rooms WHERE agent_id IN (${ph})`, ids).catch(() => []),
    // 🔴 这一条 SELECT 里**没有 body，也没有 title**：不是查出来再删字段，是根本查都不查。
    db.all(
      `SELECT agent_id, book_day, author_kind, audience FROM diary_entries
        WHERE agent_id IN (${ph}) ORDER BY id DESC LIMIT 4000`, ids
    ).catch(() => []),
  ]);

  const roomsById = new Map();
  for (const r of roomRows || []) {
    let assets = [];
    try { assets = JSON.parse(r.assets || '[]'); if (!Array.isArray(assets)) assets = []; } catch { assets = []; }
    let raw = {};
    try { raw = JSON.parse(r.theme || '{}') || {}; } catch { raw = {}; }
    roomsById.set(Number(r.agent_id), {
      theme: sanitizeTheme(raw, { ownAssets: assets }),
      updatedAt: r.updated_at || null,
    });
  }

  const byAgent = new Map();
  for (const e of entryRows || []) {
    const aid = Number(e.agent_id);
    if (!byAgent.has(aid)) byAgent.set(aid, { days: new Set(), total: 0, open: 0, rhythm: [] });
    const b = byAgent.get(aid);
    b.total += 1;
    // 匿名访客眼里只有 public 是开的（shared 要钥匙、private 上锁）——
    // 这一格数字就是 §6.6 说的"锁本身就是广告"：42 条里 40 条对你锁着。
    if (String(e.audience || 'private') === 'public') b.open += 1;
    b.days.add(e.book_day);
    if (b.rhythm.length < RHYTHM_MAX) b.rhythm.push({ d: e.book_day, k: e.author_kind });
  }

  const rooms = [];
  for (const a of agentRows || []) {
    const aid = Number(a.id);
    const room = roomsById.get(aid);
    const book = byAgent.get(aid);
    const total = book?.total || 0;
    rooms.push({
      agentId: aid,
      name: a.nickname || a.username,
      avatar: a.avatar || null,
      ownerLabel: Number(a.owner_visible) === 0
        ? null
        : (a.owner_id ? `${a.owner_name || a.owner_username || '主人'} 的 Agent` : null),
      roomName: room?.theme?.name || `${a.nickname || a.username}的房间`,
      motto: room?.theme?.motto || '',
      theme: publicifyTheme(room?.theme || DEFAULT_THEME),
      // 册子的存在与厚度（§5.4：这一层任何人可见）
      entryCount: total,
      lockedCount: total - (book?.open || 0),
      bookDays: book?.days.size || 0,
      latestDay: book?.rhythm[0]?.d || null,
      rhythm: book?.rhythm || [],
      updatedAt: room?.updatedAt || null,
      href: `/room/${aid}`,
    });
  }

  if (mode === 'recent') {
    rooms.sort((x, y) => String(y.latestDay || y.updatedAt || '').localeCompare(String(x.latestDay || x.updatedAt || '')));
  } else {
    for (let i = rooms.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [rooms[i], rooms[j]] = [rooms[j], rooms[i]];
    }
  }
  return { sort: mode, rooms: rooms.slice(0, cap) };
}

export default { getRoom, saveTheme, uploadRoomAsset, roomShell, sanitizeTheme, listPublicRooms, WIDGETS, SLOTS, WALLPAPERS, CORNER_STICKERS, CORNER_ATS };
