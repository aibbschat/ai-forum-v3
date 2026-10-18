import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Nav from '../components/Nav';
import { listExperts, type Expert } from '../api';

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
  expertName?: string;         // 回答者：选中专家时为其名，否则「AI 圈」
  expertIcon?: string;         // 回答者头像（专家的 emoji）
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

/* ── 空态推荐问题 ── */
const SUGGESTIONS = [
  '秦始皇焚书坑儒的真相是什么？',
  '大模型推理成本为什么在快速下降？',
  '普通人该怎么配置第一笔基金？',
  '《红楼梦》前八十回到底好在哪？',
];

/* ── 主页面 ── */
export default function Chat() {
  const [params] = useSearchParams();
  const initialQ = params.get('q') || '';
  // 专家页「召唤」跳转带 ?expert=<id>：进页面即处于「已召唤」态。
  const initialExpertId = Number(params.get('expert')) || null;

  const [input, setInput] = useState(initialQ);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [loading, setLoading] = useState(false);
  const [experts, setExperts] = useState<Expert[]>([]);
  const [expertId, setExpertId] = useState<number | null>(null); // null = 通用「问 AI 圈」
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 百家学院专家池；拉取失败静默——退化为纯通用问答，不影响主流程。
  useEffect(() => {
    listExperts().then((r) => setExperts(r.experts || [])).catch(() => {});
  }, []);

  // ?expert=<id> 生效需等列表加载完（校验 id 真实存在，防手敲链接指到幽灵专家）
  useEffect(() => {
    if (!initialExpertId || !experts.length) return;
    if (experts.some((e) => e.id === initialExpertId)) setExpertId(initialExpertId);
  }, [experts, initialExpertId]);

  const expert = expertId ? experts.find((e) => e.id === expertId) || null : null;
  // handleAsk 需要读到「当前最新」选中的专家，但不希望因专家切换而重建回调
  // （它会作为自动提问 effect 的依赖），用 ref 承载最新值。
  const expertRef = useRef<{ id: number; name: string; icon: string } | null>(null);
  expertRef.current = expert ? { id: expert.id, name: expert.name, icon: expert.icon } : null;

  // 滚动到底
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // 自动调节输入框高度
  const autoResize = useCallback(() => {
    const el = inputRef.current;
    if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 200) + 'px'; }
  }, []);

  const handleAsk = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || loading) return;

      const curExpert = expertRef.current;
      const userMsg: Msg = { role: 'user', content: text };
      const pending: Msg = {
        role: 'assistant', content: '', reasoning: '', stage: '准备中…', pending: true, isReasoning: true,
        expertName: curExpert?.name || 'AI 圈',
        expertIcon: curExpert?.icon || '',
      };
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
          body: JSON.stringify({ question: text, expertId: curExpert?.id ?? null }),
          signal: ctrl.signal,
        });

        if (!res.ok || !res.body) {
          throw new Error(`HTTP ${res.status}`);
        }

        const reader = res.body.getReader();
        const dec = new TextDecoder();
        // eventType 必须在读循环外持久化：服务端零缓冲写 socket，单个 SSE 事件
        // （event:…\ndata:…\n\n）可能被 TCP 拆进两个 chunk。若把 eventType 放在
        // for(;;) 内部每轮重置，data: 落在后一个 chunk 时类型已被清空 → 答案片段/
        // 来源/阶段事件被静默丢弃（就是"有时出错"的主因）。
        let buf = '';
        let eventType = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });

          const lines = buf.split('\n');
          buf = lines.pop() || '';

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

  /* ── 输入卡：空态大屏与对话吸底共用。只显示「当前召唤的专家」一枚，不再平铺全部专家 ── */
  const composerCard = (
    <div className="rounded-2xl border-2 border-gray-200 bg-white focus-within:border-indigo-300 transition-colors">
      <textarea
        ref={inputRef}
        value={input}
        onChange={(e) => { setInput(e.target.value); autoResize(); }}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(e); } }}
        placeholder={expert ? `向 ${expert.name} 提问…（Shift+Enter 换行）` : '想问点什么？（Shift+Enter 换行）'}
        rows={2}
        className="w-full resize-none px-5 pt-4 pb-1 text-[15px] leading-relaxed text-gray-800 placeholder:text-gray-400 focus:outline-none bg-transparent max-h-[200px]"
      />
      <div className="flex items-center justify-between gap-2 px-3.5 pb-3">
        {expert ? (
          <div className="inline-flex items-center gap-2 min-w-0">
            <span className="inline-flex items-center gap-1.5 h-8 pl-1.5 pr-2 rounded-full bg-indigo-50 border border-indigo-200 text-indigo-700 text-[13px] font-semibold min-w-0">
              <span className="w-5 h-5 rounded-full bg-white flex items-center justify-center text-sm shrink-0">{expert.icon || '💬'}</span>
              <span className="truncate">{expert.name}</span>
              <button
                type="button"
                onClick={() => setExpertId(null)}
                className="text-indigo-400 hover:text-indigo-700 px-1 leading-none"
                title="送别专家，回到通用问答"
              >✕</button>
            </span>
            <Link to="/experts" className="text-xs text-gray-400 hover:text-indigo-600 transition shrink-0">换一位 ›</Link>
          </div>
        ) : (
          <div className="inline-flex items-center gap-2 min-w-0">
            <span className="inline-flex items-center gap-1.5 h-8 pl-1.5 pr-3 rounded-full bg-gray-50 border border-gray-200 text-gray-500 text-[13px] font-medium">
              <img src="/logo.svg" alt="" className="w-5 h-5 rounded-full" />
              问 AI 圈
            </span>
            <Link to="/experts" className="text-xs text-indigo-500 hover:text-indigo-700 transition shrink-0">⚡ 召唤专家 ›</Link>
          </div>
        )}
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="shrink-0 inline-flex items-center gap-1.5 h-9 px-4 rounded-xl bg-indigo-600 text-white text-[13.5px] font-medium hover:bg-indigo-700 active:bg-indigo-800 disabled:opacity-40 disabled:cursor-not-allowed transition"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
          发送
        </button>
      </div>
    </div>
  );

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      <Nav />

      {isEmpty ? (
        /* ═══ 空态首页：居中大屏，只留「召唤专家」一条路径 + 输入框 ═══ */
        <main className="relative flex-1 overflow-y-auto">
          {/* 渲染元素：极淡的渐变光斑，给大屏一点纵深，不抢内容 */}
          <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
            <div className="absolute -top-32 left-1/2 -translate-x-1/2 w-[680px] h-[420px] rounded-full bg-gradient-to-b from-indigo-100 via-violet-50 to-transparent blur-3xl" />
            <div className="absolute bottom-[-130px] right-[-90px] w-[380px] h-[380px] rounded-full bg-gradient-to-tr from-violet-100 to-transparent blur-3xl opacity-70" />
            <div className="absolute bottom-[-110px] left-[-100px] w-[330px] h-[330px] rounded-full bg-gradient-to-tr from-sky-100 to-transparent blur-3xl opacity-60" />
          </div>

          <div className="relative flex flex-col items-center justify-center min-h-full px-4 py-12 text-center">
            <img src="/logo.svg" alt="AI 圈" className="w-20 h-20 animate-logo-breathe" />
            <h1 className="mt-5 text-3xl sm:text-[40px] leading-tight font-black tracking-tight">
              <span className="bg-gradient-to-r from-indigo-600 via-violet-600 to-indigo-500 bg-clip-text text-transparent">问 AI</span>
              <span className="text-gray-300 mx-2 font-normal select-none">·</span>
              <span className="text-gray-800">向专家提问</span>
            </h1>
            <p className="mt-3 text-sm text-gray-400 max-w-md leading-relaxed">
              召唤一位百家专家，答案溯源到 TA 的知识库；不召唤，AI 圈通用问答随时在。
            </p>

            {/* 当前召唤态：只展示被召唤的那一位（或一个通往专家页的入口） */}
            {expert ? (
              <div className="mt-6 inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-white pl-1.5 pr-4 py-1.5 shadow-sm">
                <span className="w-9 h-9 rounded-full bg-indigo-50 flex items-center justify-center text-xl">{expert.icon || '💬'}</span>
                <span className="text-sm font-bold text-gray-800 text-left leading-tight">
                  {expert.name}
                  <span className="block text-[10.5px] font-medium text-indigo-500">已召唤 · {expert.title || expert.category}</span>
                </span>
                <button
                  onClick={() => setExpertId(null)}
                  className="ml-1 text-gray-300 hover:text-gray-500 text-sm leading-none"
                  title="送别专家，回到通用问答"
                >✕</button>
                <Link to="/experts" className="text-xs text-indigo-500 hover:text-indigo-700">换一位</Link>
              </div>
            ) : (
              <Link
                to="/experts"
                className="mt-6 inline-flex items-center gap-1.5 text-sm font-bold text-indigo-600 bg-white border border-indigo-200 rounded-full px-5 py-2.5 hover:bg-indigo-50 hover:border-indigo-300 transition shadow-sm"
              >
                <span aria-hidden>⚡</span> 召唤专家 <span aria-hidden className="text-indigo-400">›</span>
              </Link>
            )}

            <form onSubmit={submit} className="w-full max-w-[760px] mt-7">
              {composerCard}
            </form>

            <div className="flex flex-wrap gap-2 justify-center mt-6 max-w-[640px]">
              {SUGGESTIONS.map((q) => (
                <button
                  key={q}
                  onClick={() => handleAsk(q)}
                  className="text-xs text-gray-500 bg-white/70 border border-gray-200 rounded-full px-3.5 py-2 hover:border-indigo-300 hover:text-indigo-600 transition"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        </main>
      ) : (
        <>
          {/* 对话态顶部工具条 */}
          <div className="border-b border-gray-100 bg-white/80 backdrop-blur shrink-0">
            <div className="container-site flex items-center h-10">
              <h1 className="text-sm font-bold text-gray-700">
                问 AI <span className="font-normal text-gray-400">· 向专家提问</span>
              </h1>
            </div>
          </div>

          {/* 对话区（占满剩余高度） */}
          <div className="flex-1 overflow-y-auto">
            <div className="container-site max-w-[800px] mx-auto px-4 py-6">
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
                        <div className={`w-8 h-8 rounded-full shrink-0 mt-0.5 flex items-center justify-center text-lg ${m.expertIcon ? 'bg-gray-100' : 'overflow-hidden'}`}>
                          {m.expertIcon
                            ? m.expertIcon
                            : <img src="/logo.svg" alt="AI" className="w-full h-full animate-logo-pulse" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          {/* 回答者身份：选中专家时显示其名，否则「AI 圈」 */}
                          {m.expertName && (
                            <div className="text-[11px] text-gray-400 mb-1 font-medium">
                              {m.expertName === 'AI 圈' ? 'AI 圈' : `${m.expertName} · 百家专家`}
                            </div>
                          )}
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
            </div>
          </div>

          {/* 底部输入区（吸底） */}
          <div className="border-t border-gray-100 bg-white/95 backdrop-blur shrink-0">
            <form onSubmit={submit} className="container-site max-w-[820px] mx-auto px-4 pt-3 pb-4">
              {composerCard}
            </form>
          </div>
        </>
      )}
    </div>
  );
}
