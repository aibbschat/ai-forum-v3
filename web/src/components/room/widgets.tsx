// 房间的官方小组件（D2）—— 12 件，全部矢量。
// 规格《AI圈-Agent日记与主人房间设计-2026-09.md》§6.2；id 必须与服务端
// `lib/roomService.js` 的 `WIDGETS` 注册表**一模一样**（那边是取值域的唯一定义处，
// 前端多画一件、少画一件都会在 room.test.js 的「组件 id 有重复 / 只有 N 件」断言上红）。
//
// 为什么用矢量不用贴图（静态稿 v3 的判断）：
//   ① 不糊——房间会被拉到手机宽度，位图贴纸一到 2x 就毛；
//   ② 体积小——12 件加起来不到 6KB，一张贴纸 PNG 就这个数；
//   ③ **能跟着皮肤换色**：同一只灯笼在晨白下是暖红、在墨夜下自动压成暗红，
//      这是"装饰属于房间、不属于图片"的关键。
// 所以每个组件都只吃一个 `c`（主色）参数，深浅由房间的 accent 决定。
import type { CSSProperties } from 'react';

export type WidgetId =
  | 'lantern' | 'bell' | 'bow' | 'stars' | 'moon' | 'clover'
  | 'bear' | 'sprig' | 'tape' | 'pin' | 'shell' | 'ivy';

export type Slot =
  | 'top-l' | 'top-c' | 'top-r' | 'side-l' | 'side-r' | 'bottom-l' | 'bottom-c' | 'bottom-r';

export const WIDGET_IDS: WidgetId[] = [
  'lantern', 'bell', 'bow', 'stars', 'moon', 'clover',
  'bear', 'sprig', 'tape', 'pin', 'shell', 'ivy',
];

/** 中文名给装修面板用——取向差异靠件数平铺解决，不分男女组、不打甜度标签。 */
export const WIDGET_LABELS: Record<WidgetId, string> = {
  lantern: '灯笼', bell: '风铃', bow: '蝴蝶结', stars: '星串', moon: '月牙', clover: '四叶草',
  bear: '小熊', sprig: '干花', tape: '胶带', pin: '图钉', shell: '贝壳', ivy: '常春藤',
};

/** 吸附位：全部落在边框带上，**结构上碰不到正文**（这就是不给自由拖动的理由）。 */
export const SLOT_POS: Record<Slot, CSSProperties> = {
  'top-l': { top: 6, left: 18 },
  'top-c': { top: 4, left: '50%', transform: 'translateX(-50%)' },
  'top-r': { top: 6, right: 18 },
  'side-l': { top: '42%', left: 5 },
  'side-r': { top: '42%', right: 5 },
  'bottom-l': { bottom: 8, left: 18 },
  'bottom-c': { bottom: 6, left: '50%', transform: 'translateX(-50%)' },
  'bottom-r': { bottom: 8, right: 18 },
};

type P = { c: string; c2?: string };

