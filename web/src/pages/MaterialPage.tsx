/*
 * 主人的「这本册子」——资料页（2026-09-28 重设计，方案 B）。
 * 规格《AI圈-主人资料页重设计-2026-09.md》§四-方案B。
 *
 * 为什么不是"一页表单"：数据模型本来就是 **一册 · 三格 · 一支笔在她那边**。
 *   上一版把它画成了卡片堆叠 + 底部输入框，于是"我交给她"占满全屏、
 *   "她记下了"只剩一个点不动的数字——而这条链的目的恰恰是让他俩看见彼此。
 * 所以这版：左栏是册子的目录（每格几条、哪格压着她没消化完的），
 *   右栏是当前那一页（一页纸里分条目，不是一张张卡），
 *   她为某条料写下的判断**挂在那条下面**，归不到就不挂（不硬凑）。
 *
 * ⚠️ 主题必须自带：.rm-* / .mt-* 全部只吃 --rm-* 变量，而这些变量是
 *   themeVars(theme) 算出来的、不是全局 token。上一版只搬了类名没注入变量，
 *   结果 var() 解析失败让整条简写作废——卡片没底、主按钮隐形、选中态看不出。
 *   复用 .rm-* 的页必须自己做这件事（Room.tsx 同口径）。
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  listSelfNotes, createSelfNote, updateSelfNote, deleteSelfNote,
  getRoomTheme, getAgentCard,
  type SelfNote, type SelfNoteKind, type SelfNoteStatus,
} from '../api';
import { themeVars } from '../components/room/roomTheme';
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
const KIND_SHORT: Record<SelfNoteKind, string> = {
  profile: '我的经历', preference: '习惯偏好', avoid: '工作生活',
};
const KINDS: SelfNoteKind[] = ['profile', 'preference', 'avoid'];
/** 一条资料在她那边的三种状态（文案一律从他的视角写，不出现工程词）。 */
const STATUS_TEXT: Record<SelfNoteStatus, string> = {
  pending: '等她读',
  reading: '她在读',
  settled: '她写好了',
};

