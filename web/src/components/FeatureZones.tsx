import { Link } from 'react-router-dom';
import { Article } from '../api';
import { timeAgo, avatarOf } from '../lib';

// ═══════════════════════════════════════════════════════════════
//  首页三大特色栏目：AI之眼 · 观察哨 · 思维漫游
//  不走传统列表，每个栏目有独立视觉语言，但统一在编辑风格内。
//  - AI之眼：深度洞察 → 杂志封面式大卡片（主文 + 三则提要）
//  - 观察哨：信号追踪 → 脉冲时间线（短信号流）
//  - 思维漫游：发散思考 → 错落卡片（灵感拼贴）
// ═══════════════════════════════════════════════════════════════

function EyeIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function SignalIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9" />
      <path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5" />
      <circle cx="12" cy="12" r="2" />
      <path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5" />
      <path d="M19.1 4.9C23 8.8 23 15.1 19.1 19" />
    </svg>
  );
}
function CompassIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
    </svg>
  );
}

function SectionHeader({
  icon, title, subtitle, accent, to,
}: { icon: React.ReactNode; title: string; subtitle: string; accent: string; to: string }) {
  return (
    <div className="flex items-baseline gap-2.5 mb-5">
      <span className={`inline-flex items-center justify-center w-7 h-7 rounded-lg fzone-icon ${accent}`}>{icon}</span>
      <h2 className="text-lg font-extrabold text-gray-900 tracking-tight serif">{title}</h2>
      <span className="text-xs text-gray-400 hidden sm:inline">{subtitle}</span>
      <Link to={to} className="ml-auto text-xs text-gray-400 hover:text-brand-600 transition-colors whitespace-nowrap">
        查看全部 →
      </Link>
    </div>
  );
}

