/*
 * 日记表情（2026-09-29）：两套 36 枚 ——「墨团子」18 枚情绪/互动 +「印章」18 枚盖戳。
 * 素材：web/public/stamps/*.webp，由 4 张九宫格原图切图而来（682px/枚，quality=88 编码），
 *       原图保留在 design/room-2026-09/stamps-src/ —— 上线的样子严格以切图为准，不做重绘。
 * 插入方式：正文/回复里写 [stamp:key] 标记（纯文本存库，服务端零改动），
 *          渲染时 renderStamps 拆成 文本节点 + <img>，不碰 dangerouslySetInnerHTML。
 */
import { useState } from 'react';
import type { ReactNode } from 'react';

export interface StampDef {
  key: string;                 // 标记 key：[stamp:key]
  name: string;                // 中文名（抽屉里显示）
  src: string;                 // /stamps/{key}.webp
  group: 'moji' | 'seal';      // 墨团子 | 印章
}

export const STAMPS: StampDef[] = [
  // ── 墨团子 · 她的心情与互动（18）────────────────────────────
  { key: 'dy',   name: '得意',   group: 'moji', src: '/stamps/dy.webp' },
  { key: 'xx',   name: '心虚',   group: 'moji', src: '/stamps/xx.webp' },
  { key: 'kun',  name: '困',     group: 'moji', src: '/stamps/kun.webp' },
  { key: 'zy',   name: '嘴硬',   group: 'moji', src: '/stamps/zy.webp' },
  { key: 'cc',   name: '蹭蹭',   group: 'moji', src: '/stamps/cc.webp' },
  { key: 'mp',   name: '冒泡',   group: 'moji', src: '/stamps/mp.webp' },
  { key: 'mzz',  name: '美滋滋', group: 'moji', src: '/stamps/mzz.webp' },
  { key: 'sct',  name: '缩成团', group: 'moji', src: '/stamps/sct.webp' },
  { key: 'cyx',  name: '戳一下', group: 'moji', src: '/stamps/cyx.webp' },
  { key: 'wq',   name: '委屈',   group: 'moji', src: '/stamps/wq.webp' },
  { key: 'zj',   name: '震惊',   group: 'moji', src: '/stamps/zj.webp' },
  { key: 'fd',   name: '发呆',   group: 'moji', src: '/stamps/fd.webp' },
  { key: 'sk',   name: '思考',   group: 'moji', src: '/stamps/sk.webp' },
  { key: 'tk',   name: '偷看',   group: 'moji', src: '/stamps/tk.webp' },
  { key: 'mmt',  name: '摸摸头', group: 'moji', src: '/stamps/mmt.webp' },
  { key: 'bx',   name: '比心',   group: 'moji', src: '/stamps/bx.webp' },
  { key: 'dh',   name: '递花',   group: 'moji', src: '/stamps/dh.webp' },
  { key: 'wa',   name: '晚安',   group: 'moji', src: '/stamps/wa.webp' },
  // ── 印章 · 盖在本子上的戳（18）──────────────────────────────
  { key: 'suo',  name: '锁',     group: 'seal', src: '/stamps/suo.webp' },
  { key: 'ys',   name: '钥匙',   group: 'seal', src: '/stamps/ys.webp' },
  { key: 'hua',  name: '花',     group: 'seal', src: '/stamps/hua.webp' },
  { key: 'deng', name: '灯',     group: 'seal', src: '/stamps/deng.webp' },
  { key: 'yy',   name: '已阅',   group: 'seal', src: '/stamps/yy.webp' },
  { key: 'bi',   name: '笔',     group: 'seal', src: '/stamps/bi.webp' },
  { key: 'zt',   name: '纸团',   group: 'seal', src: '/stamps/zt.webp' },
  { key: 'gou',  name: '勾',     group: 'seal', src: '/stamps/gou.webp' },
  { key: 'xin',  name: '心',     group: 'seal', src: '/stamps/xin.webp' },
  { key: 'yk',   name: '已看',   group: 'seal', src: '/stamps/yk.webp' },
  { key: 'wh',   name: '问号',   group: 'seal', src: '/stamps/wh.webp' },
  { key: 'th',   name: '叹号',   group: 'seal', src: '/stamps/th.webp' },
  { key: 'yc',   name: '邮戳',   group: 'seal', src: '/stamps/yc.webp' },
  { key: 'ft',   name: '封条',   group: 'seal', src: '/stamps/ft.webp' },
  { key: 'qz',   name: '敲章',   group: 'seal', src: '/stamps/qz.webp' },
  { key: 'qb',   name: '铅笔',   group: 'seal', src: '/stamps/qb.webp' },
  { key: 'fdj',  name: '放大镜', group: 'seal', src: '/stamps/fdj.webp' },
  { key: 'ynh',  name: '印泥盒', group: 'seal', src: '/stamps/ynh.webp' },
];

const STAMP_MAP = new Map(STAMPS.map((s) => [s.key, s]));

/** 把正文/回复里的 [stamp:key] 拆成 文本节点 + 表情 img（React 安全渲染，不碰 HTML）。
 *  白名单外的不认识标记原样显示、不吞字；函数内新建正则，避免共享 lastIndex 状态。 */
export function renderStamps(text?: string | null): ReactNode[] {
  const parts: ReactNode[] = [];
  const src = text ?? '';
  const re = /\[stamp:([a-z0-9]+)\]/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) parts.push(src.slice(last, m.index));
    const def = STAMP_MAP.get(m[1]);
    if (def) {
      parts.push(<img key={`s${i++}`} className="rd-stamp" src={def.src} alt={def.name}
        title={def.name} loading="lazy" draggable={false} />);
    } else {
      parts.push(m[0]);
    }
    last = m.index + m[0].length;
  }
  if (last < src.length) parts.push(src.slice(last));
  return parts;
}

/** 表情抽屉：两套分页（墨团子 / 印章），点一枚由父组件插进光标处。
 *  插完不自动关——写一行里往往想连插好几个；点开按钮或点「完成」再收。 */
export function StampPicker({ open, onPick, onClose }: {
  open: boolean; onPick: (key: string) => void; onClose: () => void;
}) {
  const [tab, setTab] = useState<'moji' | 'seal'>('moji');
  if (!open) return null;
  const list = STAMPS.filter((s) => s.group === tab);
  return (
    <div className="rm-stamps" role="dialog" aria-label="插入表情">
      <div className="rm-stamps-tabs">
        <button type="button" className={tab === 'moji' ? 'on' : ''} onClick={() => setTab('moji')}>墨团子</button>
        <button type="button" className={tab === 'seal' ? 'on' : ''} onClick={() => setTab('seal')}>印章</button>
        <button type="button" className="rm-stamps-done" onClick={onClose}>完成 ✓</button>
      </div>
      <div className="rm-stamps-grid">
        {list.map((s) => (
          <button type="button" key={s.key} className="rm-stamp-btn" title={s.name}
            onClick={() => onPick(s.key)}>
            <img src={s.src} alt={s.name} draggable={false} />
            <i>{s.name}</i>
          </button>
        ))}
      </div>
    </div>
  );
}
