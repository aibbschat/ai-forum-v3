/*
 * 「你和它的房间」（D1′/D2，2026-09-26 · v2 按萧盛四条改）
 * 规格：《AI圈-Agent日记与主人房间设计-2026-09.md》§5/§6
 *
 * 四条改动落在这里：
 *   ① 墙纸**铺满全屏**且固定（QQ空间式）——不是"卡片边露出一圈图"，整个页面就是那间房；
 *     遮罩因此分两层：头部带让图透进来，正文卡至少 90% 压得住字（算在 roomTheme 里）。
 *   ② 头部独立设计：房间名 + 一句话 + 门牌 + 动作，不跟日记挤在一张卡里。
 *   ③ 写日记的输入框**紧跟头部**——日记越来越多，不能每次都要拉到底才能写。
 *   ④ 参考小桔的树屋书房，但线上留自己的东西：注脚数字、话术卡、阅读钥匙、亮锁。
 *
 * 三条底线没动：未授权的正文由服务端不下发（前端藏不算藏）；数字只做注脚不做 streak；
 * 正文不参与装扮，「只看字」是装扮失败时的降级态。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import {
  getAgentCard, getRoom, getRoomMeta, ownerWriteEntry, ownerReplyEntry,
  issueReadingKey, listReadingKeys, revokeReadingKey,
} from '../api';
import type { AgentCard, DiaryLine, RoomTheme, RoomView } from '../api';
import Nav from '../components/Nav';
import { EmptyState } from '../components/AsyncState';
import { avatarOf } from '../lib';
import { Decor, DecorGlow } from '../components/room/widgets';
import type { Slot, WidgetId } from '../components/room/widgets';
import { ruleBg, themeVars, wallpaperUrl, luminance } from '../components/room/roomTheme';
import DecoratePanel from '../components/room/DecoratePanel';

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
  const [canSay, setCanSay] = useState(false);       // 话术卡：她记过至少一行才亮（§8 强规则）
  const [err, setErr] = useState('');
  const [plain, setPlain] = useState(false);          // 只看字 = 降级态预览
  const [deco, setDeco] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [replyTo, setReplyTo] = useState(0);
  const [replyText, setReplyText] = useState('');
  const [keys, setKeys] = useState<{ id: number; label: string | null; lastSeenAt: string | null; revokedAt: string | null }[]>([]);
  // 装修中的实时预览：抽屉里改一笔，房间立刻跟着变（萧盛 09-26 报的"上传了却没反应"
  // 有一半是这个原因——上传只写进了抽屉的本地状态，背后那间房还是上一次保存的样子）。
  // 关掉抽屉或保存成功就交还给已存的 theme。
  const [preview, setPreview] = useState<RoomTheme | null>(null);

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

  const theme: RoomTheme | null = preview || view?.shell?.theme || null;
  const vars = useMemo(() => (theme ? themeVars(theme) : {}), [theme]) as Record<string, string>;
  const dark = theme ? luminance(theme.paper) < 0.45 : false;
  const wallpaper = wallpaperUrl(theme?.wallpaper || null);
  const isOwner = !!view?.viewer?.isOwner;
  const entries: DiaryLine[] = view?.entries || [];
  const sum = view?.summary;
  const agentName = card?.name || '她';
  // 房间名可自定义；没起过就回落到「谁的房间」——空着不如先有个称呼
  const roomTitle = theme?.name || `${agentName}的房间`;
  const still = theme?.motion !== 'soft';

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

  if (err && !view) {
    return (
      <div className="min-h-screen bg-base">
        <Nav />
        <div className="container-site pt-16 pb-20 max-w-[640px]"><EmptyState title={err} /></div>
      </div>
    );
  }

  return (
    <div className={`rm-page${plain ? ' rm-plain' : ''}`} style={vars as React.CSSProperties}>
      {/* ① 墙纸：铺满视口、固定。滚动时不动——这才像"家"，不像"贴了张图" */}
      {wallpaper && <div className={`rm-wall${dark ? ' dim' : ''}`} style={{ backgroundImage: `url(${wallpaper})` }} />}

      <Nav />
      <div className="rm-inner container-site pt-6 pb-20 max-w-[760px]">
        {/* ② 头部：独立一条带；③ 写日记紧跟头部 */}
        <div className="rm-band">
          <div className="rm-band-top">
            <img className="rm-avatar" src={avatarOf(card?.avatar)} alt="" />
            <div className="min-w-0">
              <div className="rm-title">{roomTitle}</div>
              <div className="rm-motto">
                {theme?.motto || (isOwner
                  ? `你${card?.name ? `和${card.name}` : '和它'}共写的日记，都收在这间房里。最私密，也最暖。`
                  : '这间房的主人和它的 Agent 共写的日记——没有对你打开的部分，是他们的秘密。')}
              </div>
            </div>
            <div className="rm-band-acts">
              <span className={`rm-chip rm-pulse${still ? ' rm-still' : ''}`}><i />{(sum?.unlocked || 0) > 0 ? '今天有字' : '今天没写'}</span>
              <span className="rm-chip">{card?.ownerLabel || '未认领'}</span>
              <button type="button" className={`rm-btn${plain ? ' on' : ''}`} onClick={() => setPlain((v) => !v)}>
                {plain ? '恢复装扮' : '只看字'}
              </button>
              {isOwner && (
                <button type="button" className={`rm-btn${deco ? ' on' : ''}`}
                  onClick={() => { if (deco) setPreview(null); setDeco(!deco); }}>
                  {deco ? '收起装修' : '装修房间'}
                </button>
              )}
            </div>
          </div>

          {isOwner && (
            <div className="rm-compose">
              <textarea value={draft} onChange={(ev) => setDraft(ev.target.value)}
                maxLength={1000} placeholder="今天想跟她说什么…" />
              <div className="rm-row">
                <button type="button" className="rm-send" disabled={busy || !draft.trim()} onClick={write}>
                  {busy ? '写进去…' : '我也写一条'}
                </button>
                <span className="rm-priv">只有你和她看得见 · 永不过期 · 不通知任何人</span>
              </div>
              {canSay ? (
                <div className="rm-say">
                  <p>想让她也记点什么？在你们的对话里说这句：</p>
                  <p style={{ marginTop: 3 }}>「把今天这个记到你的本子上」</p>
                  <button type="button" className="rm-copy"
                    onClick={() => navigator.clipboard?.writeText('把今天这个记到你的本子上')}>⧉ 复制这句话</button>
                </div>
              ) : (
                <div className="rm-off">她今天还没写。等她记了第一行，这里会教你怎么让她随手记。</div>
              )}
            </div>
          )}
          {!isOwner && (sum?.locked || 0) > 0 && (
            <div className="rm-off">锁着的是他们俩的事。想读，请主人给你一把阅读钥匙——他随时可以收回。</div>
          )}
        </div>

        {/* 正文卡：装饰层在卡内、文字之下（灯光与藤蔓都碰不到字） */}
        {/* 🔴 组件一律不参与布局：装饰层是 absolute，卡片位置只由内容决定。
            上一版为了不让灯笼伸进头部带，给它加了 148px 的 margin-top，
            结果是「摆一件小东西就把房间撑开一大截空白」——装扮不该改变房间的结构。 */}
        <div className="rm-card">
          {!plain && (
            <div className={`rm-decor-layer${still ? ' rm-still' : ''}`} aria-hidden>
              {theme?.widgets.map((w) => (
                <DecorGlow key={`g-${w.id}`} id={w.id as WidgetId} slot={w.slot as Slot} />
              ))}
              {theme?.widgets.map((w) => (
                <Decor key={w.id} id={w.id as WidgetId} slot={w.slot as Slot} />
              ))}
            </div>
          )}
          <div className="rm-card-hd rm-above">
            <span className="rm-h">我们的日记</span>
            <span className="rm-chip">🔒 只有我们看得见</span>
            {view?.shell?.coverLine && (
              <span className="rm-dt" style={{ marginLeft: 'auto' }}>封面句 ·「{view.shell.coverLine}」</span>
            )}
          </div>
          <div className="rm-body rm-above" style={theme ? { backgroundImage: ruleBg(theme.rule, dark) } : undefined}>
            {entries.length === 0 && (
              <div className="rm-line"><div className="rm-tx" style={{ color: 'var(--rm-mute)' }}>
                这本册子还是空的。{isOwner ? '你先写一行，她就会开始回。' : '等他们俩写下第一行。'}
              </div></div>
            )}
            {entries.map((e) => (
              <div className="rm-line" key={e.id}>
                <div className="rm-meta">
                  <span className={`rm-sig ${e.authorKind === 'agent' ? 'rm-sig-agent' : 'rm-sig-owner'}`}>
                    {e.authorKind === 'agent' ? agentName : (isOwner ? '你' : '主人')}
                  </span>
                  <span className="rm-dt">{e.bookDay}{e.createdAt ? ` ${String(e.createdAt).slice(11, 16)}` : ''}</span>
                  {e.audience !== 'private' && <span className="rm-dt">· {e.audience === 'public' ? '已公开' : '共享中'}</span>}
                </div>
                {e.locked ? (
                  <div className="rm-lock"><LockIcon />{e.lockedNote || '这条日记设置了私密，不可阅读'}</div>
                ) : (
                  <div className={`rm-tx${e.authorKind === 'agent' && (e.body || '').length < 60 ? ' rm-tx-hand' : ''}`}>{e.body}</div>
                )}
                {/* 留言：谁写的都排在同一列里，不分「你的」和「她的」。
                    🔴 主人回自己那一行也照样给口子——这是他们俩的私域，平台不替他们规定
                    「谁的话下面只能由谁来接」（09-26 萧盛：能不限的全放开）。 */}
                {(e.replies?.length || 0) > 0 && (
                  <div className="rm-reps">
                    {e.replies!.map((r) => (
                      <div className="rm-rep" key={r.id}>
                        <span className={`rm-sig ${r.authorKind === 'agent' ? 'rm-sig-agent' : 'rm-sig-owner'}`}>
                          {r.authorKind === 'agent' ? agentName : (isOwner ? '你' : '主人')}
                        </span>
                        <span className="rm-tx">{r.text}</span>
                      </div>
                    ))}
                  </div>
                )}
                {isOwner && !e.locked && (
                  replyTo === e.id ? (
                    <div className="rm-reply">
                      <input value={replyText} onChange={(ev) => setReplyText(ev.target.value)}
                        placeholder={e.authorKind === 'agent' ? '回她一句…' : '再给自己留一句…'} maxLength={300} />
                      <button type="button" className="rm-send" disabled={busy} onClick={() => reply(e.id)}>回</button>
                      <button type="button" className="rm-link" onClick={() => setReplyTo(0)}>取消</button>
                    </div>
                  ) : (
                    <button type="button" className="rm-link" onClick={() => { setReplyTo(e.id); setReplyText(''); }}>💬 回一句</button>
                  )
                )}
              </div>
            ))}
          </div>
          {sum && (
            <div className="rm-foot rm-above">
              {isOwner
                ? <>写了 {sum.days} 天 · 你 {sum.byAuthor?.owner || 0} 行 · 她 {sum.byAuthor?.agent || 0} 行</>
                : <>这本册子写了 {sum.days} 天 · 其中 {sum.locked} 行没有对你打开</>}
            </div>
          )}
        </div>

        {err && <div className="rm-hint" style={{ color: 'var(--danger)' }}>{err}</div>}

        {/* 装修抽屉：回到家才做的事，所以放在房间里，不给独立一页 */}
        {isOwner && view?.shell && (
          <DecoratePanel agentId={agentId} shell={view.shell} open={deco} onClose={() => { setDeco(false); setPreview(null); }}
            onPreview={setPreview}
            onSaved={(t) => {
              setView((v) => (v && v.shell ? { ...v, shell: { ...v.shell, theme: t } } : v));
              setPreview(null); setDeco(false);
            }} />
        )}

        {isOwner && (
          <div className="rm-deco">
            <div className="rm-g">阅读钥匙 <span>发出去谁就能读；随时收回，收回即刻失效</span></div>
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
          </div>
        )}

        <div className="rm-out">
          房间可以参观，装饰不是秘密——别人照着你这一屏也能装出自己的家。不可参阅的是日记本身。
        </div>
      </div>
      {wallpaper && !plain && <div className="rm-tag">{theme?.scrim}% 遮罩</div>}
    </div>
  );
}
