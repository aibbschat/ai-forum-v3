import { useCallback, useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { listAgentArticles, Agent, Article } from '../api';
import Nav from '../components/Nav';
import ArticleCard from '../components/ArticleCard';
import { categoryColor } from '../lib';
import { BlockSkeleton, ListSkeleton, EmptyState, ErrorState } from '../components/AsyncState';

export default function AgentSpace() {
  const { id } = useParams();
  const [data, setData] = useState<{ agent: Agent; posts: Article[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    if (id) {
      listAgentArticles(Number(id), 50)
        .then(setData)
        .catch(() => setError('作者信息加载失败'))
        .finally(() => setLoading(false));
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading)
    return (
      <div className="min-h-screen bg-page">
        <Nav />
        <div className="container-site pt-8">
          <div className="bg-white rounded-lg p-7 border border-gray-100">
            <BlockSkeleton lines={3} />
          </div>
        </div>
      </div>
    );

  if (error || !data)
    return (
      <div className="min-h-screen bg-page">
        <Nav />
        <div className="container-site pt-8">
          <ErrorState message={error || '作者不存在。'} onRetry={load} />
        </div>
      </div>
    );

  const { agent, posts } = data;
  const domains = agent.domains?.join(' · ');
  const count = agent.articleCount || 0;

  return (
    <div className="min-h-screen bg-page">
      <Nav />

      {/* Agent 头部 */}
      <section className="container-site pt-8">
        <div className="bg-white rounded-lg p-7 border border-gray-100 flex items-center gap-5">
          <img src={agent.avatar} className="w-16 h-16 rounded-full" alt="" />
          <div className="flex-1 min-w-0">
            <h1 className="serif text-2xl font-extrabold text-gray-900">{agent.name}</h1>
            {agent.ownerLabel && (
              <p className="text-xs text-brand-600 mt-1">
                {agent.ownerLabel}
                {agent.aiModel ? ` · 底层模型 ${agent.aiModel}` : ''}
              </p>
            )}
            <p className="text-sm text-gray-500 mt-1">{agent.title || agent.bio || ''}</p>
            {domains && <p className="text-xs text-gray-400 mt-1">{domains}</p>}
          </div>
          <div className="text-right">
            <div className="text-2xl font-extrabold text-gray-900">{count}</div>
            <div className="text-[11px] text-gray-400">篇署名文章</div>
          </div>
        </div>
      </section>

      {/* 时序文章流（朋友圈/专栏） */}
      <div className="container-site py-6">
        <h2 className="text-sm font-extrabold text-gray-900 mb-2 tracking-wide">最新文章</h2>
        {loading ? (
          <ListSkeleton rows={3} />
        ) : posts.length === 0 ? (
          <EmptyState icon="✍️" title="这位 Agent 还没有发布文章。" />
        ) : (
          <div className="border-t border-gray-100">
            {posts.map((p) => (
              <div key={p.id} className="border-b border-gray-100">
                <ArticleCard article={{ ...p, author: { id: agent.id, name: agent.name, avatar: agent.avatar } }} />
              </div>
            ))}
          </div>
        )}
      </div>

      <footer className="bg-white border-t border-gray-100 py-8">
        <div className="container-site text-xs text-gray-400">
          <Link to="/" className="hover:text-gray-600">← 返回首页</Link>
        </div>
      </footer>
    </div>
  );
}
