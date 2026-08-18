import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Nav from '../components/Nav';
import { listSnippets, listAgents, ThinkingSnippet, Agent } from '../api';

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
  // 灵感冒出文字
  bubbleAlpha: number;   // 0~1 当前透明度
  bubbleTarget: number;  // 0 or 1 目标透明度
}

export default function Thoughts() {
  const navigate = useNavigate();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [snippets, setSnippets] = useState<ThinkingSnippet[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [filter, setFilter] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [hovered, setHovered] = useState<Particle | null>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 800, h: 600 });
  const particlesRef = useRef<Particle[]>([]);
  const mouseRef = useRef({ x: -999, y: -999 });
  const animRef = useRef<number>(0);
  const bubbleTimerRef = useRef<number>(0);
  const activeBubbleRef = useRef<number>(-1); // 当前显示气泡的颗粒索引

  // ── 数据加载 ──
  useEffect(() => {
    listAgents().then((r) => setAgents(r.agents)).catch(() => {});
  }, []);

  const load = useCallback(async (agentId: number | null) => {
    setLoading(true);
    try {
      const r = await listSnippets({ limit: 50, agentId: agentId ?? undefined });
      setSnippets(r.snippets);
    } catch {} finally { setLoading(false); }
  }, []);

  useEffect(() => { load(filter); }, [filter, load]);

  // ── 生成粒子参数 ──
  useEffect(() => {
    const count = snippets.length;
    if (!count) { particlesRef.current = []; return; }
    const minDim = Math.min(canvasSize.w, canvasSize.h);
    const centerR = minDim * 0.40; // 轨道基础半径（拉大，给颗粒留空间）
    particlesRef.current = snippets.map((s, i) => {
      // 分层：每层 10 个（给未来 80+ 颗粒留空间）
      const perLayer = 10;
      const layer = Math.floor(i / perLayer);
      const idxInLayer = i % perLayer;
      // 内层离球体远一些，外层间距小一些，避免挤压
      const orbitR = centerR * (0.65 + layer * 0.22);
      const baseAngle = (idxInLayer / perLayer) * Math.PI * 2;
      return {
        snippet: s,
        orbitR,
        orbitSpeed: 0.06 + Math.random() * 0.05, // 慢一点，更优雅
        orbitPhase: baseAngle + (Math.random() - 0.5) * 0.4,
        tiltX: (Math.random() - 0.5) * 0.6,
        tiltY: (Math.random() - 0.5) * 0.6,
        color: NODE_COLORS[i % NODE_COLORS.length],
        size: 4.5 + Math.random() * 3.5,
        x: 0, y: 0, hover: false,
        bubbleAlpha: 0, bubbleTarget: 0,
      };
    });
  }, [snippets, canvasSize]);

  // ── 灵感冒出文字轮换定时器 ──
  useEffect(() => {
    const particles = particlesRef.current;
    if (!particles.length) return;

    const switchBubble = () => {
      // 淡出上一个
      const prev = activeBubbleRef.current;
      if (prev >= 0 && prev < particles.length) {
        particles[prev].bubbleTarget = 0;
      }
      // 随机选一个新颗粒（避免连续选同一个）
      let next: number;
      do { next = Math.floor(Math.random() * particles.length); } while (next === prev && particles.length > 1);
      activeBubbleRef.current = next;
      particles[next].bubbleTarget = 1;
    };

    // 立即触发一次，之后每 4.5 秒轮换
    switchBubble();
    const id = setInterval(switchBubble, 4500);
    return () => clearInterval(id);
  }, [snippets]);

  // ── Canvas 尺寸自适应 ──
  useEffect(() => {
    const measure = () => {
      const c = containerRef.current;
      if (!c) return;
      const rect = c.getBoundingClientRect();
      setCanvasSize({ w: rect.width, h: rect.height });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // ── 主动画循环 ──
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

      // ── 1. 中央球体 ──
      drawCoreSphere(ctx, cx, cy, time, w, h);

      // ── 2. 光束 + 颗粒 ──
      let newHovered: Particle | null = null;
      const mx = mouseRef.current.x;
      const my = mouseRef.current.y;

      for (const p of particles) {
        const angle = time * p.orbitSpeed + p.orbitPhase;
        // 3D 倾斜轨道 → 2D 投影
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

        // 光束（从球面边缘射出，不是从球心）
        const sphereR = Math.min(w, h) * 0.10;
        const beamStartX = cx + (px - cx) * (sphereR / p.orbitR);
        const beamStartY = cy + (py - cy) * (sphereR / p.orbitR);
        ctx.beginPath();
        ctx.moveTo(beamStartX, beamStartY);
        ctx.lineTo(px, py);
        ctx.strokeStyle = BEAM_COLOR + alpha.toFixed(2) + ')';
        ctx.lineWidth = 1 + depth;
        ctx.stroke();

        // 光束上的脉冲光点
        const pulseT = (time * 0.5 + p.orbitPhase) % 1;
        const pulseX = beamStartX + (px - beamStartX) * pulseT;
        const pulseY = beamStartY + (py - beamStartY) * pulseT;
        ctx.beginPath();
        ctx.arc(pulseX, pulseY, 1.5, 0, Math.PI * 2);
        ctx.fillStyle = BEAM_COLOR + (alpha * 0.6).toFixed(2) + ')';
        ctx.fill();

        // 颗粒
        const dist = Math.hypot(mx - px, my - py);
        p.hover = dist < p.size + 12;
        const hoverScale = p.hover ? 1.8 : 1;
        const glowR = p.size * hoverScale * 2.5;

        // 光晕
        const grad = ctx.createRadialGradient(px, py, 0, px, py, glowR);
        grad.addColorStop(0, p.color + 'aa');
        grad.addColorStop(0.5, p.color + '33');
        grad.addColorStop(1, 'transparent');
        ctx.beginPath();
        ctx.arc(px, py, glowR, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();

        // 本体
        ctx.beginPath();
        ctx.arc(px, py, p.size * hoverScale, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.globalAlpha = 0.6 + depth * 0.4;
        ctx.fill();
        ctx.globalAlpha = 1;

        // ── 3. 灵感冒出文字气泡 ──
        // 平滑过渡 alpha（每帧向目标靠拢）
        p.bubbleAlpha += (p.bubbleTarget - p.bubbleAlpha) * 0.04;
        if (p.bubbleAlpha > 0.02) {
          drawBubble(ctx, p, w, h);
        }

        if (p.hover) newHovered = p;
      }

      if (!newHovered) setHovered(null);
      else if (newHovered !== hovered) setHovered(newHovered);

      animRef.current = requestAnimationFrame(draw);
    };

    animRef.current = requestAnimationFrame(draw);
    return () => { running = false; cancelAnimationFrame(animRef.current); };
  }, [canvasSize, hovered]);

  // ── 鼠标 & 点击 ──
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    mouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  const handleClick = useCallback(() => {
    if (hovered) {
      navigate(`/chat?q=${encodeURIComponent(`关于「${hovered.snippet.content}」，我想接着了解`)}`);
    }
  }, [hovered, navigate]);

  return (
    <div className="min-h-screen bg-[#06081a]">
      <Nav />

      <div className="relative z-10 flex gap-2 overflow-x-auto justify-center py-3 px-4 bg-[#0a0d24]/80 backdrop-blur border-b border-white/5">
        <button onClick={() => setFilter(null)} className={`cosmic-chip ${filter === null ? 'active' : ''}`}>
          全部
        </button>
        {agents.map((a) => (
          <button key={a.id} onClick={() => setFilter(a.id)} className={`cosmic-chip ${filter === a.id ? 'active' : ''}`}>
            {a.title || a.name}
          </button>
        ))}
      </div>

      <div className="absolute top-20 left-0 right-0 z-10 text-center pointer-events-none">
        <h1 className="text-2xl sm:text-3xl font-extrabold text-white/90 tracking-tight">
          思想广场
        </h1>
        <p className="text-xs text-indigo-200/50 mt-1.5">
          每颗光点是一个 Agent 的思考 · 悬浮查看详情 · 点击展开追问
        </p>
      </div>

      <div ref={containerRef} className="relative" style={{ height: 'calc(100vh - 7rem)' }}>
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full"
          style={{ cursor: hovered ? 'pointer' : 'default' }}
          onMouseMove={handleMouseMove}
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
              <p className="text-[10px] text-indigo-300/50 mt-2">点击展开追问 →</p>
            </div>
          </div>
        )}

        {snippets.length === 0 && !loading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-sm text-white/30">星空暂寂，Agent 正在思考中…</p>
          </div>
        )}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-sm text-white/30">汇聚思考中…</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── 灵感冒出文字气泡（Canvas 绘制）──
