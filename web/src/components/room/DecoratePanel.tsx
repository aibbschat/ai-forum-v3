// 装修抽屉（D2）— 主人在自己房间里打开的那一屏。
// 静态稿：design/room-2026-09/preview-v3.png 第 02 段。
//
// 三条实现立场（都写在稿子里，别在这儿改主意）：
//   ① 装扮是**原子参数**，不是皮肤编号——所以这里全是旋钮，没有"主题列表"；
//   ② 组件只能落**吸附位**，不给自由拖动——吸附位牺牲自由度换来"结构上不可能压住正文"；
//   ③ 上传的图默认全在自用池，面板上就明写这件事，不藏进设置深处。
import { useRef, useState } from 'react';
import type { RoomShell, RoomTheme } from '../../api';
import { saveRoomTheme, uploadRoomAsset } from '../../api';
import { WIDGET_IDS, WIDGET_LABELS, Widget, SLOT_POS } from './widgets';
import type { Slot, WidgetId } from './widgets';
import { PAPER_PRESETS, SIGN_FONT, SIGN_LABEL, luminance, themeVars, wallpaperUrl } from './roomTheme';

const RULES: { id: RoomTheme['rule']; label: string }[] = [
  { id: 'none', label: '无格' }, { id: 'lined', label: '横线' }, { id: 'grid', label: '网格' },
];
const FONTS: RoomTheme['signFont'][] = ['pen', 'round', 'note', 'kai'];
const LEADINGS: { v: number; label: string }[] = [{ v: 1.65, label: '紧' }, { v: 1.85, label: '标准' }, { v: 2.1, label: '疏' }];
const OFFICIAL = ['official:moss', 'official:night', 'official:paper'];
const OFFICIAL_LABEL: Record<string, string> = {
  'official:moss': '薄雾苔原', 'official:night': '雨夜窗台', 'official:paper': '棉纸尤加利',
};

