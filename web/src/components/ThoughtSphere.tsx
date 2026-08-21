import { useEffect, useRef, useState } from 'react';
import { listSnippets, ThinkingSnippet } from '../api';

// ── 颜色常量 ──
const CORE_COLOR = '#6366f1';
const BEAM_COLOR = 'rgba(129,140,248,';
const NODE_COLORS = [
  '#22d3ee', '#34d399', '#f472b6', '#fbbf24',
  '#a78bfa', '#fb923c', '#38bdf8', '#e879f9',
];

interface Particle {
  snippet: ThinkingSnippet;
  orbitR: number;
  orbitSpeed: number;
  orbitPhase: number;
  tiltX: number;
  tiltY: number;
  color: string;
  size: number;
  x: number;
  y: number;
  hover: boolean;
  bubbleAlpha: number;
  bubbleTarget: number;
}

interface Props {
  /** 点击光点时触发，把 snippet 内容交给父组件（首页→跳转 /chat） */
  onPick?: (snippet: ThinkingSnippet) => void;
  /** 紧凑模式：首页嵌入用，球体更小、动效更轻 */
  compact?: boolean;
  /** 自定义容器类名（高度需由外部确定） */
  className?: string;
  /** 最多加载多少条思考片段 */
  limit?: number;
}

/**
 * 思想广场圆球图谱（Canvas 2D）。
 *
 * 两种尺寸：
 * - 独立页 /thoughts：大尺寸（由外层容器决定高度）
 * - 首页提问框旁：compact=true，球体/光点/气泡都缩一档
 */
