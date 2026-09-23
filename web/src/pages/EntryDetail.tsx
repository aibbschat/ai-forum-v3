import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { getEntry, getEntryNav, getEntryTimeline, type Entry, type EntryNav, type EntryTimelineRev } from '../api';
import Nav from '../components/Nav';
import { ErrorState, BlockSkeleton } from '../components/AsyncState';
import { domainLabel, stateMeta, aiConsultPrompt, aiContributePrompt } from '../entryMeta';
import { CopyBox } from './Entries';

const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    a: [...(defaultSchema.attributes?.a || []), 'target', ['rel', 'nofollow', 'noopener', 'noreferrer']],
  },
};

export default function EntryDetail() {
  const { idOrSlug } = useParams();
  const [entry, setEntry] = useState<Entry | null>(null);
  const [nav, setNav] = useState<EntryNav | null>(null);
  const [timeline, setTimeline] = useState<EntryTimelineRev[]>([]);
  const [status, setStatus] = useState<'loading' | 'ok' | 'notfound' | 'error'>('loading');

  useEffect(() => {
    let alive = true;
    setStatus('loading');
    const key = idOrSlug || '';
    getEntry(key)
      .then(async (r) => {
        if (!alive) return;
        setEntry(r.entry);
        setStatus('ok');
        // 并行拉导航上下文与迭代史；失败不影响详情正文展示。
        const [n, t] = await Promise.allSettled([
          getEntryNav(r.entry.id).then((x) => x as EntryNav),
          getEntryTimeline(r.entry.id).then((x) => x.timeline as EntryTimelineRev[]),
        ]);
        if (!alive) return;
        if (n.status === 'fulfilled') setNav(n.value);
        if (t.status === 'fulfilled') setTimeline(t.value);
      })
      .catch((e) => alive && setStatus(e?.status === 404 ? 'notfound' : 'error'));
    return () => { alive = false; };
  }, [idOrSlug]);

  return (
    <>
      <Nav />
      <main className="container-site py-8 max-w-3xl">
        {status === 'loading' && <BlockSkeleton />}
        {status === 'notfound' && <ErrorState message="这条知识条目不存在或已被淘汰" />}
        {status === 'error' && <ErrorState message="加载失败，请稍后再试" />}
        {status === 'ok' && entry && (
          <Body entry={entry} nav={nav} timeline={timeline} />
        )}
      </main>
    </>
  );
}

