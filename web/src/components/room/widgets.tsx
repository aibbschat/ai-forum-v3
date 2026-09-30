/*
 * 房间的官方小组件（D2）—— 12 件，全部矢量。
 * 规格：《AI圈-Agent日记与主人房间设计-2026-09.md》§6；id 与服务端
 * `lib/roomService.js` 的 `WIDGETS` 一一对应（那边是取值域与"能挂哪些位"的唯一定义处）。
 *
 * ── 上一版被判定"鸡肋"，两条教训写在这里 ─────────────────────
 *  ① 我把 12 件统一染成房间强调色，理由是"跟着皮肤换色"。**这是错的**：
 *     灯笼在夜里就该是红的，红的正是它存在的意义——它给的是"黑屋里的一缕暖光"，
 *     换成绿色就退化成一个没有意义的图标。皮肤只该影响明暗浓淡，不该洗掉身份色。
 *  ② 我把组件摆在**视口角落**，于是它们不装饰任何东西，只是飘在旁边的贴纸。
 *     装饰必须**骑在日记卡的边线上**：一半在墙上、一半垂进纸里；
 *     或者像灯笼那样——人在墙上，光落在本子上。
 *
 * ── 两条不可让的约束 ────────────────────────────────────────
 *  · 垂进纸内的部分一律**半透明**（`IN`），且整层在文字之下（Room 里做 z-index 分层）：
 *    灯光再暖、藤蔓再长，都不挡一个字。
 *  · 窄屏不摆组件（边带太窄，摆上就压字），见 tokens.css 的 @media。
 */
import type { CSSProperties, ReactNode } from 'react';
import type { RoomDecoration } from '../../api';

export type WidgetId =
  | 'lantern' | 'bell' | 'bow' | 'stars' | 'moon' | 'clover'
  | 'bear' | 'sprig' | 'tape' | 'pin' | 'shell' | 'ivy';

export type Slot =
  | 'top-l' | 'top-c' | 'top-r' | 'side-l' | 'side-r' | 'bottom-l' | 'bottom-c' | 'bottom-r';

export const WIDGET_IDS: WidgetId[] = [
  'lantern', 'bell', 'bow', 'stars', 'moon', 'clover',
  'bear', 'sprig', 'tape', 'pin', 'shell', 'ivy',
];
export const WIDGET_LABELS: Record<WidgetId, string> = {
  lantern: '灯笼', bell: '风铃', bow: '蝴蝶结', stars: '星串', moon: '月牙', clover: '四叶草',
  bear: '小熊', sprig: '干花', tape: '胶带', pin: '图钉', shell: '贝壳', ivy: '常春藤',
};

/** 吸附点：全部落在日记卡的**边线**上，不是视口角落。零尺寸原点，偏移交给内层。 */
const ANCHOR_BASE: CSSProperties = { position: 'absolute', width: 0, height: 0 };
const ANCHOR: Record<Slot, CSSProperties> = {
  'top-l': { top: 0, left: '16%' },
  'top-c': { top: 0, left: '50%' },
  'top-r': { top: 0, left: '84%' },
  'side-l': { top: '42%', left: 0 },
  'side-r': { top: '42%', left: '100%' },
  'bottom-l': { top: '100%', left: '16%' },
  'bottom-c': { top: '100%', left: '50%' },
  'bottom-r': { top: '100%', left: '84%' },
};
/** 合成：锚点定位 + 零尺寸原点 */
const withBase = (s: CSSProperties): CSSProperties => ({ ...ANCHOR_BASE, ...s });

/** 垂进纸内那一段的透明度：看得见，但绝不挡字。 */
const IN = 0.34;

/*
 * 🔴 吊挂件的落位口径（09-26 改）：**边线切过身子，不切头顶**。
 *   上一版把灯笼整个画在卡片上方 168px 处，于是必须给卡片加 148px 的 margin-top
 *   才不压到头部带——结果"摆一件小东西"把日记本整个往下推，房间中间裂开一大段空白。
 *   现在吊挂件自己缩到"上半截在墙上、下半截垂进纸里"，不再要求房间给它腾地方。
 *   `top` 是相对**卡片上边线**的偏移：负的多出边线多少，就还有多少垂在纸上。
 */
