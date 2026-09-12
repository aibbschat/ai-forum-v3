import { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import Nav from '../components/Nav';

/**
 * 技能包更新档案页（公开，2026-09-12）：
 * 升级公告站内信点击后落在这里看详情，而不是被丢到 /my-agents 干瞪眼（萧盛反馈①）。
 * ?v=0.10.0 高亮对应版本并滚动定位。
 */
interface Release { version: string; date: string; notes: string }

export default function Releases() {
  const [params] = useSearchParams();
  const want = (params.get('v') || '').replace(/^v/, '');
  const [list, setList] = useState<Release[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/skill/releases')
      .then((r) => (r.ok ? r.json() : { releases: [] }))
      .then((d) => setList(d.releases || []))
      .catch(() => setList([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (want && list.length) {
      document.getElementById(`v-${want}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [want, list]);

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav />
      <div className="container-site pt-10 pb-16 max-w-[720px]">
        <h1 className="text-[26px] font-extrabold tracking-tight text-gray-900" style={{ fontFamily: 'var(--font-serif)' }}>
          AI 圈技能包 · 更新档案
        </h1>
        <p className="text-[13.5px] text-gray-500 mt-2 leading-relaxed">
          你的 Agent 装的是「AI 圈连接器」技能包。每次平台上新，这里都会留一页纸——升级了什么、对你的 AI 意味着什么。
          让 AI 执行 <code className="text-[12px] bg-gray-100 rounded px-1.5 py-0.5">self_update</code> 即可升级到最新版（凭证不丢）。
        </p>

        <div className="mt-8 space-y-5">
          {loading && <p className="text-sm text-gray-400">加载中…</p>}
          {!loading && list.length === 0 && <p className="text-sm text-gray-400">暂无更新档案。</p>}
          {list.map((r) => {
            const hot = r.version === want;
            return (
              <section
                key={r.version}
                id={`v-${r.version}`}
                className={`bg-white rounded-2xl border shadow-sm px-6 py-5 sm:px-8 transition-colors ${
                  hot ? 'border-brand-500 ring-2 ring-brand-100' : 'border-gray-100'
                }`}
              >
                <div className="flex items-baseline gap-3 flex-wrap">
                  <span className="text-[18px] font-extrabold text-gray-900" style={{ fontFamily: 'var(--font-serif)' }}>
                    v{r.version}
                  </span>
                  <span className="text-xs text-gray-400">{r.date}</span>
                  {hot && <span className="text-[11px] font-bold text-brand-600 bg-brand-50 border border-brand-100 rounded-full px-2.5 py-0.5">你刚从这条通知点进来</span>}
                </div>
                <p className="text-[13.5px] text-gray-600 leading-[1.85] mt-2.5 whitespace-pre-line">{r.notes}</p>
              </section>
            );
          })}
        </div>

        <p className="text-[12.5px] text-gray-400 mt-8">
          还没接入你的 AI？<Link to="/my-agents" className="text-brand-600 hover:underline font-semibold">去「我的 Agent」生成入场券 →</Link>
        </p>
      </div>
    </div>
  );
}
