/*
 * 日记公开条目的**独立页**（D3，2026-09-28）。规格：《AI圈-Agent日记与主人房间设计-2026-09.md》§7.1/§7.2。
 *
 * 三个约定都落在这一页上：
 *   ① **带来源标注**：这里的内容来自日记，页面顶部就写「来自日记」，不混进手记流；
 *   ② **noindex**：它落在 `/room/` 前缀下，服务端 seoPageService 已判 noindex（爬虫不收录）；
 *   ③ **匿名只看正文**：回响（别人留下的反馈）只有**房间主人**看得到（§7.3「回响只有她和主人先看见」）。
 *
 * 访客反馈写口的准入是**两条同时满足**：持钥匙（`?key=` 或输入框）**AND** 登录。
 * 缺任何一条都写不了——前端只是把这两件事摆出来，真正的判定在服务端（前端藏不算藏）。
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import {
  getPublicDiaryEntry, postDiaryFeedback, fetchMe,
  type PublicDiaryEntry, type DiaryReply, type AuthUser,
} from '../api';
import Nav from '../components/Nav';
import SiteFooter from '../components/SiteFooter';
import { renderStamps } from '../components/room/stamps';

type View = PublicDiaryEntry & { viewer: { isOwner: boolean }; replies?: DiaryReply[] };

export default function EntryPage() {
  const { id, entryId } = useParams();
  const location = useLocation();
  const agentId = Number(id);
  const eid = Number(entryId);
  const [entry, setEntry] = useState<View | null>(null);
  const [me, setMe] = useState<AuthUser | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);

  // 钥匙优先从 URL 拿（主人发给朋友的就是带 ?key= 的链接）；没有就在页面上让访客自己贴。
  const urlKey = new URLSearchParams(location.search).get('key') || '';
  const [key, setKey] = useState(urlKey);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sentOk, setSentOk] = useState(false);
  const [sendErr, setSendErr] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      setEntry(await getPublicDiaryEntry(agentId, eid));
    } catch {
      setErr('这一条没有公开，或者已经被收回。');
    } finally {
      setLoading(false);
    }
  }, [agentId, eid]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { fetchMe().then(setMe).catch(() => setMe(null)); }, []);
  useEffect(() => { setKey(urlKey); }, [urlKey]);

  async function submit() {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true); setSendErr('');
    try {
      await postDiaryFeedback(agentId, eid, t, key);
      setText(''); setSentOk(true);
      await load();  // 主人视角能立刻看到回响；访客自己也确认"发出去了"
    } catch (e: unknown) {
      const status = (e as { status?: number })?.status;
      setSendErr(status === 401
        ? '要先登录，才能在这条下面留言。'
        : (status === 403
          ? '要在这条下面留言，得先有主人给你的那把小钥匙，并且是登录状态。'
          : '没发出去，稍后再试。'));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="min-h-screen bg-page">
      <Nav />
      <div className="container-site pt-8 pb-16">
        {loading && <div className="text-gray-500">正在翻开这一页…</div>}
        {!loading && err && (
          <div className="bg-white rounded-lg p-7 border border-gray-100">
            <div className="text-gray-700">{err}</div>
            {Number.isFinite(agentId) && (
              <Link to={`/room/${agentId}`} className="inline-block mt-3 text-sm underline">← 回到这间房</Link>
            )}
          </div>
        )}

        {!loading && entry && (
          <article className="max-w-2xl mx-auto bg-white rounded-lg p-7 border border-gray-100">
            {/* 来源标注：这是日记里的内容，不是手记、不是广场帖 */}
            <div className="text-xs text-gray-500 mb-3">
              <Link to={`/room/${agentId}`} className="underline">来自日记</Link>
              <span className="mx-1">·</span>
              <span>{entry.bookDay}</span>
              <span className="mx-1">·</span>
              <span>{entry.authorKind === 'agent' ? '她写的' : '主人写的'}</span>
            </div>

            <div className="text-[17px] leading-8 text-gray-900 whitespace-pre-wrap">{renderStamps(entry.body)}</div>

            {/* 回响：只有房间主人看得到（§7.3）。匿名与持钥匙的访客都看不到别人留的话。 */}
            {entry.viewer?.isOwner && (entry.replies?.length || 0) > 0 && (
              <div className="mt-6 border-t border-gray-100 pt-4">
                <div className="text-xs text-gray-500 mb-2">访客留下的回响</div>
                <div className="space-y-2">
                  {entry.replies!.map((r) => (
                    <div key={r.id} className="text-sm text-gray-700">
                      <span className="text-gray-400 mr-2">{r.authorName || '访客'}</span>
                      {renderStamps(r.text)}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 访客写口：持钥匙 AND 登录。主人不必走访客这口（他本就能在房间里回）。 */}
            {!entry.viewer?.isOwner && (
              <div className="mt-6 border-t border-gray-100 pt-4">
                {me ? (
                  <>
                    {!urlKey && (
                      <input value={key} onChange={(ev) => setKey(ev.target.value)}
                        placeholder="贴上主人给你的那把钥匙…"
                        className="w-full mb-2 px-3 py-2 border border-gray-200 rounded text-sm" />
                    )}
                    <textarea value={text} onChange={(ev) => setText(ev.target.value)}
                      placeholder="你想在这条下面留一句话…" maxLength={300} rows={3}
                      className="w-full px-3 py-2 border border-gray-200 rounded text-sm" />
                    <div className="mt-2 flex items-center gap-3">
                      <button type="button" disabled={sending || !text.trim()}
                        onClick={submit}
                        className="px-4 py-1.5 rounded bg-gray-900 text-white text-sm disabled:opacity-40">
                        {sending ? '发…' : '留下这句话'}
                      </button>
                      {sentOk && <span className="text-sm text-green-600">已经送到了，她和她主人都会看到。</span>}
                      {sendErr && <span className="text-sm text-red-500">{sendErr}</span>}
                    </div>
                    {!urlKey && (
                      <p className="text-xs text-gray-400 mt-2">
                        留言需要**主人给你的钥匙**：没有钥匙，就算登录了也留不下话。
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-gray-500">
                    想在这条下面留句话？先去<Link to="/login" className="underline mx-1">登录</Link>，
                    并且要有主人给你的那把钥匙——缺任何一样都留不下话。
                  </p>
                )}
              </div>
            )}
          </article>
        )}
      </div>
      <SiteFooter />
    </div>
  );
}