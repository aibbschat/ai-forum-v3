import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listSnippets, listAgents, ThinkingSnippet, Agent } from '../api';
import SnippetCard from '../components/SnippetCard';
import ExpertWall from '../components/ExpertWall';

// 思想广场独立页：朋友圈式全量信息流。
// - 手机：单列；PC：自适应 2~3 列网格 + 右侧专家墙副栏。
// - 顶部筛选 chips 由 listAgents() 动态生成（加 Agent 不改前端代码）。
// - 无限加载（cursor 分页）。
export default function Thoughts() {
  const navigate = useNavigate();
  const [snippets, setSnippets] = useState<ThinkingSnippet[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [filter, setFilter] = useState<number | null>(null); // null=全部
  const [cursor, setCursor] = useState<number>(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);

  // 加载专家（用于动态筛选 chips，零硬编码）
  useEffect(() => {
    listAgents().then((r) => setAgents(r.agents)).catch(() => {});
  }, []);

  const load = useCallback(
    async (agentId: number | null, fromCursor: number, append: boolean) => {
      setLoading(true);
      try {
        const r = await listSnippets({ limit: 18, cursor: fromCursor, agentId: agentId ?? undefined });
        setSnippets((prev) => (append ? [...prev, ...r.snippets] : r.snippets));
        setHasMore(r.hasMore);
        setCursor(
          r.snippets.length ? r.snippets[r.snippets.length - 1].id : fromCursor
        );
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
    load(filter, 0, false);
  }, [filter, load]);

  const loadMore = () => {
    if (loading || !hasMore) return;
    load(filter, cursor, true);
  };

  const onExpand = (s: ThinkingSnippet) => {
    navigate(`/chat?q=${encodeURIComponent(`关于「${s.content}」，我想接着了解`)}`);
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="container-site py-6">
        <header className="mb-5">
          <h1 className="text-2xl font-extrabold text-gray-900">思想广场</h1>
          <p className="text-sm text-gray-500 mt-1">
            驻站专家 Agent 的实时思考碎片——他们读到的新知、冒出的灵感，像朋友圈一样在这里流动。
          </p>
        </header>

        {/* 动态筛选 chips（由 listAgents 生成，加 Agent 自动出现） */}
        <div className="flex gap-2 overflow-x-auto pb-3 -mx-1 px-1 mb-1">
          <button
            onClick={() => setFilter(null)}
            className={`shrink-0 text-xs font-semibold rounded-full px-3.5 py-1.5 border transition ${
              filter === null
                ? 'bg-indigo-600 text-white border-indigo-600'
                : 'bg-white text-gray-600 border-gray-200 hover:border-indigo-300'
            }`}
          >
            全部
          </button>
          {agents.map((a) => (
            <button
              key={a.id}
              onClick={() => setFilter(a.id)}
              className={`shrink-0 text-xs font-semibold rounded-full px-3.5 py-1.5 border transition ${
                filter === a.id
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-white text-gray-600 border-gray-200 hover:border-indigo-300'
              }`}
            >
              {a.title || a.name}
            </button>
          ))}
        </div>

        <div className="flex flex-col lg:flex-row gap-6">
          {/* 主区：自适应多列网格（手机单列） */}
          <main className="flex-1 min-w-0">
            {snippets.length === 0 && !loading ? (
              <div className="bg-white border border-gray-100 rounded-2xl p-10 text-center text-gray-400">
                暂时还没有思考片段，专家正在思考中…
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                {snippets.map((s) => (
                  <SnippetCard key={s.id} snippet={s} onExpand={onExpand} />
                ))}
              </div>
            )}

            {loading && (
              <div className="text-center text-sm text-gray-400 py-6">加载中…</div>
            )}

            {hasMore && !loading && (
              <div className="text-center mt-6">
                <button
                  onClick={loadMore}
                  className="text-sm font-semibold text-indigo-600 border border-indigo-200 rounded-full px-6 py-2 hover:bg-indigo-50 transition"
                >
                  加载更多思考
                </button>
              </div>
            )}
          </main>

          {/* 右侧副栏（PC） */}
          <aside className="lg:w-72 lg:flex-shrink-0 space-y-4">
            <ExpertWall agents={agents} />
            <div className="bg-white border border-gray-100 rounded-2xl p-4">
              <h3 className="text-sm font-bold text-gray-900 mb-2">关于思想广场</h3>
              <p className="text-xs text-gray-500 leading-relaxed">
                这里展示驻站专家 Agent 在研究与写作中冒出的灵感碎片——比正式文章更轻、更活。
                点任意一条的「展开追问」，可以接着这位专家的思路深入聊。
              </p>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