type Piece = { box: CSSProperties; art: ReactNode; glow?: CSSProperties };

/* ── 灯笼：挂在墙上，光落在本子上 ─────────────────────────── */
const Lantern: Piece = {
  box: { left: -62, top: -58, width: 124, height: 300, transform: 'scale(.72)', transformOrigin: 'top center' },
  art: (
    <svg width="124" height="300" viewBox="0 0 124 300" aria-hidden>
      <defs>
        <radialGradient id="rl-body" cx="38%" cy="34%" r="72%">
          <stop offset="0%" stopColor="#f07a5f" />
          <stop offset="55%" stopColor="#c9372a" />
          <stop offset="100%" stopColor="#8e1f18" />
        </radialGradient>
      </defs>
      <path d="M62 0v34" stroke="#6b5a44" strokeWidth="1.6" />
      <rect x="52" y="32" width="20" height="6" rx="2.5" fill="#a8813f" />
      <ellipse cx="62" cy="86" rx="34" ry="38" fill="url(#rl-body)" />
      <ellipse cx="62" cy="86" rx="34" ry="38" fill="none" stroke="#7d1a14" strokeWidth="1.1" opacity=".7" />
      {[-20, -10, 10, 20].map((d) => (
        <ellipse key={d} cx="62" cy="86" rx={34 - Math.abs(d)} ry="38" fill="none" stroke="#8e1f18" strokeWidth=".8" opacity=".5" />
      ))}
      {/* 内透的亮：让它是"点着的"，不是一个红块 */}
      <ellipse cx="54" cy="76" rx="13" ry="15" fill="#ffd9a0" opacity=".55" />
      <rect x="49" y="44" width="26" height="7" rx="3" fill="#c9a24d" />
      <rect x="49" y="121" width="26" height="7" rx="3" fill="#c9a24d" />
      <path d="M62 128v14" stroke="#c9a24d" strokeWidth="1.6" />
      <path d="M56 142h12l-2 8h-8z" fill="#b8452f" />
      {[58, 62, 66].map((x) => (
        <path key={x} d={`M${x} 150v${x === 62 ? 20 : 15}`} stroke="#d8a24d" strokeWidth="1.5" strokeLinecap="round" />
      ))}
      {/* 落到纸沿的一点余光，不画实体 */}
      <ellipse cx="62" cy="176" rx="42" ry="9" fill="#ffb066" opacity={IN * 0.5} />
    </svg>
  ),
  glow: {
    left: -150, top: -60, width: 420, height: 400,
    background: 'radial-gradient(closest-side, rgba(255,176,88,.30), rgba(255,176,88,.13) 42%, transparent 72%)',
  },
};

/* ── 常春藤：真的垂挂到本子上 ─────────────────────────────── */
const Ivy: Piece = {
  box: { left: -46, top: -30, width: 150, height: 330, transform: 'scale(.66)', transformOrigin: 'top center' },
  art: (
    <svg width="150" height="330" viewBox="0 0 150 330" aria-hidden>
      <path d="M20 0c6 40 26 62 34 96s2 62-8 92-6 62 6 92" fill="none" stroke="#4f7a4a" strokeWidth="2.4" strokeLinecap="round" opacity=".92" />
      {([[24, 26, -28, 0.95], [38, 58, 22, 0.92], [46, 92, -34, 0.85], [56, 126, 18, 0.7],
         [44, 162, -26, 0.55], [34, 200, 26, 0.45], [40, 240, -20, 0.38], [52, 278, 16, 0.3]] as const)
        .map(([x, y, r, o], i) => (
          <g key={i} transform={`translate(${x} ${y}) rotate(${r})`} opacity={o}>
            <path d="M0 0c10-3 20 2 24 12-9 5-19 2-24-12z" fill={i % 2 ? '#6ea365' : '#578a51'} />
            <path d="M0 0c8 1 16 6 20 12" stroke="#3f6b3c" strokeWidth=".9" fill="none" opacity=".7" />
          </g>
        ))}
      <g opacity={IN}>
        <path d="M60 296c8 8 18 10 26 6" stroke="#4f7a4a" strokeWidth="2" fill="none" strokeLinecap="round" />
        <path d="M74 300c8-2 14 2 16 9-7 3-14 0-16-9z" fill="#578a51" />
      </g>
    </svg>
  ),
  glow: { left: -70, top: 60, width: 240, height: 320, background: 'radial-gradient(closest-side, rgba(87,138,81,.13), transparent 70%)' },
};

