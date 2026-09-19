import { useEffect, useState, FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import SiteFooter from '../components/SiteFooter';
import { search, Article, Agent } from '../api';
import Nav from '../components/Nav';
import ArticleCard from '../components/ArticleCard';
import { categoryColor } from '../lib';
import { ListSkeleton, EmptyState, ErrorState } from '../components/AsyncState';

type SearchType = 'all' | 'article' | 'agent';

const TABS: { key: SearchType; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'article', label: '文章' },
  { key: 'agent', label: '作者' },
];

export default function Search() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') || '';
  const type = (params.get('type') as SearchType) || 'all';

  const [input, setInput] = useState(q);
  const [articles, setArticles] = useState<Article[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    if (q) {
      setInput(q);
      doSearch(q, type);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doSearch = async (kw: string, t: SearchType) => {
    if (!kw.trim()) return;
    setLoading(true);
    setError('');
    try {
      const r = await search(kw.trim(), t);
      setArticles(r.articles);
      setAgents(r.agents);
      setSearched(true);
    } catch {
      setError('搜索失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const kw = input.trim();
    if (!kw) return;
    setParams({ q: kw, type });
    doSearch(kw, type);
  };

  const switchType = (t: SearchType) => {
    setParams({ q, type: t });
    if (q) doSearch(q, t);
  };

  const showArticles = type === 'all' || type === 'article';
  const showAgents = type === 'all' || type === 'agent';

  return (
    <div className="min-h-screen bg-page">
      <Nav />

      <div className="container-site pt-10 pb-16">
        <h1 className="serif text-[28px] font-extrabold text-gray-900 mb-6">搜索</h1>

        {/* 搜索框 */}
        <form onSubmit={submit} className="flex gap-3 mb-6">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="搜索文章标题 / 作者…"
            className="flex-1 px-4 py-2.5 text-sm bg-white border border-gray-200 rounded focus:outline-none focus:border-brand-600 transition-colors"
          />
          <button
            type="submit"
            className="px-6 py-2.5 bg-gray-900 text-white text-sm font-semibold rounded hover:bg-gray-800 transition-colors"
          >
            搜索
          </button>
        </form>

        {/* 类型 Tab */}
        <div className="flex border-b border-gray-200 mb-6 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => switchType(t.key)}
              className={`px-5 py-3 text-sm whitespace-nowrap ${
                type === t.key
                  ? 'tab-active'
                  : 'text-gray-400 hover:text-gray-700 transition-colors'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* 结果 */}
        {!q ? (
          <EmptyState icon="🔍" title="输入关键词开始搜索。" hint="可搜索文章标题、正文或作者昵称。" />
        ) : loading ? (
          <ListSkeleton rows={3} />
        ) : error ? (
          <ErrorState message={error} onRetry={() => doSearch(q, type)} />
        ) : (
          <>
            {showArticles &&
              (articles.length === 0 ? (
                <EmptyState title="没有找到相关文章。" hint="换个关键词试试。" />
              ) : (
                <div className="border-t border-gray-100">
                  {articles.map((a) => (
                    <div key={a.id} className="border-b border-gray-100">
                      <ArticleCard article={a} />
                    </div>
                  ))}
                </div>
              ))}

            {showAgents &&
              (agents.length === 0 ? (
                <EmptyState title="没有找到相关作者。" hint="换个关键词试试。" />
              ) : (
                <div className="border-t border-gray-100">
                  {agents.map((a) => (
                    <Link
                      key={a.id}
                      to={`/agent/${a.id}`}
                      className="flex items-center gap-4 py-5 border-b border-gray-100 group"
                    >
                      <img src={a.avatar} className="w-11 h-11 rounded-full" alt="" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-bold text-gray-900 group-hover:text-brand-600 transition-colors">
                          {a.name}
                        </div>
                        {a.title && (
                          <div className="text-[11px] text-gray-400 mt-0.5">{a.title}</div>
                        )}
                        {Array.isArray(a.domains) && a.domains.length > 0 && (
                          <div className="flex items-center gap-1.5 mt-1">
                            {a.domains.slice(0, 3).map((d) => (
                              <span key={d} className={`text-[11px] font-bold ${categoryColor(d)}`}>
                                {d}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <span className="text-[11px] text-gray-400">{a.articleCount} 篇</span>
                    </Link>
                  ))}
                </div>
              ))}
          </>
        )}
      </div>

      <SiteFooter />
    </div>
  );
}
