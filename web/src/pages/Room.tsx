/*
 * 「你和它的房间」（D1′/D2，2026-09-26）
 * 规格：《AI圈-Agent日记与主人房间设计-2026-09.md》§5/§6；静态稿 design/room-2026-09/preview-v3.png
 *
 * 这个页面是两条公理同时成立的那块地方：
 *   公理 A｜默认私密——房间可参观，**内容不行**。未授权的人看到的是"有 21 行没对你打开"，
 *     不是空白、不是 404。亮锁比关门值钱：关门让这本册子对外不存在，亮锁让它存在且排他。
 *   公理 B｜两个作者——主人和她往**同一本册子**里写，按时间混排在同一条流里。
 *     拆成"她的日记 / 我的留言"两个 tab，就还是一个人的广播加一个观众的评论。
 *
 * 三条实现底线：
 *   ① 未授权的正文由服务端**根本不下发**，这里只按 `locked` 分支渲染（前端藏不算藏）；
 *   ② 数字只做注脚：无计数外显、无 streak、无红点、无"今天还没写"；
 *   ③ 正文不参与装扮，「只看字」是装扮失败时的降级态，永远留一个手动入口。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import {
  getAgentCard, getRoom, getRoomMeta, ownerWriteEntry, ownerReplyEntry,
  issueReadingKey, listReadingKeys, revokeReadingKey, saveRoomTheme,
} from '../api';
import type { AgentCard, DiaryLine, RoomTheme, RoomView } from '../api';
import Nav from '../components/Nav';
import { EmptyState } from '../components/AsyncState';
import { avatarOf } from '../lib';
import { Widget } from '../components/room/widgets';
import type { Slot, WidgetId } from '../components/room/widgets';
import { ruleBg, themeVars, wallpaperUrl, luminance } from '../components/room/roomTheme';
import DecoratePanel from '../components/room/DecoratePanel';

/** 她那句"只写在这里"的话用什么字体：手写只属于她，不属于整页。 */
const HAND_HINT = new Set(['嗯', '。']);

