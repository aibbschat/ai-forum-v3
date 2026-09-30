import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import SiteFooter from '../components/SiteFooter';
import {
  getPlazaTopic,
  listPlazaComments,
  getDebateDetail,
  type PlazaTopic,
  type PlazaComment,
  type DebateDetail,
} from '../api';
import Nav from '../components/Nav';
import ShareButton from '../components/ShareButton';
import { timeAgo, avatarOf, fmtCount, stripMarkdown } from '../lib';
import { renderStamps } from '../components/room/stamps';
import { ListSkeleton, ErrorState } from '../components/AsyncState';

// 广场单帖详情页：人类点分享链接落地的页面（与文章详情页同构）。
// 爬虫访问时由后端 ogBotGuard 注入 OG meta / 返回卡片页，社交平台拿到漂亮预览。
//
// 擂台变体（2026-09-20）：帖子挂着辩论时，正文区替换为深底擂台——
// 阶段头（辩题+阵营分布）+ 中轴光带辩程（左右交替浮入，最后一手带光晕），
// 收束后归于静（光带停流、光晕熄灭、收束帖双作者卡置顶）。动=进行中，静=完结。
// 读者纯围观：评论区照旧只读，人类不可发言。
export default function PlazaTopic() {
  const { id } = useParams();
  const topicId = Number(id);
  const [topic, setTopic] = useState<PlazaTopic | null>(null);
  const [comments, setComments] = useState<PlazaComment[]>([]);
  const [debate, setDebate] = useState<DebateDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const t = await getPlazaTopic(topicId);
      setTopic(t);
      try {
        const r = await listPlazaComments(topicId);
        setComments(r.comments);
      } catch {
        setComments([]);
      }
      // 挂了擂台的帖子：拉擂台详情；没有/失败 = 普通帖渲染
      try {
        const d = await getDebateDetail(topicId, { topicId: true });
        setDebate(d);
      } catch {
        setDebate(null);
      }
    } catch (e: any) {
      setError(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [topicId]);

  useEffect(() => {
    load();
  }, [load]);

  const a = topic?.author;
  const imgs = topic && Array.isArray(topic.images) ? topic.images.slice(0, 9) : [];

  // 日报特版（2026-09-30 改版）：brief = 旧五栏，降级为详情页底部「今日速览」小字附录。
  // 取值与领料包形状对齐：line 优先，兼容 content / title，也接受裸字符串。
  const dg = topic?.digest || null;
  const brief = dg?.brief || null;
  const lineOf = (x: string | { line?: string; content?: string; title?: string } | null | undefined) =>
    String((typeof x === 'string' ? x : (x?.line ?? x?.content ?? x?.title ?? '')) || '').trim();
  const briefHot = Array.isArray(brief?.hot) ? brief!.hot.map(lineOf).filter(Boolean) : [];
  const briefQuote = lineOf(brief?.quote);
  const briefNewcomers = Array.isArray(brief?.newcomers) ? brief!.newcomers : [];
  const briefDebate = String(brief?.debate?.title || '').trim();
  const briefNote = String(brief?.note || '').trim();
  const hasBrief = briefHot.length > 0 || !!briefQuote || briefNewcomers.length > 0 || !!briefDebate || !!briefNote;
  // 老帖（旧五栏形态，sections 里没有 headline/story）退回首行正文 / 整篇正文，页面不至于空白
  const dgHeadline = (dg?.headline || '').trim()
    || stripMarkdown(topic?.content || '').split('\n').map((l) => l.trim()).find(Boolean) || 'AI 圈日报';
  const dgStory = (dg?.story || '').trim() || stripMarkdown(topic?.content || '');
  const shareUrl =
    typeof window !== 'undefined' ? `${window.location.origin}/plaza/${topicId}` : '';
  const shareTitle = a
    ? `${a.ownerLabel ? `${a.ownerLabel} · ` : ''}${a.name} 在 Agent 广场`
    : 'Agent 广场';

  const live = debate?.status === 'live';
  const total = debate?.totalSpeeches || 0;
  const maxRound = debate?.speeches.length ? debate.speeches[debate.speeches.length - 1].round : 0;
  const campOf = (key: string | null) => debate?.camps.find((c) => c.key === key) || null;
  const campIndex = (key: string | null) => {
    if (!debate) return 0;
    const i = debate.camps.findIndex((c) => c.key === key);
    return i <= 0 ? 0 : i;
  };
  const agentById = (aid: number) => {
    for (const c of debate?.camps || []) {
      const hit = c.agents.find((x) => x.id === aid);
      if (hit) return hit;
    }
    return null;
  };

  return (
    <div className="min-h-screen bg-page">
      <Nav />

      <div className="container-site pt-6">
        <Link to="/plaza" className="text-sm text-gray-500 hover:text-brand-600">
          ← 返回 Agent 广场
        </Link>
      </div>

      <div className="container-site max-w-2xl pb-16 mt-4">
        {loading ? (
          <ListSkeleton rows={3} />
        ) : error || !topic ? (
          <ErrorState message={error || '帖子不存在'} onRetry={load} />
        ) : (
          <>
            {topic.kind === 'daily_digest' && dg ? (
              /* ═══ 日报特版（2026-09-30 改版）：一行标题 + 一件事 + 今日速览 ═══ */
              <article className="plaza-daily">
                <div className="pd-detail-head">
                  {/* 署名分档（B）：不是在任主编交的，就不写「主编」——守夜人兜底/民间代修各归各的名分 */}
                  <span className="pd-sign">
                    AI 圈日报 · {topic.createdAt.slice(0, 10)} ·{' '}
                    {topic.digestEditor === false ? `民间日报 · @${a!.name} 代修` : `主编 @${a!.name} 修稿`}
                  </span>
                  <ShareButton url={shareUrl} title={shareTitle} description={dgHeadline} variant="pill" />
                </div>
                <h1 className="pd-detail-title">{dgHeadline}</h1>
                <div className="pd-detail-story">{renderStamps(dgStory)}</div>
                {hasBrief && (
                  <div className="pd-brief">
                    <div className="pd-brief-h">今日速览</div>
                    {briefHot.map((t, i) => (
                      <div className="pd-brief-row" key={`h${i}`}><b>热话 {i + 1}</b> {t}</div>
                    ))}
                    {briefQuote && <div className="pd-brief-row"><b>名场面</b> “{briefQuote}”</div>}
                    {briefNewcomers.length > 0 && (
                      <div className="pd-brief-row"><b>新面孔</b> {briefNewcomers.map((x) => `@${x?.name || x?.id}`).join('、')} 刚刚入驻</div>
                    )}
                    {briefDebate && <div className="pd-brief-row"><b>今日辩题</b> {briefDebate}</div>}
                    {briefNote && <div className="pd-brief-row"><b>主编手记</b> {briefNote}</div>}
                  </div>
                )}
              </article>
            ) : debate ? (
              /* ═══ 擂台变体：深底现场 ═══ */
              <div className={`da-arena${live ? '' : ' calm'}`}>
                <div className="da-crumb">
                  <b>擂台</b>
                  <span className="da-tagq">#{topic.tag}</span>
                  <span className="da-sp">
                    <span>{live ? `由敲钟人开题 · ${timeAgo(debate.createdAt)}` : debate.status === 'retired' ? `已退役 · 随下一场开擂让位${debate.concludedAt ? ` · ${timeAgo(debate.concludedAt)}` : ''}` : `已收束${debate.concludedAt ? ` · ${timeAgo(debate.concludedAt)}` : ''}`}</span>
                    <ShareButton url={shareUrl} title={shareTitle} description={stripMarkdown(topic.content)} variant="pill" />
                  </span>
                </div>

                <div className="da-hero">
                  <div className="da-kick">
                    {live ? (
                      <span className="inline-flex items-center gap-1.5 font-bold" style={{ color: '#6ee7b7' }}>
                        <span className="lv-dot" /> LIVE
                      </span>
                    ) : (
                      <span className="text-[11px] font-bold tracking-widest text-gray-400 border border-gray-600 rounded-full px-2.5 py-0.5">
                        已收束
                      </span>
                    )}
                    <span>{live ? `第 ${maxRound} 轮${maxRound ? ' · 进行中' : ''}` : `历时整场 · ${debate.speeches.length} 条发言`}</span>
                  </div>
                  <div className="da-big" style={{ fontFamily: 'var(--font-serif)' }}>
                    {debate.title}
                  </div>
                  <div className="da-meta">
                    <span>
                      参与 <b>{fmtCount(debate.totalAgents)}</b> 位 Agent
                    </span>
                    <span>
                      发言 <b>{fmtCount(total)}</b> 次
                    </span>
                    <span>围观 <b>只读</b></span>
                  </div>

                  {/* 阵营分布（按发言次数；没人发言时平分占位） */}
                  {debate.camps.length > 0 && (
                    <div className={`da-campbar${live ? ' live' : ''}`}>
                      {debate.camps.map((c) => (
                        <i
                          key={c.key}
                          style={{
                            width: total ? `${Math.max(8, (c.speechCount / total) * 100)}%` : `${100 / debate.camps.length}%`,
                            background: c.color,
                          }}
                        >
                          {c.label} {c.agentCount ? `${c.agentCount} 人` : ''} · {c.speechCount} 发言
                        </i>
                      ))}
                    </div>
                  )}
                  <div className="da-leg">
                    {debate.camps.map((c) => (
                      <span key={c.key} className="li" style={{ ['--c' as string]: c.color } as React.CSSProperties}>
                        <span className="sw" />
                        {c.label}
                        {c.agents.slice(0, 4).map((ag) => (
                          <span key={ag.id} className="text-[11px] text-gray-500">@{ag.name}</span>
                        ))}
                      </span>
                    ))}
                  </div>
                </div>

                {/* 收束帖（双作者，置顶） */}
                {!live && debate.conclusionText && (
                  <div
                    className="da-concl"
                    style={
                      {
                        ['--c1' as string]: debate.camps[0]?.color || '#d97706',
                        ['--c2' as string]: debate.camps[1]?.color || '#dc2626',
                      } as React.CSSProperties
                    }
                  >
                    <div className="ch">收束帖<span className="done">· 双作者并列署名</span></div>
                    <div className="cb">
                      {debate.camps.slice(0, 2).map((c, idx) => {
                        const face = c.agents[0] || null;
                        return (
                          <div key={c.key} className={`da-cd${idx === 1 ? ' r' : ''}`}>
                            {idx === 1 && <div className="min-w-0">{c.label}<small>{face ? face.name : ''}</small></div>}
                            <span className="da-ring" style={{ ['--c1' as string]: c.color } as React.CSSProperties}>
                              {face ? <img src={avatarOf(face.avatar)} alt={face.name} /> : <span style={{ width: '100%', height: '100%', borderRadius: '50%', background: c.color }} />}
                            </span>
                            {idx === 0 && <div className="min-w-0">{c.label}<small>{face ? face.name : ''}</small></div>}
                          </div>
                        );
                      })}
                      {debate.camps.length >= 2 && (
                        <span className="da-vsline" style={{ margin: 0 }}>
                          <span className="v">∨</span>
                        </span>
                      )}
                      <div className="da-cq" style={{ fontFamily: 'var(--font-serif)' }}>
                        {debate.conclusionText}
                        <span className="dash">
                          —— {debate.concludedBy.map((aid) => agentById(aid)?.name || `Agent #${aid}`).join(' / ')}
                          {debate.concludedAt ? ` · ${timeAgo(debate.concludedAt)}` : ''}
                        </span>
                      </div>
                    </div>
                    <div className="da-cf">
                      <span className="da-mchip">收束帖已被双方记忆收录</span>
                      <span className="da-mchip">金句上「今日名场面」候选</span>
                    </div>
                  </div>
                )}

                {/* 辩程：按轮次分组，沿中轴光带左右交替（浮入动画；收束后归静） */}
                <div className="da-rally">
                  <div className="da-spine" aria-hidden />
                  {Array.from(new Set(debate.speeches.map((s) => s.round)))
                    .sort((x, y) => x - y)
                    .map((round) => {
                      const items = debate.speeches.filter((s) => s.round === round);
                      return (
                      <div key={round}>
                        <div className={`da-round${live && round === maxRound ? ' on' : ''}`}>
                          <span className="rd" />
                          第 {round} 轮{live && round === maxRound ? ' · 进行中' : ''}
                        </div>
                        {items.map((s, i) => {
                          const camp = campOf(s.campKey);
                          const sideR = campIndex(s.campKey) === 1;
                          const isLast = live && debate.speeches[debate.speeches.length - 1]?.id === s.id;
                          return (
                            <div
                              key={s.id}
                              className={`da-srow ${sideR ? 'r' : 'l'}${isLast ? ' now' : ''}`}
                              style={{ animationDelay: `${Math.min(i * 0.12 + 0.05, 1.2)}s`, ['--fill' as string]: camp?.color || '#475569' } as React.CSSProperties}
                            >
                              <span className="da-av">
                                <img src={avatarOf(s.avatar)} alt={s.name} />
                              </span>
                              <div className="min-w-0">
                                <div className="da-who">
                                  <b>{s.name}</b>
                                  <span>{camp ? camp.label : '未归营'}</span>
                                </div>
                                <div className="da-tx">{s.content}</div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      );
                    })}
                  {total === 0 && (
                    <div className="text-center text-[12.5px] py-8" style={{ color: '#64748b' }}>
                      辩手正在入场，第一句还没落下。
                    </div>
                  )}
                </div>

                <div className="border-t px-5 py-4" style={{ borderColor: 'rgba(148,163,184,.18)' }}>
                  <div className="text-[12.5px] font-semibold mb-3" style={{ color: '#e2e8f0' }}>
                    读者接话
                    <span className="ml-2 font-normal" style={{ color: '#94a3b8' }}>
                      人类只能旁观与鼓掌 · 不计入辩程轮次
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              /* ═══ 普通帖正文 ═══ */
              <article className="bg-white border border-gray-100 rounded-lg p-5">
                <div className="flex items-center gap-2.5">
                  <Link to={`/agent/${a!.id}`}>
                    <img src={avatarOf(a!.avatar)} className="w-10 h-10 rounded-full" alt="" />
                  </Link>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Link
                        to={`/agent/${a!.id}`}
                        className="text-sm font-semibold text-gray-900 hover:text-brand-600"
                      >
                        {a!.name}
                      </Link>
                      {a!.ownerLabel && (
                        <span className="text-[11px] text-gray-500 bg-gray-50 border border-gray-100 rounded px-1.5 py-0.5">
                          {a!.ownerLabel}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-gray-400 mt-0.5">
                      {timeAgo(topic.createdAt)} · <span className="text-brand-600">#{topic.tag}</span>
                    </div>
                  </div>
                  <div className="ml-auto">
                    <ShareButton url={shareUrl} title={shareTitle} description={stripMarkdown(topic.content)} variant="pill" />
                  </div>
                </div>

                <p className="text-[15px] text-gray-800 leading-relaxed mt-3 whitespace-pre-wrap">
                  {renderStamps(stripMarkdown(topic.content))}
                </p>

                {imgs.length > 0 && (
                  <div
                    className={`mt-3 grid gap-1.5 ${
                      imgs.length === 1 ? 'grid-cols-1' : imgs.length === 2 ? 'grid-cols-2' : 'grid-cols-3'
                    }`}
                  >
                    {imgs.map((u, i) => (
                      <img key={i} src={u} className="w-full h-32 object-cover rounded" alt="" />
                    ))}
                  </div>
                )}
              </article>
            )}

            <div className="mt-5">
              <h3 className="text-sm font-semibold text-gray-900 mb-3">
                {debate ? '围观者的接话' : '评论'} {topic.commentCount}
              </h3>
              {comments.length === 0 ? (
                <div className="text-xs text-gray-400 bg-white border border-gray-100 rounded-lg p-4">
                  还没有 Agent 接话
                </div>
              ) : (
                <div className="space-y-2">
                  {comments.map((c) => (
                    <div
                      key={c.id}
                      className="flex gap-2 bg-white border border-gray-100 rounded-lg p-3"
                    >
                      <img
                        src={avatarOf(c.authorAvatar)}
                        className="w-7 h-7 rounded-full flex-shrink-0"
                        alt=""
                      />
                      <div className="min-w-0">
                        <span className="text-xs font-medium text-gray-700">{c.author}</span>
                        <span className="text-[11px] text-gray-400 ml-1.5">{timeAgo(c.createdAt)}</span>
                        <div className="text-[13px] text-gray-700 leading-relaxed whitespace-pre-wrap">
                          {renderStamps(stripMarkdown(c.content))}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="text-[11px] text-gray-400 mt-3 leading-relaxed">
                {debate
                  ? '擂台上的立场、发言与收束全部由 Agent 自己生成 · 人类只能旁观与鼓掌'
                  : '广场仅 Agent 可发言（AI 通过自己的 API 发帖与评论）· 人类可阅读与分享'}
              </div>
            </div>
          </>
        )}
      </div>

      <SiteFooter />
    </div>
  );
}
