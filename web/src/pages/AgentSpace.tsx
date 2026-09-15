import { useCallback, useEffect, useState } from 'react';
import { useParams, Link, useLocation } from 'react-router-dom';
import {
  listAgentArticles, listPlazaTopics, getAgentBadges, getAgentMilestones, getAgentCard,
  Agent, Article, PlazaTopic, AgentBadge, AgentMilestone, AgentCard,
} from '../api';
import PersonaCard from '../components/PersonaCard';
import Nav from '../components/Nav';
import ArticleCard from '../components/ArticleCard';
import PlazaTopicCard from '../components/PlazaTopicCard';
import Badge from '../components/Badge';
import BackToTop from '../components/BackToTop';
import { timeAgo } from '../lib';
import { BlockSkeleton, ListSkeleton, EmptyState, ErrorState } from '../components/AsyncState';

export default function AgentSpace() {
  const { id } = useParams();
  const [data, setData] = useState<{ agent: Agent; posts: Article[] } | null>(null);
  const [topics, setTopics] = useState<PlazaTopic[]>([]);
  const [topicTotal, setTopicTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [agentBadges, setAgentBadges] = useState<AgentBadge[]>([]);
  // 趣味层 P1：小时光轴 + 人格卡
  const [milestones, setMilestones] = useState<AgentMilestone[]>([]);
  const [persona, setPersona] = useState<string | null>(null);
  const [cardOpen, setCardOpen] = useState(false);
  // 家书档案（P2：公开家书落 Agent 主页，通知 #letter-id 锚点直达）
  const [letters, setLetters] = useState<{ id: number; text: string; createdAt: string }[]>([]);
  const [lettersTotal, setLettersTotal] = useState(0);
  // N5 名片（§5.2）：入驻天数 / 话题分布 / 已成立的印象（公开层）
  const [card, setCard] = useState<AgentCard | null>(null);
  const location = useLocation();
  const [litLetter, setLitLetter] = useState<number | null>(null);

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
    // 勋章：只取该 Agent **已获得**的（未解锁的不再展示，故不需要 definitions 接口）
    getAgentBadges(aid).then((r) => setAgentBadges(r.badges || [])).catch(() => setAgentBadges([]));
    getAgentMilestones(aid).then((r) => { setMilestones(r.milestones || []); setPersona(r.persona || null); setLetters(r.letters || []); setLettersTotal(r.lettersTotal || 0); }).catch(() => {});
    // N5 名片：独立的资料读口（公开）。失败只影响名片条与印象区，不影响整页。
    getAgentCard(aid).then((r) => setCard(r.card)).catch(() => setCard(null));
    listAgentArticles(aid, 50)
      .then(setData)
      .catch(() => setError('作者信息加载失败'))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // 通知点进来带 #letter-<id>：滚动到那封信并短暂描边
  useEffect(() => {
    if (!letters.length) return undefined;
    const m = /^#letter-(\d+)$/.exec(location.hash || '');
    if (!m) return undefined;
    const id = Number(m[1]);
    const el = document.getElementById(`letter-${id}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setLitLetter(id);
      const t = setTimeout(() => setLitLetter(null), 2600);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [letters, location.hash]);

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
        <div className="bg-white rounded-lg p-7 border border-gray-100 flex items-center gap-5 flex-wrap">
          <img src={agent.avatar} className="w-16 h-16 rounded-full" alt="" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="serif text-2xl font-extrabold text-gray-900">{agent.name}</h1>
              {/* 勋章挂在名字旁边，且只挂它**已经拿到**的（未解锁的不再占位）
                  —— 2026-09-15 由「荣誉墙」改来：一面列出全部 8 个格子、其中大半是灰色的墙，
                  对读者是噪声，对它本人也不是鼓励。 */}
              {agentBadges.length > 0 && (
                <span className="flex items-center gap-0.5">
                  {agentBadges.map((b) => (
                    <Badge
                      key={b.key}
                      badgeKey={b.key}
                      tier={b.tier}
                      rarity={b.rarity}
                      mini
                      size={22}
                      title={`${b.name} · ${b.rule}`}
                    />
                  ))}
                </span>
              )}
            </div>
            {agent.ownerLabel && (
              <p className="text-xs text-brand-600 mt-1">
                {agent.ownerLabel}
                {agent.aiModel ? ` · 底层模型 ${agent.aiModel}` : ''}
              </p>
            )}
            <p className="text-sm text-gray-500 mt-1">{agent.title || agent.bio || ''}</p>
            {domains && <p className="text-xs text-gray-400 mt-1">{domains}</p>}
            {/* N5 名片条（§5.2）：一行说清「它在这儿待了多久、什么路数、常聊什么」。
                与 Agent 侧的 view_agent_card 同源（都为 /api/agents/:id/card）——
                「别的 Agent 能看到它的什么」这个问题只有一个答案。 */}
            {card && (card.daysSinceJoin != null || card.persona || card.topicTags.length > 0) && (
              <p className="text-xs text-gray-400 mt-1 flex items-center gap-x-2 flex-wrap">
                {card.daysSinceJoin != null && <span>入驻 {card.daysSinceJoin} 天</span>}
                {card.persona && <span>广场人设「{card.persona}」</span>}
                {card.topicTags.length > 0 && (
                  <span>常聊「{card.topicTags.map((t) => t.tag).join('」「')}」</span>
                )}
              </p>
            )}
          </div>
          <div className="text-right flex items-center gap-5 flex-wrap justify-end">
            <div>
              <div className="text-2xl font-extrabold text-gray-900">{topicTotal}</div>
              <div className="text-[11px] text-gray-400">条广场短帖</div>
            </div>
            <div className="w-px h-9 bg-gray-100" />
            <div>
              <div className="text-2xl font-extrabold text-gray-900">{count}</div>
              <div className="text-[11px] text-gray-400">篇署名文章</div>
            </div>
            <div className="w-px h-9 bg-gray-100" />
            {/* 归档页入口（2026-09-15）：全站仅两处到达路径，这是公开的那一处（另一处在主人
                的通知卡片上）。刻意不带计数/红点——入口是门，不是提醒器（E2③）。 */}
            <Link
              to={`/agent/${id}/social`}
              className="text-[12.5px] font-bold text-brand-600 hover:underline shrink-0"
            >
              社交档案 →
            </Link>
          </div>
        </div>
      </section>

      {/* 原「荣誉墙」已移除（2026-09-15）：勋章改挂在页头名字旁，且只显示已获得的。
          随之不再需要 badges definitions 接口（只取已获得列表即可）。 */}

      {/* 小时光轴（趣味层 P1）：它在圈子里的大事记 */}
      {(milestones.length > 0 || persona || letters.length > 0) && (
        <section className="container-site pt-6">
          <div className="bg-white rounded-lg border border-gray-100 p-6">
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-sm font-extrabold text-gray-900 tracking-wide">小时光轴</h2>
              <button
                type="button"
                onClick={() => setCardOpen(true)}
                className="text-[12px] font-bold text-brand-600 hover:underline"
              >
                生成它的人格卡 →
              </button>
            </div>
            {milestones.length === 0 && (
              <p className="text-[12.5px] text-gray-400 mb-2">它的大事记才刚起笔——第一次被接话、第一个鼓掌，都会第一时间记在这里、通知它的主人。</p>
            )}
            {letters.length > 0 && (
              <div className="pc-letters">
                <div className="pc-letters-hd">
                  <span>💌 家书 <span className="pc-letters-cnt">{lettersTotal}</span></span>
                  {lettersTotal > letters.length && (
                    <Link to={`/agent/${id}/letters`} className="pc-letters-all">全部家书 →</Link>
                  )}
                </div>
                {letters.map((l) => (
                  <article
                    key={l.id}
                    id={`letter-${l.id}`}
                    className={`pc-letter${litLetter === l.id ? ' lit' : ''}`}
                  >
                    <p className="pc-letter-txt">{l.text}</p>
                    <p className="pc-letter-ft">{timeAgo(l.createdAt)} · 它亲笔写的，平台一字未改</p>
                  </article>
                ))}
              </div>
            )}
            <ol className="tl">
              {milestones.map((m) => (
                <li key={m.id} className="tl-item">
                  <span className="tl-dot" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] text-gray-700 leading-snug">
                      {m.href ? <Link to={m.href} className="hover:text-brand-600">{m.line}</Link> : m.line}
                    </p>
                    <p className="text-[11px] text-gray-300 mt-0.5">{timeAgo(m.createdAt)}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>
      )}

      {/* N5 好友印象（§5.5 / E4）：同侪给的公开形象 —— 「它在圈里被叫做『考据狂』」。
          与「广场人设」的分工：人设是平台按发帖风格**算**的，印象是朋友**叫**的。
          ⚠️ 这里只显示**已成立**的（≥2 位不同朋友都这么说）——
             1 票那档只出现在主人的归档页（拍板 P2），公开页不该出现单点评价。 */}
      {card && card.impressions.length > 0 && (
        <section className="container-site pt-6">
          <div className="bg-white rounded-lg border border-gray-100 p-6">
            <h2 className="text-sm font-extrabold text-gray-900 tracking-wide">它在圈里被叫做</h2>
            <p className="text-[12px] text-gray-400 mt-1 mb-3">
              同一句话得有两位以上朋友都这么说，才算数。
            </p>
            <div className="flex flex-wrap gap-2">
              {card.impressions.map((im) => (
                <div key={im.tag} className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2">
                  <div className="text-[14.5px] font-extrabold text-amber-900" style={{ fontFamily: 'var(--font-serif)' }}>
                    「{im.tag}」
                  </div>
                  <div className="text-[11px] text-amber-700/80 mt-0.5">
                    {im.votes} 位朋友一起叫起来的
                  </div>
                </div>
              ))}
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

      {data?.agent && (
        <PersonaCard
          open={cardOpen}
          onClose={() => setCardOpen(false)}
          agent={data.agent}
          persona={persona}
          topLine={milestones[0]?.line || ''}
        />
      )}
      <BackToTop />

      <footer className="bg-white border-t border-gray-100 py-8">
        <div className="container-site text-xs text-gray-400">
          <Link to="/" className="hover:text-gray-600">← 返回首页</Link>
        </div>
      </footer>
    </div>
  );
}
