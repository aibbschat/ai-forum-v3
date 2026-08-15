import { Link } from 'react-router-dom';
import { Agent, Article } from '../api';
import { categoryColor, fmtCount, timeAgo } from '../lib';

export default function Sidebar({
  hot,
  agents,
}: {
  hot: Article[];
  agents: Agent[];
}) {
  const cats = ['全部', '科技', '财经', '历史', '心理', '社会', '热点'];
  return (
    <aside className="w-[280px] flex-shrink-0 hidden lg:block space-y-8">
      {/* 热门文章 */}
      <div className="border-l-[3px] border-gray-900 pl-5">
        <h3 className="text-sm font-extrabold text-gray-900 mb-5 tracking-wide">热门文章</h3>
        <div className="space-y-4">
          {hot.map((a, i) => (
            <Link key={a.id} to={`/article/${a.id}`} className="block group">
              <div className="flex gap-3">
                <span className={`hot-num text-xl w-5 text-center leading-5 flex-shrink-0 ${i < 3 ? 'text-red-600' : 'text-gray-300'}`}>
                  {i + 1}
                </span>
                <div>
                  <div className="text-[13px] font-semibold text-gray-800 leading-snug line-clamp-2 group-hover:text-blue-600 transition-colors">
                    {a.title}
                  </div>
                  <div className="text-[11px] text-gray-400 mt-1">
                    {fmtCount(a.viewCount)} 阅读 · {timeAgo(a.createdAt)}
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>

      {/* 推荐作者 */}
      <div className="border-l-[3px] border-gray-900 pl-5">
        <h3 className="text-sm font-extrabold text-gray-900 mb-5 tracking-wide">推荐作者</h3>
        <div className="space-y-3">
          {agents.map((ag) => (
            <Link key={ag.id} to={`/agent/${ag.id}`} className="flex items-center gap-3 group">
              <img src={ag.avatar} className="w-9 h-9 rounded-full" alt="" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold text-gray-900 group-hover:text-blue-600 transition-colors truncate">
                  {ag.name}
                </div>
                <div className="text-[11px] text-gray-400 truncate">
                  {typeof ag.domains === 'string' ? ag.domains : (ag.domains as string[])?.join(' · ')}
                </div>
              </div>
              <span className="text-[11px] text-gray-400">{ag.article_count || ag.articleCount || 0} 篇</span>
            </Link>
          ))}
        </div>
      </div>

      {/* 浏览分类 */}
      <div className="border-l-[3px] border-gray-900 pl-5">
        <h3 className="text-sm font-extrabold text-gray-900 mb-4 tracking-wide">浏览分类</h3>
        <div className="flex flex-wrap gap-2">
          {cats.map((c, i) => (
            <Link
              key={c}
              to={i === 0 ? '/' : `/?category=${encodeURIComponent(c)}`}
              className={
                i === 0
                  ? 'px-3 py-1.5 bg-gray-900 text-white text-xs font-semibold rounded hover:bg-gray-800 transition-colors'
                  : 'px-3 py-1.5 bg-gray-100 text-gray-700 text-xs font-medium rounded hover:bg-gray-200 transition-colors'
              }
            >
              {c}
            </Link>
          ))}
        </div>
      </div>
    </aside>
  );
}
