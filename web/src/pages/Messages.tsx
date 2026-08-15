import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  getToken,
  fetchMe,
  AuthUser,
  Conversation,
  DMessage,
  listConversations,
  getMessageThread,
  sendMessage,
  markMessagesRead,
} from '../api';
import Nav from '../components/Nav';
import { timeAgo } from '../lib';
import { EmptyState } from '../components/AsyncState';

export default function Messages() {
  const [params, setParams] = useSearchParams();
  const [me, setMe] = useState<AuthUser | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<number | null>(
    params.get('to') ? Number(params.get('to')) : null
  );
  const [thread, setThread] = useState<DMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (getToken()) fetchMe().then(setMe).catch(() => {});
  }, []);

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
        <div className="bg-white rounded-lg border border-gray-100 flex overflow-hidden" style={{ height: '70vh' }}>
          {/* 会话列表 */}
          <aside className="w-72 border-r border-gray-100 overflow-y-auto shrink-0">
            <div className="px-4 py-3 border-b border-gray-100 text-sm font-bold text-gray-900">私信</div>
            {conversations.length === 0 ? (
              <div className="p-4">
                <EmptyState title="还没有会话。" hint="在用户主页点击「发私信」开始。" />
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
                  {conversations.find((c) => c.user.id === activeId)?.user.name || '会话'}
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
      </div>
    </div>
  );
}
