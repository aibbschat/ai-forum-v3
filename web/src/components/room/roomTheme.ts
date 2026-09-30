// 房间主题的换算层（D2）——把服务端的原子参数换成一组 CSS 自定义属性。
// 为什么单独一个文件：Room 页和装修面板都要算同一套色，两处各写一份必然出现
// "面板里看着是这个颜色，房间里是另一个颜色"。
import type { CSSProperties } from 'react';
import type { RoomTheme } from '../../api';

/** 落款字体：只作用于她的署名与日期。正文一律系统字体，不参与装扮。 */
export const SIGN_FONT: Record<RoomTheme['signFont'], string> = {
  pen: '"Hanzipen SC","Kaiti SC",cursive',
  round: '"Yuanti SC","PingFang SC",sans-serif',
  note: '"Hannotate SC","Kaiti SC",cursive',
  kai: '"Kaiti SC","STKaiti",serif',
};
export const SIGN_LABEL: Record<RoomTheme['signFont'], string> = {
  pen: '钢笔体', round: '圆体', note: '手札体', kai: '楷体',
};

/** 墨色预设：正文墨色只有主人能选，但仍是「纸上的字」——低饱和、可读优先。 */
export const INK_PRESETS = ['#22262b', '#3b2f28', '#24344d', '#2f3d2f', '#4a2430'];

/** 角落装饰的四角定位（§6.2 corner.at）——贴纸骑在日记卡的角上，不参与布局。 */
export const CORNER_AT: Record<string, CSSProperties> = {
  'tr': { top: 0, right: 0 },
  'tl': { top: 0, left: 0 },
  'br': { bottom: 0, right: 0 },
  'bl': { bottom: 0, left: 0 },
};

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return [253, 253, 252];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/** 相对亮度：决定这张纸是浅底还是深底，进而决定墨色与强调色（深底标题必须显式提亮）。 */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}
const isDarkPaper = (t: RoomTheme) => luminance(t.paper) < 0.45;

/** 官方墙纸键 → 资源路径（与服务端 WALLPAPERS 表一致）。 */
export function wallpaperUrl(key: string | null): string | null {
  if (!key) return null;
  if (key.startsWith('official:')) return `/room/wallpaper/${key.split(':')[1]}.webp`;
  return key; // 主人上传的图：/covers/… 短 URL
}

/** 官方墙纸的展示名（2026-09-30 改名避撞：「雨夜窗台」从套装名里让出来，墙纸叫「夜窗雨景」）。 */
export const WALLPAPER_LABELS: Record<string, string> = {
  'official:moss': '薄雾苔原',
  'official:night': '夜窗雨景',
  'official:paper': '米纸干花',
};

/**
 * 八套主题（2026-09-30 拍板：一次全部上线）。
 * 🔴 每个主题**只带风格参数，永不写 wallpaper**——墙纸是独立的背景轴，
 * 主题卡只是「颜色 / 字体 / 线格 / 质感 / 形态 / 门牌」的组合。
 * 想一步到位可以点「连墙纸一起换」，那是显式动作，不是主题的隐含行为。
 */
export interface ThemePreset {
  key: string;
  label: string;
  desc: string;
  /** 风格参数：全部来自 RoomTheme 白名单字段 */
  theme: Partial<Pick<RoomTheme,
    'paper' | 'ink' | 'rule' | 'signFont' | 'leading' | 'motion'
    | 'paperFeel' | 'cardShape' | 'bandStyle' | 'accent'>>;
  /** 推荐墙纸（可选）：点了「连墙纸一起换」才写进 wallpaper；null=该主题不配墙纸 */
  recommendWallpaper: string | null;
}
export const THEMES: ThemePreset[] = [
  { key: 'dawn', label: '晨光白纸', desc: '极简默认：一张不打扰的纸', theme: {
    paper: '#fdfdfc', ink: '#22262b', rule: 'none', signFont: 'pen', leading: 1.85,
    motion: 'soft', paperFeel: 'none', cardShape: 'round', bandStyle: 'tag', accent: null,
  }, recommendWallpaper: null },
  { key: 'letter', label: '旧信笺', desc: '传统书信：米纸手撕边、赭红落款', theme: {
    paper: '#f4ecdd', ink: '#3b2f28', rule: 'lined', signFont: 'pen', leading: 1.9,
    paperFeel: 'paper', cardShape: 'torn', bandStyle: 'tag', accent: '#b23a48',
  }, recommendWallpaper: 'official:paper' },
  { key: 'study', label: '灯下抄书', desc: '传统深夜书房：牛皮纸、木牌门牌、金字', theme: {
    paper: '#1c1917', ink: '#e6dcc8', rule: 'lined', signFont: 'kai', leading: 1.95,
    paperFeel: 'kraft', cardShape: 'round', bandStyle: 'wood', accent: '#d8a24a',
  }, recommendWallpaper: null },
  { key: 'rain', label: '雨夜窗台', desc: '氛围夜读：深青纸、窗玻璃后的雨', theme: {
    paper: '#141821', ink: '#dfe3ea', rule: 'none', signFont: 'pen', leading: 1.9,
    paperFeel: 'none', cardShape: 'round', bandStyle: 'wood', accent: '#7fb3d5',
  }, recommendWallpaper: 'official:night' },
  { key: 'neon', label: '霓虹夜航', desc: '激进直角：深底霓虹、发光门牌', theme: {
    paper: '#0e0f14', ink: '#e8eaf2', rule: 'none', signFont: 'round', leading: 1.85,
    paperFeel: 'none', cardShape: 'square', bandStyle: 'neon', accent: '#22d3ee',
  }, recommendWallpaper: 'official:moss' },
  { key: 'cyber', label: '赛博格纸', desc: '科技点阵：终端条门牌、荧光绿字', theme: {
    paper: '#101418', ink: '#d7dee8', rule: 'dot', signFont: 'note', leading: 1.9,
    paperFeel: 'letter', cardShape: 'square', bandStyle: 'terminal', accent: '#4ade80',
  }, recommendWallpaper: null },
  { key: 'pixel', label: '像素小屋', desc: '前卫方眼：像素框、红橙点缀', theme: {
    paper: '#f7f5f0', ink: '#2b2f36', rule: 'square', signFont: 'round', leading: 1.8, motion: 'still',
    paperFeel: 'none', cardShape: 'square', bandStyle: 'pixel', accent: '#e05b2a',
  }, recommendWallpaper: 'official:moss' },
  { key: 'ink', label: '水墨留白', desc: '传统艺术：宣纸质感、印章门牌', theme: {
    paper: '#f6f4ee', ink: '#26241f', rule: 'none', signFont: 'kai', leading: 1.95,
    paperFeel: 'paper', cardShape: 'round', bandStyle: 'seal', accent: '#a33a2f',
  }, recommendWallpaper: null },
];

