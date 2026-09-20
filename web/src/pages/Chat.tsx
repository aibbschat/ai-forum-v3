import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Nav from '../components/Nav';

/* ── 类型 ── */
interface ChatSource {
  title: string;
  author?: string;
  articleId?: number;
}
interface WebSource {
  title: string;
  url?: string;
}
interface Msg {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;          // 思考过程文本
  stage?: string;              // 当前阶段提示
  sources?: ChatSource[];
  webSources?: WebSource[];
  fromWeb?: boolean;
  pending?: boolean;
  isReasoning?: boolean;       // 是否还在推理中
  isContent?: boolean;         // 是否在流式输出答案中
}

/* ── 渲染简易 Markdown（加粗/链接/换行） ── */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderText(text: string) {
  if (!text) return null;
  // 分行处理
  return text.split('\n').map((line, i) => {
    // 先整体 HTML 转义，杜绝 LLM 输出（Agent/被引用的站点内容）里夹带的原始标签/属性注入；
    // 转义后我们再拼允许的 <a>/<strong>。这样 injected 的 HTML 永远是受控的。
    let html = escapeHtml(line);
    // 加粗
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // 内嵌链接 [text](url)（text 与 url 都已是转义后的文本，落进属性不会逃逸）
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="nofollow noopener noreferrer" class="text-brand-600 hover:underline">$1</a>');
    // 裸 URL（转义后文本里不剩原始引号，href 属性不会被打断）
    html = html.replace(/(?<!["\(])(https?:\/\/[^\s<]+)/g, (m) => {
      let host: string;
      try { host = new URL(m).hostname.replace(/^www\./, ''); } catch { host = m; }
      return `<a href="${m}" target="_blank" rel="nofollow noopener noreferrer" class="text-brand-600 hover:underline">${host}</a>`;
    });
    return <span key={i} dangerouslySetInnerHTML={{ __html: html + (i > 0 ? '\n' : '') }} />;
  });
}

/* ── 思考过程折叠组件 ── */
function ReasoningBlock({ text, isOpen }: { text: string; isOpen: boolean }) {
  const [open, setOpen] = useState(isOpen);
  useEffect(() => { setOpen(isOpen); }, [isOpen]);
  if (!text) return null;
  return (
    <div className="mb-3">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-600 transition"
      >
        <span className={`inline-block transition-transform ${open ? 'rotate-90' : ''}`}>▶</span>
        思考过程
        <span className="text-gray-300">({text.length} 字)</span>
      </button>
      {open && (
        <div className="mt-2 pl-3 border-l-2 border-gray-100 text-[13px] text-gray-400 leading-relaxed whitespace-pre-wrap break-words max-h-[300px] overflow-y-auto">
          {renderText(text)}
        </div>
      )}
    </div>
  );
}

/* ── 主页面 ── */
export default function Chat() {
  const [params] = useSearchParams();
  const initialQ = params.get('q') || '';

  const [input, setInput] = useState(initialQ);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 滚动到底
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // 自动调节输入框高度
  const autoResize = useCallback(() => {
    const el = inputRef.current;
    if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 120) + 'px'; }
  }, []);

  const handleAsk = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || loading) return;

      const userMsg: Msg = { role: 'user', content: text };
      const pending: Msg = { role: 'assistant', content: '', reasoning: '', stage: '准备中…', pending: true, isReasoning: true };
      setMessages((m) => [...m, userMsg, pending]);
      setLoading(true);
      setInput('');

      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      try {
        const res = await fetch(`/api/chat/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: text }),
          signal: ctrl.signal,
        });

        if (!res.ok || !res.body) {
          throw new Error(`HTTP ${res.status}`);
        }

        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });

          const lines = buf.split('\n');
          buf = lines.pop() || '';

          let eventType = '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('event:')) {
              eventType = trimmed.slice(6);
            } else if (trimmed.startsWith('data:')) {
              const data = trimmed.slice(5).trim();
              let obj: any;
              try { obj = JSON.parse(data); } catch { continue; }
              handleSSE(eventType, obj);
            }
          }
        }
      } catch (e: any) {
        if (e.name === 'AbortError') return;
        setMessages((m) => m.map((x, i) =>
          i === m.length - 1 ? { ...x, pending: false, content: x.content || '抱歉，回答生成失败，请稍后再试。', isReasoning: false, isContent: false } : x
        ));
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loading]
  );

  // SSE 事件处理器（用 ref 稳定引用避免闭包陈旧问题）
  const handleSSE = useCallback((type: string, data: any) => {
    setMessages((m) => {
      const updated = [...m];
      const last = updated.length - 1;
      if (last < 0 || updated[last].role !== 'assistant') return m;
      const msg = { ...updated[last] };

      switch (type) {
        case 'reset':
          // 后端在从「站内无资料」切换到「联网融合回答」时发，
          // 清掉之前可能输出的「【无资料】」字样和思考过程，避免答案割裂。
          msg.content = '';
          msg.reasoning = '';
          msg.stage = '';
          msg.isContent = false;
          msg.isReasoning = false;
          break;
        case 'stage':
          msg.stage = data.text;
          break;
        case 'reasoning':
          msg.reasoning = (msg.reasoning || '') + data.text;
          msg.isReasoning = true;
          msg.pending = false;
          break;
        case 'content':
          msg.content = (msg.content || '') + data.text;
          msg.isContent = true;
          msg.isReasoning = false;
          msg.pending = false;
          break;
        case 'sources':
          msg.sources = data.inSite;
          msg.webSources = data.web;
          msg.fromWeb = data.fromWeb;
          msg.isContent = false;
          msg.isReasoning = false;
          break;
        case 'done':
          msg.pending = false;
          msg.isContent = false;
          msg.isReasoning = false;
          break;
        case 'error':
          msg.content = msg.content || data.message || '生成失败';
          msg.pending = false;
          msg.isContent = false;
          msg.isReasoning = false;
          break;
      }

      updated[last] = msg;
      return updated;
    });
  }, []);

  // 自动提问
  const didAuto = useRef(false);
  useEffect(() => {
    if (initialQ && !didAuto.current) { didAuto.current = true; handleAsk(initialQ); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQ]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    handleAsk(input);
  };

  const isEmpty = messages.length === 0;

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      <Nav />

      {/* 顶部工具条：思考广场入口 */}
      <div className="border-b border-gray-100 bg-white/80 backdrop-blur">
        <div className="container-site flex items-center justify-between h-10">
          <h1 className="text-sm font-bold text-gray-700">AI 圈 · 智能问答</h1>
          <Link
            to="/thoughts"
            className="text-xs text-gray-400 hover:text-indigo-600 transition"
          >
            💡 思考广场 →
          </Link>
        </div>
      </div>

      {/* 对话区（占满剩余高度） */}
      <div className="flex-1 overflow-y-auto">
        <div className="container-site max-w-[800px] mx-auto px-4 py-6">
          {isEmpty ? (
            /* ── 空态：欢迎 + 推荐问题 ── */
            <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
              <div className="mb-4">
                <img src="/logo.svg" alt="AI 圈" className="w-16 h-16 mx-auto animate-logo-breathe" />
              </div>
              <h2 className="text-xl font-extrabold text-gray-900 mb-2">向 AI 圈的 Agent 提问</h2>
              <p className="text-sm text-gray-400 mb-6">有问必答，实时展开思考过程。</p>
              <div className="flex flex-wrap gap-2 justify-center">
                {[
                  '大模型推理成本为什么在快速下降？',
                  '人形机器人离真正进工厂还有多远？',
                  '短视频对注意力的影响有多大？',
                  'AI 辅助阅读真的能提高效率吗？',
                ].map((q) => (
                  <button
                    key={q}
                    onClick={() => handleAsk(q)}
                    className="text-xs text-gray-600 bg-white border border-gray-200 rounded-full px-3.5 py-2 hover:border-indigo-300 hover:text-indigo-600 transition shadow-sm"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            /* ── 对话消息列表 ── */
            <div className="space-y-6 pb-4">
              {messages.map((m, i) => (
                <div key={i}>
                  {m.role === 'user' ? (
                    <div className="flex justify-end mb-1">
                      <div className="max-w-[80%] bg-indigo-600 text-white rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm whitespace-pre-wrap break-words">
                        {m.content}
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-3">
                      <div className="w-8 h-8 rounded-full overflow-hidden shrink-0 mt-0.5">
                        <img src="/logo.svg" alt="AI" className="w-full h-full animate-logo-pulse" />
                      </div>
                      <div className="flex-1 min-w-0">
                        {/* 阶段提示 */}
                        {m.stage && m.pending && (
                          <div className="text-xs text-gray-400 mb-2 flex items-center gap-1.5">
                            <span className="inline-block w-3 h-3 border-2 border-gray-300 border-t-indigo-500 rounded-full animate-spin" />
                            {m.stage}
                          </div>
                        )}
                        {/* 思考过程（可折叠） */}
                        {m.reasoning && <ReasoningBlock text={m.reasoning} isOpen={m.isReasoning || false} />}
                        {/* 正文（Markdown 完整渲染） */}
                        {(m.content || (!m.pending && !m.reasoning)) && (
                          <div className="chat-markdown text-sm text-gray-800 leading-relaxed break-words">
                            <ReactMarkdown
                              remarkPlugins={[remarkGfm]}
                              components={{
                                // 外链统一 nofollow + 新标签
                                a({ href, children, ...rest }) {
                                  const ext = typeof href === 'string' && /^https?:\/\//i.test(href);
                                  return (
                                    <a
                                      href={href}
                                      {...(ext ? { target: '_blank', rel: 'nofollow noopener noreferrer' } : {})}
                                      className="text-brand-600 hover:underline"
                                      {...rest}
                                    >
                                      {children}
                                    </a>
                                  );
                                },
                              }}
                            >
                              {m.content}
                            </ReactMarkdown>
                            {m.isContent && <span className="inline-block w-1.5 h-4 bg-indigo-400 animate-pulse ml-0.5 align-middle" />}
                          </div>
                        )}
                        {/* 加载占位 */}
                        {m.pending && !m.reasoning && !m.content && (
                          <div className="text-sm text-gray-400">
                            <span className="inline-block w-3 h-3 border-2 border-gray-300 border-t-indigo-500 rounded-full animate-spin mr-1.5" />
                            {m.stage || '准备中…'}
                          </div>
                        )}
                        {/* 来源 */}
                        {!m.pending && (m.fromWeb || m.sources?.length || m.webSources?.length) && (
                          <div className="mt-3 pt-3 border-t border-gray-100 text-[11px] text-gray-400 space-y-1">
                            <div className="font-medium text-gray-500">
                              📎 来源：{m.fromWeb ? '网络检索' : '站内文章'}
                            </div>
                            {m.sources?.map((s, j) => (
                              <div key={j} className="flex items-center gap-1">
                                · 《{s.title}》· {s.author}
                                {s.articleId ? (
                                  <Link to={`/article/${s.articleId}`} className="text-indigo-500 hover:underline ml-1">
                                    查看 ↗
                                  </Link>
                                ) : null}
                              </div>
                            ))}
                            {m.webSources?.map((s, j) => (
                              <div key={j} className="flex items-center gap-1">
                                · {s.url ? (
                                  <a href={s.url} target="_blank" rel="nofollow noopener noreferrer" className="text-indigo-500 hover:underline">
                                    {s.title}
                                  </a>
                                ) : s.title}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
          )}
        </div>
      </div>

      {/* 底部输入区（吸底） */}
      <div className="border-t border-gray-100 bg-white/90 backdrop-blur">
        <form onSubmit={submit} className="container-site max-w-[800px] mx-auto px-4 py-3">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => { setInput(e.target.value); autoResize(); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(e); } }}
              placeholder="问 AI 圈：想了解什么？（Shift+Enter 换行）"
              rows={1}
              className="flex-1 resize-none rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300 max-h-[120px]"
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="shrink-0 w-10 h-10 rounded-xl bg-indigo-600 text-white flex items-center justify-center hover:bg-indigo-700 disabled:opacity-40 transition"
              title="发送"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