/* ── 小熊：扒着卡沿往里看 ─────────────────────────────────── */
const Bear: Piece = {
  box: { left: -40, top: -40, width: 80, height: 96 },
  art: (
    <svg width="80" height="96" viewBox="0 0 80 96" aria-hidden>
      <defs>
        <radialGradient id="br-f" cx="40%" cy="32%" r="70%">
          <stop offset="0%" stopColor="#c9a888" /><stop offset="100%" stopColor="#9d7d5f" />
        </radialGradient>
      </defs>
      <circle cx="22" cy="20" r="11" fill="#9d7d5f" /><circle cx="58" cy="20" r="11" fill="#9d7d5f" />
      <circle cx="22" cy="20" r="5" fill="#c9a888" opacity=".8" /><circle cx="58" cy="20" r="5" fill="#c9a888" opacity=".8" />
      <circle cx="40" cy="34" r="24" fill="url(#br-f)" />
      <ellipse cx="40" cy="42" rx="11" ry="8.5" fill="#e2cbb0" opacity=".9" />
      <circle cx="31" cy="30" r="2.6" fill="#3b2f26" /><circle cx="49" cy="30" r="2.6" fill="#3b2f26" />
      <path d="M40 38l-3.5 3h7z" fill="#3b2f26" />
      <path d="M40 42v3M40 45c-3 3-7 2-8 0M40 45c3 3 7 2 8 0" stroke="#3b2f26" strokeWidth="1.3" fill="none" strokeLinecap="round" />
      <ellipse cx="22" cy="58" rx="10" ry="7" fill="#c9a888" /><ellipse cx="58" cy="58" rx="10" ry="7" fill="#c9a888" />
      {/* 爪子垂进纸内：半透明，像真的扒在边线上 */}
      <g opacity={IN}>
        <ellipse cx="22" cy="64" rx="10" ry="7" fill="#9d7d5f" /><ellipse cx="58" cy="64" rx="10" ry="7" fill="#9d7d5f" />
        {[18, 22, 26].map((x) => <path key={x} d={`M${x} 62v5`} stroke="#7d6146" strokeWidth="1.2" />)}
        {[54, 58, 62].map((x) => <path key={x} d={`M${x} 62v5`} stroke="#7d6146" strokeWidth="1.2" />)}
      </g>
    </svg>
  ),
};

/* ── 星串：横跨边线的绳 + 三颗会闪的星 ───────────────────── */
const Stars: Piece = {
  box: { left: -78, top: -24, width: 156, height: 96 },
  art: (
    <svg width="156" height="96" viewBox="0 0 156 96" aria-hidden>
      <path d="M4 8c28 22 120 22 148 0" fill="none" stroke="#8a7a5c" strokeWidth="1.4" opacity=".85" />
      {([[38, 22, 13], [78, 30, 16], [118, 22, 12]] as const).map(([x, y, r], i) => (
        <g key={i} className={`rm-twinkle rm-t${i}`}>
          <path d={`M${x} ${y}v6`} stroke="#8a7a5c" strokeWidth="1" />
          <path d={`M${x} ${y + 8}l${r * 0.28} ${r * 0.56} ${r * 0.62} .09-${r * 0.45} ${r * 0.43} ${r * 0.11} ${r * 0.62}-${r * 0.57}-${r * 0.3} ${r * 0.56}-${r * 0.31} ${r * 0.03}-${r * 0.61}z`}
            fill="#e8c96a" stroke="#c9a24d" strokeWidth=".6" />
        </g>
      ))}
      <path d="M78 62l2.4 5 5.4.6-4 3.7 1.1 5.4-4.9-2.7-4.9 2.7 1.1-5.4-4-3.7 5.4-.6z" fill="#e8c96a" opacity={IN} />
    </svg>
  ),
};

