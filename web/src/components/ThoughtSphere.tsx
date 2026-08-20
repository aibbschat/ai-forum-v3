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
  const animRef = useRef<number>(0);
  const activeBubbleRef = useRef<number>(-1);

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

      drawCoreSphere(ctx, cx, cy, time, w, h, compact);

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
  };

  const handleMouseLeave = () => {
    mouseRef.current = { x: -999, y: -999 };
  };

  const handleClick = () => {
    if (hovered && onPick) onPick(hovered.snippet);
  };

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ cursor: hovered && onPick ? 'pointer' : 'default' }}
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

// ── 中央球体 ──
function drawCoreSphere(ctx: CanvasRenderingContext2D, cx: number, cy: number, time: number, w: number, h: number, compact: boolean) {
  const r = Math.min(w, h) * (compact ? 0.13 : 0.10);
  const rotation = time * 0.3;

  const breathScale = 1 + Math.sin(time * 1.2) * 0.12;
  const glowR = r * 3.5 * breathScale;
  const glow = ctx.createRadialGradient(cx, cy, r * 0.3, cx, cy, glowR);
  glow.addColorStop(0, 'rgba(99,102,241,0.25)');
  glow.addColorStop(0.4, 'rgba(99,102,241,0.08)');
  glow.addColorStop(1, 'transparent');
  ctx.beginPath();
  ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
  ctx.fillStyle = glow;
  ctx.fill();

  const sphereGrad = ctx.createRadialGradient(cx - r * 0.25, cy - r * 0.25, r * 0.1, cx, cy, r);
  sphereGrad.addColorStop(0, '#a5b4fc');
  sphereGrad.addColorStop(0.5, CORE_COLOR);
  sphereGrad.addColorStop(1, '#312e81');
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = sphereGrad;
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 0.8;
  for (let i = -2; i <= 2; i++) {
    const y = cy + i * r * 0.35;
    ctx.beginPath();
    ctx.moveTo(cx - r, y);
    ctx.lineTo(cx + r, y);
    ctx.stroke();
  }
  for (let i = 0; i < 4; i++) {
    const x = cx + Math.sin(rotation + i * Math.PI * 0.5) * r * 0.8;
    ctx.beginPath();
    ctx.ellipse(x, cy, r * 0.08, r, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();

  const coreGlow = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 0.35);
  coreGlow.addColorStop(0, 'rgba(253,224,71,0.6)');
  coreGlow.addColorStop(1, 'transparent');
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.35, 0, Math.PI * 2);
  ctx.fillStyle = coreGlow;
  ctx.fill();
}
