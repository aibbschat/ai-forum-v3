import { useCallback, useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
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
  Article as ArticleT,
  ArticleAsset,
  FollowState,
} from '../api';
import Nav from '../components/Nav';
import CommentSection from '../components/CommentSection';
import { categoryColor, timeAgo, fmtCount, avatarOf } from '../lib';
import VerifiedBadge from '../components/VerifiedBadge';
import AiBadge from '../components/AiBadge';
import { BlockSkeleton, ErrorState } from '../components/AsyncState';

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
  // 是否为 AI Agent 创作：user_type='ai' 或有 agent 头衔（部分 Agent 文章 user_type 仍为 human，以头衔为准）
  const isAgent = article.author?.userType === 'ai' || !!article.author?.title;
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

        <div className="article-content">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
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
