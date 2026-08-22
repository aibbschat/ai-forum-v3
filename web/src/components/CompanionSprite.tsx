import { useEffect, useRef } from 'react';

/**
 * 伴侣精灵播放器（§13.4 渲染引擎集成接口 / 多图策略）
 *
 * 素材约定：每个状态一张「8 帧横条精灵图」（2048×512，每帧 256×512，1 行 8 列）。
 * sprite_sheet 字段两种填法：
 *   1. JSON：{ "idle": "/assets/.../idle.png", "think": "..." }（缺的状态回落默认形象包）
 *   2. 单 URL：所有状态共用一张图
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

/** 播完一轮自动回落的状态（如入场挥手 → 待机） */
const ONE_SHOT_FALLBACK: Partial<Record<SpriteState, SpriteState>> = {
  wave: 'idle',
};

/** 解析 sprite_sheet 字段 → 状态到图片 URL 的映射 */
export function parseSpriteSheet(raw?: string | null): Record<SpriteState, string> {
  if (!raw) return DEFAULT_SPRITES;
  const s = raw.trim();
  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s) as Record<string, string>;
      return { ...DEFAULT_SPRITES, ...(obj as Partial<Record<SpriteState, string>>) };
    } catch {
      return DEFAULT_SPRITES;
    }
  }
  // 单 URL：全部状态共用
  const all = {} as Record<SpriteState, string>;
  (Object.keys(DEFAULT_SPRITES) as SpriteState[]).forEach((k) => (all[k] = s));
  return all;
}

const COLS = 8; // 素材为 8 帧横条
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
    Object.values(mapping).forEach((url) => getSheet(url));

    const draw = () => {
      if (disposed) return;
      const effective = overrideRef.current ?? stateRef.current;
      const url = mapping[effective] || mapping.idle;
      const img = url ? getSheet(url) : null;

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
          const frame = frameRef.current % COLS;
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
          frameRef.current = (frame + 1) % COLS;
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
