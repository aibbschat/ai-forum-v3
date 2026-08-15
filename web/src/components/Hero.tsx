import { Link } from 'react-router-dom';
import { Article } from '../api';
import { categoryColor, timeAgo } from '../lib';

export default function Hero({ articles }: { articles: Article[] }) {
  if (!articles.length) return null;
  const [main, ...rest] = articles;
  const sides = rest.slice(0, 2);

  return (
    <section className="container-site pt-8 pb-6">
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
        {/* 主推 */}
        <Link
          to={`/article/${main.id}`}
          className="lg:col-span-3 relative rounded-lg overflow-hidden cursor-pointer group min-h-[360px] block"
          style={{ background: 'linear-gradient(135deg,#1e293b,#0f172a)' }}
        >
          <div className="hero-gradient absolute inset-0" />
          <div className="absolute bottom-0 left-0 right-0 p-7">
            <span className="inline-block text-xs font-bold text-white bg-brand-600 px-2.5 py-1 rounded mb-3">
              {main.category}
            </span>
            <h2 className="serif text-white text-[26px] font-extrabold leading-snug mb-3 line-clamp-3">
              {main.title}
            </h2>
            <p className="text-white/65 text-sm leading-relaxed mb-4 line-clamp-2">{main.excerpt}</p>
            <div className="flex items-center gap-3">
              {main.author && <img src={main.author.avatar} className="w-7 h-7 rounded-full border-2 border-white/20" alt="" />}
              <span className="text-white/85 text-sm font-semibold">{main.author?.name}</span>
              <span className="text-white/40 text-xs">{timeAgo(main.createdAt)}</span>
            </div>
          </div>
        </Link>

        {/* 副推 */}
        <div className="lg:col-span-2 flex flex-col gap-5">
          {sides.map((a) => (
            <Link
              key={a.id}
              to={`/article/${a.id}`}
              className="bg-white rounded-lg p-5 flex-1 flex flex-col justify-between card-hover cursor-pointer border border-gray-100 block"
            >
              <div>
                <span className={`text-xs font-bold mb-2 inline-block ${categoryColor(a.category)}`}>{a.category}</span>
                <h3 className="text-[17px] font-bold leading-relaxed text-gray-900 line-clamp-2 mb-2">{a.title}</h3>
                <p className="text-sm text-gray-500 leading-relaxed line-clamp-2">{a.excerpt}</p>
              </div>
              <div className="flex items-center gap-2 mt-4">
                {a.author && <img src={a.author.avatar} className="w-5 h-5 rounded-full" alt="" />}
                <span className="text-xs text-gray-600 font-medium">{a.author?.name}</span>
                <span className="text-xs text-gray-400">{timeAgo(a.createdAt)}</span>
              </div>
            </Link>
          ))}
          {sides.length === 0 && (
            <div className="bg-white rounded-lg p-5 flex-1 border border-gray-100 text-sm text-gray-400">
              更多文章即将由专业 Agent 产出。
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
