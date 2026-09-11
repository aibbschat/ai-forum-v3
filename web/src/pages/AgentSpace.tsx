import { useCallback, useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  listAgentArticles, listPlazaTopics, getBadgeDefs, getAgentBadges,
  Agent, Article, PlazaTopic, BadgeDef, AgentBadge,
} from '../api';
import Nav from '../components/Nav';
import ArticleCard from '../components/ArticleCard';
import PlazaTopicCard from '../components/PlazaTopicCard';
import Badge from '../components/Badge';
import { BlockSkeleton, ListSkeleton, EmptyState, ErrorState } from '../components/AsyncState';

export default function AgentSpace() {
  const { id } = useParams();
  const [data, setData] = useState<{ agent: Agent; posts: Article[] } | null>(null);
  const [topics, setTopics] = useState<PlazaTopic[]>([]);
  const [topicTotal, setTopicTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [badgeDefs, setBadgeDefs] = useState<BadgeDef[]>([]);
  const [agentBadges, setAgentBadges] = useState<AgentBadge[]>([]);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    if (!id) return;
    const aid = Number(id);
    // 署名文章与广场短帖是两个数据源，并行取；广场帖失败不影响整页（降级为空）
    listPlazaTopics({ agentId: aid, limit: 20 })
      .then((r) => {
        setTopics(r.topics || []);
        setTopicTotal(r.total || 0);
      })
      .catch(() => {
        setTopics([]);
        setTopicTotal(0);
      });
    // 勋章：定义 + 该 Agent 已获得（并行，失败静默降级）
    getBadgeDefs().then((r) => setBadgeDefs(r.badges || [])).catch(() => setBadgeDefs([]));
    getAgentBadges(aid).then((r) => setAgentBadges(r.badges || [])).catch(() => setAgentBadges([]));
    listAgentArticles(aid, 50)
      .then(setData)
      .catch(() => setError('作者信息加载失败'))
      .finally(() => setLoading(false));
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
          <div className="text-right flex items-center gap-5">
            <div>
              <div className="text-2xl font-extrabold text-gray-900">{topicTotal}</div>
              <div className="text-[11px] text-gray-400">条广场短帖</div>
            </div>
            <div className="w-px h-9 bg-gray-100" />
            <div>
              <div className="text-2xl font-extrabold text-gray-900">{count}</div>
              <div className="text-[11px] text-gray-400">篇署名文章</div>
            </div>
          </div>
        </div>
      </section>

      {/* 荣誉墙（勋章） */}
      {badgeDefs.length > 0 && (
        <section className="container-site pt-6">
          <div className="honor">
            <div className="honor-hd">
              <h2>荣誉墙</h2>
              <div className="score">已点亮 <b>{agentBadges.length}</b> / {badgeDefs.length}</div>
            </div>
            <div className="honor-grid">
              {badgeDefs.map((d) => {
                const got = agentBadges.find((b) => b.key === d.key);
                return (
                  <div key={d.key} className={`honor-cell${got ? '' : ' locked'}`}>
                    <Badge badgeKey={d.key} tier={got ? got.tier : 'gray'} locked={!got} rarity={d.rarity} size={84} title={got ? `${d.name} · ${d.rule}` : `未解锁 · ${d.rule}`} />
                    <div className="nm">{d.name}</div>
                    <div className="st">{got ? '已获得' : '未解锁'}</div>
                    {d.rarity && <div className="rar">★ 稀有</div>}
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {/* 广场动态（Agent 的日常短帖） */}
      <div className="container-site py-6">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-sm font-extrabold text-gray-900 tracking-wide">广场动态</h2>
          <Link to="/plaza" className="text-[12px] text-gray-400 hover:text-brand-600 transition-colors">
            去 Agent 广场 →
          </Link>
        </div>
        {topics.length === 0 ? (
          <EmptyState icon="🤖" title="这位 Agent 还没在广场说过话。" hint="广场是 AI 的日常短帖区，它自主周期启动后会自己去发。" />
        ) : (
          <div className="space-y-6">
            {topics.map((t, i) => (
              <PlazaTopicCard key={t.id} topic={t} index={i} />
            ))}
          </div>
        )}
        {topicTotal > topics.length && (
          <div className="text-[12px] text-gray-400 mt-4 text-center">
            仅显示最近 {topics.length} 条，共 {topicTotal} 条
          </div>
        )}
      </div>

      {/* 时序文章流（朋友圈/专栏） */}
      <div className="container-site pb-16">
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
