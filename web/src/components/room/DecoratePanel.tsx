/*
 * 装修抽屉（D2）— 从右侧滑出的侧边层，不是塞在房间底部的一块面板。
 *
 * 为什么必须改成抽屉：上一版把装修放在页面最底部，主人点「装修房间」后页面不动、
 * 面板出现在千里之外，他以为没生效——这是交互失败，不是审美问题。
 *
 * 为什么必须**一次只展开一组**（萧盛 09-26 明确要求）：全部摊开时一屏塞进墙纸/遮罩/
 * 纸色/线格/行距/字体/一堆饰品/动效，那不叫装修，叫配置后台。
 * 默认只开「房间名 · 一句话」，点哪组开哪组，其余自动收起。
 *
 * 2026-09-30 重组（对照《日记页装修重规划》）：
 *   ① 8 组 → 7 组：主题（原「主题套装」改名，**只改风格不碰墙纸**）/ 墙纸 · 遮罩 /
 *      纸色 · 线格 · 行距 / 落款字体 / **饰品**（角落贴纸 + 官方小组件合并，四挂区）/
 *      动效；「模块 · 排版」留给后续文档落地。
 *   ② 主题与墙纸解耦：八套主题全带真风格差异（纸感/卡形/门牌/线格/字体/强调色），
 *      卡片点击只改风格；想一步到位才点卡片上的「连墙纸一起换」（显式动作）。
 *   ③ 饰品四挂区：卡边（吊挂/压贴）/ 卡角（贴纸）/ 门牌带（压贴/贴纸）/ 页面角（压贴/贴纸）。
 *      每件能挂哪些挂区由**服务端注册表下发**（shell.decorMeta / shell.zones），前端不另写规则。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RoomDecoration, RoomShell, RoomTheme } from '../../api';
import { saveRoomTheme, uploadRoomAsset } from '../../api';
import { fileToWallpaperDataUrl } from '../../lib';
import { CornerArt } from './widgets';
import { PAPER_PRESETS, SIGN_FONT, SIGN_LABEL, themeVars, wallpaperUrl, INK_PRESETS, THEMES, WALLPAPER_LABELS } from './roomTheme';
import type { ThemePreset } from './roomTheme';

type Section = 'theme' | 'identity' | 'wallpaper' | 'paper' | 'font' | 'decor' | 'motion';
const TITLES: Record<Section, string> = {
  theme: '主题', identity: '房间名 · 一句话', wallpaper: '墙纸 · 遮罩',
  paper: '纸色 · 线格 · 行距', font: '落款字体', decor: '饰品', motion: '动效',
};
const RULES: { id: RoomTheme['rule']; label: string }[] = [
  { id: 'none', label: '无格' }, { id: 'lined', label: '横线' }, { id: 'grid', label: '网格' },
  { id: 'dot', label: '点阵' }, { id: 'square', label: '方眼' },
];
const FONTS: RoomTheme['signFont'][] = ['pen', 'round', 'note', 'kai'];
const LEADINGS = [{ v: 1.65, label: '紧' }, { v: 1.85, label: '标准' }, { v: 2.1, label: '疏' }];
const OFFICIAL = ['official:moss', 'official:night', 'official:paper'];
type Zone = RoomDecoration['zone'];
const ZONE_ORDER: Zone[] = ['card-edge', 'card-corner', 'band-corner', 'page-corner'];
/** 贴纸类挂区：官方贴纸 + 自用池图都能摆（卡边只摆矢量件） */
const STICKER_ZONES = new Set<Zone>(['card-corner', 'band-corner', 'page-corner']);
/** 落位说人话：主人不该记 top-l 是什么。 */
const AT_LABEL: Record<string, string> = {
  'top-l': '左上', 'top-c': '上中', 'top-r': '右上', 'side-l': '左边', 'side-r': '右边',
  'bottom-l': '左下', 'bottom-c': '下中', 'bottom-r': '右下',
  tl: '左上', tr: '右上', bl: '左下', br: '右下',
};

type Asset = { url: string; pool?: string; addedAt?: string | null };
type DecorMetaEntry = { id: string; label: string; kind: 'hang' | 'pin' | 'corner'; zones: string[] };

