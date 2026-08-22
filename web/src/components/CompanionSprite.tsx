import { useEffect, useRef } from 'react';

/**
 * 伴侣精灵播放器（§13.4 渲染引擎集成接口 / 多图策略）
 *
 * 素材约定：每个状态一张「横条精灵图」。推荐 8 帧横条（2048×512，每帧 256×512），
 * 但允许状态实际帧数不足 8 帧。URL 可加 `@N` 后缀显式声明帧数，例如：
 *   /assets/companions/sprites/wave.png@6
 *
 * sprite_sheet 字段两种填法：
 *   1. JSON：{ "idle": "/assets/.../idle.png@8", "think": "..." }（缺的状态回落默认形象包）
 *   2. 单 URL：所有状态共用一张图（可带 @N）
 *   3. 空：使用站内默认机器人形象包（/assets/companions/sprites/）
 */

export type SpriteState =
  | 'idle'
  | 'think'
  | 'happy'
  | 'sleep'
  | 'wave'
  | 'run'
  | 'sit'
  | 'walk_left'
  | 'walk_right';

/** 站内默认形象包（AI 伴侣机器人原创分镜，萧哥自制素材） */
export const DEFAULT_SPRITES: Record<SpriteState, string> = {
  idle: '/assets/companions/sprites/idle.png',
  think: '/assets/companions/sprites/think.png',
  happy: '/assets/companions/sprites/happy.png',
  sleep: '/assets/companions/sprites/sleep.png',
  wave: '/assets/companions/sprites/wave.png',
  run: '/assets/companions/sprites/run.png',
  sit: '/assets/companions/sprites/sit.png',
  walk_left: '/assets/companions/sprites/walk_left.png',
  walk_right: '/assets/companions/sprites/walk_right.png',
};

/** 默认包各状态实际帧数（由素材实测得到；idle 完整 8 帧，其余动作 6–7 帧） */
export const DEFAULT_FRAMES: Partial<Record<SpriteState, number>> = {
  idle: 8,
  think: 6,
  happy: 6,
  sleep: 6,
  wave: 6,
  run: 6,
  sit: 6,
  walk_left: 7,
  walk_right: 7,
};

/** 播完一轮自动回落的状态（如入场挥手 → 待机） */
const ONE_SHOT_FALLBACK: Partial<Record<SpriteState, SpriteState>> = {
  wave: 'idle',
};

export interface SpriteFrameConfig {
  url: string;
  frames: number;
}

function parseFrameUrl(raw: string): SpriteFrameConfig {
  const m = raw.match(/^(.*)@(\d+)$/);
  if (m) {
    const frames = Math.max(1, parseInt(m[2], 10));
    return { url: m[1].trim(), frames };
  }
  return { url: raw.trim(), frames: 8 };
}

/** 解析 sprite_sheet 字段 → 状态到（图片 URL + 实际帧数）的映射 */
export function parseSpriteSheet(raw?: string | null): Record<SpriteState, SpriteFrameConfig> {
  const defaults: Record<SpriteState, SpriteFrameConfig> = Object.fromEntries(
    (Object.keys(DEFAULT_SPRITES) as SpriteState[]).map((k) => [
      k,
      { url: DEFAULT_SPRITES[k], frames: DEFAULT_FRAMES[k] ?? 8 },
    ])
  ) as Record<SpriteState, SpriteFrameConfig>;

  if (!raw) return defaults;
  const s = raw.trim();
  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s) as Record<string, string>;
      const out = { ...defaults };
      (Object.keys(obj) as SpriteState[]).forEach((k) => {
        if (obj[k] != null) out[k] = parseFrameUrl(obj[k]);
      });
      return out;
    } catch {
      return defaults;
    }
  }
  // 单 URL：全部状态共用
  const cfg = parseFrameUrl(s);
  const all = {} as Record<SpriteState, SpriteFrameConfig>;
  (Object.keys(DEFAULT_SPRITES) as SpriteState[]).forEach((k) => (all[k] = cfg));
  return all;
}

const COLS = 8; // 素材总列数（2048px / 8 = 256px/帧），实际播放帧数由 cfg.frames 决定
const FRAME_MS = 125; // 8 fps

interface Props {
  state?: SpriteState;
  spriteSheet?: string | null;
  /** 展示宽度 px（帧为 1:2 竖条，高度自动 = 2×宽） */
  width?: number;
  className?: string;
}

export default function CompanionSprite({
  state = 'idle',
  spriteSheet,
  width = 150,
  className = '',
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sheetsRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const frameRef = useRef(0);
  const stateRef = useRef<SpriteState>(state);
  const overrideRef = useRef<SpriteState | null>(null);

  // 状态变化时清掉一次性回落覆盖
  useEffect(() => {
    stateRef.current = state;
    overrideRef.current = null;
    frameRef.current = 0;
  }, [state]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const mapping = parseSpriteSheet(spriteSheet);
    let disposed = false;

    const getSheet = (url: string): HTMLImageElement | null => {
      const cached = sheetsRef.current.get(url);
      if (cached) return cached.complete && cached.naturalWidth > 0 ? cached : null;
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      sheetsRef.current.set(url, img);
      return null;
    };

    // 预热全部状态图（切换状态零延迟）
    Object.values(mapping).forEach((cfg) => getSheet(cfg.url));

    const draw = () => {
      if (disposed) return;
      const effective = overrideRef.current ?? stateRef.current;
      const cfg = mapping[effective] || mapping.idle;
      const img = cfg.url ? getSheet(cfg.url) : null;
      const frameCount = cfg.frames;

      if (img) {
        const fw = Math.floor(img.naturalWidth / COLS);
        const fh = img.naturalHeight;
        if (fw > 0 && fh > 0) {
          const dpr = Math.min(2, window.devicePixelRatio || 1);
          const dispH = Math.round(width * (fh / fw));
          if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(dispH * dpr)) {
            canvas.width = Math.round(width * dpr);
            canvas.height = Math.round(dispH * dpr);
            canvas.style.width = `${width}px`;
            canvas.style.height = `${dispH}px`;
          }
          const frame = frameRef.current % frameCount;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(
            img,
            frame * fw,
            0,
            fw,
            fh,
            0,
            0,
            canvas.width,
            canvas.height
          );
          frameRef.current = (frame + 1) % frameCount;
          // 一轮播完 → 一次性状态回落
          if (frameRef.current === 0) {
            const fb = ONE_SHOT_FALLBACK[effective];
            if (fb) overrideRef.current = fb;
          }
        }
      }
    };

    const timer = window.setInterval(() => {
      if (!document.hidden) draw();
    }, FRAME_MS);
    draw();

    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [spriteSheet, width]);

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label="伴侣形象动画"
      className={className}
      style={{ imageRendering: 'auto' }}
    />
  );
}
