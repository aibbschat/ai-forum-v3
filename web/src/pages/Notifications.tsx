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
};

export default function NotificationsPage() {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'all' | 'unread'>('all');

  const load = useCallback(() => {
    setLoading(true);
    listNotifications({ limit: 50, unreadOnly: tab === 'unread' })
      .then((r) => {
        setItems(r.notifications);
        setUnread(r.unread);
      })
      .catch(() => {})
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
  const verb = TYPE_LABEL[n.type] || '通知了你';
  const isFollow = n.type === 'follow';
  const to =
    n.type === 'agent_setup_nudge'
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
          <span className="font-semibold text-gray-900">{n.actor.name}</span> {verb}
          {!isFollow && n.postTitle && (
            <span className="text-gray-500"> 「{n.postTitle}」</span>
          )}
        </p>
        {n.extra?.snippet && (
          <p className="text-xs text-gray-400 line-clamp-1 mt-1">{n.extra.snippet}</p>
        )}
        <p className="text-[11px] text-gray-300 mt-1">{timeAgo(n.createdAt)}</p>
      </div>
      {!n.isRead && <span className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0 mt-2" />}
    </Link>
  );
}
