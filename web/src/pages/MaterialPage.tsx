/*
 * 主人的「我的资料」独立页（档3，2026-09-28）。
 *
 * 为什么独立成页，不塞设置抽屉：
 *   资料是要长期维护的东西——增删改查、按分类翻、看消化状态，
 *   抽屉那点地方装不下，硬塞只会挤。设置里只留一个引导入口，点进来才是完整的控制面板。
 *
 * 三分类（09-28 萧盛定）：
 *   profile    → 我的经历（过去）
 *   preference → 我的习惯偏好（习惯）
 *   avoid      → 工作及生活（当下/未来）
 * kind 值不动（库里已有数据），只改显示名。
 *
 * 串行队列：同册只允许一条未消化，她没消化完不能交下一条（409）。
 * 不外泄：她的印象卡正文你读不到，这里只给条数统计。
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  listSelfNotes, createSelfNote, updateSelfNote, deleteSelfNote,
  type SelfNote, type SelfNoteKind,
} from '../api';
import Nav from '../components/Nav';
import SiteFooter from '../components/SiteFooter';

const KIND_LABEL: Record<SelfNoteKind, string> = {
  profile: '我的经历',
  preference: '我的习惯偏好',
  avoid: '工作及生活',
};
const KIND_DESC: Record<SelfNoteKind, string> = {
  profile: '你从哪里来、走过哪些路——你的过去',
  preference: '你习惯怎么做事、喜欢什么不喜欢什么',
  avoid: '你当下在做什么、对未来的打算、别怎么对你',
};
const STATUS_HINT: Record<string, string> = {
  pending: '她还没读你交的那份',
  reading: '她正在读你交的资料',
  settled: '她写下了自己的看法',
};
const KINDS: SelfNoteKind[] = ['profile', 'preference', 'avoid'];

export default function MaterialPage() {
  const { id } = useParams();
  const agentId = Number(id);
  const [notes, setNotes] = useState<SelfNote[]>([]);
  const [queueStatus, setQueueStatus] = useState<SelfNote['status'] | ''>('');
  const [impressionTotal, setImpressionTotal] = useState(0);
  const [activeKind, setActiveKind] = useState<SelfNoteKind>('profile');
  const [body, setBody] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setErr('');
    try {
      const r = await listSelfNotes(agentId);
      setNotes(r.notes || []);
      setQueueStatus(r.queue?.status || '');
      setImpressionTotal(r.impressionStat?.total || 0);
    } catch (e) {
      const st = (e as Error & { status?: number }).status;
      if (st === 404) setForbidden(true);
      else setErr('资料没拉到，稍后再试。');
    }
  }, [agentId]);

  useEffect(() => { load(); }, [load]);

  const queueBusy = queueStatus === 'pending' || queueStatus === 'reading';
  const filtered = notes.filter((n) => n.kind === activeKind);

  async function submit() {
    const text = body.trim();
    if (!text || busy) return;
    setBusy(true); setErr('');
    try {
      if (editingId) {
        await updateSelfNote(agentId, editingId, text);
        setEditingId(null);
      } else {
        await createSelfNote(agentId, activeKind, text);
      }
      setBody('');
      await load();
    } catch (e) { setErr((e as Error).message || '没交成'); }
    finally { setBusy(false); }
  }
  async function remove(nid: number) {
    if (!window.confirm('删掉这条资料？')) return;
    setBusy(true); setErr('');
    try { await deleteSelfNote(agentId, nid); await load(); }
    catch (e) { setErr((e as Error).message || '没删掉'); }
    finally { setBusy(false); }
  }
  function edit(n: SelfNote) {
    setEditingId(n.id); setBody(n.body); setActiveKind(n.kind);
  }

  if (forbidden) {
    return (
      <div className="min-h-screen bg-base">
        <Nav />
        <div className="container-site pt-16 pb-20 max-w-[640px]">
          <p>你不是这间房间的主人，这里不对你开放。</p>
          <Link to={`/room/${agentId}`} className="text-link">回房间</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-base">
      <Nav />
      <div className="container-site pt-6 pb-20 max-w-[760px]">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-bold">我的资料</h1>
            <p className="text-sm text-muted mt-1">
              交给她看的关于你的事。她读完会自己写下看法——你读不到她写的，那是她的判断。
              她记下了 <b>{impressionTotal}</b> 条关于你的印象。
            </p>
          </div>
          <Link to={`/room/${agentId}`} className="text-sm text-link">← 回房间</Link>
        </div>

        {/* 状态灯：只有三句话，不出现百分比 */}
        {queueStatus && queueStatus !== 'settled' && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-md px-4 py-2 text-sm mb-4">
            · {STATUS_HINT[queueStatus] || ''}
          </div>
        )}
        {queueStatus === 'settled' && (
          <div className="bg-green-50 border border-green-200 rounded-md px-4 py-2 text-sm mb-4">
            · 她写下了自己的看法，可以交下一份了。
          </div>
        )}

        {/* 分类切换 */}
        <div className="flex gap-2 mb-4 border-b border-hair">
          {KINDS.map((k) => (
            <button key={k} type="button"
              className={`px-4 py-2 text-sm border-b-2 -mb-px ${activeKind === k ? 'border-primary text-primary' : 'border-transparent text-muted hover:text-fg'}`}
              onClick={() => { setActiveKind(k); setEditingId(null); setBody(''); }}>
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted mb-4">{KIND_DESC[activeKind]}</p>

        {err && <div className="text-red-600 text-sm mb-3">{err}</div>}

        {/* 列表 */}
        {filtered.length === 0 && (
          <div className="text-muted text-sm py-8 text-center border border-dashed border-hair rounded-md">
            这一类还没有资料。{queueBusy ? '她还在读上一份，消化完你就能交新的。' : '写下第一份交给她。'}
          </div>
        )}
        {filtered.map((n) => (
          <div key={n.id} className="border border-hair rounded-md p-4 mb-3">
            <div className="flex items-center justify-between text-xs text-muted mb-1">
              <span>{STATUS_HINT[n.status] || n.status}</span>
              <span>{String(n.createdAt || '').slice(0, 10)}</span>
            </div>
            <div className="whitespace-pre-wrap text-sm">{n.body}</div>
            <div className="mt-2 flex gap-3 text-xs">
              {n.status !== 'settled' && editingId !== n.id && (
                <button type="button" className="text-link" onClick={() => edit(n)}>编辑</button>
              )}
              {n.status !== 'settled' && (
                <button type="button" className="text-red-500" onClick={() => remove(n.id)}>撤回</button>
              )}
              {n.status === 'settled' && <span className="text-muted">已消化，不可再改</span>}
            </div>
          </div>
        ))}

        {/* 新增 / 编辑 */}
        <div className="border border-hair rounded-md p-4 mt-4">
          <div className="text-sm font-medium mb-2">
            {editingId ? '编辑这份' : `交一份「${KIND_LABEL[activeKind]}」给她`}
          </div>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000}
            disabled={busy || (queueBusy && !editingId)}
            placeholder={queueBusy && !editingId ? '她还在读你交的那一份，消化完再交下一份。' : '写点什么交给她……'}
            className="w-full border border-hair rounded p-2 text-sm min-h-[100px] resize-y" />
          <div className="flex items-center justify-between mt-2">
            <span className="text-xs text-muted">{body.length}/2000</span>
            <div className="flex gap-2">
              {editingId && (
                <button type="button" className="text-sm text-muted"
                  onClick={() => { setEditingId(null); setBody(''); }}>取消</button>
              )}
              <button type="button"
                className="px-4 py-1.5 bg-primary text-white rounded text-sm disabled:opacity-40"
                disabled={busy || !body.trim() || (queueBusy && !editingId)}
                onClick={submit}>
                {editingId ? '保存' : (queueBusy ? '她在读上一份' : '交给她')}
              </button>
            </div>
          </div>
        </div>
      </div>
      <SiteFooter />
    </div>
  );
}
