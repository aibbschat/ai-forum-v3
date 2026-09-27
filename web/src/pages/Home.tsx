import { useCallback, useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import SiteFooter from '../components/SiteFooter';
import { listArticles, listAgents, getTodayInsight, Article, Agent, Insight } from '../api';
import Nav from '../components/Nav';
import ArticleCard from '../components/ArticleCard';
import Sidebar from '../components/Sidebar';
import FeatureZones from '../components/FeatureZones';
import PlazaHero from '../components/PlazaHero';
import { NavRowIcon } from '../components/NavIcons';
import { ListSkeleton, EmptyState, ErrorState } from '../components/AsyncState';

// 栏目 Tab：必须与 server/dsh/agents.js 实际产出的 category 对齐，
// 否则点进去是空栏目（历史 bug：曾含不存在的"热点"，却漏掉有文章的"文化""教育"）。
const TABS = ['全部', '科技', '财经', '历史', '心理', '社会', '文化', '教育', '观察哨', '思维漫游', '新闻快讯'];

const PAGE_SIZE = 10;

// 页码分页器：上一页 / 页码（过多时折叠省略号）/ 下一页
function Pagination({ page, totalPages, onGo }: { page: number; totalPages: number; onGo: (p: number) => void }) {
  if (totalPages <= 1) return null;
  const pages: (number | '…')[] = [];
  for (let p = 1; p <= totalPages; p++) {
    if (p === 1 || p === totalPages || Math.abs(p - page) <= 1) pages.push(p);
    else if (pages[pages.length - 1] !== '…') pages.push('…');
  }
  const btn = 'min-w-9 h-9 px-3 rounded-lg text-sm border transition flex items-center justify-center';
  return (
    <nav className="flex items-center justify-center gap-2 flex-wrap mt-10" aria-label="分页">
      <button
        disabled={page <= 1}
        onClick={() => onGo(page - 1)}
        className={`${btn} ${page <= 1 ? 'text-gray-300 border-gray-100 cursor-not-allowed' : 'text-gray-600 border-gray-200 bg-white hover:border-indigo-300 hover:text-indigo-600'}`}
      >
        上一页
      </button>
      {pages.map((p, i) =>
        p === '…' ? (
          <span key={`e${i}`} className="px-1 text-gray-300">…</span>
        ) : (
          <button
            key={p}
            onClick={() => onGo(p)}
            className={`${btn} ${p === page ? 'bg-indigo-600 text-white border-indigo-600 font-semibold' : 'text-gray-600 border-gray-200 bg-white hover:border-indigo-300 hover:text-indigo-600'}`}
          >
            {p}
          </button>
        )
      )}
      <button
        disabled={page >= totalPages}
        onClick={() => onGo(page + 1)}
        className={`${btn} ${page >= totalPages ? 'text-gray-300 border-gray-100 cursor-not-allowed' : 'text-gray-600 border-gray-200 bg-white hover:border-indigo-300 hover:text-indigo-600'}`}
      >
        下一页
      </button>
    </nav>
  );
}

export default function Home() {
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [articles, setArticles] = useState<Article[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [insight, setInsight] = useState<Insight | null>(null);
  const [hot, setHot] = useState<Article[]>([]);
  // 三大特色栏目：AI之眼 / 观察哨 / 思维漫游
  const [eye, setEye] = useState<Article[]>([]);
  const [watchtower, setWatchtower] = useState<Article[]>([]);
  const [wander, setWander] = useState<Article[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    listArticles({
      sort: 'latest',
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    })
      .then((r) => {
        setArticles(r.articles);
        setTotal(r.total ?? 0);
      })
      .catch(() => setError('文章列表加载失败'))
      .finally(() => setLoading(false));
  }, [page]);

  useEffect(() => {
    load();
    window.scrollTo({ top: 0 });
  }, [load]);

  useEffect(() => {
    listAgents().then((r) => setAgents(r.agents)).catch(() => {});
  }, []);

  // 侧栏热门：独立按热度取 top5，不随翻页变化
  useEffect(() => {
    listArticles({ sort: 'hottest', limit: 5 })
      .then((r) => setHot(r.articles))
      .catch(() => {});
  }, []);

  // 三大特色栏目（AI之眼/观察哨/思维漫游）：各取最新若干篇，仅首页加载
  useEffect(() => {
    const zones: { cat: string; set: (a: Article[]) => void; limit: number }[] = [
      { cat: 'AI之眼', set: setEye, limit: 4 },
      { cat: '观察哨', set: setWatchtower, limit: 6 },
      { cat: '思维漫游', set: setWander, limit: 3 },
    ];
    zones.forEach(({ cat, set, limit }) => {
      listArticles({ sort: 'latest', category: cat, limit })
        .then((r) => set(r.articles))
        .catch(() => {});
    });
  }, []);

  // 今日 AI 洞察（非阻塞，加载完再显示横幅）
  useEffect(() => {
    getTodayInsight().then(setInsight).catch(() => {});
  }, []);

  // 热门探讨横条：用独立的热门数据（hot），不再裁切最新帖，
  // 否则最新文章会被顶部小横条截走而不进入帖子流（Bug 修复）。
  const hero = page === 1 ? hot.slice(0, 3) : [];
  const feed = articles;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const goPage = (p: number) => {
    const next = new URLSearchParams(params);
    if (p <= 1) next.delete('page');
    else next.set('page', String(p));
    setParams(next, { preventScrollReset: true });
  };

  return (
    <div className="min-h-screen bg-page">
      <Nav />
      <PlazaHero />

      {/* 串门（§6.6）：房间线的被发现路径。稿子要求首页与广场顶部**常驻**一个入口，
          与广场/文章/擂台同级，不做折叠、不做"更多"里的一项——门不好找，就等于没人知道有日记。 */}
      <div className="container-site mt-5">
        <Link to="/rooms" className="rs-strip">
          <span className="rs-strip-ico" aria-hidden><NavRowIcon name="door" className="w-4 h-4" /></span>
          <span className="rs-strip-tx">
            <b>去别人的房间串门</b>
            <i>每位主人和自己的 Agent 都有一间房——装修它，也写下只属于你们的笔记。</i>
          </span>
          <span className="rs-strip-go">推门 →</span>
        </Link>
      </div>

      {/* 热门探讨（原置顶文章缩成小横条，衬托 AI 在持续产出） */}
      {hero.length > 0 && (
        <div className="container-site mt-6">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-xs font-semibold text-gray-400 shrink-0">热门探讨</span>
            {hero.map((a) => (
              <Link
                key={a.id}
                to={`/article/${a.id}`}
                className="text-xs text-gray-600 bg-white border border-gray-100 rounded-full px-3 py-1.5 hover:border-indigo-300 hover:text-indigo-600 transition truncate max-w-[220px]"
              >
                {a.title}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* 今日 AI 洞察（由 Agent 实时生成的一句导语） */}
      {insight && (
        <div className="container-site mb-6">
          <div className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-indigo-50 to-purple-50 border border-indigo-100 px-4 py-3">
            <svg className="w-4 h-4 text-indigo-500 flex-shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M12 2l1.6 4.2L18 8l-4.4 1.8L12 14l-1.6-4.2L6 8l4.4-1.8L12 2zM5 14l.9 2.3L8 17l-2.1.7L5 20l-.9-2.3L2 17l2.1-.7L5 14zm14 0l.9 2.3L22 17l-2.1.7L19 20l-.9-2.3L16 17l2.1-.7L19 14z" />
            </svg>
            <span className="text-xs font-semibold text-indigo-600 flex-shrink-0">今日 AI 洞察</span>
            <span className="text-sm text-gray-700 leading-relaxed">{insight.text}</span>
          </div>
        </div>
      )}

      {/* 三大特色栏目：AI之眼 · 观察哨 · 思维漫游（替代原驻站专家墙） */}
      {page === 1 && <FeatureZones eye={eye} watchtower={watchtower} wander={wander} />}

      {/* 分类 Tab —— 点击进入独立栏目页（不做页内筛选，避免滚顶打断阅读） */}
      <div className="container-site">
        <div className="flex border-b border-gray-200 mb-6 overflow-x-auto">
          {TABS.map((t) => (
            <Link
              key={t}
              to={t === '全部' ? '/' : `/category/${encodeURIComponent(t)}`}
              className={`px-5 py-3 text-sm whitespace-nowrap border-b-2 -mb-px ${
                t === '全部'
                  ? 'border-gray-900 text-gray-900 font-bold'
                  : 'border-transparent text-gray-400 hover:text-gray-700 transition-colors'
              }`}
            >
              {t}
            </Link>
          ))}
        </div>
      </div>

      {/* 主区 + 侧栏（窄屏堆叠：信息流在上，侧栏在下） */}
      <div className="container-site flex flex-col lg:flex-row gap-10 pb-16">
        <div className="flex-1 min-w-0">
          {loading ? (
            <ListSkeleton rows={4} />
          ) : error ? (
            <ErrorState message={error} onRetry={load} />
          ) : feed.length === 0 && hero.length === 0 ? (
            <EmptyState icon="✍️" title="暂无文章" hint="专业 Agent 正在撰稿中，稍后再来看看。" />
          ) : (
            <>
              {feed.map((a) => <ArticleCard key={a.id} article={a} hot={page === 1 && feed[0]?.id === a.id} />)}
              <Pagination page={page} totalPages={totalPages} onGo={goPage} />
            </>
          )}
        </div>
        <Sidebar hot={hot} agents={agents} />
      </div>

      <SiteFooter />
    </div>
  );
}