/**
 * 解析成一组 CSS 变量。
 * 强调色刻意**不由主人随便填**：深底上原色会沉下去，所以深底自动提亮一档——
 * 这是"深底上标题必须显式提亮"那条规矩的落地方式，而不是靠人记着调。
 */
/**
 * 解析成一组 CSS 变量。
 * 遮罩**分两层**（墙纸铺满全屏之后的必然结果）：
 *   band = 头部带，比正文低 22 个点，让墙纸透出来——头部是"门脸"，该让人看见这间家长什么样；
 *   card = 正文卡，至少 90%，字永远坐在压得住的纸上。
 * 所以 `scrim` 调的是"这间房透多少图进来"，不是"字能不能读清"——后者由 90% 兜住。
 */
export function themeVars(t: RoomTheme): Record<string, string> {
  const dark = isDarkPaper(t);
  const [pr, pg, pb] = hexToRgb(t.paper);
  // 墨色尊重主人的选择（主题也会带 ink）：深色纸上浅墨由主人/主题决定，
  // 没设才回落默认（向后兼容——老房间没设过 ink 的，行为不变）。
  const ink = dark ? (t.ink || '#e6e2d8') : (t.ink || '#22262b');
  const strong = dark ? '#f6f8fa' : '#141719';
  const mute = dark ? '#8b929b' : '#949ba3';
  const hair = dark ? 'rgba(255,255,255,.09)' : 'rgba(20,24,28,.09)';
  // 强调色：主题自带优先（八套主题都配了）；没配才自动推导（晨光白纸这类"零主张"主题）
  const accent = t.accent || (dark ? '#93bba9' : '#2f6f5e');
  const inset = dark ? 'rgba(255,255,255,.04)' : 'rgba(20,24,28,.03)';
  return {
    '--rm-paper-rgb': `${pr},${pg},${pb}`,
    '--rm-paper': t.paper,
    '--rm-scrim': String(t.scrim),
    '--rm-scrim-band': String(Math.max(48, t.scrim - 22)),
    '--rm-scrim-card': String(Math.max(90, t.scrim)),
    '--rm-ink': ink,
    '--rm-ink-soft': dark ? '#c3c9d1' : '#4a4f55',
    '--rm-ink-strong': strong,
    '--rm-on-accent': dark ? '#12151a' : '#ffffff',
    '--rm-mute': mute,
    '--rm-hair': hair,
    '--rm-accent': accent,
    '--rm-accent-soft': dark ? 'rgba(147,187,169,.14)' : 'rgba(47,111,94,.08)',
    '--rm-inset': inset,
    '--rm-leading': String(t.leading),
    '--rm-sign-font': SIGN_FONT[t.signFont] || SIGN_FONT.pen,
    // §6.4 三件套的第三件：条目首字与落款同一种手写体（正文仍是系统字体）
    '--rm-first-font': SIGN_FONT[t.signFont] || SIGN_FONT.pen,
  };
}

/** 线格：五种，全部低对比——格子是衬底，不能跟文字抢。点阵/方眼是 2026-09-30 给科技/前卫主题加的。 */
export function ruleBg(rule: RoomTheme['rule'], dark: boolean): string {
  const line = dark ? 'rgba(255,255,255,.05)' : 'rgba(20,24,28,.035)';
  if (rule === 'lined') return `repeating-linear-gradient(transparent 0 30px, ${line} 30px 31px)`;
  if (rule === 'grid') {
    return `repeating-linear-gradient(transparent 0 26px, ${line} 26px 27px),`
      + `repeating-linear-gradient(90deg, transparent 0 26px, ${line} 26px 27px)`;
  }
  if (rule === 'dot') {
    return `radial-gradient(${line} 1.1px, transparent 1.3px) 0 0 / 22px 22px`;
  }
  if (rule === 'square') {
    return `repeating-linear-gradient(transparent 0 24px, ${line} 24px 25px),`
      + `repeating-linear-gradient(90deg, transparent 0 24px, ${line} 24px 25px)`;
  }
  return 'none';
}

/** 纸色的 9 个预设：全低饱和中性色，深浅各占一部分（去彩虹）。 */
export const PAPER_PRESETS = [
  '#fdfdfc', '#f7f5f0', '#f2f5f0', '#eef1f4',
  '#22262c', '#16181c', '#241f1c', '#1b211b', '#2a2430',
];
