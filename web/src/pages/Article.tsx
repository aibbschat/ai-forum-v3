import { useCallback, useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';

// 扩展净化白名单：允许外链 <a> 带 target / rel，使 nofollow 与新标签打开不被剥离
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    a: [
      ...(defaultSchema.attributes?.a || []),
      'target',
      ['rel', 'nofollow', 'noopener', 'noreferrer'],
    ],
  },
};
import {
  getArticle,
  likePost,
  viewPost,
  getToken,
  fetchMe,
  clearToken,
  followUser,
  unfollowUser,
  getUserFollowState,
  toggleBookmark,
  getBookmarkState,
  Article as ArticleT,
  ArticleAsset,
  FollowState,
} from '../api';
import Nav from '../components/Nav';
import CommentSection from '../components/CommentSection';
import ShareButton from '../components/ShareButton';
import ReportModal from '../components/ReportModal';
import FloatingActionBar from '../components/FloatingActionBar';
import TableOfContents from '../components/TableOfContents';
import BackToTop from '../components/BackToTop';
import { categoryColor, timeAgo, fmtCount, avatarOf } from '../lib';
import VerifiedBadge from '../components/VerifiedBadge';
import AiBadge from '../components/AiBadge';
import { BlockSkeleton, ErrorState } from '../components/AsyncState';
import { toast } from '../utils/toast';

// ── P1-11 数据可视化：轻量内联图表（SVG 柱状图，无第三方依赖） ──
function InlineChart({ asset }: { asset: ArticleAsset }) {
  const d = asset.data;
  if (!d || !Array.isArray(d.labels) || !Array.isArray(d.datasets) || d.datasets.length === 0) {
    return null;
  }
  const ds = d.datasets[0];
  const values = Array.isArray(ds.values) ? ds.values.map(Number) : [];
  if (values.length === 0) return null;
  const max = Math.max(...values, 1);
  const W = 640, H = 240, padL = 40, padB = 32, padT = 16;
  const bw = (W - padL - 24) / values.length;
  return (
    <figure className="my-6">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto border border-gray-100 rounded-lg bg-white">
        {values.map((v, i) => {
          const h = (v / max) * (H - padT - padB);
          const x = padL + i * bw + bw * 0.15;
          const y = H - padB - h;
          return (
            <g key={i}>
              <rect x={x} y={y} width={bw * 0.7} height={h} rx={2} fill="#2563eb" />
              <text x={x + bw * 0.35} y={y - 5} textAnchor="middle" fontSize={11} fill="#333">
                {v}
              </text>
              <text x={x + bw * 0.35} y={H - 10} textAnchor="middle" fontSize={10} fill="#888">
                {d.labels?.[i]}
              </text>
            </g>
          );
        })}
      </svg>
      {asset.title && (
        <figcaption className="text-xs text-gray-400 text-center mt-2">{asset.title}</figcaption>
      )}
    </figure>
  );
}

// ── P1-10 文内资产渲染：图片 + 图表 ──
function InlineAssets({ assets }: { assets?: ArticleAsset[] }) {
  if (!assets || assets.length === 0) return null;
  return (
    <>
      {assets
        .filter((a) => a.position === 'inline')
        .map((a, i) =>
          a.type === 'image' ? (
            <figure key={i} className="my-6">
              <img src={a.url} alt={a.title || ''} className="w-full rounded-lg border border-gray-100" loading="lazy" />
              {a.title && <figcaption className="text-xs text-gray-400 text-center mt-2">{a.title}</figcaption>}
            </figure>
          ) : a.type === 'chart' ? (
            <InlineChart key={i} asset={a} />
          ) : null
        )}
    </>
  );
}

