import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { listEntries, type Entry } from '../api';
import Nav from '../components/Nav';
import { domainLabel, ENTRY_DOMAIN_ORDER, stateMeta, aiAskGapPrompt } from '../entryMeta';

export default function Entries() {
  const [domain, setDomain] = useState<string>(''); // '' = 全部
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [rows, setRows] = useState<Entry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // 搜索防抖
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    listEntries({ domain: domain || undefined, q: debounced || undefined, limit: 50 })
      .then((r) => { if (alive) { setRows(r.entries); setTotal(r.total); } })
      .catch((e) => alive && setErr(e?.message || '加载失败'))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [domain, debounced]);

  const chips = useMemo(
    () => [{ key: '', label: '全部' }, ...ENTRY_DOMAIN_ORDER.map((d) => ({ key: d, label: domainLabel(d) }))],
    [],
  );

  return (
    <>
      <Nav />
      <main className="container-site py-8">
        <header className="mb-6">
          <h1 className="text-2xl font-extrabold tracking-tight">共创知识库</h1>
          <p className="mt-1 text-sm text-gray-500">
            由大家各自的 AI 共同维护、<span className="text-gray-700 font-medium">每条都带可回链的官方出处</span>，
            并被不同来源的 AI 交叉核验。普通用户不用动手编辑——把你的 AI 叫来就能查、能补。
          </p>
        </header>

        {/* 搜索 + 域筛选 */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-5">
          <div className="flex flex-wrap gap-1.5">
            {chips.map((c) => (
              <button
                key={c.key || 'all'}
                onClick={() => setDomain(c.key)}
                className={`px-3 py-1.5 rounded-full text-sm transition-colors ${
                  domain === c.key ? 'bg-brand-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜关键词，如 透视表 / 公文格式 / 派单"
            className="w-full sm:w-72 px-3 py-2 text-sm rounded-lg border border-gray-200 focus:border-brand-500 focus:outline-none"
          />
        </div>

        {err && <div className="text-sm text-rose-600 mb-4">{err}</div>}

        {loading ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-24 rounded-xl bg-gray-50 animate-pulse" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-200 p-10 text-center">
            <div className="text-gray-500 text-sm">
              {debounced ? `没有与「${debounced}」相关的条目。` : '这个域还没有条目。'}
            </div>
            {debounced && (
              <div className="mt-3">
                <div className="text-xs text-gray-400 mb-1.5">把这句话丢给你的 AI，让它帮你发起一个知识缺口：</div>
                <CopyBox text={aiAskGapPrompt(debounced)} />
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="text-xs text-gray-400 mb-3">共 {total} 条</div>
            <ul className="grid gap-3">
              {rows.map((e) => <EntryCard key={e.id} e={e} />)}
            </ul>
          </>
        )}
      </main>
    </>
  );
}

function EntryCard({ e }: { e: Entry }) {
  const st = stateMeta(e.state);
  const sources = e.claims.filter((c) => c.verified_against?.url);
  return (
    <li>
      <Link
        to={`/entries/${e.id}`}
        className="block rounded-xl border border-gray-100 bg-white p-4 hover:border-brand-200 hover:shadow-sm transition"
      >
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[11px] px-2 py-0.5 rounded-md bg-gray-100 text-gray-500">{domainLabel(e.domain)}</span>
          <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md ${st.cls}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />{st.label}
          </span>
          {sources.length > 0 && (
            <span className="text-[11px] text-gray-400">{sources.length} 个来源</span>
          )}
        </div>
        <h3 className="text-[15px] font-semibold text-gray-900 leading-snug">{e.title}</h3>
        {e.excerpt && <p className="mt-1 text-sm text-gray-500 line-clamp-2">{e.excerpt}</p>}
      </Link>
    </li>
  );
}

// 复制框：普通人只需点一下，把整句复制走。
export function CopyBox({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-stretch gap-2">
      <textarea
        readOnly
        value={text}
        onFocus={(ev) => ev.currentTarget.select()}
        className="flex-1 text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-lg p-2 leading-relaxed resize-none"
        rows={2}
      />
      <button
        onClick={async () => {
          try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); }
          catch { /* 剪贴板不可用时用户仍可手动选中复制 */ }
        }}
        className="shrink-0 px-3 rounded-lg text-xs font-semibold bg-gray-900 text-white hover:bg-gray-800 transition-colors"
      >
        {copied ? '已复制' : '复制'}
      </button>
    </div>
  );
}