/* ── 风铃：挂着，下面垂一片短册进纸内 ─────────────────────── */
const Bell: Piece = {
  box: { left: -34, top: -44, width: 68, height: 170, transform: 'scale(.86)', transformOrigin: 'top center' },
  art: (
    <svg width="68" height="170" viewBox="0 0 68 170" aria-hidden>
      <defs>
        <linearGradient id="bl-g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#e6d3a8" /><stop offset="100%" stopColor="#b99a5e" />
        </linearGradient>
      </defs>
      <path d="M34 0v14" stroke="#6b5a44" strokeWidth="1.5" />
      <path d="M14 20a20 20 0 0140 0z" fill="url(#bl-g)" />
      <path d="M14 20h40l-3 26a17 17 0 01-34 0z" fill="url(#bl-g)" stroke="#9a7c45" strokeWidth=".8" />
      <path d="M34 46v10" stroke="#9a7c45" strokeWidth="1.2" />
      <circle cx="34" cy="60" r="5" fill="#c9a24d" />
      <g opacity={IN}>
        <path d="M34 66v18" stroke="#8a7a5c" strokeWidth="1" />
        <rect x="26" y="84" width="17" height="40" rx="2" fill="#f2e6cf" stroke="#c9bda3" strokeWidth=".8" />
        <path d="M30 92h9M30 99h9M30 106h6" stroke="#b6a888" strokeWidth="1" />
      </g>
    </svg>
  ),
};

/* ── 蝴蝶结：系在边线上，两条缎带垂进纸内 ─────────────────── */
const Bow: Piece = {
  box: { left: -40, top: -26, width: 80, height: 110 },
  art: (
    <svg width="80" height="110" viewBox="0 0 80 110" aria-hidden>
      <defs>
        <linearGradient id="bw-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#f0a3b4" /><stop offset="100%" stopColor="#c9566f" />
        </linearGradient>
      </defs>
      <g opacity={IN}>
        <path d="M36 38c-6 18-14 28-22 34 8 2 18-4 24-16z" fill="url(#bw-g)" />
        <path d="M44 38c6 18 14 28 22 34-8 2-18-4-24-16z" fill="url(#bw-g)" />
      </g>
      <path d="M40 30C26 8 2 10 4 26s22 20 36 4z" fill="url(#bw-g)" />
      <path d="M40 30c14-22 38-20 36-4s-7 20-36 4z" fill="url(#bw-g)" />
      <circle cx="40" cy="30" r="8" fill="#b8465f" />
    </svg>
  ),
};

/* ── 胶带：斜跨边角，半透明，带撕口 ───────────────────────── */
const Tape: Piece = {
  box: { left: -46, top: -18, width: 92, height: 44 },
  art: (
    <svg width="92" height="44" viewBox="0 0 92 44" aria-hidden>
      <g transform="rotate(-8 46 22)">
        <path d="M6 8h80v28H6z" fill="#d9c9a3" opacity=".5" />
        <path d="M6 8l4 4-4 4 4 4-4 4 4 4-4 4z" fill="#cbb98f" opacity=".45" />
        <path d="M86 8l-4 4 4 4-4 4 4 4-4 4 4 4z" fill="#cbb98f" opacity=".45" />
        <path d="M10 14h72M10 30h72" stroke="#fff" strokeWidth="1" opacity=".3" />
      </g>
    </svg>
  ),
};

/* ── 图钉：钉住边角，下面压出一点阴影 ─────────────────────── */
const Pin: Piece = {
  box: { left: -22, top: -20, width: 44, height: 52 },
  art: (
    <svg width="44" height="52" viewBox="0 0 44 52" aria-hidden>
      <defs>
        <radialGradient id="pn-g" cx="35%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#ff8a75" /><stop offset="100%" stopColor="#b8332a" />
        </radialGradient>
      </defs>
      <ellipse cx="22" cy="34" rx="16" ry="5" fill="#000" opacity=".12" />
      <circle cx="22" cy="20" r="14" fill="url(#pn-g)" />
      <circle cx="17" cy="15" r="4" fill="#fff" opacity=".45" />
      <path d="M22 34v12" stroke="#7d7d84" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  ),
};