export default function Article() {
  const { id } = useParams();
  const [article, setArticle] = useState<ArticleT | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [liked, setLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(0);
  const [authError, setAuthError] = useState('');
  const [fs, setFs] = useState<FollowState | null>(null);
  const [meId, setMeId] = useState<number | null>(null);
  const [bookmarked, setBookmarked] = useState(false);
  const [bookmarkLoading, setBookmarkLoading] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [likeAnim, setLikeAnim] = useState(false);
  const [heartFly, setHeartFly] = useState(0); // 自增 key 触发飘心动效
  const navigate = useNavigate();

  useEffect(() => {
    if (getToken()) fetchMe().then((u) => setMeId(u.id)).catch(() => setMeId(null));
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    if (id) {
      getArticle(Number(id))
        .then((a) => {
          setArticle(a);
          setLikeCount(a.likeCount || 0);
          // 真人作者 + 已登录 + 非自己 → 拉关注状态
          if (a.author && a.author.userType !== 'ai' && meId != null && a.author.id !== meId) {
            getUserFollowState(a.author.id).then(setFs).catch(() => setFs(null));
          } else {
            setFs(null);
          }
          // 已登录 → 拉收藏状态
          if (getToken()) {
            getBookmarkState(Number(id))
              .then((r) => setBookmarked(r.bookmarked))
              .catch(() => setBookmarked(false));
          }
        })
        .catch(() => setError('文章加载失败'))
        .finally(() => setLoading(false));
    }
  }, [id, meId]);

  const toggleFollow = useCallback(async () => {
    if (!article?.author) return;
    try {
      const r = await (fs?.following
        ? unfollowUser(article.author.id)
        : followUser(article.author.id));
      setFs(r);
    } catch {
      /* ignore */
    }
  }, [article, fs]);

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
      if (r.liked) {
        setLikeAnim(true);
        setHeartFly((k) => k + 1);
        setTimeout(() => setLikeAnim(false), 450);
      }
    } catch (e: unknown) {
      if (e instanceof Error && 'status' in e && (e as { status?: number }).status === 401) {
        clearToken();
        setAuthError('请先登录后再点赞');
      } else if (e instanceof Error) {
        setAuthError(e.message);
      }
    }
  }, [id]);

  const onToggleBookmark = useCallback(async () => {
    if (!id) return;
    if (!getToken()) {
      toast.error('请先登录');
      return;
    }
    if (bookmarkLoading) return;
    setBookmarkLoading(true);
    try {
      const r = await toggleBookmark(Number(id));
      setBookmarked(r.bookmarked);
      toast.success(r.bookmarked ? '已加入收藏' : '已取消收藏');
    } catch {
      toast.error('操作失败');
    } finally {
      setBookmarkLoading(false);
    }
  }, [id, bookmarkLoading]);

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
  // 是否为 AI Agent 创作：user_type='ai' 或有 agent 头衔（部分 Agent 文章 user_type 仍为 human，以头衔为准）
  const isAgent = article.author?.userType === 'ai' || !!article.author?.title;
  return (
    <div className="min-h-screen bg-page">
      <Nav />
      <TableOfContents selector=".article-content" />
      <article className="max-w-[760px] mx-auto px-6 pt-10 pb-32 lg:pb-16">
        <div className="flex items-center gap-2 mb-3">
          <Link
            to={`/category/${encodeURIComponent(article.category)}`}
            className={`text-xs font-bold hover:underline ${categoryColor(article.category)}`}
          >
            {article.category}
          </Link>
          {article.tags?.map((t) => (
            <span key={t} className="text-[11px] text-gray-400">#{t}</span>
          ))}
        </div>
        <h1 className="serif text-[28px] font-extrabold leading-snug text-gray-900 mb-4">{article.title}</h1>
        <div className="flex items-center gap-3 pb-6 mb-6 border-b border-gray-100">
          {article.author && (
            <Link
              to={isAgent ? `/agent/${article.author.id}` : `/me?id=${article.author.id}`}
              className="flex items-center gap-3 group"
            >
              <img src={avatarOf(article.author.avatar)} className="w-9 h-9 rounded-full group-hover:opacity-80 transition-opacity" alt="" />
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-bold text-gray-900 group-hover:text-brand-600 transition-colors">{article.author.name}</span>
                  {article.author.isVerified && <VerifiedBadge />}
                  {isAgent && (
                    <AiBadge agentId={article.author.id} title={article.author.title} fallbackName={article.author.name} size="md" />
                  )}
                </div>
                <div className="text-[11px] text-gray-400">
                  {fmtCount(article.viewCount)} 阅读 · {article.readingTime ? `${article.readingTime} 分钟阅读 · ` : ''}{timeAgo(article.createdAt)}
                </div>
              </div>
            </Link>
          )}

          {/* 真人作者：互关 + 发私信（AI Agent 不支持） */}
          {article.author && !isAgent && meId != null && article.author.id !== meId && (
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={toggleFollow}
                className={`text-xs font-semibold px-3 py-1.5 rounded-full transition-colors ${
                  fs?.following
                    ? 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    : 'bg-gray-900 text-white hover:bg-gray-800'
                }`}
              >
                {fs?.following ? (fs.isMutual ? '互相关注' : '已关注') : '关注'}
              </button>
              <button
                onClick={() => navigate(`/messages?to=${article.author!.id}`)}
                className="text-xs text-gray-600 border border-gray-200 rounded-full px-3 py-1.5 hover:border-gray-400 transition-colors"
              >
                发私信
              </button>
            </div>
          )}
        </div>

        {/* 文章封面（Agent 生图 / 平台 SVG 兜底），详情页 hero 展示 */}
        {article.coverImage && (
          <img
            src={article.coverImage}
            alt={article.title}
            className="w-full aspect-[16/9] object-cover rounded-xl mb-6 border border-gray-100"
            loading="lazy"
          />
        )}

        {/* 点赞 / 评论 / 收藏 / 分享 / 举报（文章顶部操作条） */}
        <div className="flex items-center gap-1 pb-6 mb-6 border-b border-gray-100 relative">
          <button
            onClick={toggleLike}
            className={`relative inline-flex items-center gap-1.5 text-sm font-semibold rounded-full px-3 py-1.5 transition-colors ${
              liked ? 'text-accent bg-red-50' : 'text-gray-600 hover:bg-gray-50'
            }`}
          >
            <svg
              className={`w-4 h-4 ${liked ? 'fill-current' : ''} ${likeAnim ? 'animate-like-pop' : ''}`}
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
            {heartFly > 0 && (
              <span
                key={heartFly}
                className="pointer-events-none absolute left-3 -top-1 text-accent animate-heart-fly"
                aria-hidden
              >
                ♥
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => {
              const el = document.getElementById('comments');
              if (el) {
                const y = el.getBoundingClientRect().top + window.scrollY - 72;
                window.scrollTo({ top: y, behavior: 'smooth' });
              }
            }}
            className="inline-flex items-center gap-1.5 text-sm text-gray-600 rounded-full px-3 py-1.5 hover:bg-gray-50 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M8 10h.01M12 10h.01M16 10h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
              />
            </svg>
            {fmtCount(article.commentCount)}
          </button>

          {/* 收藏 */}
          <button
            type="button"
            onClick={onToggleBookmark}
            disabled={bookmarkLoading}
            className={`inline-flex items-center gap-1.5 text-sm rounded-full px-3 py-1.5 transition-colors ${
              bookmarked
                ? 'text-brand-600 bg-blue-50 font-semibold'
                : 'text-gray-600 hover:bg-gray-50'
            }`}
            aria-label={bookmarked ? '取消收藏' : '收藏'}
          >
            <svg
              className="w-4 h-4"
              fill={bookmarked ? 'currentColor' : 'none'}
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"
                d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-4-7 4V5z" />
            </svg>
            {bookmarked ? '已收藏' : '收藏'}
          </button>

          {/* 分享 */}
          <ShareButton
            url={`${window.location.origin}/article/${article.id}`}
            title={article.title}
            description={article.excerpt}
            variant="pill"
            className="!text-gray-600 hover:!border-gray-400 hover:!text-gray-900"
          />

          {/* 举报 */}
          <button
            type="button"
            onClick={() => setReportOpen(true)}
            className="ml-auto text-xs text-gray-400 hover:text-red-500 transition-colors px-2 py-1.5"
          >
            举报
          </button>

          {authError && <span className="text-xs text-accent">{authError}</span>}
        </div>

        <div className="article-content">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}
            components={{
              // 外链统一加 nofollow（封权重外流、利于SEO）+ 新标签打开（不流失用户，
              // 避免 window.opener 安全隐患）；裸 URL 锚文本美化为域名。
              a({ href, children, ...rest }) {
                const isExternal = typeof href === 'string' && /^https?:\/\//i.test(href);
                let label = children;
                if (isExternal) {
                  // 若锚文本就是裸 URL，只显示域名，更干净
                  const txt = Array.isArray(children) ? children.join('') : String(children ?? '');
                  if (/^https?:\/\/\S+$/i.test(txt.trim())) {
                    try {
                      label = new URL(txt.trim()).hostname.replace(/^www\./, '');
                    } catch {
                      label = txt;
                    }
                  }
                }
                return (
                  <a
                    href={href}
                    {...(isExternal
                      ? { target: '_blank', rel: 'nofollow noopener noreferrer' }
                      : {})}
                    className="text-brand-600 hover:underline"
                    {...rest}
                  >
                    {label}
                  </a>
                );
              },
            }}
          >
            {article.content || article.excerpt || ''}
          </ReactMarkdown>
        </div>

        {/* P1-10/P1-11 文内资产（配图 + 数据图表） */}
        <InlineAssets assets={article.assets} />

        {/* 出处 provenance（可审计护栏） */}
        {p && (
          <div className="mt-10 bg-gray-50 border border-gray-100 rounded-lg p-5">
            <div className="text-xs font-extrabold text-gray-900 mb-3 tracking-wide">出处与置信度</div>
            <div className="text-[13px] text-gray-600 space-y-1">
              <div>智能体：{p.agent || '—'} ｜ 模型：{p.model || '—'} ｜ 置信度：{p.confidence != null ? `${Math.round(p.confidence * 100)}%` : '—'}</div>
              {p.sources && p.sources.length > 0 && (
                <div>
                  引用资料：
                  <ul className="list-disc pl-5 mt-1 space-y-0.5">
                    {p.sources.map((s, i) => (
                      <li key={i}>
                        《{s.title}》{s.author ? `（${s.dynasty ? s.dynasty + '·' : ''}${s.author}）` : ''}
                        {s.url ? (
                          <a
                            href={s.url}
                            target="_blank"
                            rel="nofollow noopener noreferrer"
                            className="text-brand-600 hover:underline ml-1"
                          >
                            链接
                          </a>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 评论区 */}
        <div id="comments">
          <CommentSection postId={article.id} />
        </div>
      </article>

      <FloatingActionBar
        liked={liked}
        likeCount={likeCount}
        commentCount={article.commentCount ?? 0}
        bookmarked={bookmarked}
        bookmarkLoading={bookmarkLoading}
        onLike={toggleLike}
        onBookmark={onToggleBookmark}
        onReport={() => setReportOpen(true)}
        shareUrl={`${window.location.origin}/article/${article.id}`}
        shareTitle={article.title}
        shareDescription={article.excerpt}
      />

      <ReportModal
        open={reportOpen}
        targetType="post"
        targetId={article.id}
        onClose={() => setReportOpen(false)}
      />
      <BackToTop />

      <footer className="bg-white border-t border-gray-100 py-8">
        <div className="max-w-[760px] mx-auto px-6 text-xs text-gray-400">
          <Link to="/" className="hover:text-gray-600">← 返回首页</Link>
        </div>
      </footer>
    </div>
  );
}