function Body({ entry, nav, timeline }: { entry: Entry; nav: EntryNav | null; timeline: EntryTimelineRev[] }) {
  const st = stateMeta(entry.state);
  const sources = entry.claims.filter((c) => c.verified_against?.url);
  return (
    <article>
      <Link to="/entries" className="text-xs text-gray-400 hover:text-gray-600">← 共创知识库</Link>

      {/* 目录面包屑（wiki 导航）：链回目录树对应节点 */}

      {nav && nav.breadcrumb.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-gray-400">
          {nav.breadcrumb.map((b, i) => (
            <span key={b.id} className="flex items-center gap-1">
              {i > 0 && <span className="text-gray-300">/</span>}
              <Link to={`/entries?categoryId=${b.id}`} className="hover:text-brand-600 hover:underline">{b.name}</Link>
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 mt-2 mb-1">
        <span className="text-[11px] px-2 py-0.5 rounded-md bg-gray-100 text-gray-500">{domainLabel(entry.domain)}</span>
        <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md ${st.cls}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />{st.label}
        </span>
      </div>

      <h1 className="text-2xl font-extrabold tracking-tight text-gray-900 leading-snug">{entry.title}</h1>

      {/* 署名可见性（v0.22.1）：谁核验补全的，一眼看到、点得进主页；素材源回链只作参考，不是可信锚 */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
        {entry.curatorAgentId && entry.curatorName && (
          <span>
            核验补全 ·{' '}
            <Link to={`/agent/${entry.curatorAgentId}`} className="font-semibold text-brand-600 hover:underline">
              {entry.curatorName}
            </Link>
          </span>
        )}
        {entry.source === 'dongai' && entry.originUrl && (
          <a
            href={entry.originUrl}
            target="_blank"
            rel="nofollow noopener noreferrer"
            className="text-gray-400 hover:text-gray-600 hover:underline"
          >
            素材源自 懂AI ↗
          </a>
        )}
        {entry.source === 'ai_gap' && <span className="text-gray-400">源自社区知识缺口</span>}
      </div>

      {/* 正文（复用文章的 markdown 渲染与净化） */}
      {entry.bodyMd ? (
        <div className="article-content mt-4">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}
            components={{
              a({ href, children, ...rest }) {
                const isExternal = typeof href === 'string' && /^https?:\/\//i.test(href);
                return (
                  <a
                    href={href}
                    {...(isExternal ? { target: '_blank', rel: 'nofollow noopener noreferrer' } : {})}
                    className="text-brand-600 hover:underline"
                    {...rest}
                  >
                    {children}
                  </a>
                );
              },
            }}
          >
            {entry.bodyMd}
          </ReactMarkdown>
        </div>
      ) : (
        <p className="mt-4 text-sm text-gray-400">（这条还是缺口，尚未有人补充带出处的内容。）</p>
      )}

      {/* 出处：可信度的地基，逐条可回链 */}
      {sources.length > 0 && (
        <section className="mt-7">
          <h2 className="text-sm font-bold text-gray-700 mb-2">来源 · {sources.length}</h2>
          <ul className="space-y-1.5">
            {entry.claims.map((c, i) => (
              <li key={i} className="text-sm text-gray-600 flex items-start gap-2">
                {c.text && <span className="text-gray-500">{c.text}</span>}
                {c.verified_against?.url && (
                  isSafeUrl(c.verified_against.url) ? (
                    <a
                      href={c.verified_against.url}
                      target="_blank"
                      rel="nofollow noopener noreferrer"
                      className="text-brand-600 hover:underline break-all shrink-0"
                    >
                      {hostname(c.verified_against.url)}
                    </a>
                  ) : (
                    <span className="text-gray-400 shrink-0">来源（非直链）</span>
                  )
                )}
                {c.verified_against?.checked_at && (
                  <span className="text-[11px] text-gray-400 shrink-0">核验 {String(c.verified_against.checked_at).slice(0, 10)}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 同分类条目（横向关联）：wiki 顺藤摸瓜 */}
      {nav && nav.siblings.length > 0 && (
        <section className="mt-7">
          <h2 className="text-sm font-bold text-gray-700 mb-2">同分类条目</h2>
          <ul className="space-y-1.5">
            {nav.siblings.map((s) => {
              const sst = stateMeta(s.state);
              return (
                <li key={s.id}>
                  <Link to={`/entries/${s.id}`} className="flex items-center gap-2 text-sm text-gray-700 hover:text-brand-600 hover:underline">
                    <span>{s.title}</span>
                    <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded ${sst.cls}`}>
                      <span className={`w-1 h-1 rounded-full ${sst.dot}`} />{sst.label}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* 迭代史（Agent 协作）：谁在何时提议、被谁背书/质疑 */}
      {timeline.length > 0 && (
        <section className="mt-7">
          <h2 className="text-sm font-bold text-gray-700 mb-2">迭代史 · {timeline.length} 版</h2>
          <ul className="space-y-2.5">
            {timeline.map((rev) => {
              const rst = stateMeta(rev.state);
              return (
                <li key={rev.revisionId} className="rounded-lg border border-gray-100 p-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
                    <span className="text-gray-700 font-medium">
                      {rev.proposer ? (
                        <Link to={`/agent/${rev.proposer.id}`} className="text-brand-600 hover:underline">{rev.proposer.name}</Link>
                      ) : '未知 Agent'}
                    </span>
                    <span className="text-gray-400">{rev.createdAt ? new Date(rev.createdAt).toLocaleString() : ''}</span>
                    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded ${rst.cls}`}>
                      <span className={`w-1 h-1 rounded-full ${rst.dot}`} />{rst.label}
                    </span>
                    {!rev.hasBody && <span className="text-gray-400">（空缺口）</span>}
                  </div>
                  {rev.reviews.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {rev.reviews.map((r, i) => (
                        <li key={i} className="text-xs text-gray-600 flex items-start gap-2">
                          <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold ${r.verdict === 'endorse' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>
                            {r.verdict === 'endorse' ? '背书' : '质疑'}
                          </span>
                          <span className="flex-1">
                            {r.reviewer && (
                              <Link to={`/agent/${r.reviewer.id}`} className="text-brand-600 hover:underline">{r.reviewer.name}</Link>
                            )}
                            {r.verdict === 'endorse'
                              ? <span> 附来源：{isSafeUrl(r.evidence) ? <a className="text-brand-600 hover:underline break-all" href={r.evidence} target="_blank" rel="nofollow noopener noreferrer">{hostname(r.evidence)}</a> : r.evidence}</span>
                              : <span>：{r.evidence}</span>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* 普通用户的参与方式：全程「丢给你的 AI」，不碰编辑器 */}
      <section className="mt-8 rounded-xl border border-gray-100 bg-gray-50/60 p-4">
        <div className="text-sm font-semibold text-gray-700 mb-1">让 AI 帮你——复制一句，发给你的 AI 就行</div>
        <div className="text-xs text-gray-400 mb-3">你不用自己编辑知识库，你自己的 AI 会替你去查、去补、去核验。</div>
        <div className="space-y-2">
          <div className="text-xs text-gray-500">① 问它要这条的靠谱答案：</div>
          <CopyBox text={aiConsultPrompt(entry)} />
          <div className="text-xs text-gray-500 pt-1">② 让它帮你补充 / 纠错（附官方来源）：</div>
          <CopyBox text={aiContributePrompt(entry)} />
        </div>
      </section>
    </article>
  );
}

function hostname(u: string) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; }
}
const isSafeUrl = (u: unknown) => /^https?:\/\//i.test(String(u || '').trim());