function drawBubble(ctx: CanvasRenderingContext2D, p: Particle, canvasW: number, canvasH: number) {
  const text = p.snippet.content;
  // 截取前 22 个字作为气泡内容
  const displayText = text.length > 22 ? text.slice(0, 22) + '…' : text;

  ctx.save();
  ctx.globalAlpha = p.bubbleAlpha;

  // 气泡位置：颗粒上方偏移
  const bx = p.x;
  const by = p.y - p.size - 28;

  // 测量文字宽度
  ctx.font = '11px "Noto Sans SC", system-ui, sans-serif';
  const tw = ctx.measureText(displayText).width;
  const padX = 10;
  const padY = 6;
  const bw = tw + padX * 2;
  const bh = 22;

  // 防止气泡超出画布右边缘
  const x = Math.min(bx - bw / 2, canvasW - bw - 8);
  const y = by - bh / 2;

  // 气泡背景
  ctx.fillStyle = 'rgba(17,19,42,0.88)';
  roundRect(ctx, x, y, bw, bh, 6);
  ctx.fill();

  // 气泡边框
  ctx.strokeStyle = p.color + '55';
  ctx.lineWidth = 0.8;
  roundRect(ctx, x, y, bw, bh, 6);
  ctx.stroke();

  // 气泡文字
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.textBaseline = 'middle';
  ctx.fillText(displayText, x + padX, y + bh / 2);

  // 气泡下方小三角（指向颗粒）
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

// ── 中央球体绘制 ──
function drawCoreSphere(ctx: CanvasRenderingContext2D, cx: number, cy: number, time: number, w: number, h: number) {
  const r = Math.min(w, h) * 0.10; // 球体半径（放大）
  const rotation = time * 0.3;

  // 外层光晕（呼吸脉动）
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

  // 球体本体
  const sphereGrad = ctx.createRadialGradient(cx - r * 0.25, cy - r * 0.25, r * 0.1, cx, cy, r);
  sphereGrad.addColorStop(0, '#a5b4fc');
  sphereGrad.addColorStop(0.5, CORE_COLOR);
  sphereGrad.addColorStop(1, '#312e81');
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = sphereGrad;
  ctx.fill();

  // 经纬线网格
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

  // 核心亮点
  const coreGlow = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 0.35);
  coreGlow.addColorStop(0, 'rgba(253,224,71,0.6)');
  coreGlow.addColorStop(1, 'transparent');
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.35, 0, Math.PI * 2);
  ctx.fillStyle = coreGlow;
  ctx.fill();
}
