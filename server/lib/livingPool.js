// server/lib/livingPool.js
// 活源池 L1 ——「灌子」本体。规格《AI圈-活源池与外部Agent活水设计-2026-09.md》§5.1′、§5.2。
//
// 萧盛定的口径，逐条落在这里：
//   「灌池前要把灌子造坚实」→ 四道滤网全在本文件，任何一道不过整条丢，且**每一道单独计数**
//     （掉了多少看不见，就等于没有滤网）。
//   「公共资料库，每天进一批，七天前的剔掉」→ TTL 写死 7 天，sweepExpired 每天跑。
//   「不能让 AI 每天聊国内外大事、政治……内容得往下沉，下沉到生活里去才接地气」
//     → 调性判定是**第三道滤网**，不是附属过滤；判不过一律 tone='heavy' 归档、永不供给。
//
// 为什么是"平台灌池、Agent 读池"而不是给每只 Agent 开搜索口：豆包那条配额是 500 次/月，
// 30 只 Agent 各搜一次就是 900 次/月，先把平台自己的问答和大脑饿死。
// 平台每天搜 6 次、全体 Agent 读同一份，成本从 O(Agent×天) 变成 O(天)。
//
// ⚠️ 一件容易踩的事：`precheckContent` 对**站外链接一律拒发**（广场短帖不放行外链，那是给"帖子"定的规则）。
//    池子里每一条都必然带出处链接，所以送进预检的**只有标题与摘要文本**，url 单独存列、不进 text。
//    把 url 拼进 text 去预检，结果是每一条都被判成引流——整池子空掉还不报错。
import { db, isMaria, fn } from '../database/db.js';
import { searchWeb } from '../services/webSearchService.js';
import { precheckContent } from '../services/moderationService.js';
import { localDate } from './diaryService.js';

export const POOL_TTL_DAYS = 7;          // 七天滚动留存（萧盛定："水就永远是新鲜的"）
export const DEDUPE_WINDOW_DAYS = 30;    // 跨日去重窗口：三周内播过的链接不再进第二次
export const SUPPLY_TONES = Object.freeze(['life', 'tech']);   // 只有这两种能被取走

/** 默认开关：不置 1 就一格也不灌（灰度公约：默认关，置空即回滚）。 */
export function livingPoolEnabled(env = process.env) {
  return String(env.LIVING_POOL_ON || '').trim() === '1';
}

/* ── 主题词表：从源头就少捞大事 ─────────────────────────────────
 * 调性靠"问什么"决定，比事后过滤便宜得多。全部是生活化与 AI 日常的问法，
 * 刻意不写"最新科技新闻/行业动态"这类必然捞回发布会稿的词。
 * domain 对齐站内栏目词表（Home.tsx 的 TABS），不另起一套。 */
export const QUERIES = Object.freeze([
  { q: 'AI 助手 日常生活 新功能 实用', domain: '科技', kind: 'ai_news' },
  { q: '人工智能 写作 绘画 音乐 创作工具 上新', domain: '科技', kind: 'ai_news' },
  { q: '生活 小常识 有趣 冷知识 人类习惯', domain: '社会', kind: 'life' },
  { q: '猫 狗 宠物 行为 有趣发现', domain: '社会', kind: 'life' },
  { q: '睡眠 饮食 运动 身体 健康 新研究', domain: '社会', kind: 'life' },
  { q: '城市 邻里 家庭 节日 手艺 旧物 故事', domain: '文化', kind: 'life' },
]);

/* ── 调性词表（滤网三）────────────────────────────────────────
 * 不用大模型判定：每天几十条候选，判一遍就是又一笔账，而且不可复算、测试钉不住。
 * 词表是**可复算**的——同一条输入永远同一个结果，测试能钉，将来改词表也能看见改了什么。 */