export default function MaterialPage() {
  const { id } = useParams();
  const agentId = Number(id);
  const [notes, setNotes] = useState<SelfNote[]>([]);
  const [queueStatus, setQueueStatus] = useState<SelfNoteStatus | ''>('');
  const [impressionTotal, setImpressionTotal] = useState(0);
  const [theme, setTheme] = useState<Parameters<typeof themeVars>[0] | null>(null);
  const [agentName, setAgentName] = useState('');
  const [activeKind, setActiveKind] = useState<SelfNoteKind>('profile');
  // 输入框只有一处：'new' = 交新的；数字 = 编辑那一条；'' = 没在写
  const [mode, setMode] = useState<'' | 'new' | number>('');
  const [body, setBody] = useState('');
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

  // 主题与称呼：跟这间房装修的那份参数走，不另配色（失败就回落默认纸色，不挡内容）
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    getRoomTheme(agentId).then((s) => setTheme(s?.theme || null)).catch(() => {});
    getAgentCard(agentId).then((c) => setAgentName(c?.card?.name || '')).catch(() => {});
  }, [agentId]);

  const vars = (theme ? themeVars(theme) : {}) as Record<string, string>;
  const name = agentName || '她';
  const queueBusy = queueStatus === 'pending' || queueStatus === 'reading';
  const filtered = notes.filter((n) => n.kind === activeKind);
  // 每格的状态：有未消化＝活点在她那边；有已消化＝这一格她写过东西；都没有＝空着
  const kindState = (k: SelfNoteKind): 'live' | 'done' | 'empty' => {
    const inKind = notes.filter((n) => n.kind === k);
    if (inKind.some((n) => n.status === 'pending' || n.status === 'reading')) return 'live';
    return inKind.length ? 'done' : 'empty';
  };

  function openCompose(next: '' | 'new' | number, text = '') {
    setMode(next); setBody(text); setErr('');
  }
  async function submit() {
    const text = body.trim();
    if (!text || busy) return;
    const editing = typeof mode === 'number' ? mode : null;
    if (!editing && queueBusy) return;   // 她在读上一份时不受理新的（服务端也会 409）
    setBusy(true); setErr('');
    try {
      if (editing) await updateSelfNote(agentId, editing, text);
      else await createSelfNote(agentId, activeKind, text);
      openCompose('');
      await load();
    } catch (e) { setErr((e as Error).message || '没交成'); }
    finally { setBusy(false); }
  }
  async function remove(n: SelfNote) {
    if (!window.confirm('撤回这条资料？她还没写下的部分会一起消失。')) return;
    setBusy(true); setErr('');
    try { await deleteSelfNote(agentId, n.id); await load(); }
    catch (e) { setErr((e as Error).message || '没删掉'); }
    finally { setBusy(false); }
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

  const composer = (
    <div className="mt-compose">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        maxLength={2000}
        disabled={busy}
        autoFocus
        placeholder={`写给你交给${name}的话——不用分点，想到什么写什么。`}
      />
      <div className="rm-row" style={{ marginTop: 6 }}>
        <span className="rm-priv">{body.length}/2000</span>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginLeft: 'auto' }}>
          <button type="button" className="rm-link" onClick={() => openCompose('')}>收起</button>
          <button type="button" className="rm-send" disabled={busy || !body.trim()} onClick={submit}>
            {typeof mode === 'number' ? '保存' : '交给她'}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="rm-page mt-desk" style={vars as React.CSSProperties}>
      <Nav />
      <div className="container-site pt-6 pb-20 max-w-[820px]">
        {/* ── 门楣：这本册子归谁、她那边现在什么状态 ── */}
        <div className="mt-band">
          <div className="rm-band-top">
            <div style={{ minWidth: 0 }}>
              <div className="rm-title" style={{ fontSize: 20 }}>{name}的册子</div>
              <div className="rm-motto" style={{ marginTop: 3 }}>
                你写进去的，她一条条记着；她记下的，也写在这本上。
              </div>
            </div>
            <div className="rm-band-acts">
              {queueBusy && (
                <span className="rm-chip" style={{ color: 'var(--rm-accent)' }}>
                  <span className="rm-pulse"><i /></span>
                  {queueStatus === 'reading' ? `她正在读你交的这份` : '她还没读你交的这份'}
                </span>
              )}
              {impressionTotal > 0 ? (
                <Link to={`/room/${agentId}/about-me`} className="rm-chip"
                  style={{ color: 'var(--rm-accent)', borderColor: 'var(--rm-accent)' }}>
                  她记下了 {impressionTotal} 条 →
                </Link>
              ) : (
                <span className="rm-chip">她还没记过你的事</span>
              )}
            </div>
          </div>
        </div>

        {err && <div className="rm-err" style={{ marginTop: 12 }}>{err}</div>}

        <div className="mt-cols">
          {/* ── 左栏：册子的目录（窄屏自动换成下方那条横条） ── */}
          <nav className="mt-nav">
            <div className="mt-nav-h">三格</div>
            {KINDS.map((k) => (
              <button key={k} type="button"
                className={`mt-item${activeKind === k ? ' on' : ''}`}
                onClick={() => { setActiveKind(k); openCompose(''); }}>
                {KIND_LABEL[k]}
                {kindState(k) === 'live' && <span className="mt-live"><i /></span>}
                <span className="c">{notes.filter((n) => n.kind === k).length}</span>
              </button>
            ))}
            <div className="mt-div" />
            <div className="mt-nav-h">进度</div>
            <div className="mt-prog">
              {KINDS.map((k) => {
                const s = kindState(k);
                return <i key={k} className={s === 'empty' ? '' : s} title={KIND_LABEL[k]} />;
              })}
            </div>
            <div className="mt-note">同一格一次只交一份，{name}消化完才收下一份。</div>
            <div className="mt-note">
              <Link to={`/room/${agentId}`} style={{ color: 'var(--rm-accent)' }}>← 回房间</Link>
            </div>
          </nav>

          {/* ── 右栏：当前那一页 ── */}
          <section className="mt-page">
            {/* 窄屏的分类条 */}
            <div className="mt-seg" style={{ marginBottom: 12 }}>
              {KINDS.map((k) => (
                <button key={k} type="button" className={activeKind === k ? 'on' : ''}
                  onClick={() => { setActiveKind(k); openCompose(''); }}>
                  {KIND_SHORT[k]} {notes.filter((n) => n.kind === k).length}
                </button>
              ))}
            </div>

            <div className="mt-page-h">
              <span className="mt-page-t">{KIND_LABEL[activeKind]}</span>
              <span className="rm-priv">{KIND_DESC[activeKind]}</span>
              {/* 入口一直在（她正在读时置灰并说明为什么），不因为不能交就凭空消失——
                  少了那个位置，他会以为是这一格不让写，而不是她在读 */}
              {mode !== 'new' && (
                <button type="button" className="rm-send"
                  style={{ marginLeft: 'auto', padding: '5px 12px', fontSize: 11 }}
                  disabled={queueBusy}
                  title={queueBusy ? `${name}还在读你交的那一份` : ''}
                  onClick={() => openCompose('new')}>
                  {queueBusy ? '她在读上一份' : '＋ 交一份'}
                </button>
              )}
            </div>

            <div className="mt-sheet">
              {filtered.length === 0 && mode !== 'new' && (
                <div className="mt-empty">
                  {queueBusy
                    ? `${name}还在读你交的那一份，消化完这一格就能交新的。`
                    : `这一格还空着。写下第一句交给她——你开的头，就是她认识你的开始。`}
                </div>
              )}

              {filtered.map((n) => {
                const settled = n.status === 'settled';
                const cards = n.replies || [];
                return (
                  <div key={n.id} className="mt-row">
                    <div className="mt-meta">
                      <span className="mt-you">你</span>
                      <span className="rm-dt">{String(n.createdAt || '').slice(0, 10)}</span>
                      {n.status === 'reading'
                        ? <span className="mt-live rm-dt"><i />{STATUS_TEXT[n.status]}</span>
                        : <span className="rm-dt">{STATUS_TEXT[n.status] || n.status}</span>}
                    </div>
                    <div className="rm-tx" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{n.body}</div>

                    {/* 她为这条写下的判断：挂在条下面，不另起一屏 */}
                    {cards.map((c) => (
                      <div key={c.id} className="mt-card">
                        <div className="mt-meta">
                          <span className="sig" style={{ fontFamily: 'var(--rm-sign-font)', fontSize: 12.5, color: 'var(--rm-accent)' }}>{name}</span>
                          <span className="rm-dt">{String(c.createdAt || '').slice(0, 10)} 记下</span>
                        </div>
                        <div className="tx">{c.body}</div>
                      </div>
                    ))}

                    <div className="mt-acts">
                      {settled
                        ? <span className="rm-priv">这条她已消化，不能再改——要补请另交一条</span>
                        : mode === n.id
                          ? null
                          : (
                            <>
                              <button type="button" className="rm-link" onClick={() => openCompose(n.id, n.body)}>编辑</button>
                              <button type="button" className="rm-link" style={{ color: 'var(--rm-mute)' }} onClick={() => remove(n)}>撤回</button>
                            </>
                          )}
                    </div>
                    {mode === n.id && composer}
                  </div>
                );
              })}

              {mode === 'new' && <div className="mt-row">{composer}</div>}
            </div>

            {filtered.length > 0 && (
              <div className="mt-foot">
                这一格 {filtered.length} 条{queueBusy ? `，${name}正在读其中一条` : ''}。
              </div>
            )}
          </section>
        </div>
      </div>
      <SiteFooter />
    </div>
  );
}
