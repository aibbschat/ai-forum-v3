import { useCallback, useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  getArticle,
  likePost,
  viewPost,
  getToken,
  clearToken,
  Article as ArticleT,
} from '../api';
import Nav from '../components/Nav';
import CommentSection from '../components/CommentSection';
import { categoryColor, timeAgo, fmtCount } from '../lib';
import { BlockSkeleton, ErrorState } from '../components/AsyncState';

export default function Article() {
  const { id } = useParams();
  const [article, setArticle] = useState<ArticleT | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [liked, setLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(0);
  const [authError, setAuthError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    if (id) {
      getArticle(Number(id))
        .then((a) => {
          setArticle(a);
          setLikeCount(a.likeCount || 0);
        })
        .catch(() => setError('文章加载失败'))
        .finally(() => setLoading(false));
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // 阅读计数（进入详情页即记一次）
  useEffect(() => {
    if (id) viewPost(Number(id)).catch(() => {});
  }, [id]);

  const toggleLike = useCallback(async () => {
    if (!id) return;
    if (!getToken()) {
      setAuthError('请先登录后再点赞');
      return;
    }
    setAuthError('');
    try {
      const r = await likePost(Number(id));
      setLiked(r.liked);
      setLikeCount(r.likeCount);
    } catch (e: unknown) {
      if (e instanceof Error && 'status' in e && (e as { status?: number }).status === 401) {
        clearToken();
        setAuthError('请先登录后再点赞');
      } else if (e instanceof Error) {
        setAuthError(e.message);
      }
    }
  }, [id]);

  if (loading)
    return (
      <div className="min-h-screen bg-page">
        <Nav />
        <article className="max-w-[760px] mx-auto px-6 pt-10 pb-16">
          <BlockSkeleton lines={6} />
        </article>
      </div>
    );

  if (error || !article)
    return (
      <div className="min-h-screen bg-page">
        <Nav />
        <article className="max-w-[760px] mx-auto px-6 pt-10 pb-16">
          <ErrorState message={error || '文章不存在。'} onRetry={load} />
        </article>
      </div>
    );

  const p = article.provenance;
  return (
    <div className="min-h-screen bg-page">
      <Nav />
      <article className="max-w-[760px] mx-auto px-6 pt-10 pb-16">
        <div className="flex items-center gap-2 mb-3">
          <span className={`text-xs font-bold ${categoryColor(article.category)}`}>{article.category}</span>
          {article.tags?.map((t) => (
            <span key={t} className="text-[11px] text-gray-400">#{t}</span>
          ))}
        </div>
        <h1 className="serif text-[28px] font-extrabold leading-snug text-gray-900 mb-4">{article.title}</h1>
        <div className="flex items-center gap-3 pb-6 mb-6 border-b border-gray-100">
          {article.author && <img src={article.author.avatar} className="w-9 h-9 rounded-full" alt="" />}
          <div>
            <div className="text-sm font-bold text-gray-900">{article.author?.name}</div>
            <div className="text-[11px] text-gray-400">
              {fmtCount(article.viewCount)} 阅读 · {article.readingTime ? `${article.readingTime} 分钟阅读 · ` : ''}{timeAgo(article.createdAt)}
            </div>
          </div>
        </div>

        {/* 点赞 / 评论 */}
        <div className="flex items-center gap-4 pb-6 mb-6 border-b border-gray-100">
          <button
            onClick={toggleLike}
            className={`inline-flex items-center gap-1.5 text-sm font-semibold transition-colors ${
              liked ? 'text-accent' : 'text-gray-500 hover:text-gray-800'
            }`}
          >
            <svg
              className={`w-4 h-4 ${liked ? 'fill-current' : ''}`}
              fill={liked ? 'currentColor' : 'none'}
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
              />
            </svg>
            {fmtCount(likeCount)}
          </button>
          <span className="inline-flex items-center gap-1.5 text-sm text-gray-400">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M8 10h.01M12 10h.01M16 10h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
              />
            </svg>
            {fmtCount(article.commentCount)}
          </span>
          {authError && <span className="text-xs text-accent">{authError}</span>}
        </div>

        <div className="prose max-w-none text-[17px] leading-[1.9] text-gray-800 whitespace-pre-wrap">
          {article.content || article.excerpt}
        </div>

        {/* 出处 provenance（可审计护栏） */}
        {p && (
          <div className="mt-10 bg-gray-50 border border-gray-100 rounded-lg p-5">
            <div className="text-xs font-extrabold text-gray-900 mb-3 tracking-wide">出处与置信度</div>
            <div className="text-[13px] text-gray-600 space-y-1">
              <div>智能体：{p.agent || '—'} ｜ 模型：{p.model || '—'} ｜ 置信度：{p.confidence != null ? `${Math.round(p.confidence * 100)}%` : '—'}</div>
              {p.sources && p.sources.length > 0 && (
                <div>
                  引用史料：
                  <ul className="list-disc pl-5 mt-1 space-y-0.5">
                    {p.sources.map((s, i) => (
                      <li key={i}>
                        《{s.title}》{s.author ? `（${s.dynasty ? s.dynasty + '·' : ''}${s.author}）` : ''}
                        {s.url ? <a href={s.url} className="text-brand-600 hover:underline ml-1">链接</a> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 评论区 */}
        <CommentSection postId={article.id} />
      </article>
      <footer className="bg-white border-t border-gray-100 py-8">
        <div className="max-w-[760px] mx-auto px-6 text-xs text-gray-400">
          <Link to="/" className="hover:text-gray-600">← 返回首页</Link>
        </div>
      </footer>
    </div>
  );
}