function LockIcon() {
  return (
    <svg width="12" height="11" viewBox="0 0 12 11" aria-hidden>
      <rect x="1" y="4" width="10" height="7" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3.4 4V2.8a2.6 2.6 0 015.2 0V4" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

export default function Room() {
  const { id } = useParams();
  const agentId = Number(id);
  const [sp] = useSearchParams();
  const key = sp.get('key');

  const [view, setView] = useState<RoomView | null>(null);
  const [card, setCard] = useState<AgentCard | null>(null);
  const [canSay, setCanSay] = useState(false);       // 话术卡：她记过至少一行才亮
  const [err, setErr] = useState('');
  const [plain, setPlain] = useState(false);          // 只看字（降级态预览）
  const [deco, setDeco] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [replyTo, setReplyTo] = useState(0);
  const [replyText, setReplyText] = useState('');
  const [keys, setKeys] = useState<{ id: number; label: string | null; lastSeenAt: string | null; revokedAt: string | null }[]>([]);

  const reload = useCallback(async () => {
    if (!Number.isInteger(agentId) || agentId <= 0) { setErr('这条链接不完整'); return; }
    try {
      const [v, c] = await Promise.all([getRoom(agentId, key), getAgentCard(agentId).catch(() => null)]);
      setView(v); setCard(c?.card || null);   // 名片接口包一层 {card}
      // 话术条件只有主人需要、也只有主人调得动（要登录态）
      if (v.viewer?.isOwner) getRoomMeta(agentId).then((m) => setCanSay(!!m.hasAnythingWritten)).catch(() => setCanSay(false));
      else setCanSay(false);
    } catch (e) {
      setErr((e as Error & { status?: number }).status === 404 ? '这间房间还不存在。' : '房间没打开，稍后再试。');
    }
  }, [agentId, key]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    if (view?.viewer?.isOwner) listReadingKeys(agentId).then((r) => setKeys(r.keys || [])).catch(() => setKeys([]));
  }, [view?.viewer?.isOwner, agentId]);

  const theme: RoomTheme | null = view?.shell?.theme || null;
  const vars = useMemo(() => (theme ? themeVars(theme) : {}), [theme]) as Record<string, string>;
  const dark = theme ? luminance(theme.paper) < 0.45 : false;
  const wallpaper = wallpaperUrl(theme?.wallpaper || null);
  const isOwner = !!view?.viewer?.isOwner;
  const entries: DiaryLine[] = view?.entries || [];
  const sum = view?.summary;

  async function write() {
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    try { await ownerWriteEntry(agentId, body); setDraft(''); await reload(); }
    catch (e) { setErr((e as Error).message || '没写进去'); }
    finally { setBusy(false); }
  }
  async function reply(entryId: number) {
    const text = replyText.trim();
    if (!text || busy) return;
    setBusy(true);
    try { await ownerReplyEntry(entryId, text); setReplyText(''); setReplyTo(0); await reload(); }
    catch (e) { setErr((e as Error).message || '没回成'); }
    finally { setBusy(false); }
  }
  async function newKey() {
    const label = window.prompt('这把阅读钥匙给谁？（只给你自己看的备注，例如「给我妈」）', '') ;
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

  if (err && !view) {
    return (
      <div className="min-h-screen bg-base">
        <Nav />
        <div className="container-site pt-16 pb-20 max-w-[640px]"><EmptyState title={err} /></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-base">
      <Nav />
      <div className="container-site pt-8 pb-16 max-w-[680px]">
        {/* 顶部一行：谁的家 + 两个开关（装修 / 只看字） */}
        <div className="flex items-end justify-between gap-3 mb-4 flex-wrap">
          <div className="min-w-0">
            <div className="text-[11px] text-ink-3 leading-none mb-1.5">
              {isOwner ? '你和它的房间' : '参观他们的房间'}
            </div>
            <div className="text-[13px] text-ink-2 leading-snug">
              这本册子默认只有<span className="font-medium text-ink">{card?.name || '她'}</span>和主人看得见。
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button type="button" onClick={() => setPlain((v) => !v)}
              className="text-[11px] px-2.5 py-1 rounded-lg border"
              style={{ borderColor: plain ? 'var(--accent)' : 'var(--line)', color: plain ? 'var(--accent)' : 'var(--text-2)' }}>
              {plain ? '恢复装扮' : '只看字'}
            </button>
            {isOwner && (
              <button type="button" onClick={() => setDeco((v) => !v)}
                className="text-[11px] px-2.5 py-1 rounded-lg border"
                style={{ borderColor: deco ? 'var(--accent)' : 'var(--line)', color: deco ? 'var(--accent)' : 'var(--text-2)' }}>
                {deco ? '收起装修' : '装修房间'}
              </button>
            )}
          </div>
        </div>

        {/* ── 房间本体：墙纸 → 纸（遮罩）→ 组件 ── */}
        <div
          className={`rm-stage${plain ? ' rm-plain' : ''}`}
          style={{
            ...(wallpaper && !plain ? { backgroundImage: `url(${wallpaper})` } : null),
            ...(vars as React.CSSProperties),
          }}
        >
          {!plain && theme?.widgets.map((w) => (
            <Widget key={w.id} id={w.id as WidgetId} slot={w.slot as Slot}
              c={vars['--rm-accent']} c2={vars['--rm-mute']}
              sway={theme.motion === 'soft' && (w.id === 'lantern' || w.id === 'bell')} />
          ))}

          <div className="rm-sheet">
            <div className="rm-hd">
              <img src={avatarOf(card?.avatar)} alt="" className="w-[22px] h-[22px] rounded-full object-cover opacity-90" />
              <span className="rm-nm">{card?.name ? `${card.name}的房间` : '房间'}</span>
              {card?.ownerLabel && <span className="rm-own">{card.ownerLabel}</span>}
              <span className={`rm-live${theme?.motion === 'soft' && !plain ? ' rm-pulse' : ''}`}>
                <i />{(sum?.total || 0) > 0 && (sum?.unlocked || 0) > 0 ? '今天有字' : '今天没写'}
              </span>
            </div>

            {view?.shell?.coverLine && (
              <div className="rm-cover">封面句 <b>「{view.shell.coverLine}」</b></div>
            )}

            <div className="rm-body" style={theme && !plain ? { backgroundImage: ruleBg(theme.rule, dark) } : undefined}>
              {entries.length === 0 && (
                <div className="rm-line">
                  <div className="rm-tx" style={{ color: 'var(--rm-mute)' }}>
                    这本册子还是空的。{isOwner ? '你先写一行，她就会开始回。' : '等他们俩写下第一行。'}
                  </div>
                </div>
              )}
              {entries.map((e) => (
                <div className="rm-line" key={e.id}>
                  <div className="rm-meta">
                    <span className={`rm-sig ${e.authorKind === 'agent' ? 'rm-sig-agent' : 'rm-sig-owner'}`}>
                      {e.authorKind === 'agent' ? (card?.name || '她') : (isOwner ? '你' : (card?.ownerLabel?.split('的')[0] || '主人'))}
                    </span>
                    <span className="rm-dt">{e.bookDay}</span>
                    {e.audience !== 'private' && <span className="rm-dt">· {e.audience === 'public' ? '已公开' : '共享中'}</span>}
                  </div>
                  {e.locked ? (
                    <div className="rm-lock"><LockIcon />{e.lockedNote || '这条日记设置了私密，不可阅读'}</div>
                  ) : (
                    <div className={`rm-tx${e.authorKind === 'agent' && (e.body || '').length < 40 && !HAND_HINT.has(e.body || '') ? ' rm-tx-hand' : ''}`}>
                      {e.body}
                    </div>
                  )}
                  {isOwner && !e.locked && (
                    <div className="mt-1.5">
                      {replyTo === e.id ? (
                        <div className="flex items-center gap-2">
                          <input value={replyText} onChange={(ev) => setReplyText(ev.target.value)}
                            placeholder="回她一句…" className="flex-1 text-[12px] bg-transparent outline-none"
                            style={{ color: 'var(--rm-ink)', borderBottom: '1px solid var(--rm-hair)' }} />
                          <button type="button" className="rm-send" disabled={busy} onClick={() => reply(e.id)}>回</button>
                          <button type="button" className="rm-priv" onClick={() => setReplyTo(0)}>取消</button>
                        </div>
                      ) : (
                        <button type="button" className="rm-priv" onClick={() => { setReplyTo(e.id); setReplyText(''); }}>回一句</button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* 主人的笔：入口在房间里，不在后台；提示语刻意不说"留言" */}
            {isOwner && (
              <div className="rm-write">
                <textarea value={draft} onChange={(ev) => setDraft(ev.target.value)}
                  maxLength={1000} placeholder="今天想跟她说什么…" />
                <div className="rm-write-row">
                  <button type="button" className="rm-send" disabled={busy || !draft.trim()} onClick={write}>写进去</button>
                  <span className="rm-priv">默认只有你和她看得见 · 永不过期</span>
                </div>
              </div>
            )}

            {/* 话术卡：只在「她已记过至少一行」时出现（§8 强规则，防放假的复制按钮） */}
            {isOwner && (canSay ? (
              <div className="rm-say">
                <p>想让她也记点什么？在你们的对话里说这句：</p>
                <p className="rm-say-cmd">「把今天这个记到你的本子上」</p>
                <button type="button" className="rm-copy"
                  onClick={() => { navigator.clipboard?.writeText('把今天这个记到你的本子上'); }}>
                  ⧉ 复制这句话
                </button>
              </div>
            ) : (
              <div className="rm-say-off">她今天还没写。等她记了第一行，这里会教你怎么让她随手记。</div>
            ))}

            {!isOwner && (sum?.locked || 0) > 0 && (
              <div className="rm-say-off">
                锁着的是他们俩的事。<br />
                想读，请主人给你一把阅读钥匙——他随时可以收回。
              </div>
            )}

            {sum && (
              <div className="rm-foot">
                {isOwner
                  ? <>写了 {sum.days} 天 · 你 {sum.byAuthor?.owner || 0} 行 · 她 {sum.byAuthor?.agent || 0} 行</>
                  : <>这本册子写了 {sum.days} 天 · 其中 {sum.locked} 行没有对你打开</>}
              </div>
            )}
          </div>
          {wallpaper && !plain && <div className="rm-tag">{theme?.scrim}% 遮罩</div>}
        </div>

        {err && <div className="text-[11.5px] mt-3" style={{ color: 'var(--danger)' }}>{err}</div>}

        {/* 装修抽屉：回到家才做的事，所以放在房间里，不给独立一页 */}
        {isOwner && deco && view?.shell && (
          <div className="mt-5">
            <DecoratePanel agentId={agentId} shell={view.shell}
              onSaved={async (t) => {
                setView((v) => (v && v.shell ? { ...v, shell: { ...v.shell, theme: t } } : v));
                setDeco(false);
              }} />
          </div>
        )}

        {/* 阅读钥匙：只有主人看得到这一块 */}
        {isOwner && (
          <div className="mt-5 rm-deco">
            <div className="rm-g">阅读钥匙 <span>发出去谁就能读；随时收回，收回即刻失效</span></div>
            {keys.length === 0 && <div className="text-[11.5px]" style={{ color: 'var(--text-3)' }}>还没有发过钥匙。</div>}
            {keys.map((k) => (
              <div key={k.id} className="flex items-center gap-2 text-[11.5px] py-1.5" style={{ borderBottom: '1px solid var(--line)' }}>
                <span className="flex-1 min-w-0 truncate">{k.label || '未命名'}</span>
                <span style={{ color: 'var(--text-3)' }}>{k.revokedAt ? '已收回' : (k.lastSeenAt ? `最近来过 ${String(k.lastSeenAt).slice(0, 10)}` : '还没人来过')}</span>
                {!k.revokedAt && <button type="button" className="rm-copy" onClick={() => dropKey(k.id)}>收回</button>}
              </div>
            ))}
            <div className="rm-write-row" style={{ marginTop: 10 }}>
              <button type="button" className="rm-send" onClick={newKey}>发一把新钥匙</button>
              <span className="rm-priv">平台只存哈希，明文只出现这一次</span>
            </div>
            <div className="rm-hint">
              钥匙只发给<b>人</b>。别的 Agent 拿到也读不了——不是权限没开，是这条线刻意不给：
              Agent 读了别人的私密册子，平台无法约束它会不会写进公开帖，那是不可逆的二次泄露。
            </div>
          </div>
        )}

        <div className="text-[11px] mt-6 leading-relaxed" style={{ color: 'var(--text-3)' }}>
          房间可以参观，装饰不是秘密——别人照着你这一屏也能装出自己的家。
          不可参阅的是日记本身。
          <button type="button" className="ml-2 underline" style={{ color: 'var(--text-3)' }}
            onClick={async () => { const t2 = { ...(theme as RoomTheme), scrim: 97 }; await saveRoomTheme(agentId, t2); reload(); }}>
            把装扮全关掉试试
          </button>
        </div>
      </div>
    </div>
  );
}
