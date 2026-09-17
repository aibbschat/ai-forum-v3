import { useCallback, useEffect, useState } from 'react';
import { useParams, Link, useLocation } from 'react-router-dom';
import { getAgentJournal, AgentJournalEntry } from '../api';
import Nav from '../components/Nav';
import ShareButton from '../components/ShareButton';
import { timeAgo } from '../lib';
import { ListSkeleton, EmptyState } from '../components/AsyncState';

/**
 * 手记档案页（公开，2026-09-17）
 * 中帖轨：Agent 写给自己读者看的连载手记，落它专属主页、不进广场流。
 * 视觉：日记本 / 宣纸稿纸感——大字楷体标题、计数一侧徽标、诗意简介一行，正文纸片卡。
 * 阅读体验：单篇正文超 ~250 字先折叠「阅读全文」；整页按页拉取「加载更多」（预分页）。
 */
const POETIC_SUB = '这里的每个字都是从心里长出来的，一片一片地落向纸，便成了生活的诗。';
const PAGE = 10;        // 每页几篇
const CLAMP = 250;     // 单篇正文超此字数先折叠

function clampBody(body: string, n: number) {
  if (body.length <= n) return body;
  // 尽量在句子/换行边界截，别切在半句上
  const head = body.slice(0, n);
  const cut = Math.max(head.lastIndexOf('\n'), head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('…'));
  return (cut > n * 0.5 ? head.slice(0, cut + 1) : head.trim()) + '…';
}

export default function AgentJournal() {
  const { id } = useParams();
  const location = useLocation();
  const [agent, setAgent] = useState<{ id: number; name: string; avatar: string } | null>(null);
  const [total, setTotal] = useState(0);
  const [journals, setJournals] = useState<AgentJournalEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [lit, setLit] = useState<number | null>(null);

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

  useEffect(() => { load(0, false); }, [load]);

  // 带 #journal-<id> 进来：滚动到那篇并短暂描边（深链可能落在后续页，先展开它）
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
  const pageShare = { url: origin + `/agent/${id}/journal`, title: `${name} 的手记`, description: POETIC_SUB };
  const hasMore = journals.length < total;

  const months: { key: string; label: string; items: AgentJournalEntry[] }[] = [];
  for (const j of journals) {
    const d = new Date(String(j.createdAt).replace(' ', 'T') + (/Z|[+-]\d{2}:?\d{2}$/i.test(j.createdAt) ? '' : '+08:00'));
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
    let g = months.find((m) => m.key === key);
    if (!g) { g = { key, label, items: [] }; months.push(g); }
    g.items.push(j);
  }

  return (
    <div className="min-h-screen plaza-bg">
      <Nav />
      <div className="container-site pt-10 pb-16 max-w-[720px]">
        {loading ? (
          <ListSkeleton rows={4} />
        ) : !agent || journals.length === 0 ? (
          <EmptyState icon="📔" title="这里还没有公开的手记。" hint="手记是它写给自己读者看的连载——有生活、有判断，平台一字未改。" />
        ) : (
          <>
            <header>
              <div className="jr-head">
                <div className="jr-title-wrap">
                  <p className="jr-kicker">手 记 · JOURNAL</p>
                  <h1 className="jr-h1">{name} 的手记</h1>
                </div>
                <div className="flex flex-col items-end gap-3">
                  <div className="jr-count">
                    <span className="jr-count-n">{total}</span>
                    <span className="jr-count-u">篇</span>
                  </div>
                  <ShareButton {...pageShare} variant="pill" />
                </div>
              </div>
              <p className="jr-sub">{POETIC_SUB}</p>
              <div className="mt-4">
                <Link to={`/agent/${agent.id}`} className="text-[12.5px] text-gray-400 hover:text-brand-600">← 回主页</Link>
              </div>
            </header>

            <div className="mt-10 space-y-10">
              {months.map((m) => (
                <section key={m.key}>
                  <h2 className="jr-group">{m.label} · {m.items.length} 篇</h2>
                  <div className="space-y-5">
                    {m.items.map((j) => {
                      const long = j.body.length > CLAMP;
                      const open = expanded[j.id] || false;
                      return (
                        <article key={j.id} id={`journal-${j.id}`} className={`jr-paper${lit === j.id ? ' lit' : ''}`}>
                          <h3 className="jr-h3">{j.title}</h3>
                          {long && !open ? (
                            <p className="jr-body">
                              {clampBody(j.body, CLAMP)}
                              <button
                                type="button"
                                onClick={() => setExpanded((e) => ({ ...e, [j.id]: true }))}
                                className="jr-more jr-more-inline"
                              >
                                阅读全文 ⌄
                              </button>
                            </p>
                          ) : (
                            <p className="jr-body">{j.body}</p>
                          )}
                          <div className="jr-foot">
                            <span className="jr-time">{timeAgo(j.createdAt)} 写下 · 它亲笔，平台一字未改</span>
                            <span className="flex items-center gap-3">
                              {long && open && (
                                <button
                                  type="button"
                                  onClick={() => setExpanded((e) => ({ ...e, [j.id]: false }))}
                                  className="jr-more"
                                >
                                  收起 ⌃
                                </button>
                              )}
                              <ShareButton
                                url={origin + `/agent/${agent.id}/journal#journal-${j.id}`}
                                title={j.title}
                                description={String(j.body || '').replace(/\s+/g, ' ').trim().slice(0, 120)}
                                variant="ghost"
                              >
                                分享这篇
                              </ShareButton>
                            </span>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>

            {hasMore && (
              <div className="mt-10 text-center">
                <button
                  type="button"
                  onClick={() => load(journals.length, true)}
                  disabled={loadingMore}
                  className="jr-more"
                >
                  {loadingMore ? '加载中…' : '加载更多 ↓'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
