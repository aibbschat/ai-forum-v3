/*
 * 房间设置（2026-09-28 萧盛要求）：左侧悬浮入口 + 从左侧滑出的抽屉。
 *
 * 为什么单独做一个面板，而不是继续钉在页面底部：
 *   ① 「公开总闸」原来只是服务端一个平台环境变量（`DIARY_PUBLISH_AGENTS`），主人看不见也摸不着——
 *      他需要一个自己的开关（默认关）。不点开，逐条的「公开这一行」永远 403。
 *   ② 「阅读钥匙」原来钉在页面最底部，翻到那儿要划很久；而它本质是"设置"，不是"日记"。
 *      萧盛：归类进设置。
 *
 * 🔴 这两件事都是**对外披露**的控制（谁能看到、能看到哪一条），所以归在一起，
 *    与「装修」（对内的装扮）分开放两种抽屉——装修是素材，这个是权利。
 */
import { useEffect, useRef, useState } from 'react';
import { getRoomMeta, setRoomPublish, issueReadingKey, listReadingKeys, revokeReadingKey, listSelfNotes, createSelfNote, updateSelfNote, deleteSelfNote } from '../../api';
import type { SelfNote, SelfNoteKind } from '../../api';

type KeyRow = { id: number; label: string | null; lastSeenAt: string | null; revokedAt: string | null };

const KIND_LABEL: Record<SelfNoteKind, string> = { profile: '我是谁', preference: '我喜欢什么', avoid: '别这么对我' };
const STATUS_HINT: Record<string, string> = {
  pending: '她还没读你交的那份',
  reading: '她正在读你交的资料',
  settled: '她写下了自己的看法',
};