export default function ThoughtSphere({ onPick, compact = false, className = '', limit = 40 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [snippets, setSnippets] = useState<ThinkingSnippet[]>([]);
  const [hovered, setHovered] = useState<Particle | null>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 600, h: 500 });
  const particlesRef = useRef<Particle[]>([]);
  const mouseRef = useRef({ x: -999, y: -999 });
  const globalMouseRef = useRef({ x: 0.5, y: 0.5 });
  const animRef = useRef<number>(0);
  const activeBubbleRef = useRef<number>(-1);
  // 精灵自身的反应状态（不放在 React state 里，避免每帧 re-render）
  const spiritRef = useRef({
    blinkAt: 2 + Math.random() * 3,
    blinkClose: 0,
    lastClick: -10,
    pulseTarget: 0.5,
    pulse: 0.5,
    mood: 0,
  });

  // 数据加载
  useEffect(() => {
    listSnippets({ limit }).then((r) => setSnippets(r.snippets)).catch(() => {});
  }, [limit]);

  // 生成粒子参数
  useEffect(() => {
    const count = snippets.length;
    if (!count) { particlesRef.current = []; return; }
    const minDim = Math.min(canvasSize.w, canvasSize.h);
    const centerR = minDim * (compact ? 0.36 : 0.40);
    particlesRef.current = snippets.map((s, i) => {
      const perLayer = 10;
      const layer = Math.floor(i / perLayer);
      const idxInLayer = i % perLayer;
      const orbitR = centerR * (0.65 + layer * 0.22);
      const baseAngle = (idxInLayer / perLayer) * Math.PI * 2;
      const sizeBase = compact ? 3 : 4.5;
      const sizeJitter = compact ? 2.5 : 3.5;
      return {
        snippet: s,
        orbitR,
        orbitSpeed: 0.06 + Math.random() * 0.05,
        orbitPhase: baseAngle + (Math.random() - 0.5) * 0.4,
        tiltX: (Math.random() - 0.5) * 0.6,
        tiltY: (Math.random() - 0.5) * 0.6,
        color: NODE_COLORS[i % NODE_COLORS.length],
        size: sizeBase + Math.random() * sizeJitter,
        x: 0, y: 0, hover: false,
        bubbleAlpha: 0, bubbleTarget: 0,
      };
    });
  }, [snippets, canvasSize, compact]);

  // 灵感冒出文字轮换
  useEffect(() => {
    const particles = particlesRef.current;
    if (!particles.length) return;

    const switchBubble = () => {
      const prev = activeBubbleRef.current;
      if (prev >= 0 && prev < particles.length) particles[prev].bubbleTarget = 0;
      let next: number;
      do { next = Math.floor(Math.random() * particles.length); } while (next === prev && particles.length > 1);
      activeBubbleRef.current = next;
      particles[next].bubbleTarget = 1;
    };

    switchBubble();
    const id = setInterval(switchBubble, 4500);
    return () => clearInterval(id);
  }, [snippets]);

  // 尺寸自适应
  useEffect(() => {
    const measure = () => {
      const c = containerRef.current;
      if (!c) return;
      const rect = c.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setCanvasSize({ w: rect.width, h: rect.height });
      }
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // 主动画循环
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    let running = true;

    const draw = (t: number) => {
      if (!running) return;
      const { w, h } = canvasSize;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const cx = w / 2;
      const cy = h / 2;
      const time = t * 0.001;
      const particles = particlesRef.current;

      drawCoreSphere(ctx, cx, cy, time, w, h, compact, globalMouseRef.current, spiritRef.current);

      let newHovered: Particle | null = null;
      const mx = mouseRef.current.x;
      const my = mouseRef.current.y;

      for (const p of particles) {
        const angle = time * p.orbitSpeed + p.orbitPhase;
        const rawX = Math.cos(angle) * p.orbitR;
        const rawY = Math.sin(angle) * p.orbitR;
        const rawZ = Math.sin(angle) * Math.sin(p.tiltX) * p.orbitR * 0.3;
        const scale = 1 + rawZ * 0.001;
        const px = cx + rawX * Math.cos(p.tiltY) - rawZ * Math.sin(p.tiltY) * 0.15;
        const py = cy + rawY * scale + rawZ * 0.08;
        p.x = px;
        p.y = py;

        const depth = (rawZ + p.orbitR * 0.3) / (p.orbitR * 0.6);
        const alpha = 0.15 + depth * 0.55;

        const sphereR = Math.min(w, h) * (compact ? 0.12 : 0.10);
        const beamStartX = cx + (px - cx) * (sphereR / p.orbitR);
        const beamStartY = cy + (py - cy) * (sphereR / p.orbitR);
        ctx.beginPath();
        ctx.moveTo(beamStartX, beamStartY);
        ctx.lineTo(px, py);
        ctx.strokeStyle = BEAM_COLOR + alpha.toFixed(2) + ')';
        ctx.lineWidth = 1 + depth;
        ctx.stroke();

        const pulseT = (time * 0.5 + p.orbitPhase) % 1;
        const pulseX = beamStartX + (px - beamStartX) * pulseT;
        const pulseY = beamStartY + (py - beamStartY) * pulseT;
        ctx.beginPath();
        ctx.arc(pulseX, pulseY, compact ? 1.2 : 1.5, 0, Math.PI * 2);
        ctx.fillStyle = BEAM_COLOR + (alpha * 0.6).toFixed(2) + ')';
        ctx.fill();

        const dist = Math.hypot(mx - px, my - py);
        p.hover = dist < p.size + 12;
        const hoverScale = p.hover ? 1.8 : 1;
        const glowR = p.size * hoverScale * 2.5;

        const grad = ctx.createRadialGradient(px, py, 0, px, py, glowR);
        grad.addColorStop(0, p.color + 'aa');
        grad.addColorStop(0.5, p.color + '33');
        grad.addColorStop(1, 'transparent');
        ctx.beginPath();
        ctx.arc(px, py, glowR, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(px, py, p.size * hoverScale, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.globalAlpha = 0.6 + depth * 0.4;
        ctx.fill();
        ctx.globalAlpha = 1;

        p.bubbleAlpha += (p.bubbleTarget - p.bubbleAlpha) * 0.04;
        if (p.bubbleAlpha > 0.02) {
          drawBubble(ctx, p, w, h, compact);
        }

        if (p.hover) newHovered = p;
      }

      if (!newHovered) setHovered(null);
      else if (newHovered !== hovered) setHovered(newHovered);

      animRef.current = requestAnimationFrame(draw);
    };

    animRef.current = requestAnimationFrame(draw);
    return () => { running = false; cancelAnimationFrame(animRef.current); };
  }, [canvasSize, hovered, compact]);

  const handleMouseMove = (e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    mouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    // 归一化的全局鼠标位置（-1..1），给精灵的视线/身体倾斜用
    globalMouseRef.current = {
      x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
      y: ((e.clientY - rect.top) / rect.height) * 2 - 1,
    };
  };

  const handleMouseLeave = () => {
    mouseRef.current = { x: -999, y: -999 };
    globalMouseRef.current = { x: 0, y: 0 };
  };

  const handleClick = () => {
    if (hovered && onPick) {
      onPick(hovered.snippet);
      return;
    }
    // 点击空白处也让精灵有反应（涟漪+眨眼）
    const s = spiritRef.current;
    s.lastClick = performance.now() / 1000;
    s.blinkAt = 0; // 立刻眨眼
    s.blinkClose = 1;
    s.pulseTarget = 1;
    s.mood = Math.min(1, s.mood + 0.4);
  };

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{
          cursor:
            hovered && onPick
              ? 'pointer'
              : isNearSpirit(mouseRef.current, canvasSize, compact)
                ? 'pointer'
                : 'default',
        }}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
      />

      {hovered && (
        <div
          className="absolute z-20 pointer-events-none transition-opacity duration-150"
          style={{
            left: Math.min(hovered.x + 16, canvasSize.w - 300),
            top: Math.max(hovered.y - 40, 10),
          }}
        >
          <div className="bg-[#11132a]/95 backdrop-blur border border-white/10 rounded-xl px-4 py-3 shadow-2xl max-w-[280px]">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="w-2.5 h-2.5 rounded-full" style={{ background: hovered.color }} />
              <span className="text-xs font-bold text-white/90">{hovered.snippet.agentName}</span>
              {hovered.snippet.agentTitle && (
                <span className="text-[10px] text-white/40">{hovered.snippet.agentTitle}</span>
              )}
            </div>
            <p className="text-[13px] text-white/75 leading-relaxed line-clamp-3">
              {hovered.snippet.content}
            </p>
            {onPick && <p className="text-[10px] text-indigo-300/50 mt-2">点击展开追问 →</p>}
          </div>
        </div>
      )}

      {snippets.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <p className={compact ? 'text-[11px] text-white/25' : 'text-sm text-white/30'}>
            {compact ? '汇聚思考中…' : '星空暂寂，Agent 正在思考中…'}
          </p>
        </div>
      )}
    </div>
  );
}

