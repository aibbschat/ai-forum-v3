import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { listEntries, getEntryTree, type Entry, type EntryTreeDomain } from '../api';
import Nav from '../components/Nav';
import {
  domainLabel, ENTRY_DOMAIN_ORDER, stateMeta, aiAskGapPrompt, TRUST_TABS, categoryNameById,
} from '../entryMeta';

export default function Entries() {
  const [tabKey, setTabKey] = useState('answer'); // 信任度 tab：answer|all|gap|contested
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [rows, setRows] = useState<Entry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // 目录树：null=全部（全域平铺），number=具体目录节点。
  // categoryId 以 URL 查询参数为唯一数据源：面包屑链回、刷新、分享、返回都能恢复选中。
  const [searchParams, setSearchParams] = useSearchParams();
  const categoryId = (() => {
    const v = searchParams.get('categoryId');
    const n = v ? Number(v) : NaN;
    return Number.isNaN(n) ? null : n;
  })();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [tree, setTree] = useState<EntryTreeDomain[]>([]);

  // 首屏拉目录树（一次即可）
  useEffect(() => {
    getEntryTree().then((t) => {
      setTree(t.domains);
      // 默认展开每个 domain 的第一级，便于钻取
      const init: Record<string, boolean> = {};
      t.domains.forEach((d) => { if (d.categories.length) init[`${d.domain}:${d.categories[0].id}`] = true; });
      setExpanded(init);
    }).catch(() => { /* 目录树拉不到不阻塞列表 */ });
  }, []);

  // 搜索防抖
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const activeTab = TRUST_TABS.find((t) => t.key === tabKey) || TRUST_TABS[0];

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr(null);
    // 目录树已按 domain 分块；categoryId 指向具体目录即可完成整域/整目录过滤，无需重复传 domain。
    listEntries({
      q: debounced || undefined,
      categoryId,
      scope: activeTab.scope,
      state: activeTab.state,
      limit: 50,
    })
      .then((r) => { if (alive) { setRows(r.entries); setTotal(r.total); } })
      .catch((e) => alive && setErr(e?.message || '加载失败'))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryId, tabKey, debounced]);

  const toggle = (key: string) => setExpanded((p) => ({ ...p, [key]: !p[key] }));
  const selectCategory = (id: number) => {
    // 重复点击已选目录 → 取消选中回「全域」（清掉 categoryId 查询参数）；否则回写 URL 以共享/刷新/返回。
    const next = categoryId === id ? null : id;
    if (next == null) {
      const p = new URLSearchParams(searchParams);
      p.delete('categoryId');
      setSearchParams(p, { replace: true });
    } else {
      setSearchParams({ categoryId: String(next) }, { replace: true });
    }
  };

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

        <div className="flex flex-col lg:flex-row lg:gap-6">
          {/* 左栏：目录树（wiki 骨架） */}
          <aside className="lg:w-64 lg:shrink-0 mb-5 lg:mb-0">
            <div className="rounded-xl border border-gray-100 bg-white p-3">
              <div className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">目录</div>
              {tree.length === 0 && <div className="text-xs text-gray-400">目录加载中…</div>}
              <div className="space-y-1">
                {tree.map((d) => (
                  <CategoryBlock
                    key={d.domain}
                    domain={d.domain}
                    categories={d.categories}
                    expanded={expanded}
                    onToggle={toggle}
                    selected={categoryId}
                    onSelect={selectCategory}
                  />
                ))}
              </div>
            </div>
          </aside>

          {/* 主区：信任度 tabs + 搜索 + 列表 */}
          <section className="flex-1 min-w-0">
            {/* 顶部：信任度 tabs（一级维度）+ 搜索 */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
              <div className="flex flex-wrap gap-1.5">
                {TRUST_TABS.map((t) => (
                  <button
                    key={t.key}
                    onClick={() => setTabKey(t.key)}
                    title={t.hint}
                    className={`px-3 py-1.5 rounded-full text-sm transition-colors ${
                      tabKey === t.key ? 'bg-brand-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {t.label}
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
                  {debounced
                    ? `没有与「${debounced}」相关的条目。`
                    : categoryId
                      ? activeTab.key === 'answer'
                        ? '这个目录下还没有可引用的答案，切到「全部」可看草稿态 / 缺口。'
                        : '这个目录下还没有条目。'
                      : '这里还没有条目。'}
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
                  {rows.map((e) => <EntryCard key={e.id} e={e} tree={tree} />)}
                </ul>
              </>
            )}
          </section>
        </div>
      </main>
    </>
  );
}

// 目录块：一个 domain 的目录树（支持两级展开）
function CategoryBlock({
  domain, categories, expanded, onToggle, selected, onSelect,
}: {
  domain: string; categories: EntryTreeDomain['categories']; expanded: Record<string, boolean>;
  onToggle: (k: string) => void; selected: number | null; onSelect: (id: number) => void;
}) {
  return (
    <div>
      <div className="px-2 py-1 text-[11px] font-semibold text-gray-400 uppercase tracking-wide">{domainLabel(domain)}</div>
      {categories.map((c) => {
        const key = `${domain}:${c.id}`;
        const hasKids = c.children && c.children.length > 0;
        const active = selected === c.id;
        return (
          <div key={c.id}>
            <div className={`flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm cursor-pointer transition-colors ${active ? 'bg-brand-50 text-brand-700 font-medium' : 'text-gray-700 hover:bg-gray-50'}`}>
              {hasKids ? (
                <button onClick={() => onToggle(key)} className="shrink-0 text-gray-400 hover:text-gray-700 w-4 text-center text-xs">
                  {expanded[key] ? '▾' : '▸'}
                </button>
              ) : <span className="shrink-0 w-4" />}
              <button onClick={() => onSelect(c.id)} className="flex-1 text-left truncate">
                {c.name}
              </button>
              {c.count > 0 && <span className="shrink-0 text-[11px] text-gray-400">{c.count}</span>}
            </div>
            {hasKids && expanded[key] && (
              <div className="ml-4 border-l border-gray-100 pl-2">
                {c.children.map((kid) => {
                  const kactive = selected === kid.id;
                  return (
                    <button
                      key={kid.id}
                      onClick={() => onSelect(kid.id)}
                      className={`w-full flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-left transition-colors ${kactive ? 'bg-brand-50 text-brand-700 font-medium' : 'text-gray-600 hover:bg-gray-50'}`}
                    >
                      <span className="truncate flex-1">{kid.name}</span>
                      {kid.count > 0 && <span className="text-[11px] text-gray-400">{kid.count}</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function EntryCard({ e, tree }: { e: Entry; tree: EntryTreeDomain[] }) {
  const st = stateMeta(e.state);
  const sources = e.claims.filter((c) => c.verified_against?.url);
  const catName = categoryNameById(tree, e.categoryId, '');
  return (
    <li>
      <Link
        to={`/entries/${e.id}`}
        className="block rounded-xl border border-gray-100 bg-white p-4 hover:border-brand-200 hover:shadow-sm transition"
      >
        <div className="flex items-center gap-2 mb-1.5 flex-wrap">
          <span className="text-[11px] px-2 py-0.5 rounded-md bg-gray-100 text-gray-500">{domainLabel(e.domain)}</span>
          {catName && <span className="text-[11px] px-2 py-0.5 rounded-md bg-brand-50 text-brand-700">{catName}</span>}
          <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md ${st.cls}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />{st.label}
          </span>
          {sources.length > 0 && (
            <span className="text-[11px] text-gray-400">{sources.length} 个来源</span>
          )}
        </div>
        <h3 className="text-[15px] font-semibold text-gray-900 leading-snug">{e.title}</h3>
        {e.excerpt && <p className="mt-1 text-sm text-gray-500 line-clamp-2">{e.excerpt}</p>}
        {e.curatorName && (
          <p className="mt-1.5 text-[11px] text-gray-400">核验补全 · {e.curatorName}{e.source === 'dongai' ? '（素材源自 懂AI）' : ''}</p>
        )}
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