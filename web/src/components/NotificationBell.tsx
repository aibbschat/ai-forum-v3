import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { listNotifications, unreadNotificationCount, markAllNotificationsRead, type AppNotification } from '../api';
import { avatarOf, timeAgo } from '../lib';

const TYPE_LABEL: Record<string, string> = {
  like: '赞了你的',
  comment: '评论了你的',
  reply: '回复了你的',
  mention: '@了你的',
  follow: '关注了你',
};

export default function NotificationBell() {
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const loadUnread = () =>
    unreadNotificationCount()
      .then((r) => setUnread(r.count))
      .catch(() => {});

  useEffect(() => {
    loadUnread();
    const t = setInterval(loadUnread, 30000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    listNotifications({ limit: 20 })
      .then((r) => {
        setItems(r.notifications);
        setUnread(r.unread);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const markAll = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await markAllNotificationsRead();
      setUnread(0);
      setItems((prev) => prev.map((x) => ({ ...x, isRead: true })));
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="relative" ref={wrapRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative w-8 h-8 flex items-center justify-center text-gray-500 hover:text-gray-900 transition-colors"
        aria-label="通知"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 10-12 0v3.2a2 2 0 01-.6 1.4L4 17h5m6 0a3 3 0 11-6 0" />
        </svg>
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-[340px] max-w-[90vw] bg-white border border-gray-100 rounded-xl shadow-xl z-50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
            <span className="text-sm font-bold text-gray-900">通知</span>
            {unread > 0 && (
              <button
                type="button"
                onClick={markAll}
                className="text-xs text-brand-600 hover:underline"
              >
                全部已读
              </button>
            )}
          </div>
          <div className="max-h-[60vh] overflow-y-auto">
            {loading ? (
              <div className="px-4 py-6 text-center text-xs text-gray-400">加载中…</div>
            ) : items.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-gray-400">还没有通知</div>
            ) : (
              items.map((n) => <NotifItem key={n.id} n={n} onNavigate={() => setOpen(false)} />)
            )}
          </div>
          <Link
            to="/notifications"
            onClick={() => setOpen(false)}
            className="block text-center text-xs text-gray-500 hover:text-gray-900 py-2.5 border-t border-gray-100"
          >
            查看全部通知
          </Link>
        </div>
      )}
    </div>
  );
}

function NotifItem({ n, onNavigate }: { n: AppNotification; onNavigate: () => void }) {
  const verb = TYPE_LABEL[n.type] || '通知了你';
  const isFollow = n.type === 'follow';
  const target = isFollow ? (
    <span className="text-gray-900 font-semibold">动态</span>
  ) : n.postId ? (
    <span className="text-gray-900 font-semibold">文章</span>
  ) : (
    <span>内容</span>
  );
  const to = n.postId ? `/article/${n.postId}` : isFollow ? `/me?id=${n.actor.id}` : '/notifications';
  return (
    <Link
      to={to}
      onClick={onNavigate}
      className={`flex items-start gap-3 px-4 py-3 border-b border-gray-50 hover:bg-gray-50 transition-colors ${
        !n.isRead ? 'bg-brand-50/40' : ''
      }`}
    >
      <img src={avatarOf(n.actor.avatar)} className="w-8 h-8 rounded-full flex-shrink-0" alt="" />
      <div className="flex-1 min-w-0">
        <p className="text-[13px] text-gray-700 leading-snug">
          <span className="font-semibold text-gray-900">{n.actor.name}</span> {verb}
          {!isFollow && <span> {target}</span>}
        </p>
        {n.extra?.snippet && (
          <p className="text-xs text-gray-400 line-clamp-1 mt-0.5">{n.extra.snippet}</p>
        )}
        <p className="text-[11px] text-gray-300 mt-0.5">{timeAgo(n.createdAt)}</p>
      </div>
      {!n.isRead && <span className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0 mt-1.5" />}
    </Link>
  );
}
