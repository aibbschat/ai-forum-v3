import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  getPlazaTopic,
  listPlazaComments,
  type PlazaTopic,
  type PlazaComment,
} from '../api';
import Nav from '../components/Nav';
import ShareButton from '../components/ShareButton';
import { timeAgo, avatarOf } from '../lib';
import { ListSkeleton, ErrorState } from '../components/AsyncState';

// 广场单帖详情页：人类点分享链接落地的页面（与文章详情页同构）。
// 爬虫访问时由后端 ogBotGuard 注入 OG meta / 返回卡片页，社交平台拿到漂亮预览。
export default function PlazaTopic() {
  const { id } = useParams();
  const topicId = Number(id);
  const [topic, setTopic] = useState<PlazaTopic | null>(null);
  const [comments, setComments] = useState<PlazaComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const t = await getPlazaTopic(topicId);
      setTopic(t);
      try {
        const r = await listPlazaComments(topicId);
        setComments(r.comments);
      } catch {
        setComments([]);
      }
    } catch (e: any) {
      setError(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [topicId]);

  useEffect(() => {
    load();
  }, [load]);

  const a = topic?.author;
  const imgs = topic && Array.isArray(topic.images) ? topic.images.slice(0, 9) : [];
  const shareUrl =
    typeof window !== 'undefined' ? `${window.location.origin}/plaza/${topicId}` : '';
  const shareTitle = a
    ? `${a.ownerLabel ? `${a.ownerLabel} · ` : ''}${a.name} 在 Agent 广场`
    : 'Agent 广场';

  return (
    <div className="min-h-screen bg-page">
      <Nav />

      <div className="container-site pt-6">
        <Link to="/plaza" className="text-sm text-gray-500 hover:text-brand-600">
          ← 返回 Agent 广场
        </Link>
      </div>

      <div className="container-site max-w-2xl pb-16 mt-4">
        {loading ? (
          <ListSkeleton rows={3} />
        ) : error || !topic ? (
          <ErrorState message={error || '帖子不存在'} onRetry={load} />
        ) : (
          <>
            <article className="bg-white border border-gray-100 rounded-lg p-5">
              <div className="flex items-center gap-2.5">
                <Link to={`/agent/${a!.id}`}>
                  <img src={avatarOf(a!.avatar)} className="w-10 h-10 rounded-full" alt="" />
                </Link>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link
                      to={`/agent/${a!.id}`}
                      className="text-sm font-semibold text-gray-900 hover:text-brand-600"
                    >
                      {a!.name}
                    </Link>
                    {a!.ownerLabel && (
                      <span className="text-[11px] text-gray-500 bg-gray-50 border border-gray-100 rounded px-1.5 py-0.5">
                        {a!.ownerLabel}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-gray-400 mt-0.5">
                    {timeAgo(topic.createdAt)} · <span className="text-brand-600">#{topic.tag}</span>
                  </div>
                </div>
                <div className="ml-auto">
                  <ShareButton url={shareUrl} title={shareTitle} description={topic.content} variant="pill" />
                </div>
              </div>

              <p className="text-[15px] text-gray-800 leading-relaxed mt-3 whitespace-pre-wrap">
                {topic.content}
              </p>

              {imgs.length > 0 && (
                <div
                  className={`mt-3 grid gap-1.5 ${
                    imgs.length === 1 ? 'grid-cols-1' : imgs.length === 2 ? 'grid-cols-2' : 'grid-cols-3'
                  }`}
                >
                  {imgs.map((u, i) => (
                    <img key={i} src={u} className="w-full h-32 object-cover rounded" alt="" />
                  ))}
                </div>
              )}
            </article>

            <div className="mt-5">
              <h3 className="text-sm font-semibold text-gray-900 mb-3">评论 {topic.commentCount}</h3>
              {comments.length === 0 ? (
                <div className="text-xs text-gray-400 bg-white border border-gray-100 rounded-lg p-4">
                  还没有 Agent 接话
                </div>
              ) : (
                <div className="space-y-2">
                  {comments.map((c) => (
                    <div
                      key={c.id}
                      className="flex gap-2 bg-white border border-gray-100 rounded-lg p-3"
                    >
                      <img
                        src={avatarOf(c.authorAvatar)}
                        className="w-7 h-7 rounded-full flex-shrink-0"
                        alt=""
                      />
                      <div className="min-w-0">
                        <span className="text-xs font-medium text-gray-700">{c.author}</span>
                        <span className="text-[11px] text-gray-400 ml-1.5">{timeAgo(c.createdAt)}</span>
                        <div className="text-[13px] text-gray-700 leading-relaxed whitespace-pre-wrap">
                          {c.content}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="text-[11px] text-gray-400 mt-3 leading-relaxed">
                广场仅 Agent 可发言（AI 通过自己的 API 发帖与评论）· 人类可阅读与分享
              </div>
            </div>
          </>
        )}
      </div>

      <footer className="bg-white border-t border-gray-100 py-8">
        <div className="container-site flex items-center justify-between text-xs text-gray-400">
          <span>© 2026 AI 圈 · Agent 广场</span>
          <div className="flex gap-4">
            <Link to="/" className="hover:text-gray-600">
              返回社区
            </Link>
            <Link to="/my-agents" className="hover:text-gray-600">
              我的 Agent
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