/* ── 干花：压在边线下的标本 ───────────────────────────────── */
const Sprig: Piece = {
  box: { left: -50, top: -14, width: 100, height: 66 },
  art: (
    <svg width="100" height="66" viewBox="0 0 100 66" aria-hidden>
      <g transform="rotate(6 50 30)">
        <path d="M12 40c22-6 46-10 74-8" stroke="#8a9a7a" strokeWidth="1.6" fill="none" opacity=".8" />
        {([[26, 36, 0.82], [40, 33, 0.8], [54, 31, IN + 0.16], [68, 30, IN + 0.1]] as const).map(([x, y, o], i) => (
          <g key={i} opacity={o}>
            <ellipse cx={x} cy={y - 6} rx="6" ry="3.6" fill="#cbbfa8" />
            <ellipse cx={x} cy={y + 5} rx="5.4" ry="3.2" fill="#bfb29a" />
          </g>
        ))}
        <circle cx="82" cy="30" r="4.6" fill="#e0c9a0" opacity=".9" />
        <circle cx="82" cy="30" r="2" fill="#b8995e" />
      </g>
    </svg>
  ),
};

/* ── 贝壳：搁在下沿，一半探进纸内 ─────────────────────────── */
const Shell: Piece = {
  box: { left: -30, top: -26, width: 60, height: 56 },
  art: (
    <svg width="60" height="56" viewBox="0 0 60 56" aria-hidden>
      <defs>
        <linearGradient id="sh-g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f3ddd0" /><stop offset="100%" stopColor="#c9a394" />
        </linearGradient>
      </defs>
      <path d="M30 6c14 0 24 12 24 26H6C6 18 16 6 30 6z" fill="url(#sh-g)" stroke="#b28a7a" strokeWidth=".8" />
      {[10, 20, 30, 40, 50].map((x) => <path key={x} d={`M30 6L${x} 32`} stroke="#b28a7a" strokeWidth=".8" opacity=".65" />)}
      <path d="M6 32h48c0 6-10 10-24 10S6 38 6 32z" fill="#e6cfc2" opacity={IN + 0.2} />
    </svg>
  ),
};

/* ── 四叶草：压在角上的幸运草 ─────────────────────────────── */
const Clover: Piece = {
  box: { left: -26, top: -22, width: 52, height: 62 },
  art: (
    <svg width="52" height="62" viewBox="0 0 52 62" aria-hidden>
      {[0, 90, 180, 270].map((r, i) => (
        <ellipse key={i} cx="26" cy="12" rx="9" ry="11" fill={i % 2 ? '#5f9a58' : '#6fae66'} opacity=".92" transform={`rotate(${r} 26 20)`} />
      ))}
      <path d="M26 30c-2 10 2 16 6 22" stroke="#4f7a4a" strokeWidth="1.8" fill="none" opacity={IN + 0.3} strokeLinecap="round" />
    </svg>
  ),
};

/* ── 月牙：带一点冷光洒在纸上 ─────────────────────────────── */
const Moon: Piece = {
  box: { left: -30, top: -46, width: 60, height: 60 },
  art: (
    <svg width="60" height="60" viewBox="0 0 60 60" aria-hidden>
      <defs>
        <radialGradient id="mn-g" cx="62%" cy="38%" r="60%">
          <stop offset="0%" stopColor="#fdf6dd" /><stop offset="100%" stopColor="#d9cf9f" />
        </radialGradient>
      </defs>
      <circle cx="30" cy="30" r="22" fill="url(#mn-g)" />
      <path d="M36 9a22 22 0 100 42 26 26 0 010-42z" fill="#f5ecc9" />
      <circle cx="24" cy="24" r="3" fill="#ddd2a6" opacity=".7" />
      <circle cx="20" cy="36" r="2" fill="#ddd2a6" opacity=".6" />
    </svg>
  ),
  glow: { left: -120, top: -20, width: 300, height: 300, background: 'radial-gradient(closest-side, rgba(214,222,255,.20), transparent 70%)' },
};

const PIECES: Record<WidgetId, Piece> = {
  lantern: Lantern, ivy: Ivy, bear: Bear, stars: Stars, bell: Bell,
  bow: Bow, tape: Tape, pin: Pin, sprig: Sprig, shell: Shell, clover: Clover, moon: Moon,
};

const HANGING = new Set<WidgetId>(['lantern', 'bell', 'stars', 'ivy']);

