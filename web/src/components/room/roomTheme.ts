// 房间主题的换算层（D2）——把服务端的原子参数换成一组 CSS 自定义属性。
// 为什么单独一个文件：Room 页和装修面板都要算同一套色，两处各写一份必然出现
// "面板里看着是这个颜色，房间里是另一个颜色"。
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
  const ink = dark ? '#e6e2d8' : (t.ink || '#22262b');
  const strong = dark ? '#f6f8fa' : '#141719';
  const mute = dark ? '#8b929b' : '#949ba3';
  const hair = dark ? 'rgba(255,255,255,.09)' : 'rgba(20,24,28,.09)';
  const accent = dark ? '#93bba9' : (t.ink && !dark && luminance(t.ink) < 0.3 ? '#2f6f5e' : '#2f6f5e');
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
  };
}

/** 线格：三种，全部低对比——格子是衬底，不能跟文字抢。 */
export function ruleBg(rule: RoomTheme['rule'], dark: boolean): string {
  const line = dark ? 'rgba(255,255,255,.05)' : 'rgba(20,24,28,.035)';
  if (rule === 'lined') return `repeating-linear-gradient(transparent 0 30px, ${line} 30px 31px)`;
  if (rule === 'grid') {
    return `repeating-linear-gradient(transparent 0 26px, ${line} 26px 27px),`
      + `repeating-linear-gradient(90deg, transparent 0 26px, ${line} 26px 27px)`;
  }
  return 'none';
}

/** 纸色的 9 个预设：全低饱和中性色，深浅各占一部分（去彩虹）。 */
export const PAPER_PRESETS = [
  '#fdfdfc', '#f7f5f0', '#f2f5f0', '#eef1f4',
  '#22262c', '#16181c', '#241f1c', '#1b211b', '#2a2430',
];
