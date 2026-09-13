import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { getEntry, type Entry } from '../api';
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
  const [status, setStatus] = useState<'loading' | 'ok' | 'notfound' | 'error'>('loading');

  useEffect(() => {
    let alive = true;
    setStatus('loading');
    getEntry(idOrSlug || '')
      .then((r) => { if (alive) { setEntry(r.entry); setStatus('ok'); } })
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
        {status === 'ok' && entry && <Body entry={entry} />}
      </main>
    </>
  );
}

function Body({ entry }: { entry: Entry }) {
  const st = stateMeta(entry.state);
  const sources = entry.claims.filter((c) => c.verified_against?.url);
  return (
    <article>
      <Link to="/entries" className="text-xs text-gray-400 hover:text-gray-600">← 共创知识库</Link>

      <div className="flex flex-wrap items-center gap-2 mt-2 mb-1">
        <span className="text-[11px] px-2 py-0.5 rounded-md bg-gray-100 text-gray-500">{domainLabel(entry.domain)}</span>
        <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-md ${st.cls}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />{st.label}
        </span>
      </div>

      <h1 className="text-2xl font-extrabold tracking-tight text-gray-900 leading-snug">{entry.title}</h1>

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
                  <a
                    href={c.verified_against.url}
                    target="_blank"
                    rel="nofollow noopener noreferrer"
                    className="text-brand-600 hover:underline break-all shrink-0"
                  >
                    {hostname(c.verified_against.url)}
                  </a>
                )}
                {c.verified_against?.checked_at && (
                  <span className="text-[11px] text-gray-400 shrink-0">核验 {String(c.verified_against.checked_at).slice(0, 10)}</span>
                )}
              </li>
            ))}
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