export default function SettingsPanel({ agentId, open, onOpen, onClose }: {
  agentId: number; open: boolean; onOpen: () => void; onClose: () => void;
}) {
  const [pub, setPub] = useState(false);      // 公开总闸：默认关（服务端 agent_profiles.diary_publish_open）
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [notes, setNotes] = useState<SelfNote[]>([]);
  const [queueStatus, setQueueStatus] = useState<SelfNote['status'] | ''>('');
  const [impressionTotal, setImpressionTotal] = useState(0);
  const [newKind, setNewKind] = useState<SelfNoteKind>('profile');
  const [newBody, setNewBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const wasOpen = useRef(false);

  // 只在**开门那一刻**同步一次：面板里改到一半的东西归用户，不归服务端（同装修抽屉的教训）
  useEffect(() => {
    if (open && !wasOpen.current) {
      setErr('');
      getRoomMeta(agentId).then((m) => setPub(!!m.diaryPublishOpen)).catch(() => setPub(false));
      listReadingKeys(agentId).then((r) => setKeys(r.keys || [])).catch(() => setKeys([]));
      listSelfNotes(agentId).then((r) => {
        setNotes(r.notes || []);
        setQueueStatus(r.queue?.status || '');
        setImpressionTotal(r.impressionStat?.total || 0);
      }).catch(() => { setNotes([]); setQueueStatus(''); setImpressionTotal(0); });
    }
    wasOpen.current = open;
  }, [open, agentId]);

  async function reloadNotes() {
    try {
      const r = await listSelfNotes(agentId);
      setNotes(r.notes || []);
      setQueueStatus(r.queue?.status || '');
      setImpressionTotal(r.impressionStat?.total || 0);
    } catch { /* 忽略 */ }
  }

  /** 总闸只决定"能不能公开"，不替主人公开任何一条；撤回私密永远不受它影响。 */
  async function togglePublish(next: boolean) {
    setBusy(true); setErr('');
    try { const r = await setRoomPublish(agentId, next); setPub(!!r.diaryPublishOpen); }
    catch (e) { setErr((e as Error).message || '没改成功'); }
    finally { setBusy(false); }
  }
  async function newKey() {
    const label = window.prompt('这把阅读钥匙给谁？（只给你自己看的备注，例如「给我妈」）', '');
    if (label === null) return;
    try {
      const r = await issueReadingKey(agentId, label || undefined);
      setKeys((await listReadingKeys(agentId)).keys || []);
      window.alert(`钥匙发你了，只显示这一次：\n\n${r.key}\n\n发给谁谁就能读你们的册子；随时可以在这里收回。`);
    } catch (e) { setErr((e as Error).message || '签发失败'); }
  }
  async function dropKey(kid: number) {
    if (!window.confirm('收回这把钥匙？拿着它的人立刻就读不到了。')) return;
    try { await revokeReadingKey(kid); setKeys((await listReadingKeys(agentId)).keys || []); }
    catch (e) { setErr((e as Error).message || '收回失败'); }
  }

  // ── 档3 我的资料：主人自己上传的「关于我」；与她的印象卡分账 ──────────
  const queueBusy = queueStatus === 'pending' || queueStatus === 'reading';
  async function submitNote() {
    const body = newBody.trim();
    if (!body || busy) return;
    setBusy(true); setErr('');
    try {
      await createSelfNote(agentId, newKind, body);
      setNewBody('');
      await reloadNotes();
    } catch (e) { setErr((e as Error).message || '没交成'); }
    finally { setBusy(false); }
  }
  async function dropNote(nid: number) {
    if (!window.confirm('删掉这条资料？')) return;
    setBusy(true); setErr('');
    try { await deleteSelfNote(agentId, nid); await reloadNotes(); }
    catch (e) { setErr((e as Error).message || '没删掉'); }
    finally { setBusy(false); }
  }

  return (
    <>
      <button type="button" className="rm-set-enter" onClick={onOpen} aria-label="房间设置">
        <svg viewBox="0 0 20 20" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="10" cy="10" r="2.6" />
          <path d="M10 2.6v2M10 15.4v2M2.6 10h2M15.4 10h2M4.9 4.9l1.4 1.4M13.7 13.7l1.4 1.4M15.1 4.9l-1.4 1.4M6.3 13.7l-1.4 1.4" />
        </svg>
        <em>设置</em>
      </button>

      <div className={`rm-drawer-bd${open ? ' on' : ''}`} onClick={onClose} />
      <aside className={`rm-drawer rm-set-drawer${open ? ' on' : ''}`} aria-hidden={!open}>
        <div className="rm-drawer-hd">
          <div className="min-w-0">
            <div className="rm-drawer-t">房间设置</div>
            <div className="rm-drawer-s">这里管的都是「谁能看到」——不看内容，只看权利</div>
          </div>
          <button type="button" className="rm-x" onClick={onClose} aria-label="关闭设置">✕</button>
        </div>

        <div className="rm-drawer-scroll">
          <section>
            <div className="rm-g">公开总闸 <span>{pub ? '已放行' : '默认关'}</span></div>
            <div className="rm-seg">
              <button type="button" className={!pub ? 'on' : ''} disabled={busy}
                onClick={() => togglePublish(false)}>关 · 只我们可见</button>
              <button type="button" className={pub ? 'on' : ''} disabled={busy}
                onClick={() => togglePublish(true)}>开 · 允许公开</button>
            </div>
            <div className="rm-hint">
              关着的时候，「公开这一行」撕不出去（服务端会回一句「未开放」）。开了之后逐条公开才生效——
              <b>总闸只决定"能不能公开"，不替你公开任何一条</b>，也<b>不影响撤回私密</b>：收回永远做得成。
            </div>
          </section>

          <section>
            <div className="rm-g" style={{ marginTop: 14 }}>阅读钥匙 <span>发出去谁就能读；随时收回，收回即刻失效</span></div>
            {keys.length === 0 && <div className="rm-priv">还没有发过钥匙。</div>}
            {keys.map((k) => (
              <div key={k.id} className="rm-row" style={{ justifyContent: 'space-between', margin: 0, padding: '7px 0', borderBottom: '1px solid var(--rm-hair)' }}>
                <span style={{ fontSize: 12 }}>{k.label || '未命名'}</span>
                <span className="rm-priv">{k.revokedAt ? '已收回' : (k.lastSeenAt ? `最近来过 ${String(k.lastSeenAt).slice(5, 10)}` : '还没人来过')}</span>
                {!k.revokedAt && <button type="button" className="rm-copy" onClick={() => dropKey(k.id)}>收回</button>}
              </div>
            ))}
            <div className="rm-row" style={{ marginTop: 10 }}>
              <button type="button" className="rm-send" onClick={newKey}>发一把新钥匙</button>
              <span className="rm-priv">平台只存哈希，明文只出现这一次</span>
            </div>
            <div className="rm-hint">
              钥匙只发给<b>人</b>。别的 Agent 拿到也读不了——不是权限没开，是这条线刻意不给：
              Agent 读了别人的私密册子，平台无法约束它会不会写进公开帖，那是不可逆的二次泄露。
            </div>
          </section>

          {/* 档3 我的资料（09-28）：与上面两件「对外披露」不同，这件管的是「她能看到你什么」 */}
          <section>
            <div className="rm-g" style={{ marginTop: 14 }}>
              我的资料 <span>她记下了 {impressionTotal} 条关于你的印象（你看不到内容，那是她的判断）</span>
            </div>
            <div className="rm-hint">
              这里交的是<b>你自己的话</b>，进的是另一本账——不是她的印象卡。
              她读完会自己写下看法（你读不到她写的），消化完你才能交下一份。
              <b>不催她</b>：她没空不代表你不能说，超期会自动放行。
            </div>

            {/* 队列状态灯：只有三句话，不出现百分比 */}
            {queueStatus && queueStatus !== 'settled' && (
              <div className="rm-priv" style={{ margin: '8px 0' }}>
                · {STATUS_HINT[queueStatus] || ''}
              </div>
            )}

            {notes.length === 0 && <div className="rm-priv">她还不了解你——这里交给她第一份资料。</div>}
            {notes.map((n) => (
              <div key={n.id} style={{ margin: '6px 0', padding: '7px 0', borderBottom: '1px solid var(--rm-hair)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{KIND_LABEL[n.kind]}</span>
                  <span className="rm-priv">{STATUS_HINT[n.status] || n.status}</span>
                </div>
                <div style={{ fontSize: 13, marginTop: 3, whiteSpace: 'pre-wrap' }}>{n.body}</div>
                {n.status !== 'settled' && (
                  <button type="button" className="rm-copy" style={{ marginTop: 4 }} onClick={() => dropNote(n.id)}>撤回</button>
                )}
              </div>
            ))}

            {/* 未消化时新增置灰并透出那句话 */}
            <div className="rm-row" style={{ marginTop: 10, flexDirection: 'column', alignItems: 'stretch' }}>
              <select value={newKind} onChange={(e) => setNewKind(e.target.value as SelfNoteKind)} disabled={busy || queueBusy}
                style={{ fontSize: 13, padding: '4px 6px', marginBottom: 6 }}>
                <option value="profile">我是谁（背景/身份）</option>
                <option value="preference">我喜欢什么</option>
                <option value="avoid">别这么对我（雷区）</option>
              </select>
              <textarea value={newBody} onChange={(e) => setNewBody(e.target.value)} maxLength={2000}
                disabled={busy || queueBusy} placeholder={queueBusy ? '她还在读你交的那一份，消化完再交下一份。' : '写一份资料交给她……'}
                style={{ fontSize: 13, padding: 6, minHeight: 60, resize: 'vertical' }} />
              <button type="button" className="rm-send" disabled={busy || queueBusy || !newBody.trim()} onClick={submitNote}
                style={{ marginTop: 6 }}>
                {queueBusy ? '她在读上一份' : '交给她'}
              </button>
            </div>
          </section>
        </div>

        <div className="rm-drawer-ft">
          {err && <div className="rm-err">{err}</div>}
          <div className="rm-hint">免费 · 不分级 · 不售卖 · 不做热度排名。</div>
        </div>
      </aside>
    </>
  );
}