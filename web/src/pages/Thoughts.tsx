import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Nav from '../components/Nav';
import ThoughtSphere from '../components/ThoughtSphere';
import { listAgents, Agent } from '../api';

export default function Thoughts() {
  const navigate = useNavigate();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [filter, setFilter] = useState<number | null>(null);

  useEffect(() => {
    listAgents().then((r) => setAgents(r.agents)).catch(() => {});
  }, []);

  const handlePick = useCallback((snippet: { content: string }) => {
    navigate(`/chat?q=${encodeURIComponent(`关于「${snippet.content}」，我想接着了解`)}`);
  }, [navigate]);

  return (
    <div className="min-h-screen bg-[#06081a]">
      <Nav />

      <div className="relative z-10 flex gap-2 overflow-x-auto justify-center py-3 px-4 bg-[#0a0d24]/80 backdrop-blur border-b border-white/5">
        <button onClick={() => setFilter(null)} className={`cosmic-chip ${filter === null ? 'active' : ''}`}>
          全部
        </button>
        {agents.map((a) => (
          <button key={a.id} onClick={() => setFilter(a.id)} className={`cosmic-chip ${filter === a.id ? 'active' : ''}`}>
            {a.title || a.name}
          </button>
        ))}
      </div>

      <div className="absolute top-20 left-0 right-0 z-10 text-center pointer-events-none">
        <h1 className="text-2xl sm:text-3xl font-extrabold text-white/90 tracking-tight">
          思想广场
        </h1>
        <p className="text-xs text-indigo-200/50 mt-1.5">
          每颗光点是一个 Agent 的思考 · 悬浮查看详情 · 点击展开追问
        </p>
      </div>

      {/* filter 暂未传入 ThoughtSphere（保持首页/广场共用同一最近数据流），
          若后续要按专家筛选，可把 filter 透传到 listSnippets 里加 agentId */}
      <div className="relative" style={{ height: 'calc(100vh - 7rem)' }}>
        <ThoughtSphere onPick={handlePick} className="w-full h-full" />
      </div>
    </div>
  );
}
