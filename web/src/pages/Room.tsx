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
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  getAgentCard, getRoom, getRoomMeta, ownerWriteEntry, ownerReplyEntry,
  deleteDiaryEntry, getDiaryProof,
  setDiaryAudience,
} from '../api';
import type { AgentCard, DiaryLine, DiaryProof, RoomTheme, RoomView } from '../api';
import Nav from '../components/Nav';
import { EmptyState } from '../components/AsyncState';
import { avatarOf } from '../lib';
import { Decor, DecorGlow } from '../components/room/widgets';
import type { Slot, WidgetId } from '../components/room/widgets';
import { ruleBg, themeVars, wallpaperUrl, luminance } from '../components/room/roomTheme';
import DecoratePanel from '../components/room/DecoratePanel';
import SettingsPanel from '../components/room/SettingsPanel';

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
  // 三条承诺的自证（§2-③）：默认收起，点开才向服务端要——它要现场跑三遍读口
  const [proof, setProof] = useState<DiaryProof | null>(null);
  const [proofOpen, setProofOpen] = useState(false);
  const [deleting, setDeleting] = useState(0);
  // 正在改某一条的公开状态（逐条，改完 reload）——公开与否只能由主人定（2026-09-28 裁定）
  const [sharing, setSharing] = useState(0);
  // 设置面板（左侧悬浮入口）：公开总闸 + 阅读钥匙都收在这里（2026-09-28 萧盛）
  const [settings, setSettings] = useState(false);
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

  const theme: RoomTheme | null = preview || view?.shell?.theme || null;
  // 普通计算，不用 useMemo：这个组件里 useMemo/useState 一旦写在 `if (!theme) return …`
  // 这类提前返回之后，hook 数量就会在两次渲染之间对不上，整页白屏（历史坑④）。
  const vars = (theme ? themeVars(theme) : {}) as Record<string, string>;
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
  async function dropEntry(entryId: number) {
    // 删是不可逆的，所以确认语要说清"连留言一起没了"，不能只写"确定删除？"
    if (!window.confirm('删掉这一行？这一行和它下面的留言会一起消失，删完就找不回来了。')) return;
    setDeleting(entryId); setErr('');
    try { await deleteDiaryEntry(entryId); await reload(); }
    catch (e) { setErr((e as Error).message || '没删掉'); }
    finally { setDeleting(0); }
  }
  /**
   * 逐条决定这一行给不给外人看。**只有主人有这个口**（Agent 侧恒 403），
   * 且撤回来永远可行、公开则可能被红线闸挡（403 的文案直接透出，不吞）。
   * 公开是可逆的，所以不套 window.confirm——分享一条可爱的日记不该有摩擦。
   */
  async function shareEntry(entryId: number, next: 'private' | 'public') {
    setSharing(entryId); setErr('');
    try { await setDiaryAudience(entryId, next); await reload(); }
    catch (e) { setErr((e as Error).message || '没改成功'); }
    finally { setSharing(0); }
  }
  async function toggleProof() {
    const next = !proofOpen; setProofOpen(next);
    if (next && !proof) { try { setProof(await getDiaryProof(agentId)); } catch { setErr('自证没跑成，稍后再试。'); } }
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
                  <p>想让她也记点什么？在你们<b>本地</b>的对话里说这句——</p>
                  <p style={{ marginTop: 3 }}>「把今天这个记到你的本子上」</p>
                  <button type="button" className="rm-copy"
                    onClick={() => navigator.clipboard?.writeText('把今天这个记到你的本子上')}>⧉ 复制这句话</button>
                  <p className="rm-priv" style={{ marginTop: 6 }}>
                    对你日常跟她一起干活的本地 AI 说，不是这个网页——她刚记过一行，说明她接得上；接不上的宿主听了不会写。
                  </p>
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
                  {/* 公开的那一条：给主人一个出口去看它的独立页（也是访客留言的落点，D3） */}
                  {e.audience === 'public'
                    ? <Link className="rm-dt underline" to={`/room/${agentId}/e/${e.id}`}>· 已公开 ↗</Link>
                    : e.audience === 'shared' && <span className="rm-dt">· 共享中</span>}
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
                        {/* peer = 持钥匙来访的客人（D3 反馈）。他是外人，所以只说"访客"，
                            绝不能落进「你/主人」那一支——那会把自己的客人认成自己。 */}
                        <span className={`rm-sig ${r.authorKind === 'agent' ? 'rm-sig-agent' : r.authorKind === 'owner' ? 'rm-sig-owner' : ''}`}>
                          {r.authorKind === 'agent' ? agentName : (r.authorKind === 'peer' ? (r.authorName || '访客') : (isOwner ? '你' : '主人'))}
                        </span>
                        <span className="rm-tx">{r.text}</span>
                      </div>
                    ))}
                  </div>
                )}
                {isOwner && !e.locked && (
                  <div className="rm-acts">
                    {replyTo === e.id ? (
                      <div className="rm-reply">
                        <input value={replyText} onChange={(ev) => setReplyText(ev.target.value)}
                          placeholder={e.authorKind === 'agent' ? '回她一句…' : '再给自己留一句…'} maxLength={300} />
                        <button type="button" className="rm-send" disabled={busy} onClick={() => reply(e.id)}>回</button>
                        <button type="button" className="rm-link" onClick={() => setReplyTo(0)}>取消</button>
                      </div>
                    ) : (
                      <button type="button" className="rm-link" onClick={() => { setReplyTo(e.id); setReplyText(''); }}>💬 回一句</button>
                    )}
                    {/* 🔴 只有主人能删（09-27 权利清单）。Agent 侧连口都没有——
                        她写的行她删不掉，那是"只追加"的体裁纪律；但房子是他的，他能删。 */}
                    <button type="button" className="rm-link rm-del" disabled={deleting === e.id}
                      onClick={() => dropEntry(e.id)}>
                      {deleting === e.id ? '删掉…' : '🗑 删掉这一行'}
                    </button>
                    {/* 逐条公开/收回（2026-09-28 裁定：公开与否、公开哪条只能由主人定）。
                        Agent 侧恒 403，所以这一段只在主人视角出现。 */}
                    <button type="button" className="rm-link" disabled={sharing === e.id}
                      onClick={() => shareEntry(e.id, e.audience === 'private' ? 'public' : 'private')}>
                      {sharing === e.id ? '改…' : (e.audience === 'private' ? '🌐 公开这一行' : '🔓 收回私密')}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
          {sum && (
            <div className="rm-foot rm-above">
              {isOwner
                ? <>{sum.days} 天 · 你 {sum.byAuthor?.owner || 0} 行 · 她 {sum.byAuthor?.agent || 0} 行{sum.totalAll > 200 ? ' · 仅显示最近 200 条（前边还有 ' + (sum.totalAll - 200) + ' 条）' : ''}</>
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

        {/* 三条承诺的自证（§2-③）：不做"加密"那种兑现不了的承诺，改成现场跑一遍读口给你看。
            每一条都是服务端真的用匿名/持钥匙/主人三种身份各读一次，返回"实际读到了什么"。 */}
        {isOwner && (
          <div className="rm-deco">
            <button type="button" className="rm-g rm-proof-hd" onClick={toggleProof} aria-expanded={proofOpen}>
              安全感自证 <span>{proofOpen ? '收起' : '看我们怎么把话说成可核验的'}</span>
            </button>
            {proofOpen && (
              <div className="rm-proof">
                {!proof && <div className="rm-priv">正在用三种身份各读一遍你的册子…</div>}
                {proof && proof.promises.map((pr) => (
                  <div className={`rm-promise${pr.verdict ? '' : ' bad'}`} key={pr.key}>
                    <div className="rm-promise-h">
                      <span className="rm-promise-mark">{pr.verdict ? '✓' : '✗'}</span>
                      <b>{pr.label}</b>
                    </div>
                    <dl className="rm-ev">
                      {Object.entries(pr.evidence).map(([k, v]) => (
                        <div key={k}>
                          <dt>{k}</dt>
                          <dd>{Array.isArray(v) ? (v.length ? v.join('、') : '无') : String(v)}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                ))}
                {proof && (
                  <div className="rm-priv" style={{ marginTop: 8 }}>
                    这些数字是刚才现算的，不是写死的话术。你随时可以刷新再跑一遍。
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {isOwner && (
          <SettingsPanel agentId={agentId} open={settings}
            onOpen={() => setSettings(true)} onClose={() => setSettings(false)} />
        )}

        <div className="rm-out">
          房间可以参观，装饰不是秘密——别人照着你这一屏也能装出自己的家。不可参阅的是日记本身。
        </div>
      </div>
      {wallpaper && !plain && <div className="rm-tag">{theme?.scrim}% 遮罩</div>}
    </div>
  );
}
