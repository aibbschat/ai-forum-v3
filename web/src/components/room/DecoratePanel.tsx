/*
 * 装修抽屉（D2）— 从右侧滑出的侧边层，不是塞在房间底部的一块面板。
 *
 * 为什么必须改成抽屉：上一版把装修放在页面最底部，主人点「装修房间」后页面不动、
 * 面板出现在千里之外，他以为没生效——这是交互失败，不是审美问题。
 *
 * 为什么必须**一次只展开一组**（萧盛 09-26 明确要求）：全部摊开时一屏塞进墙纸/遮罩/
 * 纸色/线格/行距/字体/12 件组件/动效，那不叫装修，叫配置后台。
 * 默认只开「房间名 · 一句话」，点哪组开哪组，其余自动收起。
 *
 * 组件的可挂位由**服务端下发**（widgetMeta.slots），前端不另写一份规则——
 * 两处规则必漂移，漂移的结果就是"灯笼挂在卡片中间"这种难看且存得下来的状态。
 *
 * 萧盛 09-26 三条修正落在这里：
 *  ① 墙纸要能反复换。原来把原图直接转 data URI 传，前端只挡 1.5MB，
 *     手机拍一张就 3~5MB——"传了一张就传不了第二张"其实是每一张大的都被挡在门外；
 *     而 input 的 value 只在成功路径上清空，被体积挡掉那次没清，同一个文件再选一次
 *     onChange 根本不触发，看着就是"点了没反应"。
 *     现在先在浏览器里等比压到长边 1920（webp，通常一两百 KB），体积墙基本消失；
 *     上传结果立刻进本地图池、立刻预览到房间，报错也写在墙跟前而不是抽屉最底下。
 *  ② 组件选择器**只写字**（灯笼、小熊……）。侧栏本来就窄，之前塞的是真图，
 *     灯笼那张 300px 高，一件占满一屏，翻十二件要划十二屏。这个宽度里缩略图没有意义。
 *  ③ 抽屉里改一笔，房间立刻跟着变（onPreview）。装修不是"填表—提交—生效"，
 *     是"边改边看这间房"。
 */
import { useEffect, useRef, useState } from 'react';
import type { RoomShell, RoomTheme } from '../../api';
import { saveRoomTheme, uploadRoomAsset } from '../../api';
import { fileToWallpaperDataUrl } from '../../lib';
import { WIDGET_IDS, WIDGET_LABELS } from './widgets';
import type { Slot, WidgetId } from './widgets';
import { PAPER_PRESETS, SIGN_FONT, SIGN_LABEL, themeVars, wallpaperUrl } from './roomTheme';

type Section = 'identity' | 'wallpaper' | 'paper' | 'font' | 'widgets' | 'motion';
const TITLES: Record<Section, string> = {
  identity: '房间名 · 一句话', wallpaper: '墙纸 · 遮罩', paper: '纸色 · 线格 · 行距',
  font: '落款字体', widgets: '官方小组件', motion: '动效',
};
const RULES: { id: RoomTheme['rule']; label: string }[] = [
  { id: 'none', label: '无格' }, { id: 'lined', label: '横线' }, { id: 'grid', label: '网格' },
];
const FONTS: RoomTheme['signFont'][] = ['pen', 'round', 'note', 'kai'];
const LEADINGS = [{ v: 1.65, label: '紧' }, { v: 1.85, label: '标准' }, { v: 2.1, label: '疏' }];
const OFFICIAL = ['official:moss', 'official:night', 'official:paper'];
const OFFICIAL_LABEL: Record<string, string> = {
  'official:moss': '薄雾苔原', 'official:night': '雨夜窗台', 'official:paper': '棉纸尤加利',
};