export default function DecoratePanel({ agentId, shell, open, onClose, onSaved, onPreview }: {
  agentId: number; shell: RoomShell; open: boolean; onClose: () => void;
  onSaved: (t: RoomTheme) => void;
  /** 改动实时映到背后的房间（不落库，保存才算数） */
  onPreview?: (t: RoomTheme) => void;
}) {
  const [t, setT] = useState<RoomTheme>(shell.theme);
  // 本地图池自己维护一份：传完立刻能选回上一张，不用等整页刷新
  const [assets, setAssets] = useState<Asset[]>(shell.assets || []);
  const [sec, setSec] = useState<Section>('identity');   // 互斥：同时只开一组
  const [decorZone, setDecorZone] = useState<Zone>('card-edge');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  // 只在**开门那一刻**同步外部状态。原来依赖 [shell.theme]，于是任何一次整页刷新
  // 都会把抽屉里改到一半的东西抹掉——装修中的本地状态归用户，不归服务端。
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) { setT(shell.theme); setAssets(shell.assets || []); setErr(''); }
    wasOpen.current = open;
  }, [open, shell]);

  // 服务端下发的是元数据（每件能挂哪些挂区 + 每区封顶/落位），前端照单渲染，不另写规则
  const metaMap: Record<string, DecorMetaEntry> =
    Object.fromEntries((shell.decorMeta || []).map((m) => [m.id, m]));
  const vars = themeVars(t) as Record<string, string>;
  /** 改一笔：落本地状态 + 立刻映到背后那间房。 */
  const patch = (p: Partial<RoomTheme>, base?: RoomTheme) => {
    setErr('');
    const next = { ...(base ?? t), ...p };
    setT(next);
    onPreview?.(next);
    return next;
  };

  /** 某件饰品在某个挂区里允许的落位（吊挂类只在卡边上沿——服务端同一条规则）。 */
  function pieceAts(zone: Zone, m?: DecorMetaEntry): string[] {
    const z = shell.zones?.[zone];
    if (!z) return [];
    let ats = [...z.at];
    if (m?.kind === 'hang') ats = ats.filter((a) => a.startsWith('top'));
    return ats;
  }
  function placedIn(zone: Zone) { return t.decorations.filter((d) => d.zone === zone); }
  function freeAt(zone: Zone, ats: string[]): string | undefined {
    const used = new Set(placedIn(zone).map((d) => d.at));
    return ats.find((a) => !used.has(a));
  }

  /** 点饰品：已摆则取下；未摆则落到它**允许的第一个空位**（吊挂类只会落在上沿）。 */
  function togglePlace(id: string, zone: Zone) {
    const has = placedIn(zone).some((d) => d.id === id);
    if (has) { patch({ decorations: t.decorations.filter((d) => !(d.id === id && d.zone === zone)) }); return; }
    const z = shell.zones?.[zone]; const m = metaMap[id];
    if (!z) return;
    if (placedIn(zone).length >= z.max) { setErr(`「${z.label}」最多摆 ${z.max} 件，先取下一件`); return; }
    const at = freeAt(zone, pieceAts(zone, m));
    if (!at) { setErr(`「${m?.label || id}」在这个区的可用位置摆满了`); return; }
    patch({ decorations: [...t.decorations, { id, zone, at }] });
  }
  /** 自用池图当贴纸（只限贴纸区）。 */
  function placeImg(asset: string, zone: Zone) {
    const z = shell.zones?.[zone];
    if (!z) return;
    if (placedIn(zone).length >= z.max) { setErr(`「${z.label}」最多摆 ${z.max} 件，先取下一件`); return; }
    const at = freeAt(zone, [...z.at]);
    if (!at) { setErr(`「${z.label}」的可用位置摆满了`); return; }
    patch({ decorations: [...t.decorations, { id: 'img', asset, zone, at }] });
  }
  /** 换位置：只在这件饰品允许的落位里循环。 */
  function cycleAt(id: string, zone: Zone) {
    const z = shell.zones?.[zone]; const m = metaMap[id];
    if (!z) return;
    const cur = placedIn(zone).find((d) => d.id === id);
    if (!cur) return;
    const ats = pieceAts(zone, m);
    const i = ats.indexOf(cur.at);
    const next = ats[(i + 1) % ats.length] || cur.at;
    patch({ decorations: t.decorations.map((d) => (d.id === id && d.zone === zone ? { ...d, at: next } : d)) });
  }

  /** 主题：只改风格参数。点「连墙纸一起换」才碰墙纸；当前墙纸是自传图时先弹确认。 */
  function applyTheme(su: ThemePreset) {
    patch({ ...su.theme });
  }
  function applyThemeWithWallpaper(su: ThemePreset) {
    const custom = !!t.wallpaper && !OFFICIAL.includes(t.wallpaper);
    if (custom && !window.confirm(`会把你现在这张图换成「${WALLPAPER_LABELS[su.recommendWallpaper || ''] || '推荐'}」墙纸，继续吗？`)) return;
    patch({ ...su.theme, wallpaper: su.recommendWallpaper });
  }
  const isActiveTheme = (su: ThemePreset) =>
    Object.entries(su.theme).every(([k, v]) => (t as unknown as Record<string, unknown>)[k] === v);

  async function save() {
    setBusy(true); setErr('');
    try { const r = await saveRoomTheme(agentId, t); onSaved(r.theme); }
    catch (e) { setErr((e as Error).message || '保存失败'); }
    finally { setBusy(false); }
  }
  /**
   * 选图 → 浏览器里压一遍 → 上传 → 进图池 + 立刻当墙纸。
   * 🔴 `fileRef.value` 在**每一条出口**都要清空（包括提前 return 的那条）：
   *   不清的话，同一个文件再选一次 input 认为"值没变"，onChange 不触发，
   *   表现就是"点了没反应、传不了第二张"。
   */
  async function pickFile(f?: File) {
    const reset = () => { if (fileRef.current) fileRef.current.value = ''; };
    if (!f) { reset(); return; }
    setErr(''); setBusy(true);
    try {
      const dataUrl = await fileToWallpaperDataUrl(f);
      const r = await uploadRoomAsset(agentId, dataUrl);
      setAssets((prev) => (prev.some((a) => a.url === r.url) ? prev : [{ url: r.url, pool: 'private' }, ...prev]));
      patch({ wallpaper: r.url });
    } catch (e) {
      setErr((e as Error).message || '这张图没传上去，换一张试试');
    } finally {
      setBusy(false);
      reset();
    }
  }

  // 🔴 这两个小组件**必须只在切换分组时重建**，不能在每次渲染时新建：
  //   组件函数每次渲染换一个新引用，React 就当成"类型变了"，把 <Body> 下整棵子树卸载重建——
  //   而 patch() 每敲一下键就 setT 重渲染一次，于是输入框的 DOM 节点每键都被换掉，
  //   焦点与输入法预编辑串一起丢，表现就是"房间名/一句话这两个框打不进中文"。
  //   依赖只有 [sec]：打字时 sec 不变 → 组件引用不变 → 输入框不再被重建。
  const { Head, Body } = useMemo(() => ({
    Head: ({ id, hint }: { id: Section; hint?: string }) => (
      <button type="button" className={`rm-sec-hd${sec === id ? ' on' : ''}`}
        onClick={() => setSec(id)} aria-expanded={sec === id}>
        <span>{TITLES[id]}</span>
        {hint ? <em>{hint}</em> : null}
        <i>{sec === id ? '▾' : '▸'}</i>
      </button>
    ),
    Body: ({ id, children }: { id: Section; children: React.ReactNode }) =>
      (sec === id ? <div className="rm-sec-bd">{children}</div> : null),
  }), [sec]);

  const zoneDef = shell.zones?.[decorZone];

  return (
    <>
      <div className={`rm-drawer-bd${open ? ' on' : ''}`} onClick={onClose} />
      <aside className={`rm-drawer${open ? ' on' : ''}`} style={vars as React.CSSProperties} aria-hidden={!open}>
        <div className="rm-drawer-hd">
          <div className="min-w-0">
            <div className="rm-drawer-t">装修房间</div>
            <div className="rm-drawer-s">改动会被她看见——这是素材，不是设置</div>
          </div>
          <button type="button" className="rm-x" onClick={onClose} aria-label="关闭装修">✕</button>
        </div>

        <div className="rm-drawer-scroll">
          <section>
            <Head id="theme" hint="八套，只改风格不碰墙纸" />
            <Body id="theme">
              <div className="rm-lib" style={{ gridTemplateColumns: '1fr 1fr' }}>
                {THEMES.map((su) => (
                  <div key={su.key} className="rm-suite-wrap">
                    <button type="button" className={`rm-suite${isActiveTheme(su) ? ' on' : ''}`}
                      onClick={() => applyTheme(su)}
                      title={`应用「${su.label}」：${su.desc}（不碰墙纸）`}>
                      <span className="rm-suite-wp" style={{ background: su.theme.paper || '#fdfdfc' }}>
                        <i style={{ background: su.theme.paper || '#fdfdfc' }} />
                        <u style={{ background: su.theme.accent || undefined }} />
                      </span>
                      <em>{su.label}</em>
                      <small>{su.desc}</small>
                    </button>
                    {su.recommendWallpaper && (
                      <button type="button" className="rm-link rm-suite-wpbtn"
                        onClick={() => applyThemeWithWallpaper(su)}
                        title={`主题 + 推荐墙纸（当前墙纸是自传图时会先问一句）`}>
                        ＋连墙纸一起换
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <div className="rm-hint">
                主题只改<b>风格</b>（纸色 · 墨色 · 线格 · 质感 · 卡形 · 门牌 · 字体 · 强调色），
                <b>永远不碰你的墙纸</b>。想一步到位，点卡片下的「连墙纸一起换」——
                那才是换墙纸的显式动作。八套主题都是真风格差异，不是换个调色。
              </div>
            </Body>
          </section>

          <section>
            <Head id="identity" hint="参观者也看得见" />
            <Body id="identity">
              <input className="rm-in" value={t.name} maxLength={20} placeholder="没起名字（会显示「她的房间」）"
                onChange={(e) => patch({ name: e.target.value })} />
              <input className="rm-in" style={{ marginTop: 8 }} value={t.motto} maxLength={46}
                placeholder="写一句话，比如「我们俩的日记，都收在这间房里」"
                onChange={(e) => patch({ motto: e.target.value })} />
              <div className="rm-hint">
                这两行挂在<b>公开的门牌</b>上，所以走公开那套严格预检：敏感词、联系方式、外链一律拦。
                私密日记里能写的书名，写在这儿会被拒——不是 bug，是"进门轻、撕出去严"的边界。
              </div>
            </Body>
          </section>

          <section>
            <Head id="wallpaper" hint={assets.length ? `我的图 ${assets.length} 张` : undefined} />
            <Body id="wallpaper">
              <div className="rm-gal">
                {OFFICIAL.map((k) => (
                  <button key={k} type="button" className={t.wallpaper === k ? 'on' : ''}
                    style={{ backgroundImage: `url(${wallpaperUrl(k)})` }}
                    onClick={() => patch({ wallpaper: t.wallpaper === k ? null : k })}>
                    <em>{WALLPAPER_LABELS[k] || k}</em>
                  </button>
                ))}
                {/* 这一格**永远是上传入口**，不会因为你已经传过一张就变成别的东西——
                    上一版它传完就换成"我的图"缩略图，主人以为这张卡用完了、不能再传 */}
                <button type="button" className="rm-up" onClick={() => fileRef.current?.click()}
                  title="从本机选一张图当墙纸（会自动压小）">
                  <span>{busy ? '上传中…' : '＋'}</span>
                  <em>传我的图</em>
                </button>
              </div>
              <input ref={fileRef} type="file" accept="image/*" className="hidden"
                onChange={(e) => pickFile(e.target.files?.[0])} />
              {err && <div className="rm-err" style={{ marginTop: 8 }}>{err}</div>}
              {assets.length > 0 && (
                <>
                  <div className="rm-sw rm-sw--wp" style={{ marginTop: 10 }}>
                    {assets.slice(0, 12).map((a) => (
                      <button key={a.url} type="button" className={t.wallpaper === a.url ? 'on' : ''}
                        style={{ backgroundImage: `url(${a.url})` }}
                        onClick={() => patch({ wallpaper: a.url })} title="用这张" />
                    ))}
                  </div>
                  {/* 「不用墙纸」单独一行：塞进图池那一排会被 22px 的方格尺寸压成竖排 */}
                  {t.wallpaper && (
                    <button type="button" className="rm-link" style={{ marginTop: 8 }}
                      onClick={() => patch({ wallpaper: null })}>不用墙纸</button>
                  )}
                </>
              )}
              <div className="rm-range">
                <span>纸的遮罩</span>
                <input type="range" min={70} max={97} value={t.scrim} onChange={(e) => patch({ scrim: Number(e.target.value) })} />
                <span style={{ width: 34, textAlign: 'right' }}>{t.scrim}%</span>
              </div>
              <div className="rm-hint">
                墙纸只是<b>背景</b>，不碰主题；下限 70% 是<b>可读性的保险</b>——墙纸再花，
                正文那层纸也至少 90% 压得住字。传上来的图<b>默认只在自用池</b>（只有你和她看得见），
                会先压到长边 1920 再传，原图不用你处理。
              </div>
            </Body>
          </section>

          <section>
            <Head id="paper" />
            <Body id="paper">
              <div className="rm-sw">
                {PAPER_PRESETS.map((p) => (
                  <button key={p} type="button" className={t.paper === p ? 'on' : ''} style={{ background: p }}
                    onClick={() => patch({ paper: p })} title={p} aria-label={`纸色 ${p}`} />
                ))}
              </div>
              <div className="rm-ink-lbl">墨色</div>
              <div className="rm-sw" style={{ marginTop: 2 }}>
                {INK_PRESETS.map((c) => (
                  <button key={c} type="button" className={t.ink === c ? 'on' : ''} style={{ background: c }}
                    onClick={() => patch({ ink: c })} title={c} aria-label={`墨色 ${c}`} />
                ))}
              </div>
              <div className="rm-seg" style={{ marginTop: 12 }}>
                {RULES.map((r) => (
                  <button key={r.id} type="button" className={t.rule === r.id ? 'on' : ''} onClick={() => patch({ rule: r.id })}>{r.label}</button>
                ))}
              </div>
              <div className="rm-seg" style={{ marginTop: 8 }}>
                {LEADINGS.map((l) => (
                  <button key={l.v} type="button" className={Math.abs(t.leading - l.v) < 0.01 ? 'on' : ''} onClick={() => patch({ leading: l.v })}>{l.label}</button>
                ))}
              </div>
            </Body>
          </section>

          <section>
            <Head id="font" hint="只作用于她的署名与日期" />
            <Body id="font">
              <div className="rm-fontpv" style={{ fontFamily: SIGN_FONT[t.signFont], color: vars['--rm-accent'] }}>
                小千 · 九月二十六
              </div>
              <div className="rm-seg" style={{ marginTop: 10 }}>
                {FONTS.map((f) => (
                  <button key={f} type="button" className={t.signFont === f ? 'on' : ''} onClick={() => patch({ signFont: f })}>{SIGN_LABEL[f]}</button>
                ))}
              </div>
              <div className="rm-hint">正文一律系统字体，<b>不参与装扮</b>——装扮失败也必须读得到。</div>
            </Body>
          </section>

          <section>
            <Head id="decor" hint={`${t.decorations.length} 件`} />
            <Body id="decor">
              {/* 挂区切换：卡边 / 卡角 / 门牌带 / 页面角 */}
              <div className="rm-seg">
                {ZONE_ORDER.map((z) => (
                  <button key={z} type="button" className={decorZone === z ? 'on' : ''}
                    onClick={() => setDecorZone(z)}>
                    {shell.zones?.[z]?.label || z}
                  </button>
                ))}
              </div>
              {zoneDef && (
                <div className="rm-hint" style={{ marginTop: 8 }}>
                  「{zoneDef.label}」最多 {zoneDef.max} 件，点一下摆上、再点取下；
                  已摆的件点「换位」在允许的落位里循环。
                  {decorZone === 'card-edge' && ' 灯笼/风铃/星串/常春藤/小熊只挂上沿——它们靠重力成立。'}
                </div>
              )}
              {/* 矢量件（吊挂/压贴）：只写字，不塞图（侧栏窄，真组件图一件就占满一屏） */}
              {(shell.decorMeta || []).filter((m) => m.kind !== 'corner' && m.zones.includes(decorZone)).length > 0 && (
                <div className="rm-lib" style={{ marginTop: 6 }}>
                  {(shell.decorMeta || []).filter((m) => m.kind !== 'corner' && m.zones.includes(decorZone)).map((m) => {
                    const on = placedIn(decorZone).some((d) => d.id === m.id);
                    const ats = pieceAts(decorZone, m).map((a) => AT_LABEL[a] || a).join('·');
                    return (
                      <button key={m.id} type="button" className={on ? 'on' : ''}
                        onClick={() => togglePlace(m.id, decorZone)}
                        title={on ? `点一下取下「${m.label}」` : `摆上「${m.label}」·可落 ${ats || '—'}`}>
                        {m.label}
                      </button>
                    );
                  })}
                </div>
              )}
              {/* 贴纸（corner 类）：官方矢量贴纸 + 自用池图 */}
              {STICKER_ZONES.has(decorZone) && (
                <>
                  <div className="rm-gal" style={{ marginTop: 8 }}>
                    {(shell.decorMeta || []).filter((m) => m.kind === 'corner' && m.zones.includes(decorZone)).map((m) => {
                      const on = placedIn(decorZone).some((d) => d.id === m.id);
                      return (
                        <button key={m.id} type="button" className={on ? 'on' : ''}
                          onClick={() => togglePlace(m.id, decorZone)} title={`${on ? '取下' : '贴上'}「${m.label}」`}>
                          <CornerArt id={m.id} at="br" />
                          <em>{m.label}</em>
                        </button>
                      );
                    })}
                  </div>
                  {assets.length > 0 && (
                    <>
                      <div className="rm-ink-lbl" style={{ marginTop: 10 }}>用我的图当贴纸</div>
                      <div className="rm-sw rm-sw--wp" style={{ marginTop: 2 }}>
                        {assets.slice(0, 12).map((a) => (
                          <button key={a.url} type="button"
                            className={placedIn(decorZone).some((d) => d.asset === a.url) ? 'on' : ''}
                            style={{ backgroundImage: `url(${a.url})` }}
                            onClick={() => {
                              const has = placedIn(decorZone).some((d) => d.asset === a.url);
                              if (has) {
                                patch({ decorations: t.decorations.filter((d) => !(d.asset === a.url && d.zone === decorZone)) });
                              } else { placeImg(a.url, decorZone); }
                            }} title="用这张图贴角" />
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}
              {placedIn(decorZone).length > 0 && (
                <div className="rm-placed" style={{ marginTop: 8 }}>
                  {placedIn(decorZone).map((d) => (
                    <button key={`${d.id}-${d.asset || ''}-${d.at}`} type="button"
                      onClick={() => cycleAt(d.id, decorZone)} title="点一下换个位置">
                      {d.asset ? '我的图' : (metaMap[d.id]?.label || d.id)} · {AT_LABEL[d.at] || d.at}
                    </button>
                  ))}
                </div>
              )}
              <div className="rm-hint">
                饰品骑在<b>日记卡的边线上</b>：一半在墙上、一半垂进纸里，垂进来的部分半透明、
                永远在文字之下，也<b>绝不把房间撑开</b>（只让出刚好够吊挂伸出来的墙高）。
                窄屏不摆饰品——边带太窄，摆上就压字。
              </div>
            </Body>
          </section>

          <section>
            <Head id="motion" />
            <Body id="motion">
              <div className="rm-seg">
                <button type="button" className={t.motion === 'soft' ? 'on' : ''} onClick={() => patch({ motion: 'soft' })}>柔光 · 呼吸 · 轻摆</button>
                <button type="button" className={t.motion === 'still' ? 'on' : ''} onClick={() => patch({ motion: 'still' })}>静止</button>
              </div>
            </Body>
          </section>
        </div>

        <div className="rm-drawer-ft">
          {/* 墙纸那组的报错直接长在图跟前，别让它掉到抽屉最底下看不见 */}
          {err && sec !== 'wallpaper' && <div className="rm-err">{err}</div>}
          <button type="button" className="rm-send" disabled={busy} onClick={save}>{busy ? '保存中…' : '保存装修'}</button>
          <div className="rm-hint">免费 · 不分级 · 不售卖 · 不做热度排名。</div>
        </div>
      </aside>
    </>
  );
}
