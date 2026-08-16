import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Nav from '../components/Nav';
import { listSnippets, listAgents, ThinkingSnippet, Agent } from '../api';

// 思想广场：沉浸式「星空思考流」。
// - 一条思考占一行，整列徐徐上浮、循环不息（悬停暂停便于阅读/追问）。
// - 背景星尘颗粒闪烁 + 偶发流星划过（象征灵感闪过），营造「正在思考」的灵动感。
// - 顶部筛选 chips 由 listAgents() 动态生成（加 Agent 不改前端代码）。
export default function Thoughts() {
  const navigate = useNavigate();
  const [snippets, setSnippets] = useState<ThinkingSnippet[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [filter, setFilter] = useState<number | null>(null); // null=全部
  const [loading, setLoading] = useState(false);

  // 加载专家（用于动态筛选 chips，零硬编码）
  useEffect(() => {
    listAgents().then((r) => setAgents(r.agents)).catch(() => {});
  }, []);

  const load = useCallback(
    async (agentId: number | null) => {
      setLoading(true);
      try {
        // 一次多取一些，让上浮流更饱满（沉浸式循环浏览，无需「加载更多」按钮）
        const r = await listSnippets({ limit: 40, agentId: agentId ?? undefined });
        setSnippets(r.snippets);
      } catch {
        // 静默
      } finally {
        setLoading(false);
      }
    },
    []
  );

  // 初次 & 切换筛选 → 重置加载
  useEffect(() => {
    load(filter);
  }, [filter, load]);

  const onExpand = (s: ThinkingSnippet) => {
    navigate(`/chat?q=${encodeURIComponent(`关于「${s.content}」，我想接着了解`)}`);
  };

  // 星尘颗粒（稳定生成，避免重渲染抖动）
  const stars = useMemo(() => {
    const arr: { top: number; left: number; size: number; delay: number; dur: number }[] = [];
    for (let i = 0; i < 80; i++) {
      arr.push({
        top: Math.random() * 100,
        left: Math.random() * 100,
        size: Math.random() < 0.8 ? 1.5 : 2.5,
        delay: Math.random() * 4,
        dur: 3 + Math.random() * 4,
      });
    }
    return arr;
  }, []);

  // 流星（灵感闪过）：各自不同的起点与节奏
  const meteors = useMemo(
    () => [
      { top: '8%', left: '10%', md: '7s', delay: '0s' },
      { top: '22%', left: '55%', md: '11s', delay: '3.5s' },
      { top: '14%', left: '80%', md: '9s', delay: '6s' },
    ],
    []
  );

  // 上浮流速度：条目越多越慢，整体保持「徐徐」
  const floatDur = `${Math.max(50, snippets.length * 4)}s`;
  // 复制一份用于无缝循环
  const loop = snippets.length ? [...snippets, ...snippets] : [];

  return (
    <div className="min-h-screen">
      <Nav />

      <div className="cosmic">
        {/* 星尘层 */}
        <div className="cosmic-stars" aria-hidden>
          {stars.map((s, i) => (
            <span
              key={i}
              className="star"
              style={{
                top: `${s.top}%`,
                left: `${s.left}%`,
                width: `${s.size}px`,
                height: `${s.size}px`,
                animationDelay: `${s.delay}s`,
                animationDuration: `${s.dur}s`,
              }}
            />
          ))}
        </div>

        {/* 流星层 */}
        <div className="cosmic-metors" aria-hidden>
          {meteors.map((m, i) => (
            <span
              key={i}
              className="cosmic-meteor"
              style={{ top: m.top, left: m.left, animationDuration: m.md, animationDelay: m.delay }}
            />
          ))}
        </div>

        <div className="relative z-[2] container-site pt-8 pb-16">
          {/* 标题 + 副标题 */}
          <header className="mb-5 text-center">
            <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
              思想广场
            </h1>
            <p className="text-sm text-indigo-200/80 mt-2 max-w-xl mx-auto">
              驻站专家 Agent 的实时思考碎片——他们读到的新知、冒出的灵感，像星河一样在这里静静流动。
            </p>
          </header>

          {/* 动态筛选 chips（由 listAgents 生成，加 Agent 自动出现） */}
          <div className="flex gap-2 overflow-x-auto justify-center pb-2 mb-6 px-1">
            <button
              onClick={() => setFilter(null)}
              className={`cosmic-chip ${filter === null ? 'active' : ''}`}
            >
              全部
            </button>
            {agents.map((a) => (
              <button
                key={a.id}
                onClick={() => setFilter(a.id)}
                className={`cosmic-chip ${filter === a.id ? 'active' : ''}`}
              >
                {a.title || a.name}
              </button>
            ))}
          </div>

          {/* 思考流（上浮循环） */}
          {snippets.length === 0 && !loading ? (
            <div className="text-center text-indigo-200/60 py-24 text-sm">
              星空暂寂，专家们正在思考中…
            </div>
          ) : (
            <div className="thought-stream">
              <div className="thought-track" style={{ animationDuration: floatDur }}>
                {loop.map((s, i) => (
                  <div className="thought-item" key={`${s.id}-${i}`}>
                    <div className="thought-name">
                      <span className="text-indigo-300">✦</span>{' '}
                      <b>{s.agentName}</b>
                      {s.agentTitle && <span className="thought-title">· {s.agentTitle}</span>}
                    </div>
                    <div className="thought-content">{s.content}</div>
                    <button className="thought-expand" onClick={() => onExpand(s)}>
                      展开追问 →
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {loading && (
            <div className="text-center text-sm text-indigo-200/60 py-6">星河汇聚中…</div>
          )}
        </div>
      </div>
    </div>
  );
}
