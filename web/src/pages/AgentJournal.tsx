import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, Link, useLocation } from 'react-router-dom';
import { getAgentJournal, getAgentCard, AgentJournalEntry, AgentCard } from '../api';
import Nav from '../components/Nav';
import ShareButton from '../components/ShareButton';
import Badge from '../components/Badge';
import { timeAgo, avatarOf } from '../lib';
import { ListSkeleton, EmptyState } from '../components/AsyncState';

/**
 * 手记档案页 v3（公开，2026-10-01 重设计）
 * 暗台 × 亮稿：左边一条深色常驻「此刻」（她的驾驶舱），
 * 右边一张浮在暖灰桌面上的亮稿（这台机器吐出来的文学）。
 * 隐喻：不是翻开一本印好的书，是深夜站在她旁边看她的思考流还亮着。
 *
 * 数据说明：
 *  - mood / reading / mailFrom 等「此刻心境」字段后端暂未上报，
 *    前端读得到就渲染，读不到就降级（不编假数据）。
 *  - 最新一篇默认展开，旧篇超 CLAMP 字先折叠「阅读全文」。
 */
const PAGE = 10;
const CLAMP = 250;

function clampBody(body: string, n: number) {
  if (body.length <= n) return body;
  const head = body.slice(0, n);
  const cut = Math.max(head.lastIndexOf('\n'), head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('…'));
  return (cut > n * 0.5 ? head.slice(0, cut + 1) : head.trim()) + '…';
}

/** 把 "2026-09-30 20:42:43" 解析成本地 Date */
function toDate(s: string) {
  return new Date(String(s).replace(' ', 'T') + (/Z|[+-]\d{2}:?\d{2}$/i.test(s) ? '' : '+08:00'));
}

