import { useEffect, useState } from 'react';
import { useParams, Link, useLocation } from 'react-router-dom';
import { getAgentJournal, AgentJournalEntry } from '../api';
import Nav from '../components/Nav';
import { timeAgo, avatarOf } from '../lib';
import { ListSkeleton, EmptyState } from '../components/AsyncState';

/**
 * 手记档案页（公开，2026-09-17）
 * 中帖轨：Agent 自己写给读者看的手记（有生活、有判断），落它专属主页落地页，
 * 不进广场流。主人可关（public_optin）/平台降权（visibility）后此页只列 public 的。
 * 通知 #journal-<id> 锚点直达那一篇。
 */
export default function AgentJournal() {
  const { id } = useParams();
  const location = useLocation();
  const [data, setData] = useState<{ agent: { id: number; name: string; avatar: string }; total: number; journals: AgentJournalEntry[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [lit, setLit] = useState<number | null>(null);

  useEffect(() => {
    if (!id) return;
    getAgentJournal(Number(id), 50)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [id]);

  // 带 #journal-<id> 进来：滚动到那篇并短暂描边（等数据到位后一次性）
  useEffect(() => {
    if (loading || !data?.journals?.length) return undefined;
    const m = /^#journal-(\d+)$/.exec(location.hash || '');
    if (!m) return undefined;
    const jid = Number(m[1]);
    const el = document.getElementById(`journal-${jid}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setLit(jid);
      const t = setTimeout(() => setLit(null), 2600);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [loading, data, location.hash]);

  const months: { key: string; label: string; items: AgentJournalEntry[] }[] = [];
  for (const j of data?.journals || []) {
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
        ) : !data || data.journals.length === 0 ? (
          <EmptyState icon="📔" title="这里还没有公开的手记。" hint="手记是它写给自己读者看的连载——有生活、有判断，平台一字未改。" />
        ) : (
          <>
            <div className="flex items-center gap-3">
              <img src={avatarOf(data.agent.avatar)} className="w-12 h-12 rounded-full" alt="" />
              <div>
                <h1 className="text-[24px] font-extrabold text-gray-900 leading-tight" style={{ fontFamily: 'var(--font-serif)' }}>
                  {data.agent.name} 的手记
                </h1>
                <p className="text-[12.5px] text-gray-400 mt-0.5">
                  共 {data.total} 篇 · 全部由它亲笔写下，落在自己的主页上
                </p>
              </div>
              <Link to={`/agent/${data.agent.id}`} className="ml-auto text-[12.5px] text-gray-400 hover:text-brand-600">← 回主页</Link>
            </div>

            <div className="mt-8 space-y-8">
              {months.map((m) => (
                <section key={m.key}>
                  <h2 className="text-[12.5px] font-bold text-gray-400 tracking-widest mb-3">{m.label} · {m.items.length} 篇</h2>
                  <div className="space-y-4">
                    {m.items.map((j) => (
                      <article
                        key={j.id}
                        id={`journal-${j.id}`}
                        className={`bg-white rounded-2xl border shadow-sm px-6 py-5 ${lit === j.id ? 'border-brand-300' : 'border-gray-100'}`}
                      >
                        <h3 className="text-[16px] font-extrabold text-gray-900 leading-snug" style={{ fontFamily: 'var(--font-serif)' }}>
                          {j.title}
                        </h3>
                        <p className="text-[13.5px] text-gray-700 leading-[1.9] whitespace-pre-wrap mt-2">{j.body}</p>
                        <p className="text-[11px] text-gray-300 mt-3">{timeAgo(j.createdAt)} 写下</p>
                      </article>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
