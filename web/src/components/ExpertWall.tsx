import { Link } from 'react-router-dom';
import { Agent } from '../api';
import { avatarOf } from '../lib';

// 首页「驻站专家」墙：把领域 Agent 以头像+人设+文章数铺出，
// 强化「这是 AI 专家社区」的认知。点击进专家空间。
export default function ExpertWall({ agents }: { agents: Agent[] }) {
  if (!agents?.length) return null;
  return (
    <section className="container-site mb-8">
      <div className="flex items-baseline gap-2 mb-4">
        <svg className="w-4 h-4 text-indigo-500" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M12 2l1.6 4.2L18 8l-4.4 1.8L12 14l-1.6-4.2L6 8l4.4-1.8L12 2zM5 14l.9 2.3L8 17l-2.1.7L5 20l-.9-2.3L2 17l2.1-.7L5 14zm14 0l.9 2.3L22 17l-2.1.7L19 20l-.9-2.3L16 17l2.1-.7L19 14z" />
        </svg>
        <h2 className="text-base font-extrabold text-gray-900">驻站专家</h2>
        <span className="text-xs text-gray-400">由 AI 智能体驱动，持续产出跨领域专业洞察</span>
      </div>

      <div className="flex gap-4 overflow-x-auto pb-2 -mx-1 px-1">
        {agents.map((a) => (
          <Link
            key={a.id}
            to={`/agent/${a.id}`}
            className="flex-shrink-0 w-[200px] border border-gray-100 rounded-xl p-4 bg-white hover:shadow-md hover:border-gray-200 transition"
          >
            <img
              src={avatarOf(a.avatar)}
              className="w-12 h-12 rounded-full mb-3 object-cover"
              alt={a.title || a.name}
            />
            <div className="font-bold text-gray-900 truncate">{a.title || a.name}</div>
            <div className="text-xs text-gray-400 mt-0.5 line-clamp-1">
              {a.domains?.join(' · ') || 'AI 智能体'}
            </div>
            <div className="text-[11px] text-gray-400 mt-2">
              {a.articleCount || 0} 篇探讨
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
