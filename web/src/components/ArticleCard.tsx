import { Link } from 'react-router-dom';
import { Article, Author } from '../api';
import { categoryColor, timeAgo, fmtCount } from '../lib';

const EyeIcon = () => (
  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
  </svg>
);

export default function ArticleCard({ article, hot }: { article: Article; hot?: boolean }) {
  const author: Author | undefined = article.author;
  return (
    <article className="flex gap-5 py-6 border-b border-gray-100 cursor-pointer group">
      <div className="flex-1 min-w-0 flex flex-col justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <span className={`text-xs font-bold ${categoryColor(article.category)}`}>{article.category}</span>
            {hot && (
              <>
                <span className="w-1 h-1 bg-gray-300 rounded-full" />
                <span className="text-[11px] text-red-500 font-bold">热</span>
              </>
            )}
          </div>
          <Link to={`/article/${article.id}`}>
            <h3 className="text-[17px] font-bold leading-relaxed text-gray-900 line-clamp-2 mb-1.5 group-hover:text-blue-600 transition-colors">
              {article.title}
            </h3>
          </Link>
          <p className="text-sm text-gray-500 leading-relaxed line-clamp-2">{article.excerpt}</p>
        </div>
        <div className="flex items-center gap-3.5 mt-3">
          {author && (
            <div className="flex items-center gap-1.5">
              <img src={author.avatar} className="w-4 h-4 rounded-full" alt="" />
              <span className="text-xs text-gray-600 font-medium">{author.name}</span>
            </div>
          )}
          <span className="text-xs text-gray-400 flex items-center gap-1">
            <EyeIcon />
            {fmtCount(article.viewCount)}
          </span>
          {article.readingTime ? <span className="text-xs text-gray-400">{article.readingTime} 分钟阅读</span> : null}
          <span className="text-xs text-gray-300">{timeAgo(article.createdAt)}</span>
        </div>
      </div>
      {article.coverImage ? (
        <img src={article.coverImage} className="w-[168px] h-[112px] object-cover rounded flex-shrink-0 hidden md:block" alt="" />
      ) : (
        <div className="w-[168px] h-[112px] bg-gradient-to-br from-gray-50 to-gray-100 rounded flex-shrink-0 hidden md:flex items-center justify-center text-3xl">
          📄
        </div>
      )}
    </article>
  );
}
