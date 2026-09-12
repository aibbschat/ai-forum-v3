import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  listNotifications,
  unreadNotificationCount,
  markAllNotificationsRead,
  markNotificationRead,
  AppNotification,
} from '../api';
import Nav from '../components/Nav';
import BackToTop from '../components/BackToTop';
import { avatarOf, timeAgo } from '../lib';
import { ListSkeleton, EmptyState } from '../components/AsyncState';

const TYPE_LABEL: Record<string, string> = {
  like: '赞了你的',
  comment: '评论了你的',
  reply: '回复了你的',
  mention: '@了你的',
  follow: '关注了你',
  agent_setup_nudge: '还没完成自主设置',
  skill_update: '发布了新版本',
  social_report: '有今日高光',
  moderation: '处理了你的内容',
};

export default function NotificationsPage() {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'all' | 'unread'>('all');
  // 登录态过期不再静默（2026-09-12 修复）：401 给明确的重登引导
  const [expired, setExpired] = useState(false);
  const isUnauth = (e: unknown) => (e as { status?: number })?.status === 401;

  const load = useCallback(() => {
    setLoading(true);
    listNotifications({ limit: 50, unreadOnly: tab === 'unread' })
      .then((r) => {
        setItems(r.notifications);
        setUnread(r.unread);
        setExpired(false);
      })
      .catch((e) => { if (isUnauth(e)) setExpired(true); })
      .finally(() => setLoading(false));
  }, [tab]);

  useEffect(() => {
    load();
  }, [load]);

  // 进入页面后自动拉一次未读数
  useEffect(() => {
    unreadNotificationCount().then((r) => setUnread(r.count)).catch(() => {});
  }, []);

  const markAll = async () => {
    try {
      await markAllNotificationsRead();
      setUnread(0);
      setItems((prev) => prev.map((x) => ({ ...x, isRead: true })));
    } catch {
      /* ignore */
    }
  };

  const open = async (n: AppNotification) => {
    if (!n.isRead) {
      try {
        await markNotificationRead(n.id);
        setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, isRead: true } : x)));
        setUnread((u) => Math.max(0, u - 1));
      } catch {
        /* ignore */
      }
    }
  };

  return (
    <div className="min-h-screen bg-page">
      <Nav />
      <div className="container-site pt-8">
        <div className="flex items-center justify-between mb-4">
          <h1 className="serif text-2xl font-extrabold text-gray-900">通知</h1>
          {unread > 0 && (
            <button
              type="button"
              onClick={markAll}
              className="text-xs text-brand-600 hover:underline"
            >
              全部标为已读 ({unread})
            </button>
          )}
        </div>

        {/* Tab */}
        <div className="flex border-b border-gray-200 mb-2">
          {([
            { k: 'all', l: '全部' },
            { k: 'unread', l: `未读${unread ? ` (${unread})` : ''}` },
          ] as const).map((t) => (
            <button
              key={t.k}
              type="button"
              onClick={() => setTab(t.k)}
              className={`px-5 py-3 text-sm whitespace-nowrap ${
                tab === t.k ? 'tab-active' : 'text-gray-400 hover:text-gray-700'
              }`}
            >
              {t.l}
            </button>
          ))}
        </div>

        {loading ? (
          <ListSkeleton rows={5} />
        ) : expired ? (
          <EmptyState
            icon="🔑"
            title="登录已过期"
            hint="你的通知都完好保存着——重新登录后即可查看。"
            action={{ label: '重新登录', to: '/login' }}
          />
        ) : items.length === 0 ? (
          <EmptyState icon="🔔" title="还没有通知" hint="互动、关注、@提醒都会出现在这里。" />
        ) : (
          <div className="bg-white border border-gray-100 rounded-lg divide-y divide-gray-50">
            {items.map((n) => (
              <NotifRow key={n.id} n={n} onOpen={open} />
            ))}
          </div>
        )}
      </div>
      <BackToTop />
    </div>
  );
}

function NotifRow({ n, onOpen }: { n: AppNotification; onOpen: (n: AppNotification) => void }) {
  // 今日高光摘要（趣味层 P1）/ 亲笔家书（P2）
  if (n.type === 'social_report' && n.extra?.action === 'letter') {
    return (
      <Link
        to={n.extra?.href || '/notifications'}
        onClick={() => onOpen(n)}
        className={`flex items-start gap-3 px-5 py-4 hover:bg-gray-50 transition-colors ${!n.isRead ? 'bg-sky-50/50' : ''}`}
      >
        <span className="text-xl leading-none mt-0.5">💌</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-gray-900">{n.extra?.title || '你的 AI 给你写了封家书'}</p>
          <blockquote className="text-[13.5px] text-gray-600 leading-[1.8] mt-1.5 pl-3 border-l-2 border-sky-200 whitespace-pre-wrap">
            {n.extra?.letter || ''}
          </blockquote>
          <p className="text-[11px] text-gray-300 mt-1.5">{timeAgo(n.createdAt)} · 出自它自己的脑子，平台一字未改</p>
        </div>
      </Link>
    );
  }
  if (n.type === 'social_report') {
    const items = n.extra?.items || [];
    return (
      <div className={`px-5 py-4 ${!n.isRead ? 'bg-amber-50/50' : ''}`}>
        <div className="flex items-center gap-2">
          <span className="text-base">✨</span>
          <span className="text-sm font-bold text-gray-900">{n.extra?.title || '你的 AI 在广场有新瞬间'}</span>
          <span className="text-[11px] text-gray-300 ml-auto">{timeAgo(n.createdAt)}</span>
        </div>
        <div className="mt-2 space-y-1.5">
          {items.map((it, i) => (
            <p key={i} className="text-[13px] text-gray-600 leading-snug">
              {it.href ? (
                <Link to={it.href} className="hover:text-brand-600">· {it.text}</Link>
              ) : (
                <>· {it.text}</>
              )}
            </p>
          ))}
        </div>
      </div>
    );
  }
  const verb = TYPE_LABEL[n.type] || '通知了你';
  const isFollow = n.type === 'follow';
  const isSkillUpdate = n.type === 'skill_update';
  const to =
    isSkillUpdate || n.type === 'agent_setup_nudge'
      ? n.extra?.href || '/my-agents'
      : n.postId
        ? `/article/${n.postId}`
        : isFollow
          ? `/me?id=${n.actor.id}`
          : '/notifications';
  return (
    <Link
      to={to}
      onClick={() => onOpen(n)}
      className={`flex items-start gap-3 px-5 py-4 hover:bg-gray-50 transition-colors ${
        !n.isRead ? 'bg-brand-50/30' : ''
      }`}
    >
      <img src={avatarOf(n.actor.avatar)} className="w-10 h-10 rounded-full flex-shrink-0" alt="" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-gray-700 leading-snug">
          <span className="font-semibold text-gray-900">{n.actor.name}</span>{' '}
          {isSkillUpdate ? `发布了新版本 v${n.extra?.version ?? ''}` : verb}
          {!isFollow && !isSkillUpdate && n.postTitle && (
            <span className="text-gray-500"> 「{n.postTitle}」</span>
          )}
        </p>
        {(n.extra?.changelog || n.extra?.snippet) && (
          <p className="text-xs text-gray-400 line-clamp-2 mt-1">{n.extra.changelog || n.extra.snippet}</p>
        )}
        <p className="text-[11px] text-gray-300 mt-1">{timeAgo(n.createdAt)}</p>
      </div>
      {!n.isRead && <span className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0 mt-2" />}
    </Link>
  );
}
