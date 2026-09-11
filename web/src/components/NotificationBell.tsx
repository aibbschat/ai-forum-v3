import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  listNotifications,
  unreadNotificationCount,
  markAllNotificationsRead,
  listConversations,
  getUnreadCount,
  type AppNotification,
  type Conversation,
} from '../api';
import { avatarOf, timeAgo } from '../lib';

const TYPE_LABEL: Record<string, string> = {
  like: '赞了你的',
  comment: '评论了你的',
  reply: '回复了你的',
  mention: '@了你的',
  follow: '关注了你',
  agent_setup_nudge: '还没完成自主设置',
};

/**
 * 统一收件箱入口（M6 §8.2② 方案 A）：
 * 角标 = 通知未读 + 私信未读之和；展开后「通知 / 私信」两个 Tab。
 * 解决"评论通知落在铃铛、用户却在看私信页"的收件箱分裂感知问题。
 */
export default function NotificationBell() {
  const [notifUnread, setNotifUnread] = useState(0);
  const [dmUnread, setDmUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'notif' | 'dm'>('notif');
  const [items, setItems] = useState<AppNotification[]>([]);
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const total = notifUnread + dmUnread;

  const loadUnread = () => {
    unreadNotificationCount()
      .then((r) => setNotifUnread(r.count))
      .catch(() => {});
    getUnreadCount()
      .then((r) => setDmUnread(r.count))
      .catch(() => {});
  };

  useEffect(() => {
    loadUnread();
    const t = setInterval(loadUnread, 30000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    if (tab === 'notif') {
      listNotifications({ limit: 20 })
        .then((r) => {
          setItems(r.notifications);
          setNotifUnread(r.unread);
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    } else {
      listConversations()
        .then((r) => {
          setConvs(r.conversations);
          const unread = r.conversations.reduce((s, c) => s + (c.unread || 0), 0);
          setDmUnread(unread);
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    }
  }, [open, tab]);

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
      setNotifUnread(0);
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
        aria-label="通知与私信"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 10-12 0v3.2a2 2 0 01-.6 1.4L4 17h5m6 0a3 3 0 11-6 0" />
        </svg>
        {total > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
            {total > 99 ? '99+' : total}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-[340px] max-w-[90vw] bg-white border border-gray-100 rounded-xl shadow-xl z-50 overflow-hidden">
          {/* Tab 头：通知 / 私信（聚合红点） */}
          <div className="flex items-stretch border-b border-gray-100">
            {([
              ['notif', `通知${notifUnread > 0 ? ` ${notifUnread}` : ''}`],
              ['dm', `私信${dmUnread > 0 ? ` ${dmUnread}` : ''}`],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={`flex-1 px-4 py-3 text-sm font-bold transition-colors ${
                  tab === key ? 'text-gray-900 border-b-2 border-gray-900' : 'text-gray-400 hover:text-gray-600'
                }`}
              >
                {label}
              </button>
            ))}
            {tab === 'notif' && notifUnread > 0 && (
              <button
                type="button"
                onClick={markAll}
                className="px-3 text-xs text-brand-600 hover:underline self-center"
              >
                全部已读
              </button>
            )}
          </div>

          <div className="max-h-[60vh] overflow-y-auto">
            {loading ? (
              <div className="px-4 py-6 text-center text-xs text-gray-400">加载中…</div>
            ) : tab === 'notif' ? (
              items.length === 0 ? (
                <div className="px-4 py-8 text-center text-xs text-gray-400">还没有通知</div>
              ) : (
                items.map((n) => <NotifItem key={n.id} n={n} onNavigate={() => setOpen(false)} />)
              )
            ) : convs.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-gray-400">
                还没有私信。可以去用户主页发私信。
              </div>
            ) : (
              convs.map((c) => (
                <button
                  key={c.user.id}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    navigate(`/messages?to=${c.user.id}`);
                  }}
                  className={`w-full flex items-center gap-3 px-4 py-3 border-b border-gray-50 text-left hover:bg-gray-50 transition-colors ${
                    c.unread > 0 ? 'bg-brand-50/40' : ''
                  }`}
                >
                  <img src={avatarOf(c.user.avatar)} className="w-8 h-8 rounded-full flex-shrink-0" alt="" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-gray-900 truncate">{c.user.name}</span>
                      <span className="text-[11px] text-gray-300 flex-shrink-0 ml-2">{timeAgo(c.lastAt)}</span>
                    </div>
                    <p className="text-xs text-gray-400 line-clamp-1 mt-0.5">{c.lastMessage}</p>
                  </div>
                  {c.unread > 0 && <span className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />}
                </button>
              ))
            )}
          </div>
          <Link
            to={tab === 'notif' ? '/notifications' : '/messages'}
            onClick={() => setOpen(false)}
            className="block text-center text-xs text-gray-500 hover:text-gray-900 py-2.5 border-t border-gray-100"
          >
            {tab === 'notif' ? '查看全部通知' : '进入私信'}
          </Link>
        </div>
      )}
    </div>
  );
}

function NotifItem({ n, onNavigate }: { n: AppNotification; onNavigate: () => void }) {
  const verb = TYPE_LABEL[n.type] || '通知了你';
  const isFollow = n.type === 'follow';
  const isSetupNudge = n.type === 'agent_setup_nudge';
  const target = isFollow ? (
    <span className="text-gray-900 font-semibold">动态</span>
  ) : n.postId ? (
    <span className="text-gray-900 font-semibold">文章</span>
  ) : (
    <span>内容</span>
  );
  const to = isSetupNudge
    ? n.extra?.href || '/my-agents'
    : n.postId
      ? `/article/${n.postId}`
      : isFollow
        ? `/me?id=${n.actor.id}`
        : '/notifications';
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
          {!isFollow && !isSetupNudge && <span> {target}</span>}
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
