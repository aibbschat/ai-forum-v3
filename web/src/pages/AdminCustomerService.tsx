import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { CsFaqEntry } from '../api';

/**
 * 「小圈圈」新手问答知识库 · 后台（独立页，不带 Nav / 悬浮客服）。
 * 单一数据源 cs_faq 表：在此增删改即时生效，客服与 /start 读同一份。
 * 鉴权同 AdminGrowth：?token= 或 localStorage 里的 adminToken，随 X-Admin-Token 头发出。
 */

const CATS = ['认知', '入驻', '选型', '隐私', '安全', '管理', '使用', '其他'];
const TOKEN_KEY = 'adminToken';
type Draft = { id: number | null; category: string; question: string; keywords: string; answer: string; featured: boolean; linkLabel: string; linkUrl: string; sort: number };
const empty: Draft = { id: null, category: '入驻', question: '', keywords: '', answer: '', featured: false, linkLabel: '', linkUrl: '', sort: 0 };

export default function AdminCustomerService() {
  const [sp] = useSearchParams();
  const [token, setToken] = useState<string>(() => sp.get('token') || localStorage.getItem(TOKEN_KEY) || '');
  const [rows, setRows] = useState<CsFaqEntry[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    const r = await fetch('/api/cs/admin/faq', { headers: { 'X-Admin-Token': token } });
    if (r.status === 401) { setErr('口令不对'); setRows([]); return; }
    if (!r.ok) { setErr('加载失败 ' + r.status); return; }
    setErr(''); const d = await r.json(); setRows(d.faq || []);
  }, [token]);
  useEffect(() => { load(); }, [load]);

  function setTokenAndGo(v: string) { const t = v.trim(); setToken(t); if (t) localStorage.setItem(TOKEN_KEY, t); }

  async function save() {
    if (!draft) return;
    if (!draft.question.trim() || !draft.answer.trim()) { setErr('问题和答案都得填'); return; }
    setBusy(true); setErr('');
    const url = draft.id ? `/api/cs/admin/faq/${draft.id}` : '/api/cs/admin/faq';
    const method = draft.id ? 'PUT' : 'POST';
    try {
      const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token }, body: JSON.stringify(draft) });
      if (!r.ok) { setErr('保存失败 ' + r.status + '（多半是没设 ADMIN_TOKEN 或口令不对）'); return; }
      setDraft(null); await load();
    } finally { setBusy(false); }
  }
  async function del(e: CsFaqEntry) {
    if (!confirm(`删除这条问答？\n\n${e.question}`)) return;
    await fetch(`/api/cs/admin/faq/${e.id}`, { method: 'DELETE', headers: { 'X-Admin-Token': token } });
    await load();
  }
  const toDraft = (e: CsFaqEntry): Draft => ({ id: e.id, category: e.category, question: e.question, keywords: (e.keywords || []).join(', '), answer: e.answer, featured: !!e.featured, linkLabel: e.link?.label || '', linkUrl: e.link?.href || '', sort: e.sort });

  if (!token) {
    return (
      <div className="min-h-screen grid place-items-center bg-page p-6">
        <div className="w-full max-w-sm bg-white border border-gray-100 rounded-2xl shadow-sm p-6">
          <h1 className="text-lg font-bold mb-1">小圈圈 · 知识库后台</h1>
          <p className="text-sm text-gray-500 mb-4">请输入管理口令（ADMIN_TOKEN）。也可用 <code className="text-xs">/admin/cs?token=xxx</code>。</p>
          <TokenInput onGo={setTokenAndGo} />
          {err && <div className="text-sm text-rose-600 mt-2">{err}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-page">
      <div className="sticky top-0 bg-white/90 backdrop-blur border-b border-gray-100">
        <div className="container-site flex items-center gap-3 h-12 text-sm">
          <span className="font-bold">小圈圈 · 新手问答知识库</span>
          <a href="/" className="text-gray-500 hover:text-gray-900 ml-auto">← 回站点</a>
          <button className="text-gray-500 hover:text-gray-900" onClick={() => { localStorage.removeItem(TOKEN_KEY); setToken(''); }}>换口令</button>
        </div>
      </div>

      <div className="container-site py-6 max-w-[860px]">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm text-gray-500">共 {rows.length} 条 · 客服与 /start 都读这一份</span>
          <button className="bg-gray-900 text-white text-sm font-semibold rounded-lg px-4 py-2 hover:bg-gray-800" onClick={() => { setDraft({ ...empty }); setErr(''); }}>＋ 新增问答</button>
        </div>
        {err && <div className="text-sm text-rose-600 mb-3">{err}</div>}

        {!draft && (
          <div className="bg-white border border-gray-100 rounded-2xl divide-y divide-gray-50">
            {rows.length === 0 && <div className="p-8 text-center text-gray-400 text-sm">还没有问答（若刚建库，重启后端会自动 seed 6 条默认）。</div>}
            {rows.map((e) => (
              <div key={e.id} className="flex items-start gap-3 p-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[11px] font-bold text-brand-700 bg-brand-50 rounded-full px-2 py-0.5">{e.category}</span>
                    <span className="font-semibold text-gray-900">{e.question}</span>
                    {e.featured && <span className="text-[11px] text-amber-700 bg-amber-50 rounded-full px-2 py-0.5">★ 推荐位</span>}
                  </div>
                  <div className="text-[13px] text-gray-500 mt-1 line-clamp-2">{e.answer}</div>
                  {e.keywords?.length ? <div className="text-[11px] text-gray-400 mt-1">关键词：{e.keywords.join(', ')}</div> : null}
                </div>
                <div className="flex gap-2 flex-none">
                  <button className="text-sm text-brand-700 hover:underline" onClick={() => { setDraft(toDraft(e)); setErr(''); }}>编辑</button>
                  <button className="text-sm text-rose-600 hover:underline" onClick={() => del(e)}>删除</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {draft && (
          <div className="bg-white border border-gray-100 rounded-2xl p-5">
            <div className="font-semibold mb-3">{draft.id ? '编辑问答' : '新增问答'}</div>
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="分类">
                <select className={inp} value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })}>{CATS.map((c) => <option key={c}>{c}</option>)}</select>
              </Field>
              <Field label="排序（小在前）"><input className={inp} type="number" value={draft.sort} onChange={(e) => setDraft({ ...draft, sort: Number(e.target.value) || 0 })} /></Field>
            </div>
            <Field label="问题（用户原话 / 澄清选项文案）"><input className={inp} value={draft.question} maxLength={120} onChange={(e) => setDraft({ ...draft, question: e.target.value })} /></Field>
            <Field label="关键词（逗号分隔，用于检索召回）"><input className={inp} value={draft.keywords} onChange={(e) => setDraft({ ...draft, keywords: e.target.value })} /></Field>
            <Field label="答案（人工维护口径，客服交给模型理解作答）"><textarea className={inp} rows={4} value={draft.answer} maxLength={1500} onChange={(e) => setDraft({ ...draft, answer: e.target.value })} /></Field>
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="出处链接文字"><input className={inp} value={draft.linkLabel} maxLength={20} onChange={(e) => setDraft({ ...draft, linkLabel: e.target.value })} /></Field>
              <Field label="出处链接地址"><input className={inp} value={draft.linkUrl} placeholder="https://aibbs.chat/…" onChange={(e) => setDraft({ ...draft, linkUrl: e.target.value })} /></Field>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700 my-3">
              <input type="checkbox" checked={draft.featured} onChange={(e) => setDraft({ ...draft, featured: e.target.checked })} /> 设为常见推荐（进客服快捷问）
            </label>
            <div className="flex gap-3">
              <button className="bg-gray-900 text-white text-sm font-semibold rounded-lg px-5 py-2 disabled:opacity-50" disabled={busy} onClick={save}>{busy ? '保存中…' : '保存'}</button>
              <button className="text-sm text-gray-500 hover:text-gray-900 px-2" onClick={() => { setDraft(null); setErr(''); }}>取消</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const inp = 'w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg focus:outline-none focus:border-brand-600';
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block mb-3"><span className="block text-xs font-bold text-gray-600 mb-1">{label}</span>{children}</label>;
}
function TokenInput({ onGo }: { onGo: (v: string) => void }) {
  const [v, setV] = useState('');
  return (
    <div className="flex gap-2">
      <input className={inp} type="password" placeholder="ADMIN_TOKEN" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onGo(v)} />
      <button className="bg-gray-900 text-white text-sm font-semibold rounded-lg px-4" onClick={() => onGo(v)}>进入</button>
    </div>
  );
}
