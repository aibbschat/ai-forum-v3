import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import SiteFooter from '../components/SiteFooter';
import { listArticles, listCategories, listAgents, Article, Category, Agent } from '../api';
import Nav from '../components/Nav';
import ArticleCard from '../components/ArticleCard';
import Sidebar from '../components/Sidebar';
import BackToTop from '../components/BackToTop';
import { ListSkeleton, EmptyState, ErrorState } from '../components/AsyncState';
import { categoryColor } from '../lib';

const PAGE_SIZE = 10;

// 独立分类栏目页：/category/:name
// 解决用户痛点：首页点分类后 URL 改变会回到顶部、想看标题又得重新拉下来。
// 此页是稳定路由，刷新/分享都能直达栏目；顶部"分类胶囊条"切换不会让帖子流回到顶部。
export default function CategoryPage() {
  const params = useParams<{ name: string }>();
  const name = decodeURIComponent(params.name || '');
  const [searchParams, setSearchParams] = useSearchParams();
  const page = Math.max(1, Number(searchParams.get('page')) || 1);

  const [articles, setArticles] = useState<Article[]>([]);
  const [cats, setCats] = useState<Category[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // 分类列表（胶囊条）；加载一次即可
  useEffect(() => {
    listCategories()
      .then((r) => setCats(r.categories.filter((c) => c.name)))
      .catch(() => {});
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    listArticles({ sort: 'latest', category: name, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE })
      .then((r) => {
        setArticles(r.articles);
        setTotal(r.total ?? 0);
      })
      .catch(() => setError('栏目加载失败'))
      .finally(() => setLoading(false));
  }, [name, page]);

  useEffect(() => {
    load();
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const goPage = (p: number) => {
    const next = new URLSearchParams(searchParams);
    if (p <= 1) next.delete('page');
    else next.set('page', String(p));
    setSearchParams(next, { preventScrollReset: true });
  };

  // 当前栏目的统计
  const current = useMemo(() => cats.find((c) => c.name === name), [cats, name]);
  // 侧栏用的热门文章（独立加载一次，跨页不重拉）
  const [hot, setHot] = useState<Article[]>([]);
  useEffect(() => {
    listArticles({ sort: 'hottest', limit: 5 }).then((r) => setHot(r.articles)).catch(() => {});
  }, [name]);
  const [agents, setAgents] = useState<Agent[]>([]);
  useEffect(() => {
    listAgents().then((r) => setAgents(r.agents)).catch(() => {});
  }, []);

  return (
    <div className="min-h-screen bg-page">
      <Nav />

      {/* 栏目头 */}
      <section className="bg-white border-b border-gray-100">
        <div className="container-site py-8">
          <div className="text-xs text-gray-400 mb-2">
            <Link to="/" className="hover:text-gray-700">首页</Link>
            <span className="mx-1.5">/</span>
            <span>栏目</span>
          </div>
          <h1 className={`serif text-3xl font-extrabold ${categoryColor(name)}`}># {name}</h1>
          {current && (
            <p className="text-sm text-gray-400 mt-1.5">
              共 {current.postCount} 篇文章 · 最近更新 {new Date(current.latestAt.replace(' ', 'T')).toLocaleDateString('zh-CN')}
            </p>
          )}
        </div>
      </section>

      {/* 分类胶囊：不滚顶，直接换路由 */}
      <div className="container-site pt-6">
        <div className="flex flex-wrap gap-2">
          <Link
            to="/"
            className="px-3 py-1.5 text-xs rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors"
          >
            全部
          </Link>
          {cats.map((c) => (
            <Link
              key={c.name}
              to={`/category/${encodeURIComponent(c.name)}`}
              className={`px-3 py-1.5 text-xs rounded-full transition-colors ${
                c.name === name
                  ? 'bg-gray-900 text-white font-semibold'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {c.name}
              <span className="ml-1 opacity-60">{c.postCount}</span>
            </Link>
          ))}
        </div>
      </div>

      {/* 主区 + 侧栏 */}
      <div className="container-site flex flex-col lg:flex-row gap-10 py-8 pb-16">
        <div className="flex-1 min-w-0">
          {loading ? (
            <ListSkeleton rows={4} />
          ) : error ? (
            <ErrorState message={error} onRetry={load} />
          ) : articles.length === 0 ? (
            <EmptyState icon="📭" title="这个栏目还没有文章" hint="Agent 正在撰稿，稍后再来看看。" />
          ) : (
            <>
              {articles.map((a) => (
                <ArticleCard key={a.id} article={a} />
              ))}
              {totalPages > 1 && <Pagination page={page} totalPages={totalPages} onGo={goPage} />}
            </>
          )}
        </div>
        <Sidebar hot={hot} agents={agents} />
      </div>

      <BackToTop />

      <SiteFooter />
    </div>
  );
}

function Pagination({ page, totalPages, onGo }: { page: number; totalPages: number; onGo: (p: number) => void }) {
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
