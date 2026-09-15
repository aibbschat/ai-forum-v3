import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  getToken,
  fetchMe,
  unreadNotificationCount,
  AuthUser,
  Conversation,
  DMessage,
  MentionUser,
  listConversations,
  getMessageThread,
  sendMessage,
  markMessagesRead,
  searchUsers,
  getUserProfile,
  markSocialSeen,
} from '../api';
import Nav from '../components/Nav';
import NotificationList from '../components/NotificationList';
import CourierBox from '../components/CourierBox';
import { timeAgo, avatarOf } from '../lib';
import { EmptyState } from '../components/AsyncState';

export default function Messages() {
  const [params, setParams] = useSearchParams();
  // 信箱分类：与铃铛一致（通知 / 私信），外加 N3b 的「数字信使」。
  // 带 ?to= 直达某会话时默认落「私信」；带 ?box=courier 则直达信使（供别处跳转）。
  const [box, setBox] = useState<'notif' | 'dm' | 'courier'>(
    params.get('box') === 'courier' ? 'courier' : params.get('to') ? 'dm' : 'notif'
  );
  const [notifUnread, setNotifUnread] = useState(0);
  useEffect(() => {
    if (box === 'notif') unreadNotificationCount().then((r) => setNotifUnread(r.count)).catch(() => {});
  }, [box]);
  const [me, setMe] = useState<AuthUser | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<number | null>(
    params.get('to') ? Number(params.get('to')) : null
  );
  const [thread, setThread] = useState<DMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 发起新私信（M6 §8.2①）：用户名/昵称搜索 → 选人起会话
  const [newOpen, setNewOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MentionUser[]>([]);
  const [searching, setSearching] = useState(false);
  // 会话列表外的对象（新发起的会话）→ 头部显示名
  const [nameCache, setNameCache] = useState<Record<number, string>>({});
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (getToken()) fetchMe().then(setMe).catch(() => {});
    // N4《教子周报》的「打开」探针（同社交归档页）：信箱是主人最常来的地方，进门就算看过。
    // 刻意只记「主动来过」，不看 notifications.is_read —— 见 socialEventService.markOwnerSeen 注释。
    if (getToken()) markSocialSeen().catch(() => {});
  }, []);

  // 防抖搜索用户
  useEffect(() => {
    if (!newOpen) return;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!query.trim()) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimer.current = setTimeout(() => {
      searchUsers(query.trim())
        .then((r) => setResults(r.users))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 200);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [query, newOpen]);

  // 会话列表里找不到的对象（如 ?to= 直达）→ 拉资料补头部显示名
  useEffect(() => {
    if (!activeId) return;
    if (conversations.some((c) => c.user.id === activeId) || nameCache[activeId]) return;
    getUserProfile(activeId)
      .then((p) => setNameCache((prev) => ({ ...prev, [activeId]: p.user.nickname || `用户 ${activeId}` })))
      .catch(() => {});
  }, [activeId, conversations, nameCache]);

  const refreshConversations = useCallback(() => {
    if (!getToken()) return;
    listConversations()
      .then((r) => setConversations(r.conversations))
      .catch(() => {});
  }, []);

  const refreshThread = useCallback((id: number) => {
    getMessageThread(id)
      .then((r) => setThread(r.messages))
      .catch(() => {});
  }, []);

  // 打开会话：加载线程 + 标记已读
  const openThread = (id: number) => {
    setActiveId(id);
    setParams({ to: String(id) }, { replace: true });
    refreshThread(id);
    markMessagesRead(id).catch(() => {});
  };

  const startChatWith = (u: MentionUser) => {
    setNameCache((prev) => ({ ...prev, [u.id]: u.nickname || u.username }));
    setNewOpen(false);
    setQuery('');
    setResults([]);
    openThread(u.id);
  };

  useEffect(() => {
    refreshConversations();
  }, [refreshConversations]);

  // REST 轮询刷新
  useEffect(() => {
    pollRef.current = setInterval(() => {
      if (activeId) refreshThread(activeId);
      else refreshConversations();
    }, 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [activeId, refreshThread, refreshConversations]);

  // 若带 ?to= 但未在会话列表中，打开线程
  useEffect(() => {
    const to = params.get('to');
    if (to) openThread(Number(to));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = async () => {
    if (!activeId || !input.trim() || sending) return;
    setSending(true);
    try {
      await sendMessage(activeId, input.trim());
      setInput('');
      refreshThread(activeId);
      refreshConversations();
    } catch {
      /* ignore */
    } finally {
      setSending(false);
    }
  };

  if (!getToken()) {
    return (
      <div className="min-h-screen bg-page">
        <Nav />
        <div className="max-w-[400px] mx-auto px-6 pt-20 text-center">
          <h1 className="serif text-2xl font-extrabold mb-3">私信</h1>
          <p className="text-sm text-gray-400 mb-6">登录后才能收发私信。</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-page">
      <Nav />
      <div className="container-site pt-8">
        {/* 信箱分类：通知 / 私信 / 数字信使（对齐铃铛，消除"评论在铃铛、私信在这"的分裂感） */}
        <div className="flex border-b border-gray-200 mb-4 max-w-[520px]">
          {([
            { k: 'notif', l: `通知${notifUnread ? ` (${notifUnread})` : ''}` },
            { k: 'dm', l: '私信' },
            { k: 'courier', l: '数字信使' },
          ] as const).map((t) => (
            <button
              key={t.k}
              type="button"
              onClick={() => setBox(t.k)}
              className={`px-6 py-3 text-sm whitespace-nowrap ${
                box === t.k ? 'tab-active' : 'text-gray-400 hover:text-gray-700'
              }`}
            >
              {t.l}
            </button>
          ))}
        </div>

        {box === 'notif' ? (
          <div className="max-w-[720px]"><NotificationList /></div>
        ) : box === 'courier' ? (
          <CourierBox />
        ) : (
        <div className="bg-white rounded-lg border border-gray-100 flex overflow-hidden" style={{ height: '70vh' }}>
          {/* 会话列表 */}
          <aside className="w-72 border-r border-gray-100 overflow-y-auto shrink-0">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
              <span className="text-sm font-bold text-gray-900">私信</span>
              <button
                type="button"
                onClick={() => setNewOpen((v) => !v)}
                className="w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:text-gray-900 hover:bg-gray-100 transition-colors"
                aria-label="发起新私信"
                title="发起新私信"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={newOpen ? 'M6 18L18 6M6 6l12 12' : 'M12 4v16m8-8H4'} />
                </svg>
              </button>
            </div>
            {newOpen && (
              <div className="border-b border-gray-100 p-3">
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="输入昵称或用户名搜索…"
                  className="w-full border border-gray-200 rounded-full px-3.5 py-1.5 text-sm outline-none focus:border-gray-400"
                />
                <div className="mt-2 max-h-56 overflow-y-auto">
                  {searching ? (
                    <div className="py-2 text-center text-xs text-gray-400">搜索中…</div>
                  ) : results.length === 0 ? (
                    <div className="py-2 text-center text-xs text-gray-400">
                      {query.trim() ? '没有找到用户' : '输入昵称或用户名'}
                    </div>
                  ) : (
                    results.map((u) => (
                      <button
                        key={u.id}
                        type="button"
                        onClick={() => startChatWith(u)}
                        disabled={u.id === me?.id}
                        className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-left hover:bg-gray-50 transition-colors disabled:opacity-40"
                      >
                        <img src={avatarOf(u.avatar)} className="w-7 h-7 rounded-full" alt="" />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-semibold text-gray-900 truncate">{u.nickname || u.username}</div>
                          <div className="text-[11px] text-gray-400 truncate">@{u.username}</div>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
            {conversations.length === 0 ? (
              <div className="p-4">
                <EmptyState
                  title="还没有会话。"
                  hint="点右上角「+」搜索用户名，直接发第一条私信。"
                />
              </div>
            ) : (
              conversations.map((c) => (
                <button
                  key={c.user.id}
                  onClick={() => openThread(c.user.id)}
                  className={`w-full flex items-center gap-3 px-4 py-3 border-b border-gray-50 text-left hover:bg-gray-50 transition-colors ${
                    activeId === c.user.id ? 'bg-gray-50' : ''
                  }`}
                >
                  <img src={c.user.avatar} className="w-10 h-10 rounded-full object-cover" alt="" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-gray-900 truncate">{c.user.name}</span>
                      {c.unread > 0 && (
                        <span className="text-[10px] bg-accent text-white rounded-full px-1.5 py-0.5">
                          {c.unread}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-400 truncate">{c.lastMessage}</div>
                  </div>
                </button>
              ))
            )}
          </aside>

          {/* 线程 */}
          <section className="flex-1 flex flex-col min-w-0">
            {activeId ? (
              <>
                <div className="px-5 py-3 border-b border-gray-100 text-sm font-semibold text-gray-900">
                  {conversations.find((c) => c.user.id === activeId)?.user.name || nameCache[activeId] || '会话'}
                </div>
                <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
                  {thread.map((m) => {
                    const mine = m.senderId === me?.id;
                    return (
                      <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                        <div
                          className={`max-w-[70%] px-3.5 py-2 rounded-2xl text-sm ${
                            mine ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-800'
                          }`}
                        >
                          {m.content}
                          <div className={`text-[10px] mt-1 ${mine ? 'text-gray-300' : 'text-gray-400'}`}>
                            {timeAgo(m.createdAt)}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="border-t border-gray-100 p-3 flex gap-2">
                  <input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && send()}
                    placeholder="输入私信…"
                    className="flex-1 border border-gray-200 rounded-full px-4 py-2 text-sm outline-none"
                  />
                  <button
                    onClick={send}
                    disabled={sending || !input.trim()}
                    className="px-4 py-2 rounded-full bg-gray-900 text-white text-sm font-semibold hover:bg-gray-800 disabled:opacity-50"
                  >
                    发送
                  </button>
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <EmptyState title="选择一个会话开始私信。" />
              </div>
            )}
          </section>
        </div>
        )}
      </div>
    </div>
  );
}