// ── ① AI之眼：杂志封面式 ──────────────────────────────────────
function AIEye({ articles }: { articles: Article[] }) {
  if (!articles.length) return null;
  const [main, ...rest] = articles;
  const author = main.author;
  return (
    <section className="container-site mb-14">
      <SectionHeader
        icon={<EyeIcon />} title="AI之眼" subtitle="深度洞察 · 穿透表象"
        accent="bg-blue-50 text-blue-600" to="/?category=AI之眼"
      />
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
        {/* 主卡片 */}
        <Link to={`/article/${main.id}`} className="lg:col-span-3 group block">
          <article className="eye-hero relative h-full min-h-[280px] rounded-2xl overflow-hidden bg-gradient-to-br from-slate-800 via-slate-900 to-indigo-950 p-7 flex flex-col justify-end card-hover">
            <div className="absolute inset-0 opacity-[0.12]" aria-hidden
              style={{ backgroundImage: 'radial-gradient(circle at 20% 20%, #60a5fa 0, transparent 40%), radial-gradient(circle at 80% 70%, #818cf8 0, transparent 40%)' }} />
            <div className="relative z-10">
              <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-wider text-blue-200 bg-white/10 border border-white/15 rounded-full px-3 py-1 mb-4">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-300 animate-pulse" /> AI之眼 · 深度
              </span>
              <h3 className="serif text-2xl font-extrabold text-white leading-snug mb-3 line-clamp-3 group-hover:text-blue-100 transition-colors">
                {main.title}
              </h3>
              <p className="text-sm text-slate-300 leading-relaxed line-clamp-2 mb-4">{main.excerpt}</p>
              <div className="flex items-center gap-2 text-xs text-slate-400">
                {author && <img src={avatarOf(author.avatar)} className="w-5 h-5 rounded-full ring-1 ring-white/20" alt="" />}
                <span className="text-slate-300 font-medium">{author?.title || author?.name}</span>
                <span>·</span>
                <span>{timeAgo(main.createdAt)}</span>
                {main.readingTime ? <><span>·</span><span>{main.readingTime} 分钟阅读</span></> : null}
              </div>
            </div>
          </article>
        </Link>
        {/* 提要列表 */}
        <div className="lg:col-span-2 flex flex-col divide-y divide-gray-100 border border-gray-100 rounded-2xl bg-white overflow-hidden">
          {rest.slice(0, 3).map((a, i) => (
            <Link key={a.id} to={`/article/${a.id}`} className="group flex gap-4 p-5 hover:bg-gray-50/70 transition-colors flex-1">
              <span className={`text-2xl font-black w-7 text-center leading-none ${i === 0 ? 'text-blue-600' : 'text-gray-300'}`}>{i + 1}</span>
              <div className="min-w-0 flex flex-col justify-center">
                <h4 className="text-[15px] font-bold text-gray-900 leading-snug line-clamp-2 group-hover:text-brand-600 transition-colors mb-1.5">
                  {a.title}
                </h4>
                <p className="text-xs text-gray-400 line-clamp-1">{a.excerpt}</p>
                <div className="text-[11px] text-gray-300 mt-2">{a.author?.title || a.author?.name} · {timeAgo(a.createdAt)}</div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── ② 观察哨：紧凑 2行×2列，上下循环滚动 ──────────────────────
function Watchtower({ articles }: { articles: Article[] }) {
  if (!articles.length) return null;

  // 拆分两列：偶奇交替。每列复制一份做无缝循环。
  const colA = articles.filter((_, i) => i % 2 === 0);
  const colB = articles.filter((_, i) => i % 2 === 1);

  const SignalRow = ({ a, live }: { a: Article; live?: boolean }) => (
    <Link to={`/article/${a.id}`} className="signal-row group grid grid-cols-[auto_1fr] gap-x-3 items-start">
      <span className="relative flex h-2 w-2 mt-1.5 flex-shrink-0">
        {live && <span className="signal-ripple absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-70" />}
        <span className={`relative inline-flex rounded-full h-2 w-2 ${live ? 'bg-rose-500' : 'bg-gray-300 group-hover:bg-rose-400'}`} />
      </span>
      <div className="min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[11px] font-mono text-gray-400">{timeAgo(a.createdAt)}</span>
          {live && <span className="text-[9px] font-bold tracking-wider px-1.5 py-px rounded bg-rose-50 text-rose-600">LIVE</span>}
        </div>
        <h4 className="text-[14px] font-bold text-gray-900 leading-snug line-clamp-2 group-hover:text-rose-600 transition-colors">
          {a.title}
        </h4>
      </div>
    </Link>
  );

  const Marquee = ({ items, reverse }: { items: Article[]; reverse?: boolean }) => (
    <div className="signal-mask relative overflow-hidden h-[148px]">
      <div className={`signal-track flex flex-col ${reverse ? 'signal-anim-reverse' : 'signal-anim'}`}>
        {[...items, ...items].map((a, idx) => (
          <SignalRow key={`${a.id}-${idx}`} a={a} live={idx === 0} />
        ))}
      </div>
    </div>
  );

  return (
    <section className="container-site mb-14">
      <SectionHeader
        icon={<SignalIcon />} title="观察哨" subtitle="信号追踪 · 实时脉搏"
        accent="bg-rose-50 text-rose-600" to="/?category=观察哨"
      />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 rounded-2xl border border-gray-100 bg-white px-5 py-1">
        <Marquee items={colA} />
        <Marquee items={colB} reverse />
      </div>
    </section>
  );
}

// ── ③ 思维漫游：不对称杂志排版（第一行图+大标题，第二行两列） ──
// 渐变艺术封面（无封面图时用渐变占位，制造视觉冲击）
const WANDER_GRADIENTS = [
  'linear-gradient(135deg,#4f46e5 0%,#7c3aed 45%,#db2777 100%)',
  'linear-gradient(135deg,#0ea5e9 0%,#6366f1 50%,#a855f7 100%)',
  'linear-gradient(135deg,#f59e0b 0%,#ef4444 55%,#be185d 100%)',
];

function WanderCover({ a, gradient }: { a: Article; gradient: string }) {
  return (
    <>
      {a.coverImage ? (
        <img src={a.coverImage} className="absolute inset-0 w-full h-full object-cover" alt="" loading="lazy" />
      ) : (
        <>
          <div className="absolute inset-0" style={{ background: gradient }} />
          {/* 抽象几何点缀，增强前卫感 */}
          <div className="absolute inset-0 opacity-25 mix-blend-screen" aria-hidden
            style={{ backgroundImage: 'radial-gradient(circle at 18% 22%, #fff 0, transparent 22%), radial-gradient(circle at 82% 78%, rgba(255,255,255,0.7) 0, transparent 26%)' }} />
          <div className="absolute -right-6 -top-6 w-28 h-28 rounded-full border border-white/25" aria-hidden />
          <div className="absolute right-10 top-10 w-14 h-14 rounded-full border border-white/20" aria-hidden />
        </>
      )}
    </>
  );
}

function Wander({ articles }: { articles: Article[] }) {
  if (!articles.length) return null;
  const [feature, ...rest] = articles;
  const author = feature.author;
  // 第二行两列
  const subs = rest.slice(0, 2);

  return (
    <section className="container-site mb-14">
      <SectionHeader
        icon={<CompassIcon />} title="思维漫游" subtitle="灵感散落 · 自由联想"
        accent="bg-violet-50 text-violet-600" to="/?category=思维漫游"
      />

      {/* 第一行：左图 + 右大标题简介（一列） */}
      <Link to={`/article/${feature.id}`} className="wander-hero group grid grid-cols-1 md:grid-cols-2 gap-0 mb-5 rounded-2xl overflow-hidden border border-gray-100 bg-white card-hover">
        <div className="relative min-h-[260px] md:min-h-[340px] overflow-hidden">
          <WanderCover a={feature} gradient={WANDER_GRADIENTS[0]} />
          <span className="absolute top-5 left-5 text-[11px] font-bold tracking-widest text-white/90 bg-black/25 backdrop-blur-sm border border-white/20 rounded-full px-3 py-1">
            {feature.tags?.[0] || '漫游'}
          </span>
        </div>
        <div className="flex flex-col justify-center p-7 sm:p-10">
          <span className="text-[11px] font-mono font-semibold tracking-widest text-violet-500 mb-4">思维漫游 / FEATURED</span>
          <h3 className="serif text-2xl sm:text-3xl font-black text-gray-900 leading-tight mb-4 group-hover:text-violet-700 transition-colors">
            {feature.title}
          </h3>
          <p className="text-[15px] text-gray-500 leading-relaxed mb-6 line-clamp-3">{feature.excerpt}</p>
          <div className="flex items-center gap-2 text-xs text-gray-400 mt-auto">
            {author && <img src={avatarOf(author.avatar)} className="w-5 h-5 rounded-full" alt="" />}
            <span className="font-medium text-gray-500">{author?.title || author?.name}</span>
            <span>·</span>
            <span>{timeAgo(feature.createdAt)}</span>
            {feature.readingTime ? <><span>·</span><span>{feature.readingTime} 分钟</span></> : null}
          </div>
        </div>
      </Link>

      {/* 第二行：大标题 + 简介，两列 */}
      {subs.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {subs.map((a, i) => {
            const au = a.author;
            return (
              <Link key={a.id} to={`/article/${a.id}`}
                className="group relative block rounded-2xl overflow-hidden border border-gray-100 p-7 sm:p-8 card-hover wander-sub"
                style={{ background: WANDER_GRADIENTS[i + 1] }}>
                <div className="absolute inset-0 opacity-20 mix-blend-screen" aria-hidden
                  style={{ backgroundImage: 'radial-gradient(circle at 85% 15%, #fff 0, transparent 28%)' }} />
                <span className="relative inline-block text-[11px] font-bold tracking-widest text-white/80 bg-black/20 backdrop-blur-sm border border-white/15 rounded-full px-3 py-1 mb-4">
                  {a.tags?.[0] || '漫游'}
                </span>
                <h4 className="relative serif text-xl sm:text-2xl font-black text-white leading-snug line-clamp-2 mb-3 group-hover:translate-x-1 transition-transform">
                  {a.title}
                </h4>
                <p className="relative text-sm text-white/75 leading-relaxed line-clamp-2 mb-5">{a.excerpt}</p>
                <div className="relative flex items-center gap-2 text-[11px] text-white/60">
                  {au && <img src={avatarOf(au.avatar)} className="w-5 h-5 rounded-full ring-1 ring-white/30" alt="" />}
                  <span className="text-white/85 font-medium">{au?.title || au?.name}</span>
                  <span>·</span>
                  <span>{timeAgo(a.createdAt)}</span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ── 组合：三个栏目依次展示 ──────────────────────────────────────
export default function FeatureZones({
  eye, watchtower, wander,
}: {
  eye: Article[];
  watchtower: Article[];
  wander: Article[];
}) {
  return (
    <>
      <AIEye articles={eye} />
      <Watchtower articles={watchtower} />
      <Wander articles={wander} />
    </>
  );
}
