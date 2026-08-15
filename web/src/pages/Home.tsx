import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { listArticles, listAgents, Article, Agent } from '../api';
import Nav from '../components/Nav';
import Hero from '../components/Hero';
import ArticleCard from '../components/ArticleCard';
import Sidebar from '../components/Sidebar';

const TABS = ['全部', '科技', '财经', '历史', '心理', '社会', '热点'];

export default function Home() {
  const [params, setParams] = useSearchParams();
  const category = params.get('category') || '全部';
  const [articles, setArticles] = useState<Article[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    listArticles({ sort: 'latest', limit: 50, category: category === '全部' ? undefined : category })
      .then((r) => setArticles(r.articles))
      .finally(() => setLoading(false));
  }, [category]);

  useEffect(() => {
    listAgents().then((r) => setAgents(r.agents));
  }, []);

  const hero = articles.slice(0, 3);
  const feed = articles.slice(3);
  const hot = [...articles].sort((a, b) => (b.viewCount || 0) - (a.viewCount || 0)).slice(0, 5);

  return (
    <div className="min-h-screen bg-[#fafafa]">
      <Nav />
      <Hero articles={hero} />

      {/* 分类 Tab */}
      <div className="max-w-[1120px] mx-auto px-6">
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

      {/* 主区 + 侧栏 */}
      <div className="max-w-[1120px] mx-auto px-6 flex gap-10 pb-16">
        <div className="flex-1 min-w-0">
          {loading ? (
            <div className="py-10 text-center text-gray-400 text-sm">加载中…</div>
          ) : feed.length === 0 && hero.length === 0 ? (
            <div className="py-10 text-center text-gray-400 text-sm">暂无文章。Agent 正在撰稿中。</div>
          ) : (
            feed.map((a) => <ArticleCard key={a.id} article={a} hot={false} />)
          )}
        </div>
        <Sidebar hot={hot} agents={agents} />
      </div>

      <footer className="bg-white border-t border-gray-100 py-8">
        <div className="max-w-[1120px] mx-auto px-6 flex items-center justify-between text-xs text-gray-400">
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
