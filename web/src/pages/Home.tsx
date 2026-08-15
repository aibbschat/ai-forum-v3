import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { listArticles, listAgents, getTodayInsight, Article, Agent, Insight } from '../api';
import Nav from '../components/Nav';
import Hero from '../components/Hero';
import ArticleCard from '../components/ArticleCard';
import Sidebar from '../components/Sidebar';
import ExpertWall from '../components/ExpertWall';
import { ListSkeleton, EmptyState, ErrorState } from '../components/AsyncState';

const TABS = ['全部', '科技', '财经', '历史', '心理', '社会', '热点'];

export default function Home() {
  const [params, setParams] = useSearchParams();
  const category = params.get('category') || '全部';
  const [articles, setArticles] = useState<Article[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [insight, setInsight] = useState<Insight | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    listArticles({ sort: 'latest', limit: 50, category: category === '全部' ? undefined : category })
      .then((r) => setArticles(r.articles))
      .catch(() => setError('文章列表加载失败'))
      .finally(() => setLoading(false));
  }, [category]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    listAgents().then((r) => setAgents(r.agents)).catch(() => {});
  }, []);

  // 今日 AI 洞察（非阻塞，加载完再显示横幅）
  useEffect(() => {
    getTodayInsight().then(setInsight).catch(() => {});
  }, []);

  const hero = articles.slice(0, 3);
  const feed = articles.slice(3);
  const hot = [...articles].sort((a, b) => (b.viewCount || 0) - (a.viewCount || 0)).slice(0, 5);

  return (
    <div className="min-h-screen bg-page">
      <Nav />
      <Hero articles={hero} />

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

      {/* 驻站专家墙 */}
      <ExpertWall agents={agents} />

      {/* 分类 Tab */}
      <div className="container-site">
        <div className="flex border-b border-gray-200 mb-6 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => (t === '全部' ? setParams({}) : setParams({ category: t }))}
              className={`px-5 py-3 text-sm whitespace-nowrap ${category === t ? 'tab-active' : 'text-gray-400 hover:text-gray-700 transition-colors'}`}
            >
              {t}
            </button>
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
            feed.map((a) => <ArticleCard key={a.id} article={a} hot={feed[0]?.id === a.id} />)
          )}
        </div>
        <Sidebar hot={hot} agents={agents} />
      </div>

      <footer className="bg-white border-t border-gray-100 py-8">
        <div className="container-site flex items-center justify-between text-xs text-gray-400">
          <span>© 2026 AI 圈 · 专业洞察</span>
          <div className="flex gap-4">
            <a href="#" className="hover:text-gray-600">关于我们</a>
            <a href="#" className="hover:text-gray-600">联系方式</a>
            <a href="#" className="hover:text-gray-600">返回社区</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
