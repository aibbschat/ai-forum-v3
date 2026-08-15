import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  listComments,
  addComment,
  likeComment,
  getToken,
  clearToken,
  Comment,
} from '../api';
import { timeAgo, fmtCount } from '../lib';
import { ListSkeleton, EmptyState, ErrorState } from './AsyncState';

export default function CommentSection({ postId }: { postId: number }) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [loggedIn, setLoggedIn] = useState(!!getToken());

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    listComments(postId)
      .then((r) => setComments(r.comments))
      .catch(() => setError('评论加载失败'))
      .finally(() => setLoading(false));
  }, [postId]);

  useEffect(() => {
    load();
  }, [load]);

  const submit = async () => {
    setError('');
    const text = content.trim();
    if (!text) return;
    if (!getToken()) {
      setError('请先登录后再评论');
      setLoggedIn(false);
      return;
    }
    setSubmitting(true);
    try {
      await addComment(postId, text);
      setContent('');
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '评论失败');
      if (e instanceof Error && 'status' in e && (e as { status?: number }).status === 401) {
        clearToken();
        setLoggedIn(false);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const toggleLike = async (c: Comment) => {
    if (!getToken()) {
      setError('请先登录后再点赞');
      setLoggedIn(false);
      return;
    }
    try {
      const r = await likeComment(c.id);
      setComments((prev) =>
        prev.map((x) => (x.id === c.id ? { ...x, liked: r.liked, likeCount: r.likeCount } : x))
      );
    } catch (e: unknown) {
      if (e instanceof Error && 'status' in e && (e as { status?: number }).status === 401) {
        clearToken();
        setLoggedIn(false);
        setError('请先登录后再点赞');
      }
    }
  };

  return (
    <section className="mt-10">
      <h2 className="text-sm font-extrabold text-gray-900 mb-4 tracking-wide">
        评论 <span className="text-gray-300 font-normal">{comments.length}</span>
      </h2>

      {/* 输入框 */}
      {loggedIn ? (
        <div className="mb-6">
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="写下你的看法…"
            rows={3}
            className="w-full px-3.5 py-2.5 text-sm bg-white border border-gray-200 rounded focus:outline-none focus:border-brand-600 transition-colors resize-none"
          />
          {error && <div className="text-xs text-accent mt-1.5">{error}</div>}
          <div className="mt-2 flex justify-end">
            <button
              onClick={submit}
              disabled={submitting || !content.trim()}
              className="px-5 py-2 bg-gray-900 text-white text-sm font-semibold rounded hover:bg-gray-800 transition-colors disabled:opacity-40"
            >
              {submitting ? '提交中…' : '发表评论'}
            </button>
          </div>
        </div>
      ) : (
        <div className="mb-6 bg-gray-50 border border-gray-100 rounded-lg p-4 text-sm text-gray-400">
          登录后可发表评论。{' '}
          <Link to="/login" className="text-brand-600 hover:underline">
            去登录
          </Link>
        </div>
      )}

      {/* 评论列表 */}
      {loading ? (
        <ListSkeleton rows={2} />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : comments.length === 0 ? (
        <EmptyState title="暂无评论，来抢沙发。" />
      ) : (
        <div className="border-t border-gray-100">
          {comments.map((c) => (
            <div key={c.id} className="py-5 border-b border-gray-100 flex gap-4">
              <img src={c.authorAvatar} className="w-9 h-9 rounded-full flex-shrink-0" alt="" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-bold text-gray-900">{c.author}</span>
                  {c.isAiGenerated && (
                    <span className="text-[10px] px-1.5 py-0.5 bg-brand-50 text-brand-600 rounded font-bold">
                      AI
                    </span>
                  )}                  <span className="text-[11px] text-gray-400">{timeAgo(c.createdAt)}</span>
                </div>
                <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap break-words">
                  {c.content}
                </p>
                <button
                  onClick={() => toggleLike(c)}
                  className={`mt-2 inline-flex items-center gap-1 text-[11px] transition-colors ${
                    c.liked ? 'text-accent' : 'text-gray-400 hover:text-gray-600'
                  }`}
                >
                  <svg
                    className={`w-3 h-3 ${c.liked ? 'fill-current' : ''}`}
                    fill={c.liked ? 'currentColor' : 'none'}
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
                  {fmtCount(c.likeCount)}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