/* ── 贴纸库（统一饰品的 corner 类，2026-09-30）──────────────────
 * 官方贴纸全矢量（零素材文件、零审核敞口），自用池的图走 <img>。
 * 与组件同一纪律：贴纸在装饰层、文字之下、不参与布局；窄屏不摆。
 * 旧三枚（叶/点/星）+ 新四枚（花瓣/萤火/云朵/唱片，2026-09-30 扩充）。
 * 画幅统一 64×64，画面朝「右上」画——贴到不同角时用镜像翻到该角的朝向。
 */
const CORNER_ART: Record<string, ReactNode> = {
  'official:leaf': (
    <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden>
      <path d="M56 8C34 10 18 22 10 44c2 8 10 10 16 8 8-2 16-12 20-20s4-16 2-20c-4-6-16 0-20 6 2-14 16-18 28-10z" fill="#6fae66" opacity=".85"/>
      <path d="M14 46c6 6 12 8 20 6" stroke="#4f7a4a" strokeWidth="1.4" fill="none"/>
    </svg>
  ),
  'official:dot': (
    <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden>
      <circle cx="52" cy="52" r="5" fill="#c9a24d" opacity=".8"/>
      <circle cx="36" cy="58" r="3.4" fill="#c9a24d" opacity=".6"/>
      <circle cx="58" cy="36" r="3.4" fill="#c9a24d" opacity=".6"/>
      <circle cx="22" cy="54" r="2.4" fill="#c9a24d" opacity=".4"/>
      <circle cx="54" cy="22" r="2.4" fill="#c9a24d" opacity=".4"/>
    </svg>
  ),
  'official:star': (
    <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden>
      <path d="M52 40l4.2 8.4 9.4 1.4-6.8 6.6 1.6 9.4-8.4-4.4-8.4 4.4 1.6-9.4-6.8-6.6 9.4-1.4z" transform="translate(-6 -8) scale(.8)" fill="#e8c96a" stroke="#c9a24d" strokeWidth=".7"/>
      <path d="M30 54l2.2 4.4 5 .7-3.6 3.5.8 4.9-4.4-2.3-4.4 2.3.8-4.9-3.6-3.5 5-.7z" fill="#e8c96a" opacity=".75"/>
    </svg>
  ),
  'official:petal': (
    <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden>
      <path d="M52 10c-6 2-10 8-10 14 0-4-4-8-10-8 6 4 8 9 8 14-6-4-12-3-16 1 6 1 11 4 14 8-5 0-10 3-13 8 6-1 12 0 17 3-2 5-1 10 2 14 2-5 7-8 12-8-1-6 1-11 5-15 5 2 10 1 14-2-5-3-8-8-8-14 6 0 10-4 12-9-6-1-10-4-12-6z" fill="#e8a2b4"/>
      <circle cx="18" cy="50" r="2" fill="#e8a2b4" opacity=".7"/>
      <circle cx="12" cy="42" r="1.6" fill="#e8a2b4" opacity=".5"/>
    </svg>
  ),
  'official:firefly': (
    <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden>
      <circle cx="48" cy="18" r="3" fill="#ffe27a"/>
      <circle cx="48" cy="18" r="8" fill="#ffe27a" opacity=".22"/>
      <circle cx="28" cy="30" r="2.4" fill="#ffe27a"/>
      <circle cx="28" cy="30" r="6.5" fill="#ffe27a" opacity=".2"/>
      <circle cx="54" cy="40" r="2" fill="#ffe27a" opacity=".8"/>
      <circle cx="54" cy="40" r="5.5" fill="#ffe27a" opacity=".18"/>
      <circle cx="36" cy="52" r="2.8" fill="#ffe27a" opacity=".6"/>
      <circle cx="36" cy="52" r="7" fill="#ffe27a" opacity=".16"/>
      <circle cx="16" cy="20" r="1.6" fill="#ffe27a" opacity=".5"/>
    </svg>
  ),
  'official:cloud': (
    <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden>
      <path d="M46 20c-4 0-7 2-9 5-2-1-4-2-6-2-6 0-10 4-10 9 0 1 0 2 1 3h-2c-4 0-7 3-7 6s3 6 7 6h26c6 0 11-4 11-10s-5-10-11-10z" fill="#dfe8f2" opacity=".9"/>
      <path d="M46 20c4 0 7 2 9 5 4 0 7 3 7 7s-3 7-7 7" fill="none" stroke="#c6d4e4" strokeWidth="1.4" opacity=".7"/>
    </svg>
  ),
  'official:disc': (
    <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id="dc-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#3a4152"/><stop offset="100%" stopColor="#15181f"/>
        </linearGradient>
      </defs>
      <circle cx="44" cy="44" r="22" fill="url(#dc-g)" stroke="#c9a24d" strokeWidth="1.6"/>
      <circle cx="44" cy="44" r="6" fill="#e8c96a"/>
      <circle cx="44" cy="44" r="2.6" fill="#3a4152"/>
      {[8, 12, 16].map((r) => (
        <circle key={r} cx="44" cy="44" r={r} fill="none" stroke="#9aa4b8" strokeWidth=".8" opacity=".45"/>
      ))}
    </svg>
  ),
};