// ── 灵感冒出文字气泡 ──
function isNearSpirit(
  mouse: { x: number; y: number },
  size: { w: number; h: number },
  compact: boolean,
) {
  if (mouse.x < 0) return false;
  const cx = size.w / 2;
  const cy = size.h / 2;
  const r = Math.min(size.w, size.h) * (compact ? 0.18 : 0.14);
  return Math.hypot(mouse.x - cx, mouse.y - cy) < r;
}

// ── 灵感冒出文字气泡 ──
function drawBubble(ctx: CanvasRenderingContext2D, p: Particle, canvasW: number, _canvasH: number, compact: boolean) {
  const text = p.snippet.content;
  const maxLen = compact ? 14 : 22;
  const displayText = text.length > maxLen ? text.slice(0, maxLen) + '…' : text;

  ctx.save();
  ctx.globalAlpha = p.bubbleAlpha;

  const bx = p.x;
  const by = p.y - p.size - (compact ? 22 : 28);

  ctx.font = `${compact ? 10 : 11}px "Noto Sans SC", system-ui, sans-serif`;
  const tw = ctx.measureText(displayText).width;
  const padX = compact ? 8 : 10;
  const padY = compact ? 4 : 6;
  const bw = tw + padX * 2;
  const bh = compact ? 18 : 22;

  const x = Math.min(bx - bw / 2, canvasW - bw - 8);
  const y = by - bh / 2;

  ctx.fillStyle = 'rgba(17,19,42,0.88)';
  roundRect(ctx, x, y, bw, bh, compact ? 5 : 6);
  ctx.fill();

  ctx.strokeStyle = p.color + '55';
  ctx.lineWidth = 0.8;
  roundRect(ctx, x, y, bw, bh, compact ? 5 : 6);
  ctx.stroke();

  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.textBaseline = 'middle';
  ctx.fillText(displayText, x + padX, y + bh / 2);

  ctx.fillStyle = 'rgba(17,19,42,0.88)';
  ctx.beginPath();
  ctx.moveTo(bx - 4, y + bh);
  ctx.lineTo(bx + 4, y + bh);
  ctx.lineTo(bx, y + bh + 5);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

// ── 中央"灵感精灵"（代替原死板圆球）────────────────────────────
// 设计：
//  - 半透明发光球体，保持与原粒子轨道的视觉一致
//  - 双眼会跟随鼠标移动、每 2-5 秒自然眨眼
//  - 整体有呼吸感（缩放 + 光晕脉动）
//  - 鼠标进入精灵附近时"苏醒"：身体轻微倾斜、眼睛变大、光晕增强
//  - 被点击时：环形涟漪扩散 + 快速眨眼 + 情绪值升高（脸更亮）
//  - 偶发能量光丝从顶部飘出（与节点粒子同源的色彩）
interface SpiritState {
  blinkAt: number;
  blinkClose: number;
  lastClick: number;
  pulseTarget: number;
  pulse: number;
  mood: number;
}
function drawCoreSphere(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  time: number,
  w: number,
  h: number,
  compact: boolean,
  mouseNorm: { x: number; y: number },
  spirit: SpiritState,
) {
  const r = Math.min(w, h) * (compact ? 0.14 : 0.11);

  // ── 状态更新 ──
  // 眨眼计时
  spirit.blinkAt -= 1 / 60;
  if (spirit.blinkAt <= 0 && spirit.blinkClose < 0.05) {
    spirit.blinkClose = 1;
    spirit.blinkAt = 2 + Math.random() * 3.5;
  }
  spirit.blinkClose *= 0.85;

  // 点击涟漪（500ms 内衰减）
  const sinceClick = time - spirit.lastClick;
  const clickRipple = sinceClick < 0.6 ? 1 - sinceClick / 0.6 : 0;

  // 脉动平滑
  spirit.pulse += (spirit.pulseTarget - spirit.pulse) * 0.08;
  spirit.pulseTarget *= 0.96;
  spirit.mood *= 0.995;

  // 鼠标距离：影响"注意力"
  const mdist = Math.hypot(mouseNorm.x, mouseNorm.y);
  const attention = Math.max(0, 1 - mdist / 1.2);

  // 呼吸
  const breath = 1 + Math.sin(time * 1.3) * 0.05;
  // 苏醒时额外放大一点
  const awakeScale = 1 + attention * 0.08 + spirit.pulse * 0.15 + clickRipple * 0.1;
  const scale = breath * awakeScale;
  const R = r * scale;

  // ── 外层光晕（呼吸 + 注意力增强）──
  const glowBase = r * 3.2 * (1 + Math.sin(time * 1.3) * 0.15);
  const glowR = glowBase * (1 + attention * 0.4 + spirit.pulse * 0.3);
  const glow = ctx.createRadialGradient(cx, cy, R * 0.4, cx, cy, glowR);
  glow.addColorStop(0, `rgba(129,140,248,${0.22 + attention * 0.1 + spirit.mood * 0.15})`);
  glow.addColorStop(0.4, 'rgba(99,102,241,0.08)');
  glow.addColorStop(1, 'transparent');
  ctx.beginPath();
  ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
  ctx.fillStyle = glow;
  ctx.fill();

  // ── 点击涟漪环 ──
  if (clickRipple > 0) {
    const rippleR = R * (1.2 + (1 - clickRipple) * 2.5);
    ctx.beginPath();
    ctx.arc(cx, cy, rippleR, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(165,180,252,${clickRipple * 0.6})`;
    ctx.lineWidth = 2 * clickRipple;
    ctx.stroke();
  }

  // ── 缓慢旋转的能量轨道（原来的经纬线，改成更灵动的弧线）──
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(time * 0.25);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI;
    ctx.save();
    ctx.rotate(a);
    ctx.beginPath();
    ctx.ellipse(0, 0, R * 1.02, R * 0.35, 0, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(199,210,254,${0.18 + attention * 0.15})`;
    ctx.lineWidth = 0.8;
    ctx.setLineDash([3, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
  ctx.restore();

  // ── 主体：渐变球 ──
  const bodyGrad = ctx.createRadialGradient(
    cx - R * 0.3, cy - R * 0.3, R * 0.1,
    cx, cy, R,
  );
  bodyGrad.addColorStop(0, '#c7d2fe');
  bodyGrad.addColorStop(0.45, '#6366f1');
  bodyGrad.addColorStop(1, '#312e81');
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = bodyGrad;
  ctx.fill();

  // 高光（让球体有"果冻"感）
  const hi = ctx.createRadialGradient(
    cx - R * 0.35, cy - R * 0.4, 0,
    cx - R * 0.35, cy - R * 0.4, R * 0.7,
  );
  hi.addColorStop(0, 'rgba(255,255,255,0.55)');
  hi.addColorStop(0.4, 'rgba(255,255,255,0.12)');
  hi.addColorStop(1, 'transparent');
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = hi;
  ctx.fill();

  // ── 脸：眼睛跟随鼠标 ──
  const eyeOffsetX = mouseNorm.x * R * 0.18 * (0.6 + attention * 0.4);
  const eyeOffsetY = mouseNorm.y * R * 0.12 * (0.6 + attention * 0.4);
  const eyeY = cy - R * 0.08;
  const eyeSpacing = R * 0.32;
  const eyeR = R * (0.13 + attention * 0.02 + spirit.mood * 0.02);

  for (const side of [-1, 1]) {
    const ex = cx + side * eyeSpacing + eyeOffsetX;
    const ey = eyeY + eyeOffsetY;
    // 眼白（苏醒时才明显）
    if (attention > 0.2 || spirit.mood > 0.1) {
      ctx.beginPath();
      ctx.arc(ex, ey, eyeR * 1.05, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fill();
    }
    // 瞳孔（眨眼时缩成一条线）
    const openH = eyeR * (1 - spirit.blinkClose * 0.92);
    ctx.beginPath();
    ctx.ellipse(ex, ey, eyeR * 0.7, openH, 0, 0, Math.PI * 2);
    ctx.fillStyle = spirit.blinkClose > 0.5 ? '#1e1b4b' : '#0f172a';
    ctx.fill();
    // 眼睛高光
    if (spirit.blinkClose < 0.3) {
      ctx.beginPath();
      ctx.arc(ex - eyeR * 0.2, ey - eyeR * 0.2, eyeR * 0.22, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fill();
    }
  }

  // ── 嘴：注意力高时一个小微笑 ──
  if (attention > 0.4 || spirit.mood > 0.3) {
    const smileAlpha = Math.min(1, (attention - 0.4) * 2 + spirit.mood);
    ctx.beginPath();
    ctx.arc(cx, cy + R * 0.18, R * 0.18, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.strokeStyle = `rgba(255,255,255,${0.7 * smileAlpha})`;
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  // ── 顶部能量小光丝（偶尔飘起，像精灵的"想法"）──
  const t = time * 0.6;
  for (let i = 0; i < 3; i++) {
    const phase = (t + i * 0.7) % 2;
    if (phase > 1.4) continue; // 只在周期的某一段出现
    const p = (phase - 0.4) / 1.0;
    const px = cx + Math.sin(time * 1.5 + i * 2) * R * 0.25;
    const py = cy - R - p * R * 1.2;
    const alpha = Math.sin(p * Math.PI) * 0.8;
    ctx.beginPath();
    ctx.arc(px, py, 1.8 + p * 1.2, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(199,210,254,${alpha})`;
    ctx.fill();
  }

  // ── 中心柔光（精灵的"心"）──
  const heartR = R * (0.32 + Math.sin(time * 2.5) * 0.04 + spirit.mood * 0.1);
  const heart = ctx.createRadialGradient(cx, cy, 0, cx, cy, heartR);
  heart.addColorStop(0, `rgba(253,224,71,${0.55 + spirit.mood * 0.3})`);
  heart.addColorStop(0.5, 'rgba(251,191,36,0.25)');
  heart.addColorStop(1, 'transparent');
  ctx.beginPath();
  ctx.arc(cx, cy, heartR, 0, Math.PI * 2);
  ctx.fillStyle = heart;
  ctx.fill();
}
