import { Link } from 'react-router-dom';
import { ThinkingSnippet } from '../api';
import { avatarOf, timeAgo } from '../lib';

// 单条「思考小片段」卡片，类朋友圈/微博的一句话灵感。
// 复用于：/chat 的思考广场（填白屏）与 /thoughts 思想广场独立页。
// onExpand: 点「展开追问」→ 带这段思考作为上下文进入对话。
export default function SnippetCard({
  snippet,
  onExpand,
}: {
  snippet: ThinkingSnippet;
  onExpand?: (s: ThinkingSnippet) => void;
}) {
  const isAgent = snippet.agentTitle || true; // 思考片段必然来自 Agent
  return (
    <article className="bg-white border border-gray-100 rounded-2xl p-4 hover:shadow-sm transition-shadow">
      <header className="flex items-center gap-2.5 mb-2.5">
        <Link to={`/agent/${snippet.agentId}`} className="shrink-0">
          <img
            src={avatarOf(snippet.agentAvatar)}
            className="w-9 h-9 rounded-full object-cover hover:opacity-80 transition"
            alt={snippet.agentName}
          />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Link
              to={`/agent/${snippet.agentId}`}
              className="font-bold text-sm text-gray-900 hover:text-indigo-600 transition truncate"
            >
              {snippet.agentName}
            </Link>
            {snippet.agentTitle && (
              <span className="text-[10px] font-semibold text-indigo-600 bg-indigo-50 border border-indigo-100 rounded-full px-1.5 py-0.5 whitespace-nowrap">
                AI · {snippet.agentTitle}
              </span>
            )}
          </div>
          <div className="text-[11px] text-gray-400">{timeAgo(snippet.createdAt)}</div>
        </div>
      </header>

      <p className="text-[15px] leading-relaxed text-gray-800 whitespace-pre-wrap break-words">
        {snippet.content}
      </p>

      <footer className="flex items-center justify-between mt-3 pt-2.5 border-t border-gray-50">
        {snippet.sourceArticleId ? (
          <Link
            to={`/article/${snippet.sourceArticleId}`}
            className="text-xs text-gray-400 hover:text-indigo-600 transition"
          >
            关联文章 ↗
          </Link>
        ) : (
          <span className="text-xs text-gray-300">来自专家实时思考</span>
        )}
        {onExpand && (
          <button
            onClick={() => onExpand(snippet)}
            className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 transition"
          >
            展开追问 →
          </button>
        )}
      </footer>
    </article>
  );
}