/** 角位锚定：0×0 原点落在挂区的真实角上（旧版锚卡永远在左上，tr/br 全错位——修）。 */
const CORNER_ANCHOR: Record<string, CSSProperties> = {
  tl: { top: 0, left: 0 },
  tr: { top: 0, right: 0 },
  bl: { bottom: 0, left: 0 },
  br: { bottom: 0, right: 0 },
};
/** 贴到角上后向内收一点，不压住边框线。 */
const CORNER_INNER: Record<string, CSSProperties> = {
  tl: { left: 1, top: 1 },
  tr: { right: 1, top: 1 },
  bl: { left: 1, bottom: 1 },
  br: { right: 1, bottom: 1 },
};
/** 画面默认朝右上，按角位镜像翻到正确朝向（tr 不翻）。 */
const CORNER_MIRROR: Record<string, string> = {
  tl: 'scaleX(-1)', bl: 'scaleX(-1) scaleY(-1)', br: 'scaleY(-1)',
};

/**
 * 贴纸（corner 类）：官方矢量件或自用池图，骑在挂区的一个角上。
 * `zone` 决定它出现在哪一层（卡片内 / 门牌内 / 页面），`at` 决定贴哪个角。
 */
export function CornerArt({ id, asset, at, size = 64 }: {
  id?: string; asset?: string; at: string; size?: number;
}) {
  const anchor = CORNER_ANCHOR[at];
  if (!anchor) return null;
  const key = id || asset || '';
  const official = key.startsWith('official:');
  const art = official ? CORNER_ART[key] : null;
  return (
    <span className="rm-corner" style={{ position: 'absolute', width: 0, height: 0, ...anchor }} aria-hidden>
      <span style={{ position: 'absolute', width: size, height: size, ...CORNER_INNER[at] }}>
        {art ? (
          <span style={{ display: 'block', width: size, height: size, transform: CORNER_MIRROR[at] || undefined, transformOrigin: 'center' }}>
            {art}
          </span>
        ) : (
          <img src={asset} alt="" style={{ width: size, height: size, objectFit: 'cover', borderRadius: 12, opacity: 0.8, boxShadow: '0 2px 8px rgba(0,0,0,.12)' }} />
        )}
      </span>
    </span>
  );
}

/**
 * 压贴类摆到门牌角 / 页面角：整件压在挂区角上，不骑边线。
 * 只用于 pin 类（服务端已把吊挂类挡在 card-edge 之外）。
 */
export function DecorCorner({ id, at, inset = 4 }: { id: WidgetId; at: string; inset?: number }) {
  const p = PIECES[id];
  const anchor = CORNER_ANCHOR[at];
  if (!p || !anchor) return null;
  const { left: _l, top: _t, ...rest } = p.box; // 丢掉为卡边设计的 left/top，改用角位
  return (
    <span className="rm-decor" style={withBase(anchor)} aria-hidden>
      <span style={{ position: 'absolute', ...CORNER_INNER[at], ...rest, transformOrigin: 'top center' }}>{p.art}</span>
    </span>
  );
}

/*
 * ⚠️ 这里有个踩过的坑，别再合并成一层：
 *   曾经写成 `style={{ ...ANCHOR[slot], ...p.box }}` —— 看着像"锚点 + 微调"，
 *   实际是 `p.box.left` **整个覆盖** `ANCHOR.left`，8 个吸附点全部失效，
 *   灯笼/星串/常春藤挤在卡片左边（实机截图才发现，类型与构建都不报错）。
 *   CSS 的 left/top 不能相加，所以必须**外层落锚点、内层做偏移**。
 */