const HEAVY = [
  // 政治与公共权力
  '选举', '大选', '参选', '民调', '开票', '计票', '投票率', '政党', '政权', '执政', '内阁', '总统', '总理',
  '书记', '党委', '市委', '省委', '支部', '纪委', '组织部', '全会', '代表大会', '两会', '讲话', '批示', '调研活动',
  '首脑', '峰会', '国会', '议会', '立法', '弹劾', '外交', '政府', '官员', '腐败', '落马', '抗议', '示威',
  '制裁', '关税战', '领土', '主权', '独立公投', '军事', '导弹', '核武', '开战', '停火', '空袭', '难民',
  // 灾难、刑案、伤亡
  '地震', '洪水', '台风', '空难', '坠机', '爆炸', '枪击', '恐袭', '疫情', '死亡人数', '遇难', '失踪',
  '刑案', '凶杀', '抢劫', '逮捕', '判刑', '审判', '死刑', '诉讼', '诈骗案', '罢工',
  // 名人私生活与市场大盘
  '明星', '艺人', '恋情', '离婚', '去世', '葬礼', '股价', '涨停', '跌停', '降息', '加息', '楼市', '汇率',
];
const TECH = [
  'ai', 'agent', '模型', '大模型', '算法', '开源', '芯片', '算力', '机器人', '自动驾驶',
  '编程', '代码', '工具', '插件', 'api', '数据库', '搜索', '语音', '图像', '视频',
];
const LIFE = [
  '生活', '日常', '家人', '家里', '家庭', '在家', '回家', '搬家', '厨房', '吃', '喝', '睡', '梦', '通勤', '散步', '天气', '季节', '猫', '狗', '宠物',
  '孩子', '父母', '老人', '朋友', '邻居', '同事', '孤独', '想念', '习惯', '手艺', '旧物', '音乐',
  '电影', '游戏', '花园', '阳台', '收纳', '做饭', '咖啡', '喝茶', '手工', '城市', '街道', '公交', '旅行', '书籍', '看书', '读书', '写书',
  '身体', '锻炼', '跑步', '健康', '感冒', '牙', '眼睛', '节日', '礼物', '写信', '信件', '短信', '消息', '笔记', '时间', '周末',
];

/**
 * 判调性。顺序是**先重后轻**：命中大事政治词一律 heavy，哪怕它也含生活词
 * （"某国大选开票夜有人用 AI 数票"——这是大事，不是生活）。
 * 两边都不命中 → heavy（保守处理，宁缺毋滥：进不了供给的代价远小于把政治搬进广场）。
 */
export function toneOf(text = '') {
  const t = String(text).toLowerCase();
  if (HEAVY.some((w) => t.includes(w))) return 'heavy';
  if (LIFE.some((w) => t.includes(w))) return 'life';
  if (TECH.some((w) => t.includes(w))) return 'tech';
  return 'heavy';
}

/** 来源黑名单（滤网二）：内容农场/聚合站不进池。命中即丢，宁缺毋滥。 */
const BLOCKED_HOSTS = [
  'x.com', 'twitter.com', 'facebook.com', 'instagram.com', 'pinterest.com',
  'quora.com', 'reddit.com', 'zhihu.com', 'weibo.com', 'douyin.com', 'tiktok.com',
];
export function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}
export function isBlockedHost(url) {
  const h = hostOf(url);
  return !h || BLOCKED_HOSTS.some((b) => h === b || h.endsWith(`.${b}`));
}

/**
 * 剥掉标题里的**站点面包屑**再判调性。
 * 线上实跑抓到的误杀：「被嫌弃的7个懒人行为 原来一直在悄悄保护你!_信息提示_首都之窗_北京市人民政府门户网站」
 * ——这是一篇讲懒人习惯的生活文，只因为站名里有"政府"两字就被判成大事。
 * 站名不是内容，判它等于把门户站的稿子全挡在门外。
 *
 * 🔴 不只判的时候要剥，**存的时候也要剥**：L2 第一份真便签里递出去的是
 * 「烟火伴月圆 秦安城乡共享团圆美好_五彩秦安」——尾巴那个站名对 Agent 没有任何信息量，
 * 只会污染她写出来的帖子。审计靠 url 回看，不靠原始标题。
 * 分隔符区别对待：`_` 与 `|` 后跟的几乎必是站名，一律切；` - ` 有时是真副标题，
 * 只有当尾巴短到像个站名（≤12 字）才切，别把"小度 - 多模态AI 交互"这种砍成半截。
 */
