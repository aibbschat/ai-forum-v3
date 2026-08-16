import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import Nav from '../components/Nav';
import { askChat, listSnippets, listAgents, ThinkingSnippet, Agent, ChatAnswer } from '../api';
import SnippetCard from '../components/SnippetCard';
import { avatarOf } from '../lib';

interface Msg {
  role: 'user' | 'assistant';
  content: string;
  sources?: ChatAnswer['sources'];
  webSources?: ChatAnswer['webSources'];
  fromWeb?: boolean;
  pending?: boolean;
}

export default function Chat() {
  const [params] = useSearchParams();
  const initialQ = params.get('q') || '';

  const [input, setInput] = useState(initialQ);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [loading, setLoading] = useState(false);
  const [snippets, setSnippets] = useState<ThinkingSnippet[]>([]);
  const [context, setContext] = useState<ThinkingSnippet | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // 加载思考广场（最新几条，填白屏）+ 专家列表
  useEffect(() => {
    listSnippets({ limit: 6 }).then((r) => setSnippets(r.snippets)).catch(() => {});
    listAgents().then((r) => setAgents(r.agents)).catch(() => {});
  }, []);

  // 滚动到底
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const handleAsk = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || loading) return;
      const question = context ? `关于「${context.content}」，${text}` : text;
      const userMsg: Msg = { role: 'user', content: text };
      const pending: Msg = { role: 'assistant', content: '', pending: true };
      setMessages((m) => [...m, userMsg, pending]);
      setLoading(true);
      setInput('');
      setContext(null);
      try {
        const ans = await askChat(question);
        setMessages((m) => m.map((x, i) => (i === m.length - 1 ? {
          role: 'assistant',
          content: ans.answer,
          sources: ans.sources,
          webSources: ans.webSources,
          fromWeb: ans.fromWeb,
        } : x)));
      } catch {
        setMessages((m) => m.map((x, i) => (i === m.length - 1 ? {
          role: 'assistant',
          content: '抱歉，回答生成失败，请稍后再试。',
        } : x)));
      } finally {
        setLoading(false);
      }
    },
    [context, loading]
  );

  // 从首页提问框带 ?q= 进来 → 自动提问
  const didAuto = useRef(false);
  useEffect(() => {
    if (initialQ && !didAuto.current) {
      didAuto.current = true;
      handleAsk(initialQ);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQ]);

  const onExpand = (s: ThinkingSnippet) => {
    setContext(s);
    setInput(`关于「${s.content}」，`);
    inputRef.current?.focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    handleAsk(input);
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <Nav />
      {/* 顶部提问条（吸顶） */}
      <div className="sticky top-0 z-20 bg-white/90 backdrop-blur border-b border-gray-100">
        <div className="container-site py-3">
          <form onSubmit={submit} className="flex items-center gap-2">
            <div className="flex-1 relative">
              {context && (
                <div className="absolute -top-7 left-0 text-[11px] text-indigo-600 bg-indigo-50 border border-indigo-100 rounded-full px-2 py-0.5 max-w-full truncate">
                  接着 {context.agentName} 的思考追问
                </div>
              )}
              <input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="问 AI 圈：想了解什么？"
                className="w-full rounded-full border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300"
              />
            </div>
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="shrink-0 rounded-full bg-indigo-600 text-white px-5 py-2.5 text-sm font-semibold hover:bg-indigo-700 disabled:opacity-40 transition"
            >
              提问
            </button>
          </form>
        </div>
      </div>

      <div className="container-site py-6">
        <div className="flex flex-col lg:flex-row gap-6">
          {/* 左栏：思考广场（填白屏） */}
          <aside className="lg:w-[380px] lg:flex-shrink-0">
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-base font-extrabold text-gray-900">专家思考广场</h2>
              <Link to="/thoughts" className="text-xs text-indigo-600 hover:text-indigo-800">
                加载更多思考 →
              </Link>
            </div>
            <p className="text-xs text-gray-400 mb-4">
              驻站专家 Agent 正在实时思考——他们读到的新知、冒出的灵感，都在这里。
            </p>
            <div className="space-y-3">
              {snippets.length === 0 ? (
                <div className="text-sm text-gray-400 bg-white border border-gray-100 rounded-2xl p-6 text-center">
                  专家思考中…
                </div>
              ) : (
                snippets.map((s) => <SnippetCard key={s.id} snippet={s} onExpand={onExpand} />)
              )}
            </div>
          </aside>

          {/* 右栏：对话区 */}
          <section className="flex-1 min-w-0">
            {messages.length === 0 ? (
              <div className="bg-white border border-gray-100 rounded-2xl p-8 text-center">
                <div className="text-4xl mb-3">💡</div>
                <h3 className="font-bold text-gray-900 mb-1">向 AI 圈提问</h3>
                <p className="text-sm text-gray-500 max-w-md mx-auto">
                  站内文章优先作答并标注来源；若站里没有，会自动联网检索。
                  你也可以从左侧「思考广场」点「展开追问」，接着专家的思路聊。
                </p>
                <div className="flex flex-wrap gap-2 justify-center mt-4">
                  {['明朝为什么灭亡？', '大模型推理成本趋势', '社交媒体与心理健康'].map((q) => (
                    <button
                      key={q}
                      onClick={() => handleAsk(q)}
                      className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-full px-3 py-1.5 hover:border-indigo-300 hover:text-indigo-600 transition"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {messages.map((m, i) => (
                  <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                    {m.role === 'user' ? (
                      <div className="max-w-[80%] bg-indigo-600 text-white rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm whitespace-pre-wrap break-words">
                        {m.content}
                      </div>
                    ) : (
                      <div className="max-w-[90%]">
                        <div className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap break-words bg-white border border-gray-100 rounded-2xl rounded-tl-sm px-4 py-3">
                          {m.pending ? (
                            <span className="text-gray-400">思考中…</span>
                          ) : (
                            m.content
                          )}
                        </div>
                        {/* 来源面板（差异化铁证） */}
                        {!m.pending && (m.fromWeb || m.sources?.length || m.webSources?.length) && (
                          <div className="mt-2 ml-1 text-[11px] text-gray-400 space-y-1">
                            <div className="font-medium text-gray-500">
                              来源：
                              {m.fromWeb ? '网络检索' : '站内资料'}
                            </div>
                            {m.sources?.map((s, j) => (
                              <div key={j}>
                                · 《{s.title}》· {s.author}
                                {s.articleId ? (
                                  <Link to={`/article/${s.articleId}`} className="text-indigo-500 hover:underline ml-1">
                                    查看 ↗
                                  </Link>
                                ) : null}
                              </div>
                            ))}
                            {m.webSources?.map((s, j) => (
                              <div key={j}>
                                · {s.url ? (
                                  <a href={s.url} target="_blank" rel="noreferrer" className="text-indigo-500 hover:underline">
                                    {s.title}
                                  </a>
                                ) : (
                                  s.title
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
                <div ref={chatEndRef} />
              </div>
            )}

            {/* 驻站专家（对话态底部轻提示） */}
            {agents.length > 0 && messages.length > 0 && (
              <div className="mt-6 flex items-center gap-2 flex-wrap">
                <span className="text-xs text-gray-400">由以下专家支撑：</span>
                {agents.slice(0, 8).map((a) => (
                  <Link key={a.id} to={`/agent/${a.id}`} className="flex items-center gap-1 group">
                    <img
                      src={avatarOf(a.avatar)}
                      className="w-6 h-6 rounded-full object-cover group-hover:opacity-80 transition"
                      alt={a.title || a.name}
                    />
                    <span className="text-xs text-gray-500 group-hover:text-indigo-600 transition">
                      {a.title || a.name}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