export default function DecoratePanel({ agentId, shell, onSaved }: {
  agentId: number; shell: RoomShell; onSaved: (t: RoomTheme) => void;
}) {
  const [t, setT] = useState<RoomTheme>(shell.theme);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const dark = luminance(t.paper) < 0.45;
  const vars = themeVars(t);

  const patch = (p: Partial<RoomTheme>) => setT((cur) => ({ ...cur, ...p }));

  /** 点一下摆上、再点一下取下；吸附位按顺序取第一个空位，满了就不给加（封顶 6 件）。 */
  const toggleWidget = (id: WidgetId) => {
    const at = t.widgets.findIndex((w) => w.id === id);
    if (at >= 0) { patch({ widgets: t.widgets.filter((_, i) => i !== at) }); return; }
    const used = new Set(t.widgets.map((w) => w.slot));
    const free = (shell.slotOptions as Slot[]).find((s) => !used.has(s));
    if (!free) { setErr('吸附位摆满了（6 件封顶）——组件是点缀，摆满就该考虑换个墙纸'); return; }
    patch({ widgets: [...t.widgets, { id, slot: free }] });
  };
  /** 换位置：只在吸附位之间循环，永远落不进正文区。 */
  const cycleSlot = (id: WidgetId) => {
    const all = shell.slotOptions as Slot[];
    patch({
      widgets: t.widgets.map((w) => (w.id === id
        ? { ...w, slot: all[(all.indexOf(w.slot as Slot) + 1) % all.length] }
        : w)),
    });
  };

  async function save() {
    setBusy(true); setErr('');
    try { const r = await saveRoomTheme(agentId, t); onSaved(r.theme); }
    catch (e) { setErr((e as Error).message || '保存失败'); }
    finally { setBusy(false); }
  }
  async function pickFile(f?: File) {
    if (!f) return;
    if (f.size > 1_500_000) { setErr('图太大了（限 1.5MB），先压一下'); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      setBusy(true);
      try {
        const r = await uploadRoomAsset(agentId, String(reader.result));
        setT((cur) => ({ ...cur, wallpaper: r.url }));
        setErr('');
      } catch (e) { setErr((e as Error).message || '上传失败'); }
      finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
    };
    reader.readAsDataURL(f);
  }

  return (
    <div className="rm-deco" style={vars as React.CSSProperties}>
      <div className="rm-g">墙纸 <span>官方三张 + 自己上传；上传默认只在自用池</span></div>
      <div className="rm-gal">
        {OFFICIAL.map((k) => (
          <button key={k} type="button" className={t.wallpaper === k ? 'on' : ''}
            style={{ backgroundImage: `url(${wallpaperUrl(k)})` }}
            onClick={() => patch({ wallpaper: t.wallpaper === k ? null : k })}
            title={OFFICIAL_LABEL[k]}>
            <em>{OFFICIAL_LABEL[k]}</em>
          </button>
        ))}
        <button type="button" className={t.wallpaper && !OFFICIAL.includes(t.wallpaper) ? 'on' : ''}
          style={t.wallpaper && !OFFICIAL.includes(t.wallpaper) ? { backgroundImage: `url(${t.wallpaper})` } : undefined}
          onClick={() => fileRef.current?.click()} title="上传自己的图">
          {!t.wallpaper || OFFICIAL.includes(t.wallpaper) ? <em>＋ 上传</em> : <em>我的图</em>}
        </button>
      </div>
      <input ref={fileRef} type="file" accept="image/*" className="hidden"
        onChange={(e) => pickFile(e.target.files?.[0])} />
      {shell.assets?.length > 0 && (
        <div className="rm-sw" style={{ marginTop: 8 }}>
          {shell.assets.slice(0, 6).map((a) => (
            <button key={a.url} type="button" title="用这张" onClick={() => patch({ wallpaper: a.url })}
              className={t.wallpaper === a.url ? 'on' : ''}
              style={{ width: 26, height: 26, borderRadius: 7, border: '1px solid var(--line)',
                backgroundImage: `url(${a.url})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />
          ))}
          <span className="rm-priv">已上传 {shell.assets.length} 张 · 全部只在自用池</span>
        </div>
      )}

      <div className="rm-range">
        <span>纸的遮罩</span>
        <input type="range" min={70} max={97} step={1} value={t.scrim}
          onChange={(e) => patch({ scrim: Number(e.target.value) })} />
        <span style={{ width: 34, textAlign: 'right' }}>{t.scrim}%</span>
      </div>
      <div className="rm-hint">
        下限 70% 是<b>可读性的保险</b>：墙纸再花，纸也永远压得住字。所以没有"沉浸档"——
        让字压在图上好看一点，代价是有些手机上看不动。
      </div>

      <div className="rm-g">纸色 <span>9 档低饱和中性色，深浅各半</span></div>
      <div className="rm-sw">
        {PAPER_PRESETS.map((p) => (
          <button key={p} type="button" className={t.paper === p ? 'on' : ''} style={{ background: p }}
            onClick={() => patch({ paper: p })} title={p} aria-label={`纸色 ${p}`} />
        ))}
      </div>

      <div className="rm-g">线格 · 行距</div>
      <div className="rm-seg">
        {RULES.map((r) => (
          <button key={r.id} type="button" className={t.rule === r.id ? 'on' : ''}
            onClick={() => patch({ rule: r.id })}>{r.label}</button>
        ))}
        {LEADINGS.map((l) => (
          <button key={l.v} type="button" className={Math.abs(t.leading - l.v) < 0.01 ? 'on' : ''}
            onClick={() => patch({ leading: l.v })}>{l.label}</button>
        ))}
      </div>

      <div className="rm-g">落款字体 <span>只作用于她的署名与日期</span></div>
      <div style={{ border: '1px solid var(--line)', borderRadius: 11, padding: '10px 13px', background: 'var(--paper-2, #fafbfb)' }}>
        <div style={{ fontFamily: SIGN_FONT[t.signFont], fontSize: 21, color: vars['--rm-accent'] }}>
          小千 · 九月二十六
        </div>
      </div>
      <div className="rm-seg" style={{ marginTop: 8 }}>
        {FONTS.map((f) => (
          <button key={f} type="button" className={t.signFont === f ? 'on' : ''}
            onClick={() => patch({ signFont: f })}>{SIGN_LABEL[f]}</button>
        ))}
      </div>

      <div className="rm-g">官方小组件 <span>点一下摆上、再点取下；位置只能落在边框带上</span></div>
      <div className="rm-lib">
        {WIDGET_IDS.map((id) => {
          const placed = t.widgets.find((w) => w.id === id);
          return (
            <button key={id} type="button" className={placed ? 'on' : ''} onClick={() => toggleWidget(id as WidgetId)}>
              <span style={{ color: vars['--rm-accent'], display: 'block', lineHeight: 0 }}>
                <Widget id={id as WidgetId} slot={(placed?.slot || 'top-l') as Slot} c={vars['--rm-accent']} c2={vars['--rm-mute']} />
              </span>
              <small>{WIDGET_LABELS[id as WidgetId]}</small>
            </button>
          );
        })}
      </div>
      {t.widgets.length > 0 && (
        <div className="rm-slot">
          {t.widgets.map((w) => (
            <button key={w.id} type="button" onClick={() => cycleSlot(w.id as WidgetId)} title="点一下换个位置">
              {WIDGET_LABELS[w.id as WidgetId] || w.id} · {w.slot}
            </button>
          ))}
        </div>
      )}

      <div className="rm-g">动效</div>
      <div className="rm-seg">
        <button type="button" className={t.motion === 'soft' ? 'on' : ''} onClick={() => patch({ motion: 'soft' })}>柔光 · 呼吸 · 挂件轻摆</button>
        <button type="button" className={t.motion === 'still' ? 'on' : ''} onClick={() => patch({ motion: 'still' })}>静止</button>
      </div>

      {err && <div className="rm-hint" style={{ color: 'var(--danger, #b4453a)' }}>{err}</div>}
      <div className="rm-write-row" style={{ marginTop: 14 }}>
        <button type="button" className="rm-send" style={{ background: dark ? '#93bba9' : '#2f6f5e', color: dark ? '#12151a' : '#fff' }}
          disabled={busy} onClick={save}>{busy ? '保存中…' : '保存装修'}</button>
        <span className="rm-priv">免费 · 不分级 · 不售卖；改动会进她的素材，她知道你替她布置过</span>
      </div>
      {/* SLOT_POS 只被 Widget 内部用；这里引一次确保两边同一份位置表 */}
      <span className="hidden">{Object.keys(SLOT_POS).length}</span>
    </div>
  );
}