const Lantern = ({ c, c2 }: P) => (
  <svg width="26" height="34" viewBox="0 0 24 32" aria-hidden>
    <path d="M12 0v5" stroke={c2 || '#8a6a3f'} strokeWidth="1.2" />
    <ellipse cx="12" cy="14" rx="9" ry="8" fill={c} />
    <path d="M12 6v16M5 14h14" stroke={c} strokeOpacity=".45" strokeWidth=".8" />
    <rect x="8" y="5" width="8" height="2.6" rx="1" fill={c2 || '#8a6a3f'} />
    <rect x="8" y="21" width="8" height="2.6" rx="1" fill={c2 || '#8a6a3f'} />
    <path d="M12 24v4M10 28v3M14 28v3" stroke={c} strokeWidth="1.1" />
  </svg>
);
const Bell = ({ c }: P) => (
  <svg width="24" height="22" viewBox="0 0 26 24" aria-hidden>
    <path d="M13 3a7 7 0 017 7v5l2 3H4l2-3v-5a7 7 0 017-7z" fill={c} />
    <path d="M10 20a3 3 0 006 0" fill={c} opacity=".7" />
    <circle cx="13" cy="2" r="1.6" fill={c} opacity=".8" />
  </svg>
);
const Bow = ({ c }: P) => (
  <svg width="26" height="24" viewBox="0 0 24 24" aria-hidden>
    <path d="M12 12C9 6 2 6 2 12s7 6 10 0z" fill={c} />
    <path d="M12 12c3-6 10-6 10 0s-7 6-10 0z" fill={c} />
    <circle cx="12" cy="12" r="2.6" fill={c} opacity=".75" />
    <path d="M12 14l-3 7M12 14l3 7" stroke={c} strokeWidth="2" />
  </svg>
);
const Stars = ({ c }: P) => (
  <svg width="38" height="22" viewBox="0 0 38 22" aria-hidden>
    <path d="M2 6h34" stroke={c} strokeWidth="1" opacity=".7" />
    <path d="M8 8l1.6 3.4L13 13l-3.4 1.6L8 18l-1.6-3.4L3 13l3.4-1.6z" fill={c} />
    <path d="M19 10l1.3 2.8 2.9 1.2-2.9 1.2-1.3 2.8-1.3-2.8-2.9-1.2 2.9-1.2z" fill={c} opacity=".8" />
    <path d="M30 7l1.6 3.4 3 1.2-3 1.6L30 17l-1.6-3.4-3-1.6 3-1.2z" fill={c} />
  </svg>
);
const Moon = ({ c }: P) => (
  <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden>
    <path d="M18 3a9 9 0 100 18 7.4 7.4 0 010-18z" fill={c} />
  </svg>
);
const Clover = ({ c }: P) => (
  <svg width="24" height="26" viewBox="0 0 24 26" aria-hidden>
    <path d="M12 12C12 8 10 6 7.4 6S4 8 4 10s2 2.6 4 2.6S12 12 12 12z" fill={c} />
    <path d="M12 12c0-4 2-6 4.6-6S20 8 20 10s-2 2.6-4 2.6S12 12 12 12z" fill={c} opacity=".85" />
    <path d="M12 12c-4 0-6 2-6 4.6S8 20 10 20s2.6-2 2.6-4S12 12 12 12z" fill={c} opacity=".85" />
    <path d="M12 12c4 0 6 2 6 4.6S16 20 14 20s-2.6-2-2.6-4S12 12 12 12z" fill={c} />
    <path d="M12 14v10" stroke={c} strokeWidth="1.2" />
  </svg>
);
const Bear = ({ c }: P) => (
  <svg width="26" height="24" viewBox="0 0 26 24" aria-hidden>
    <circle cx="6.5" cy="7" r="3.6" fill={c} />
    <circle cx="19.5" cy="7" r="3.6" fill={c} />
    <circle cx="13" cy="13" r="8.6" fill={c} />
    <circle cx="10" cy="11.5" r="1.2" fill="#4a3f35" opacity=".75" />
    <circle cx="16" cy="11.5" r="1.2" fill="#4a3f35" opacity=".75" />
    <ellipse cx="13" cy="16" rx="2.2" ry="1.7" fill="#fff" opacity=".45" />
  </svg>
);
const Sprig = ({ c }: P) => (
  <svg width="24" height="32" viewBox="0 0 24 32" aria-hidden>
    <path d="M4 30C10 22 14 12 22 2" stroke={c} strokeWidth="1.3" fill="none" />
    <ellipse cx="14" cy="18" rx="4.6" ry="3.2" fill={c} opacity=".85" transform="rotate(-30 14 18)" />
    <ellipse cx="19" cy="10" rx="4.2" ry="3" fill={c} opacity=".7" transform="rotate(-40 19 10)" />
    <ellipse cx="9" cy="24" rx="4.2" ry="3" fill={c} opacity=".7" transform="rotate(-20 9 24)" />
  </svg>
);
const Tape = ({ c }: P) => (
  <svg width="46" height="16" viewBox="0 0 46 24" aria-hidden>
    <rect x="0" y="6" width="46" height="12" fill={c} opacity=".45" />
    <path d="M0 6l3 3-3 3 3 3-3 3" stroke={c} fill="none" opacity=".6" />
    <path d="M46 6l-3 3 3 3-3 3 3 3" stroke={c} fill="none" opacity=".6" />
  </svg>
);
const Pin = ({ c }: P) => (
  <svg width="22" height="26" viewBox="0 0 24 26" aria-hidden>
    <circle cx="12" cy="9" r="7" fill={c} />
    <circle cx="10" cy="7" r="2" fill="#fff" opacity=".35" />
    <path d="M12 16v8" stroke={c} strokeOpacity=".55" strokeWidth="1.6" />
  </svg>
);
const Shell = ({ c }: P) => (
  <svg width="26" height="20" viewBox="0 0 26 22" aria-hidden>
    <path d="M2 20a12 12 0 0124 0z" fill={c} opacity=".8" />
    <path d="M14 20V6M8 21 11 7M20 21 17 7M4 21 7 10M24 21 21 10" stroke="#fff" strokeOpacity=".5" strokeWidth=".9" fill="none" />
  </svg>
);
const Ivy = ({ c }: P) => (
  <svg width="26" height="22" viewBox="0 0 26 22" aria-hidden>
    <path d="M4 20C4 10 12 3 24 2c0 11-9 18-20 18z" fill={c} opacity=".85" />
    <path d="M5 19C11 14 17 8 23 3" stroke="#fff" strokeOpacity=".4" strokeWidth="1" fill="none" />
  </svg>
);

const MAP: Record<WidgetId, (p: P) => React.ReactElement> = {
  lantern: Lantern, bell: Bell, bow: Bow, stars: Stars, moon: Moon, clover: Clover,
  bear: Bear, sprig: Sprig, tape: Tape, pin: Pin, shell: Shell, ivy: Ivy,
};

/**
 * 摆一件组件。`c` 由房间 accent 决定 → 同一件东西在不同皮肤下自动换色。
 * `sway` 给挂着的两件（灯笼/风铃）一点呼吸外的摆动；`motion:'still'` 时由父级关掉。
 */
export function Widget({ id, slot, c, c2, sway = false, style }: {
  id: WidgetId; slot: Slot; c: string; c2?: string; sway?: boolean; style?: CSSProperties;
}) {
  const C = MAP[id];
  if (!C) return null;                       // 未注册的 id：静默不画（服务端已挡，这里只是双保险）
  return (
    <span className={`rm-w${sway ? ' rm-sway' : ''}`} style={{ ...SLOT_POS[slot], ...style }}>
      <C c={c} c2={c2} />
    </span>
  );
}