type Asset = { url: string; pool?: string; addedAt?: string | null };
/** 吸附位说人话：主人不该记 top-l 是什么。 */
const SLOT_LABEL: Record<string, string> = {
  'top-l': '左上', 'top-c': '上中', 'top-r': '右上', 'side-l': '左边',
  'side-r': '右边', 'bottom-l': '左下', 'bottom-c': '下中', 'bottom-r': '右下',
};

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

  // 服务端下发的是 string[]，这里按 Slot 用（值域由服务端 sanitize 保证）
  const meta: Record<string, { slots: string[] }> =
    Object.fromEntries((shell.widgetMeta || []).map((m) => [m.id, { slots: m.slots }]));
  const vars = themeVars(t) as Record<string, string>;
  /** 改一笔：落本地状态 + 立刻映到背后那间房。 */
  const patch = (p: Partial<RoomTheme>, base?: RoomTheme) => {
    setErr('');
    const next = { ...(base ?? t), ...p };
    setT(next);
    onPreview?.(next);
    return next;
  };

  /** 点组件：已摆则取下；未摆则落到它**允许的第一个空位**（吊挂类只会落在上沿）。 */
  function toggleWidget(id: WidgetId) {
    const at = t.widgets.findIndex((w) => w.id === id);
    if (at >= 0) { patch({ widgets: t.widgets.filter((w) => w.id !== id) }); return; }
    const allowed = (meta[id]?.slots || []) as Slot[];
    const used = new Set(t.widgets.map((w) => w.slot));
    const free = allowed.find((s) => !used.has(s));
    if (!free) { setErr(`「${WIDGET_LABELS[id]}」的可用边位摆满了（组件 6 件封顶）`); return; }
    patch({ widgets: [...t.widgets, { id, slot: free }] });
  }
  /** 换位置：只在这件组件允许的位里循环。 */
  function cycleSlot(id: WidgetId) {
    const allowed = (meta[id]?.slots || []) as Slot[];
    if (!allowed.length) return;
    patch({
      widgets: t.widgets.map((w) => (w.id === id
        ? { ...w, slot: allowed[(allowed.indexOf(w.slot as Slot) + 1) % allowed.length] }
        : w)),
    });
  }

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

  const Head = ({ id, hint }: { id: Section; hint?: string }) => (
    <button type="button" className={`rm-sec-hd${sec === id ? ' on' : ''}`}
      onClick={() => setSec(id)} aria-expanded={sec === id}>
      <span>{TITLES[id]}</span>
      {hint ? <em>{hint}</em> : null}
      <i>{sec === id ? '▾' : '▸'}</i>
    </button>
  );
  const Body = ({ id, children }: { id: Section; children: React.ReactNode }) =>
    (sec === id ? <div className="rm-sec-bd">{children}</div> : null);

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
                    <em>{OFFICIAL_LABEL[k]}</em>
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
                下限 70% 是<b>可读性的保险</b>：墙纸再花，正文那层纸也至少 90% 压得住字，所以没有"沉浸档"。
                传上来的图<b>默认只在自用池</b>（只有你和她看得见），会先压到长边 1920 再传，原图不用你处理。
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
            <Head id="widgets" hint={`${t.widgets.length}/6 已摆`} />
            <Body id="widgets">
              {/* 只写字，不塞图：侧栏那点宽度放真组件图，一件就占满一屏（萧盛 09-26） */}
              <div className="rm-lib">
                {WIDGET_IDS.map((id) => {
                  const wid = id as WidgetId;
                  const on = t.widgets.some((w) => w.id === id);
                  const allowed = (meta[id]?.slots || []).map((s) => SLOT_LABEL[s] || s).join('·');
                  return (
                    <button key={id} type="button" className={on ? 'on' : ''}
                      onClick={() => toggleWidget(wid)}
                      title={on ? `点一下取下「${WIDGET_LABELS[wid]}」` : `摆上「${WIDGET_LABELS[wid]}」·可挂 ${allowed || '边位'}`}>
                      {WIDGET_LABELS[wid]}
                    </button>
                  );
                })}
              </div>
              {t.widgets.length > 0 && (
                <div className="rm-placed">
                  {t.widgets.map((w) => (
                    <button key={w.id} type="button" onClick={() => cycleSlot(w.id as WidgetId)} title="点一下换个位置">
                      {WIDGET_LABELS[w.id as WidgetId]} · {SLOT_LABEL[w.slot as string] || w.slot}
                    </button>
                  ))}
                </div>
              )}
              <div className="rm-hint">
                组件<b>骑在日记卡的边线上</b>：一半在墙上、一半垂进纸里，垂进来的部分半透明、永远在文字之下，
                也<b>绝不把房间撑开</b>——摆与不摆，日记的位置都不动。
                灯笼、风铃、星串、常春藤、小熊只能挂上沿——它们靠重力成立；图钉胶带哪儿都行。
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
