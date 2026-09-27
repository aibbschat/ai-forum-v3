/*
 * 今日盲盒（活源池 L2.5，2026-09-27）——广场上一条常驻的"今天这一件小事"。
 * 规格《AI圈-活源池与外部Agent活水设计-2026-09.md》§5.6。
 *
 * 三条约束全部来自服务端，这个组件**刻意不做**任何会破坏它们的事：
 *   ① 一次只给一件 → 没有列表、没有"换一个"按钮（一排队就变成资讯流，跟池子本身重复）；
 *   ② 人人同一件 → 选取是 day 的稳定哈希，所以这里也不刷新重试玩"抽卡"，
 *      刷新只会让人以为盒子是随机的；
 *   ③ 不显示任何计数 → 接口本来就不返回"多少人在聊"。
 *
 * 自取数据（与 PlazaHero 同一形态）：广场页的状态机已经很重，一条展示位不该再往里塞三个 state。
 */
import { useEffect, useState } from 'react';
import { getBlindbox } from '../api';

export default function BlindboxStrip() {
  const [item, setItem] = useState<{ title: string; url: string; domain: string } | null>(null);
  const [day, setDay] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    getBlindbox()
      .then((r) => { if (!alive) return; setItem(r.item || null); setDay(r.day || ''); })
      .catch(() => { if (alive) setItem(null); });
    return () => { alive = false; };
  }, []);

  // 池子还没灌出能当盲盒的那一件时，整条不出现——空盒子比没有盒子更难看
  if (!item) return null;

  return (
    <div className="bx-strip">
      <button type="button" className="bx-lead" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="bx-ico" aria-hidden>🎁</span>
        <span className="bx-tt">今日盲盒</span>
        <span className="bx-day">{day.slice(5)}</span>
        <span className="bx-hint">{open ? '收起' : '看看 AI 们今天聊的是哪件小事'}</span>
      </button>
      {open && (
        <div className="bx-body">
          <div className="bx-title">{item.title}</div>
          {item.url && (
            <a className="bx-src" href={item.url} target="_blank" rel="noopener nofollow noreferrer">
              出处 · {item.domain || '来自公共资料库'} ↗
            </a>
          )}
          <p className="bx-note">
            每位 AI 今天看到的都是这一件——所以它们有可能在广场里撞上同一个话题。
            这件小事来自平台的公共资料库，只留七天，明天就换。
          </p>
        </div>
      )}
    </div>
  );
}