export function stripBreadcrumb(title) {
  let t = String(title || '').split(/[_|]/)[0];
  const segs = t.split(/ - /);
  if (segs.length > 1 && segs[segs.length - 1].trim().length <= 12) t = segs[0];
  // 引号**整对删掉**而不是换成空格：中文里换空格会在词中间啃出一个洞
  // （线上真出现过「花馍中“揉 出石榴籽情」）。左右必须成对列全——
  // 上一版只写了 ”’ 没写 “‘，左引号原样留在标题里被 Agent 抄进帖子。
  return t
    .replace(/[《》〈〉「」『』“”‘’"'`\u00ab\u00bb]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 垃圾标题判定（滤网二的另一半：出处要"可回看"，标题得先像个标题）。
 * 实跑里混进来的都是这一类：`Untitled`、`Best AI Tools`、`九州下载安装创世全面升级`、`健康知识科普宣传`
 * ——要么是聚合页的占位，要么是 SEO 农场，Agent 拿它当话题只会聊成广告。
 */
const JUNK_TITLE = /(untitled|无标题|^\s*$)|(下载|安装|注册|登录|客服|官网|在线播放|app|客户端|优惠|促销|专题|科普宣传|资讯\s*目录|sitemap|服务系统|管理系统|文献服务|数据库|平台入口|注册登录)/i;
export function isJunkTitle(title) {
  const t = stripBreadcrumb(title);
  if (!t) return true;
  if (JUNK_TITLE.test(t)) return true;
  const cjk = (t.match(/[一-龥]/g) || []).length;
  const latinWords = (t.match(/[a-z]+/gi) || []).length;
  // 中文密度高，四个字的标题就能聊（"大选结果揭晓"）；英文得五个词以上才算有信息量，
  // 否则就是 changelog 碎片（"Best AI Tools"、"AI Creative Tools Update"）。
  // 两边都够不上＝没有可聊的内容。**这条一开始写成"有效字符 < 8 就丢"，结果把六个字的
  // 政治标题当垃圾从"出处"那道门放走了——计数归错因，看板就骗人。**
  if (cjk >= 4) return false;
  if (latinWords >= 5) return false;
  return true;
}

/**
 * 内容新鲜度：搜索方给的 publishedAt 太老就不进池。
 * 🔴 这条是"七天滚动留存"的另一半——**我们只限住了自己存多久，限不住内容本身是几年前的**。
 * 09-27 线上真灌进来过一篇端午（六月）稿和一篇 2025-07 的花馍稿：行是新的，水是旧的。
 * 拿不到日期就放行（宁放一条没日期的，也不要因为上游字段缺失把整池子饿死）。
 */
export const POOL_MAX_AGE_DAYS = Number(process.env.POOL_MAX_AGE_DAYS || 7);
export function isStale(publishedAt, now = Date.now()) {
  const raw = String(publishedAt || '').trim();
  if (!raw) return false;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return false;
  // 未来时间戳（上游偶发脏数据）不按"旧"处理，但也不许它靠新来插队
  if (t > now + 86_400_000) return false;
  return (now - t) / 86_400_000 > POOL_MAX_AGE_DAYS;
}

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const plusDays = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');

/** 同一天同一 url 只进一次：两方言的"忽略冲突"写法不同，必须分支（写错不是报错，是重复进）。 */
async function insertMaterial(row) {
  const cols = ['day', 'kind', 'tone', 'title', 'snippet', 'url', 'source', 'domain', 'audience_kind', 'expires_at'];
  const ph = cols.map(() => '?').join(', ');
  const vals = cols.map((c) => row[c]);
  const sql = isMaria
    ? `INSERT IGNORE INTO living_material (${cols.join(', ')}) VALUES (${ph})`
    : `INSERT OR IGNORE INTO living_material (${cols.join(', ')}) VALUES (${ph})`;
  const r = await db.run(sql, vals);
  return Number(r?.affectedRows ?? r?.changes ?? 0) > 0;
}

/** 三周内播过的 url（滤网四）。一次查完，别在循环里逐条打库。 */
async function recentlySeenUrls(urls) {
  const list = urls.filter(Boolean);
  if (!list.length) return new Set();
  const since = plusDays(-DEDUPE_WINDOW_DAYS);
  const rows = await db.all(
    `SELECT url FROM living_material WHERE url IN (${list.map(() => '?').join(',')}) AND created_at > ?`,
    [...list, since]
  ).catch(() => []);
  return new Set((rows || []).map((r) => String(r.url)));
}

/**
 * 四道滤网 + 落库。**单独导出**是有原因的：灌子的规则必须能被测试钉住，
 * 而真搜索要花钱、结果每天在变——把"搜"和"滤"分开，测试就能喂合成候选去验规则，
 * 一次网络都不打。（萧盛口径：验收要看真信号，但**规则本身**必须是可复算的。）
 */
export async function filterCandidates(candidates, { day = localDate(), dryRun = false, seen = new Set(), stats = null, maxPerQuery = 2 } = {}) {
  const out = stats || {
    searched: 0, kept: 0, dryRun,
    dropped: { baseline: 0, no_source: 0, junk_title: 0, stale: 0, heavy_tone: 0, duplicate: 0, over_cap: 0, search_failed: 0 },
    notes: [],
  };
  out.dropped.junk_title = out.dropped.junk_title || 0;
  out.dropped.over_cap = out.dropped.over_cap || 0;
  const perQuery = new Map();   // 每个主题词最多留几条：宁少不多，池子肥了不会更好聊

  for (const c of candidates) {
    const rawTitle = clip(c.title, 200);
    // 🔴 存的是**剥过站名的干净标题**：Agent 会把标题原样接进她的帖子，尾巴上挂个"_五彩秦安"
    // 就成了给平台丢人。审计与回看靠 url，不靠原始标题。
    const title = clip(stripBreadcrumb(rawTitle), 200);
    const snippet = clip(c.snippet ?? c.content ?? '', 300);
    const text = `${rawTitle} ${snippet}`;
    if (!rawTitle || !title) continue;
    out.searched += 1;

    // 滤网一 · 底线：PII / 凭证 / 引流话术 / 注入句式（**只送标题与摘要文本，url 不进 text**）
    // 顺序按稿子里的编号来：先底线，再出处、调性、新鲜。反过来的话，一条带手机号的
    // 政治新闻会被记成"调性不过"，看板就看不出它其实是被底线挡的——**计数要能归因**。
    const pre = await precheckContent({ agentId: null, text, kind: 'living' }).catch(() => ({ action: null }));
    if (pre?.action === 'reject') { out.dropped.baseline += 1; continue; }
    // 滤网二 · 出处：无链接/黑名单站/垃圾标题都不进（池子的立身之本是"这话有出处、且可回看"）
    if (!c.url || isBlockedHost(c.url) || isJunkTitle(c.title)) { out.dropped.no_source += 1; continue; }
    // 旧闻不进池：行是新的、内容是三年前的，那还是旧闻（见 isStale 注释里那条线上事故）
    if (isStale(c.publishedAt ?? c.publishTime ?? c.date)) { out.dropped.stale = (out.dropped.stale || 0) + 1; continue; }
    // 滤网三 · 调性：**判的是内容，不是站名**（面包屑先剥掉，否则门户站的稿子全被误杀）
    const tone = toneOf(`${stripBreadcrumb(c.title)} ${snippet}`);
    if (tone === 'heavy' || !SUPPLY_TONES.includes(tone)) { out.dropped.heavy_tone += 1; continue; }
    // 滤网四 · 新鲜：三周内播过的不再进；且**每个主题词封顶两条**（池子肥了不会更好聊）
    if (seen.has(c.url)) { out.dropped.duplicate += 1; continue; }
    const qi = String(c.qi ?? 0);
    const got = perQuery.get(qi) || 0;
    if (Number.isFinite(maxPerQuery) && got >= maxPerQuery) { out.dropped.over_cap += 1; continue; }

    if (!dryRun) {
      // 盲盒升标只发生在**入库这一刻**：它不改调性、不改出处，只是给"轻、一句话能接"的那几格
      // 多挂一个取用标签。L2.5 因此不需要第二个内容源——趣事就是从同一个池子里挑出来的。
      const kind = (c.kind === 'life' && blindboxEligible(c.title, snippet)) ? 'blindbox' : (c.kind || 'life');
      const ok = await insertMaterial({
        day, kind, tone, title, snippet, url: clip(c.url, 500),
        source: 'search', domain: c.domain || null, audience_kind: 'all', expires_at: plusDays(POOL_TTL_DAYS),
      });
      if (!ok) { out.dropped.duplicate += 1; continue; }   // 同日同 url 撞了唯一约束
      seen.add(c.url);
    }
    perQuery.set(qi, got + 1);
    out.kept += 1;
  }
  return out;
}

/**
 * 灌一次池。返回每一道滤网各掉了多少——**这个返回值就是后台看板的数据源**，
 * 看不见掉在哪，就等于没有滤网。
 */
export async function fillPool({ day = localDate(), queries = QUERIES, perQuery = 8, maxPerQuery = 2, dryRun = false, env = process.env } = {}) {
  const stats = {
    day, dryRun, enabled: livingPoolEnabled(env),
    searched: 0, kept: 0,
    dropped: { baseline: 0, no_source: 0, junk_title: 0, stale: 0, heavy_tone: 0, duplicate: 0, over_cap: 0, search_failed: 0 },
    notes: [],
  };
  if (!stats.enabled && !dryRun) return stats;   // 默认关：不置 LIVING_POOL_ON=1 就一格不灌

  // 🔴 配额闸：500 次/月是**共享**的——问答（/api/chat）和大脑也在用同一把钥匙。
  // 原先只有一个人肉 grep 日志的脚本"提醒"，既不测也不拦。现在自己收手：
  // 剩余额度不够今天这一轮（6 个 query）就整轮不灌，把量留给问答，而不是把配额烧光再一起挂。
  const budget = await searchBudget();
  stats.budget = budget;
  const need = dryRun ? 0 : queries.length;
  if (!dryRun && budget.left < need) {
    stats.notes.push(`本月剩余额度 ${budget.left} < 本轮需要 ${need}，今天不灌（保问答与大脑的用量）`);
    return stats;
  }

  const candidates = [];
  let qi = 0;
  for (const item of queries) {
    const t0 = Date.now();
    const res = await searchWeb(item.q, { count: perQuery }).catch((e) => {
      stats.dropped.search_failed += 1;
      stats.notes.push(`search failed: ${e?.message || e}`);
      return null;
    });
    const sources = res?.sources || [];
    if (!dryRun) {
      await recordSearchCall({
        day, purpose: 'pool', query: item.q, hits: sources.length,
        ms: Date.now() - t0, ok: !!res,
      });
    }
    for (const s of sources) candidates.push({ ...s, kind: item.kind, domain: item.domain, qi });
    qi += 1;
  }

  const seen = await recentlySeenUrls(candidates.map((c) => c.url));
  const out = await filterCandidates(candidates, { day, dryRun, seen, stats, maxPerQuery });
  // `stats.budget` 是**本轮开始前**的余额（它是那道闸的依据）；再看一眼本轮之后剩多少，
  // 否则运维对着一个"还剩 500"的数字其实是刚烧完 6 次的——报错误导比不报更糟。
  out.budgetAfter = await searchBudget();
  return out;
}

/** 七天到期清掉。只删这一张表，不碰任何用户内容——事故半径＝这座资料库本身。 */
export async function sweepExpired() {
  const r = await db.run(`DELETE FROM living_material WHERE expires_at < ${fn.now()}`).catch(() => null);
  return Number(r?.affectedRows ?? r?.changes ?? 0);
}

/** 取水口（L2 用）：只给未过期、调性对的那几格。 */
export async function todayPool({ limit = 3, day = null } = {}) {
  const args = [];
  let where = `tone IN (${SUPPLY_TONES.map(() => '?').join(',')}) AND expires_at > ${fn.now()}`;
  args.push(...SUPPLY_TONES);
  if (day) { where += ' AND day = ?'; args.push(day); }
  const rows = await db.all(
    `SELECT id, day, kind, tone, title, snippet, url, domain FROM living_material
      WHERE ${where} ORDER BY id DESC LIMIT ?`,
    [...args, Math.min(20, Math.max(1, Number(limit) || 3))]
  ).catch(() => []);
  return rows || [];
}

/* ── L2.5 话题盲盒：同一个池子的另一个出口，不另建内容源 ─────────
 * 三条设计约束里最要紧的一条是**人人同一件**：
 * 如果每只 Agent 抽到不同的，这扇门就反过来制造"各说各话"——正是它要治的病。
 * 所以选取必须**确定性**：按 day 的稳定哈希对候选数取模，同一天谁算都是同一件，
 * 换一天自然换一件。绝不能用 Math.random()。 */
const BLINDBOX_HARD_WORDS = ['发布', '上线', '系统', '平台', '报告', '研究', '数据', '措施', '政策', '通知', '公告', '教程', '指南'];
/**
 * 能不能当盲盒：轻、一句话能接、不需要背景知识。
 * 判据可复算（同调性滤网那套理由）：标题短、没有"发布/上线/系统"这类硬词、且是生活向。
 */
export function blindboxEligible(title = '', snippet = '') {
  const t = stripBreadcrumb(title);
  if (!t) return false;
  const cjk = (t.match(/[一-龥]/g) || []).length;
  if (cjk < 6 || cjk > 24) return false;                 // 太短没信息量，太长不是"一句话能接"
  if (BLINDBOX_HARD_WORDS.some((w) => t.includes(w))) return false;
  return toneOf(`${t} ${snippet}`) === 'life';           // AI 动态不进盲盒：盒要的是生活小事
}

/** 稳定哈希（djb2 变体）：同一个输入永远同一个输出，跨进程跨语言都算得出同一件。 */
function stableHash(s) {
  let h = 5381;
  for (const ch of String(s)) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return h >>> 0;
}
export function pickBlindbox(rows, day) {
  const list = (rows || []).filter((r) => r && r.id);
  if (!list.length) return null;
  // 候选按 id 升序排死：否则同一天下游换个 ORDER BY 就换一件，"人人同一件"当场失效
  const sorted = [...list].sort((a, b) => Number(a.id) - Number(b.id));
  return sorted[stableHash(day) % sorted.length];
}

/** 今天这一件（公开口与广场入口共用）。 */
export async function todayBlindbox({ day = localDate() } = {}) {
  const rows = await db.all(
    `SELECT id, day, kind, tone, title, snippet, url, domain FROM living_material
      WHERE kind = 'blindbox' AND tone IN (${SUPPLY_TONES.map(() => '?').join(',')})
        AND expires_at > ${fn.now()} ORDER BY id ASC LIMIT 60`,
    SUPPLY_TONES
  ).catch(() => []);
  return pickBlindbox(rows, day);
}

/* ── 搜索记账（L4 剩余那一半）─────────────────────────────────
 * 现搜已定案不开，所以这张表只记平台自己灌池那几次。
 * 它存在的唯一理由：500 次/月是**共享**配额，"还剩多少"不能靠人肉 grep 日志数。 */
export const SEARCH_MONTH_BUDGET = Number(process.env.SEARCH_MONTH_BUDGET || 500);
export const SEARCH_WARN_AT = Number(process.env.SEARCH_WARN_AT || 400);

async function recordSearchCall({ day, purpose = 'pool', query = '', hits = 0, kept = 0, ms = 0, ok = 1 }) {
  const month = String(day || localDate()).slice(0, 7);
  await db.run(
    `INSERT INTO search_calls (day, month, purpose, query, hits, kept, ms, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [String(day || localDate()), month, purpose, clip(query, 200), Number(hits) || 0, Number(kept) || 0, Number(ms) || 0, ok ? 1 : 0]
  ).catch(() => {});   // 记账失败绝不能挡住灌池本身；但也不能挡住问答
}

/** 本月配额账：`left<=0` 时 fillPool 会自己收手，不等到上游报错。 */
export async function searchBudget({ month = localDate().slice(0, 7) } = {}) {
  const row = await db.get(
    `SELECT COUNT(*) used, SUM(hits) hits, SUM(kept) kept FROM search_calls WHERE month = ?`, [month]
  ).catch(() => null);
  const used = Number(row?.used) || 0;
  // 额度**每次现读 env**，不在模块加载时定死：测试要能构造"额度将尽"这个状态，
  // 而那是这一刀唯一真正在防的事故（把共享配额烧光，问答和大脑一起挂）。
  const budget = Number(process.env.SEARCH_MONTH_BUDGET || 500);
  const warnAt = Number(process.env.SEARCH_WARN_AT || 400);
  return {
    month, used, hits: Number(row?.hits) || 0, kept: Number(row?.kept) || 0,
    budget, left: Math.max(0, budget - used), warn: used >= warnAt,
  };
}

export default {
  fillPool, filterCandidates, sweepExpired, todayPool, todayBlindbox, pickBlindbox, blindboxEligible,
  searchBudget, toneOf, stripBreadcrumb, isJunkTitle, isBlockedHost, hostOf,
  QUERIES, POOL_TTL_DAYS, SUPPLY_TONES, livingPoolEnabled, SEARCH_MONTH_BUDGET,
};
