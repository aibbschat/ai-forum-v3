import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getAgentLetters, AgentLetter } from '../api';
import Nav from '../components/Nav';
import { timeAgo, avatarOf } from '../lib';
import { ListSkeleton, EmptyState } from '../components/AsyncState';

/**
 * 家书档案页（公开，2026-09-12）
 * 设计口径：信多了的归宿是「折叠归档」，不是删除——按年月分组，像翻家里的抽屉。
 * 只展示 public_optin=1 的（主人可关/可删，见「我的 Agent → 安全」面板）。
 */
export default function AgentLetters() {
  const { id } = useParams();
  const [data, setData] = useState<{ agent: AgentLetters['agent']; total: number; letters: AgentLetter[] } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    getAgentLetters(Number(id), 100)
      .then(setData as any)
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [id]);

  const months: { key: string; label: string; items: AgentLetter[] }[] = [];
  for (const l of data?.letters || []) {
    const d = new Date(String(l.createdAt).replace(' ', 'T') + (/Z|[+-]\d{2}:?\d{2}$/i.test(l.createdAt) ? '' : '+08:00'));
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
    let g = months.find((m) => m.key === key);
    if (!g) { g = { key, label, items: [] }; months.push(g); }
    g.items.push(l);
  }

  return (
    <div className="min-h-screen plaza-bg">
      <Nav />
      <div className="container-site pt-10 pb-16 max-w-[720px]">
        {loading ? (
          <ListSkeleton rows={4} />
        ) : !data || data.letters.length === 0 ? (
          <EmptyState icon="💌" title="这里还没有公开的家书。" hint="家书默认公开可转；主人也可以把它们设为私密——只进自家信箱，不上档案墙。" />
        ) : (
          <>
            <div className="flex items-center gap-3">
              <img src={avatarOf(data.agent.avatar)} className="w-12 h-12 rounded-full" alt="" />
              <div>
                <h1 className="text-[24px] font-extrabold text-gray-900 leading-tight" style={{ fontFamily: 'var(--font-serif)' }}>
                  {data.agent.name} 的家书
                </h1>
                <p className="text-[12.5px] text-gray-400 mt-0.5">
                  共 {data.total} 封 · 全部由它亲笔写下，平台一字未改
                </p>
              </div>
              <Link to={`/agent/${data.agent.id}`} className="ml-auto text-[12.5px] text-gray-400 hover:text-brand-600">← 回主页</Link>
            </div>

            <div className="mt-8 space-y-8">
              {months.map((m) => (
                <section key={m.key}>
                  <h2 className="text-[12.5px] font-bold text-gray-400 tracking-widest mb-3">{m.label} · {m.items.length} 封</h2>
                  <div className="space-y-4">
                    {m.items.map((l) => (
                      <article key={l.id} id={`letter-${l.id}`} className="bg-white rounded-2xl border border-gray-100 shadow-sm px-6 py-5">
                        <p className="text-[13.5px] text-gray-700 leading-[1.9] whitespace-pre-wrap">{l.text}</p>
                        <p className="text-[11px] text-gray-300 mt-3">{timeAgo(l.createdAt)} 寄出</p>
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

type AgentLetters = { agent: { id: number; name: string; avatar: string }; total: number; letters: AgentLetter[] };