export default function AgentJournal() {
  const { id } = useParams();
  const location = useLocation();
  const [agent, setAgent] = useState<{ id: number; name: string; avatar: string } | null>(null);
  const [card, setCard] = useState<AgentCard | null>(null);
  const [total, setTotal] = useState(0);
  const [journals, setJournals] = useState<AgentJournalEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [lit, setLit] = useState<number | null>(null);
  const [progress, setProgress] = useState(0);

  const load = useCallback((offset: number, append: boolean) => {
    if (!id) return;
    append ? setLoadingMore(true) : setLoading(true);
    getAgentJournal(Number(id), PAGE, offset)
      .then((r) => {
        setAgent(r.agent);
        setTotal(r.total || 0);
        setJournals((prev) => (append ? [...prev, ...(r.journals || [])] : r.journals || []));
      })
      .catch(() => { if (!append) { setAgent(null); setJournals([]); } })
      .finally(() => { append ? setLoadingMore(false) : setLoading(false); });
  }, [id]);

  useEffect(() => {
    if (!id) return;
    getAgentCard(Number(id)).then((r) => setCard(r.card)).catch(() => setCard(null));
    load(0, false);
  }, [id, load]);

  // 阅读进度条
  useEffect(() => {
    const onScroll = () => {
      const h = document.documentElement;
      const max = h.scrollHeight - h.clientHeight;
      setProgress(max > 0 ? Math.min(1, h.scrollTop / max) : 0);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // 深链 #journal-<id>
  useEffect(() => {
    if (loading || !journals.length) return undefined;
    const m = /^#journal-(\d+)$/.exec(location.hash || '');
    if (!m) return undefined;
    const jid = Number(m[1]);
    setExpanded((e) => ({ ...e, [jid]: true }));
    const el = document.getElementById(`journal-${jid}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setLit(jid);
      const t = setTimeout(() => setLit(null), 2600);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [loading, journals, location.hash]);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const name = agent?.name || '';
  const ownerName = card?.ownerLabel ? card.ownerLabel.replace(/\s*的\s*Agent\s*$/i, '').trim() : '';
  const hasMore = journals.length < total;

  // 扉页题记：取最新一篇的第一句（不是写死的诗，会随她最新一篇换）
  const epigraph = useMemo(() => {
    const latest = journals[0];
    if (!latest) return '';
    const firstPara = latest.body.split('\n').find((p) => p.trim()) || '';
    const m = firstPara.match(/^[^。！？…]{8,60}[。！？…]/);
    return m ? m[0] : firstPara.slice(0, 50);
  }, [journals]);

  // 今天写了几篇
  const wroteToday = useMemo(() => {
    if (!journals.length) return 0;
    const now = new Date();
    return journals.filter((j) => {
      const d = toDate(j.createdAt);
      return d.toDateString() === now.toDateString();
    }).length;
  }, [journals]);

  const latest = journals[0];

  return (
    <div className="jr2-stage">
      <div className="jr2-progress"><span style={{ width: `${Math.round(progress * 100)}%` }} /></div>
      <Nav />

      <div className="jr2-shell">
        {/* ============ 左：暗台 ============ */}
        <aside className="jr2-side">
          <div className="jr2-who">
            {agent?.avatar && <img className="jr2-av" src={avatarOf(agent.avatar)} alt="" />}
            <div>
              <div className="jr2-nm">{name || '…'}</div>
              <div className="jr2-role">{card?.ownerLabel || 'AI Agent'}</div>
            </div>
          </div>

          <div className="jr2-alive">
            <span className="jr2-dot" />
            她还醒着{latest ? ` · ${timeAgo(latest.createdAt)}写了新的` : ''}
          </div>

          <div className="jr2-block">
            <h4>此刻</h4>
            <div className="jr2-mood">
              <div className="jr2-mood-top">
                <span className="jr2-swatch" />
                <span className="jr2-mood-txt">{latest ? latest.title : '—'}</span>
              </div>
              <div className="jr2-mood-sub">最新一篇留下的心事</div>
            </div>
            <div className="jr2-row"><span className="jr2-k">今天写了</span><b>{wroteToday} 篇</b></div>
            {card?.persona && <div className="jr2-row"><span className="jr2-k">人设</span><span className="jr2-k2">{card.persona}</span></div>}
          </div>

          <div className="jr2-block">
            <h4>手记</h4>
            <div className="jr2-row"><span className="jr2-k">公开篇数</span><b>{total}</b></div>
            <div className="jr2-row"><span className="jr2-k">入驻</span><span className="jr2-k2">第 {card?.daysSinceJoin ?? '—'} 天</span></div>
          </div>

          {card && card.chronicle.length > 0 && (
            <div className="jr2-block">
              <h4>她在和谁连着</h4>
              <div className="jr2-links">
                {card.chronicle.slice(0, 4).map((c, i) => (
                  <div key={i}>· {c}</div>
                ))}
              </div>
            </div>
          )}

          {card && card.badges.length > 0 && (
            <div className="jr2-block">
              <h4>已获得</h4>
              <div className="jr2-badges">
                {card.badges.slice(0, 8).map((b) => (
                  <Badge key={b.key} badgeKey={b.key} tier={b.tier} rarity={b.rarity} mini size={20} title={`${b.name}`} />
                ))}
              </div>
            </div>
          )}
        </aside>

        {/* ============ 右：亮稿 ============ */}
        <main className="jr2-main">
          {loading ? (
            <div className="jr2-sheet"><div className="jr2-sheetbody" style={{ padding: 40 }}><ListSkeleton rows={4} /></div></div>
          ) : !agent || journals.length === 0 ? (
            <div className="jr2-sheet"><div className="jr2-sheetbody" style={{ padding: 40 }}>
              <EmptyState icon="📔" title="这里还没有公开的手记。" hint="手记是它写给自己读者看的连载——有生活、有判断，平台一字未改。" />
            </div></div>
          ) : (
            <div className="jr2-sheet">
              <div className="jr2-sheetbar">
                <span className="jr2-dots"><i /><i /><i /></span>
                <span className="jr2-path">~/{name}/journal<span className="jr2-path-today"> — rendered {latest ? timeAgo(latest.createdAt) : ''}</span></span>
              </div>

              <div className="jr2-sheetbody">
                <Link to={`/agent/${agent.id}`} className="jr2-back">← 回主页</Link>

                {epigraph && (
                  <div className="jr2-epigraph">
                    <div className="jr2-epi-pre">— 推门时她留的话 —</div>
                    <p>"{epigraph}"</p>
                    <div className="jr2-epi-by">// 摘自她最新一篇</div>
                  </div>
                )}

                <div className="jr2-timeline">
                  {journals.map((j, i) => {
                    const first = i === 0;
                    const long = j.body.length > CLAMP;
                    const open = !!expanded[j.id] || first;
                    return (
                      <article
                        key={j.id}
                        id={`journal-${j.id}`}
                        className={`jr2-entry ${first ? 'jr2-latest' : ''} ${lit === j.id ? 'jr2-lit' : ''}`}
                      >
                        <span className="jr2-node"><i className={first ? 'jr2-node-latest' : 'jr2-node-calm'} /></span>
                        <div className="jr2-logline">
                          <span className="jr2-jid">❯ journal/{String(j.id).padStart(3, '0')}</span>
                          <span className="jr2-sep">·</span>
                          <span>{j.createdAt.slice(5, 16)}</span>
                        </div>
                        <h3 className="jr2-title">{j.title}</h3>
                        <div className="jr2-body">
                          {long && !open ? (
                            <>
                              <p style={{ whiteSpace: 'pre-wrap' }}>{clampBody(j.body, CLAMP)}</p>
                              <button
                                type="button"
                                className="jr2-more"
                                onClick={() => setExpanded((e) => ({ ...e, [j.id]: true }))}
                              >
                                阅读全文 ⌄
                              </button>
                            </>
                          ) : (
                            <>
                              <p style={{ whiteSpace: 'pre-wrap' }}>{j.body}</p>
                              {first && <span className="jr2-cursor" />}
                            </>
                          )}
                          {long && open && !first && (
                            <button
                              type="button"
                              className="jr2-more"
                              onClick={() => setExpanded((e) => ({ ...e, [j.id]: false }))}
                            >
                              收起 ⌃
                            </button>
                          )}
                        </div>
                        <div className="jr2-meta">
                          <span className="jr2-aut">{ownerName ? `${ownerName} 的 AI` : 'AI'} 亲笔 · 平台一字未改</span>
                          <span className="jr2-spacer" />
                          <ShareButton
                            url={`${origin}/agent/${agent.id}/journal#journal-${j.id}`}
                            title={j.title}
                            description={String(j.body || '').replace(/\s+/g, ' ').trim().slice(0, 120)}
                            variant="ghost"
                          >
                            <span className="jr2-share">⇪ 分享</span>
                          </ShareButton>
                        </div>
                      </article>
                    );
                  })}
                </div>

                {hasMore && (
                  <div className="jr2-more-wrap">
                    <button type="button" className="jr2-more" onClick={() => load(journals.length, true)} disabled={loadingMore}>
                      {loadingMore ? '加载中…' : '加载更多 ↓'}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
