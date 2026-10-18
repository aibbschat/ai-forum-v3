import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Nav from '../components/Nav';
import { listExperts, type Expert } from '../api';

/**
 * 百家学院 · 专家页 —— 「问 AI · 向专家提问」的召唤台。
 *
 * 为什么要有这一页：/chat 首屏只留一枚「召唤专家」入口。10 位专家若不配介绍
 * 直接摊在问答页上，第一次来的人只会晕——这里给每位一张完整介绍卡
 * （头衔 / 简介 / 代表观点 / 擅长领域），「召唤」才带仪式感，也才敢点。
 *
 * 召唤 = 跳 /chat?expert=<id>：问答页据此把输入框锁定在这位专家身上。
 * 专家知识库（百家学院既有 &lt;slug&gt;.db）与人格都在后端，这一页只展示公开介绍字段。
 */
export default function Experts() {
  const [experts, setExperts] = useState<Expert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    listExperts()
      .then((r) => setExperts(r.experts || []))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <Nav />

      {/* 页头：深色渐变带一点星光，与「百家」的气质相配，也把它和列表页区分开 */}
      <div className="relative overflow-hidden bg-gradient-to-b from-indigo-950 via-indigo-900 to-violet-900">
        <div className="pointer-events-none absolute inset-0" aria-hidden>
          <div className="absolute -top-24 left-1/2 -translate-x-1/2 w-[560px] h-[320px] rounded-full bg-violet-500/20 blur-3xl" />
          <div className="absolute right-[12%] bottom-[-60px] w-[300px] h-[300px] rounded-full bg-indigo-400/20 blur-3xl" />
          {/* 三枚漂浮专家符号，点缀"这里坐着很多人" */}
          <span className="absolute left-[10%] top-[28%] text-2xl opacity-25 rotate-[-8deg] select-none">📜</span>
          <span className="absolute left-[78%] top-[22%] text-2xl opacity-25 rotate-[10deg] select-none">🤖</span>
          <span className="absolute left-[64%] bottom-[26%] text-xl opacity-20 rotate-[-6deg] select-none">🌿</span>
        </div>
        <div className="relative container-site text-center py-12 sm:py-16">
          <div className="text-[11px] font-bold tracking-[0.4em] text-indigo-300">AI 圈 · 百家学院</div>
          <h1 className="mt-3 text-3xl sm:text-4xl font-black tracking-tight text-white">召唤一位专家</h1>
          <p className="mt-3 text-sm sm:text-[15px] text-indigo-200/80 max-w-xl mx-auto leading-relaxed">
            每位专家都带着自己深耕多年的知识库。挑一位，点「召唤」，接下来就是你们俩的对话。
          </p>
          <div className="mt-4 inline-flex items-center gap-2 text-[11.5px] text-indigo-300/70">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            {loading ? '正在点名…' : `${experts.length} 位专家在线候场`}
          </div>
        </div>
      </div>

      {/* 专家卡片 */}
      <div className="flex-1 container-site max-w-[1000px] mx-auto px-4 py-8 sm:py-10">
        {error ? (
          <div className="text-center text-sm text-gray-400 py-16">专家名单加载失败，刷新试试。</div>
        ) : loading ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="rounded-2xl border border-gray-200 bg-white p-5 animate-pulse">
                <div className="flex items-center gap-3.5">
                  <div className="w-12 h-12 rounded-2xl bg-gray-100" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 w-24 bg-gray-100 rounded" />
                    <div className="h-3 w-32 bg-gray-50 rounded" />
                  </div>
                </div>
                <div className="mt-4 h-3 w-full bg-gray-50 rounded" />
                <div className="mt-2 h-3 w-4/5 bg-gray-50 rounded" />
              </div>
            ))}
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {experts.map((e) => (
              <div
                key={e.id}
                className="group relative flex flex-col gap-3 rounded-2xl border border-gray-200 bg-white p-5 hover:border-indigo-300 hover:shadow-[0_8px_30px_-12px_rgba(79,70,229,0.25)] transition-all"
              >
                <div className="flex items-start gap-3.5">
                  <span className="w-12 h-12 rounded-2xl bg-gradient-to-b from-gray-50 to-gray-100 border border-gray-100 flex items-center justify-center text-[26px] shrink-0 group-hover:scale-105 transition-transform">
                    {e.icon || '💬'}
                  </span>
                  <div className="min-w-0 flex-1 pt-0.5">
                    <div className="flex items-center gap-2">
                      <h3 className="text-[16px] font-bold text-gray-900 truncate">{e.name}</h3>
                      {e.category && (
                        <span className="shrink-0 text-[10.5px] font-semibold text-indigo-600 bg-indigo-50 rounded-full px-2 py-0.5">
                          {e.category}
                        </span>
                      )}
                    </div>
                    {e.title && <div className="text-xs text-gray-400 mt-1 truncate">{e.title}</div>}
                  </div>
                </div>

                {e.bio && (
                  <p className="text-[13px] leading-relaxed text-gray-600 line-clamp-3">{e.bio}</p>
                )}

                {e.quote && (
                  <p className="text-xs text-gray-400 italic line-clamp-2 border-l-2 border-indigo-100 pl-2.5">
                    {e.quote}
                  </p>
                )}

                {Array.isArray(e.domains) && e.domains.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {e.domains.slice(0, 4).map((d) => (
                      <span key={d} className="text-[11px] text-gray-500 bg-gray-50 border border-gray-100 rounded-md px-1.5 py-0.5">
                        {d}
                      </span>
                    ))}
                  </div>
                )}

                <div className="mt-auto pt-1 flex items-center justify-between">
                  <span className="text-[11px] text-gray-300 group-hover:text-indigo-300 transition-colors select-none">
                    答案溯源到 TA 的知识库
                  </span>
                  <Link
                    to={`/chat?expert=${e.id}`}
                    className="inline-flex items-center gap-1 text-[13px] font-bold text-white bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 rounded-full py-2 pl-4 pr-[18px] transition shadow-sm"
                  >
                    ⚡ 召唤
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* 兜底：不想挑专家也能直接聊 */}
        <div className="mt-8 text-center text-[13px] text-gray-400">
          还没想好问谁？
          <Link to="/chat" className="text-indigo-500 hover:text-indigo-700 font-medium ml-1">
            直接问 AI 圈（通用问答）›
          </Link>
        </div>
      </div>
    </div>
  );
}
