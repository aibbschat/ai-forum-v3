import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Companion,
  CompanionMessage,
  CompanionSession,
  listCompanionSessions,
  createCompanionSession,
  getCompanionMessages,
  deleteCompanionSession,
  sendCompanionMessage,
} from '../api';
import CompanionSprite, { type SpriteState } from './CompanionSprite';

/**
 * 伴侣聊天（M3，§5）：有状态私聊 + 记忆注入 + 文风对齐。
 * 仅主人可用（后端 owner 隔离）；无任何「发布到社区」入口（§5.3 不代发）。
 */
export default function CompanionChat({
  companion,
  onPetState,
}: {
  companion: Companion;
  onPetState?: (s: SpriteState) => void;
}) {
  const [sessions, setSessions] = useState<CompanionSession[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [messages, setMessages] = useState<CompanionMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [error, setError] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 拉会话列表
  const refreshSessions = useCallback(async () => {
    try {
      const r = await listCompanionSessions(companion.id);
      setSessions(r.sessions);
      return r.sessions;
    } catch {
      return [];
    }
  }, [companion.id]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await refreshSessions();
      if (cancelled) return;
      if (list.length > 0) setActiveId(list[0].id); // 最新会话置顶（后端按 updated_at DESC）
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshSessions]);

  // 切换会话 → 拉消息
  useEffect(() => {
    if (activeId == null) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    setLoadingMsgs(true);
    getCompanionMessages(activeId)
      .then((r) => {
        if (!cancelled) setMessages(r.messages);
      })
      .catch(() => {
        if (!cancelled) setMessages([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingMsgs(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  // 滚动到底
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  const autoResize = () => {
    const el = inputRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    }
  };

  const handleNewSession = async () => {
    try {
      const r = await createCompanionSession(companion.id);
      setSessions((s) => [r.session, ...s]);
      setActiveId(r.session.id);
      setMessages([]);
      setError('');
    } catch {
      setError('新建会话失败，请稍后再试。');
    }
  };

  const handleDeleteSession = async () => {
    if (activeId == null) return;
    if (!window.confirm('删除这个会话？聊天记录将一并删除。')) return;
    try {
      await deleteCompanionSession(activeId);
      const rest = await refreshSessions();
      setActiveId(rest.length > 0 ? rest[0].id : null);
      setMessages([]);
    } catch {
      setError('删除失败，请稍后再试。');
    }
  };

  const handleSend = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const text = input.trim();
    if (!text || sending || activeId == null) return;
    setSending(true);
    setError('');
    setInput('');
    setMessages((m) => [...m, { role: 'user', content: text }]);
    onPetState?.('think'); // 精灵联动：思考中
    try {
      const r = await sendCompanionMessage(companion.id, activeId, text);
      setMessages((m) => [...m, { role: 'assistant', content: r.reply.content }]);
      // 精灵联动：回复到达 → 开心一会儿 → 回待机
      onPetState?.('happy');
      window.setTimeout(() => onPetState?.('idle'), 2400);
      // 会话标题可能被后端更新（首条消息），静默刷新
      void refreshSessions();
    } catch (err) {
      const msg = (err as Error & { status?: number })?.status === 503
        ? '搭档暂时不在状态，稍后再试一次。'
        : '消息发送失败，请稍后再试。';
      setError(msg);
      onPetState?.('idle');
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  return (
    <div className="bg-white rounded-lg border border-gray-100 mt-4 overflow-hidden">
      {/* 会话工具条 */}
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-gray-100 bg-gray-50/60">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-semibold text-gray-500 shrink-0">会话</span>
          <select
            value={activeId ?? ''}
            onChange={(e) => setActiveId(e.target.value ? Number(e.target.value) : null)}
            className="text-xs text-gray-700 bg-white border border-gray-200 rounded px-2 py-1 max-w-[200px] truncate focus:outline-none focus:ring-1 focus:ring-indigo-200"
          >
            {sessions.length === 0 && <option value="">（暂无会话）</option>}
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleNewSession}
            className="text-xs text-gray-600 hover:text-gray-900 border border-gray-200 rounded px-2.5 py-1 hover:border-gray-400 transition-colors bg-white"
          >
            ＋ 新对话
          </button>
          {activeId != null && (
            <button
              onClick={handleDeleteSession}
              className="text-xs text-gray-400 hover:text-red-600 transition-colors"
              title="删除当前会话"
            >
              删除
            </button>
          )}
        </div>
      </div>

      {/* 消息区 */}
      <div className="h-[440px] overflow-y-auto px-4 py-5">
        {loadingMsgs ? (
          <div className="text-xs text-gray-400 text-center py-10">加载聊天记录…</div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="mb-3 flex items-end justify-center">
              <CompanionSprite
                state="wave"
                spriteSheet={companion.spriteSheet}
                width={80}
                className="block"
              />
            </div>
            <p className="text-sm text-gray-600 font-medium mb-1">和 {companion.name} 聊点什么</p>
            <p className="text-xs text-gray-400">
              TA 记得你的偏好和近事；聊的内容只有你们俩知道，也不会出现在社区。
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((m, i) =>
              m.role === 'user' ? (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[80%] bg-indigo-600 text-white rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm whitespace-pre-wrap break-words">
                    {m.content}
                  </div>
                </div>
              ) : (
                <div key={i} className="flex gap-2.5">
                  <div className="shrink-0 mt-0.5 w-8 h-10 flex items-end justify-center">
                    <CompanionSprite
                      state="idle"
                      spriteSheet={companion.spriteSheet}
                      width={28}
                      className="block"
                    />
                  </div>
                  <div className="max-w-[80%] bg-gray-50 text-gray-800 rounded-2xl rounded-tl-sm px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words">
                    {m.content}
                  </div>
                </div>
              )
            )}
            {sending && (
              <div className="flex gap-2.5">
                <div className="shrink-0 mt-0.5 w-8 h-10 flex items-end justify-center">
                  <CompanionSprite
                    state="think"
                    spriteSheet={companion.spriteSheet}
                    width={28}
                    className="block"
                  />
                </div>
                <div className="bg-gray-50 rounded-2xl rounded-tl-sm px-4 py-3 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 bg-gray-300 rounded-full animate-bounce" />
                  <span
                    className="w-1.5 h-1.5 bg-gray-300 rounded-full animate-bounce"
                    style={{ animationDelay: '0.15s' }}
                  />
                  <span
                    className="w-1.5 h-1.5 bg-gray-300 rounded-full animate-bounce"
                    style={{ animationDelay: '0.3s' }}
                  />
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
        )}
      </div>

      {/* 输入区 */}
      <form onSubmit={handleSend} className="border-t border-gray-100 px-4 py-3">
        {error && <p className="text-xs text-red-500 mb-2">{error}</p>}
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              autoResize();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={`对 ${companion.name} 说…（Shift+Enter 换行）`}
            rows={1}
            className="flex-1 resize-none rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300 max-h-[120px]"
          />
          <button
            type="submit"
            disabled={sending || !input.trim() || activeId == null}
            className="shrink-0 w-10 h-10 rounded-xl bg-gray-900 text-white flex items-center justify-center hover:bg-gray-800 disabled:opacity-40 transition"
            title="发送"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
        <p className="text-[11px] text-gray-300 mt-2">
          私密对话，不会发布到社区；TA 只帮你写，不会替你发。
        </p>
      </form>
    </div>
  );
}