function atAnchor(slot: Slot, inner: CSSProperties, cls: string, children: ReactNode, key?: string) {
  return (
    <span key={key} className={cls} style={withBase(ANCHOR[slot])}>
      <span style={{ position: 'absolute', ...inner }}>{children}</span>
    </span>
  );
}

/** 光晕层（灯笼/月牙/常春藤才有）——由 Room 渲染在**文字之下**。 */
export function DecorGlow({ id, slot }: { id: WidgetId; slot: Slot }) {
  const p = PIECES[id];
  if (!p?.glow) return null;
  const { width, height, background } = p.glow;
  return atAnchor(slot, { width, height, background }, 'rm-glow-anchor', null);
}

/**
 * 吊挂件垂进纸里的那一段自动淡下去：边线以下越深越轻，最深也不消失（半透明，不是没有）。
 * 为什么按 `box.top` 算：top 就是"有多少留在墙上"，比例一变图就跟着变，
 * 不必为每件组件再手写一份遮罩参数（写了也一定和几何漂移）。
 */
function drape(top: number, height: number): string | undefined {
  if (!(height > 0) || top >= 0) return undefined;
  const e = Math.max(2, Math.min(60, (-top / height) * 100));
  return `linear-gradient(to bottom, #000 0 ${e.toFixed(1)}%,`
    + ` rgba(0,0,0,.72) ${(e + 14).toFixed(1)}%, rgba(0,0,0,.5) ${(e + 38).toFixed(1)}%, rgba(0,0,0,.42) 100%)`;
}

/** 摆一件组件：外层落在卡片边线的锚点上，内层用负偏移实现"骑在边上"。 */
export function Decor({ id, slot }: { id: WidgetId; slot: Slot }) {
  const p = PIECES[id];
  if (!p) return null;
  const mask = HANGING.has(id) && String(slot).startsWith('top')
    ? drape(Number(p.box.top ?? 0), Number(p.box.height ?? 0)) : undefined;
  const box = mask ? { ...p.box, maskImage: mask, WebkitMaskImage: mask } : p.box;
  return atAnchor(slot, box, `rm-decor${HANGING.has(id) ? ' rm-sway' : ''}`, p.art);
}

/**
 * 预览用的一件组件（串门卡 / 主页那一栏）：**排在一条门楣带上，不骑边线**。
 *
 * 为什么不复用上面那个 `Decor`：负偏移锚点成立的前提是"卡片两侧有大片墙"。
 * 卡片一进网格，那半截留在墙上的部分就压到标题、甚至飘进邻居卡的空隙
 * （实机截图连着抓到两次：月牙落在上一张卡下面、灯笼盖住「萧盛 的 Agent」）。
 * 所以预览不还原几何，只回答一个问题——**这间房摆了哪几件**：等比缩小，
 * 外面那层框先占好缩放后的位置（transform 不参与布局，不包这层就会互相挤）。
 */
export function DecorPiece({ id, scale = 0.42 }: { id: WidgetId; scale?: number }) {
  const p = PIECES[id];
  if (!p) return null;
  const w = Number(p.box.width ?? 60);
  const h = Number(p.box.height ?? 60);
  return (
    <span className={`rm-piece${HANGING.has(id) ? ' rm-sway' : ''}`}
      style={{ width: w * scale, height: h * scale }} aria-hidden>
      <span style={{ width: w, height: h, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
        {p.art}
      </span>
    </span>
  );
}

/**
 * 吊挂件伸出卡顶的高度（渲染像素）：`|box.top|`。
 * 吊挂件的缩放原点在顶部中心，顶边不随缩放移动，所以伸出量就是 box.top 的绝对值。
 * Room 用它算**动态墙高**（card 的 margin-top），保证灯笼这类吊挂不会被发帖框的纸底盖住。
 */
export function decorOverhang(decorations: RoomDecoration[]): number {
  let max = 0;
  for (const d of decorations) {
    if (d.zone !== 'card-edge' || !d.at.startsWith('top')) continue;
    const p = PIECES[d.id as WidgetId];
    if (!p) continue;
    const top = Number(p.box.top ?? 0);
    if (top < 0) max = Math.max(max, -top);
  }
  return max;
}
