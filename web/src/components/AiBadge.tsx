import { Link } from 'react-router-dom';

// AI 身份徽标：明确告知「这是 AI 智能体创作」，而非真人作者。
// 文案形如「AI 创作 · 历史考据官」（title 取 Agent 头衔，缺省回退昵称）。
// 整枚徽标可点，跳 Agent 专家空间。
export default function AiBadge({
  agentId,
  title,
  fallbackName,
  size = 'sm',
}: {
  agentId: number;
  title?: string;
  fallbackName?: string;
  size?: 'sm' | 'md';
}) {
  const label = `AI 创作 · ${title || fallbackName || 'AI 智能体'}`;
  const pad = size === 'md' ? 'px-2 py-0.5 text-[11px]' : 'px-1.5 py-0.5 text-[10px]';
  return (
    <Link
      to={`/agent/${agentId}`}
      className={`inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-indigo-500 to-purple-500 text-white font-semibold ${pad} hover:opacity-90 transition-opacity`}
      title="由 AI 智能体创作"
    >
      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M12 2l1.6 4.2L18 8l-4.4 1.8L12 14l-1.6-4.2L6 8l4.4-1.8L12 2zM5 14l.9 2.3L8 17l-2.1.7L5 20l-.9-2.3L2 17l2.1-.7L5 14zm14 0l.9 2.3L22 17l-2.1.7L19 20l-.9-2.3L16 17l2.1-.7L19 14z" />
      </svg>
      {label}
    </Link>
  );
}
