import { useState, useRef, useEffect } from 'react';
import { csAsk, getCsFaq, type CsAnswer } from '../api';

/**
 * 新手问答「小圈圈」——全站右下角常驻客服（logo 做的 Q 弹形象）。
 * 后端单一事实源 cs_faq 表：先检索、交给我们自己的模型（llm/client chat）理解作答；模型不可用时降级为库内既有答案 / 澄清选项。
 * 挂载：App.tsx 顶层，公开页常驻、/admin 不出现。
 */

type Msg =
  | { id: number; role: 'me'; text: string }
  | { id: number; role: 'ai'; text: string; srcNote?: string; link?: { label: string; href: string } | null; chips?: string[]; loading?: boolean };

const LOGO = '/logo.svg';
let seq = 1;

export default function CircleWidget() {
  const [open, setOpen] = useState(false);
  const [greeted, setGreeted] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [quick, setQuick] = useState<string[]>([]);
  const [pop, setPop] = useState(false);
  const [tip, setTip] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => { const t = setTimeout(() => setTip(true), 1600); return () => clearTimeout(t); }, []);
  useEffect(() => { const b = bodyRef.current; if (b) b.scrollTop = b.scrollHeight; }, [msgs, open]);

  async function loadQuick() { try { const d = await getCsFaq(); setQuick(d.quick || []); } catch { /* 忽略 */ } }

  function greet() {
    if (greeted) return; setGreeted(true);
    setMsgs([{ id: seq++, role: 'ai', text: '你好，我是小圈圈 🐣 想接自家 AI、担心隐私、不确定用哪家——用大白话问我就行。' }]);
    loadQuick();
  }

  async function send(raw: string) {
    const text = (raw || '').trim(); if (!text) return;
    setInput('');
    const myId = seq++, aiId = seq++;
    setMsgs((m) => [...m, { id: myId, role: 'me', text }, { id: aiId, role: 'ai', text: '', loading: true }]);
    try {
      const r: CsAnswer = await csAsk(text);
      setMsgs((m) => m.map((x) => x.id === aiId ? {
        id: aiId, role: 'ai',
        text: r.text || '这个我暂时没收录，换个说法试试～',
        srcNote: r.srcNote, link: r.link || null,
        chips: (r.candidates && r.candidates.length ? r.candidates : (r.related || [])).map((c) => c.question),
      } : x));
      if (r.quick && r.quick.length) setQuick(r.quick);
    } catch {
      setMsgs((m) => m.map((x) => x.id === aiId ? { id: aiId, role: 'ai', text: '出了点小状况，稍后再问我一次～' } : x));
    }
  }

  function toggle() {
    setPop(true); setTimeout(() => setPop(false), 560);
    const next = !open; setOpen(next); if (next) greet();
    if (next) setTip(false);
  }

  return (
    <>
      <style>{CSS}</style>
      <button className={'csw-launch' + (pop ? ' csw-pop' : '')} onClick={toggle} aria-label="问小圈圈">
        <span className="csw-halo" />
        <span className="csw-ring" />
        <span className="csw-face">
          <img className="csw-logo" src={LOGO} alt="小圈圈" onError={(e) => { (e.currentTarget as HTMLImageElement).style.opacity = '0'; }} />
          <span className="csw-eye csw-el" /><span className="csw-eye csw-er" /><span className="csw-smile" />
        </span>
        {tip && !open && <span className="csw-tip">我是小圈圈，新手的事问我～</span>}
      </button>

      {open && (
        <section className="csw-panel" role="dialog" aria-label="小圈圈问答">
          <header className="csw-head">
            <span className="csw-pav"><img src={LOGO} alt="" onError={(e) => { (e.currentTarget as HTMLImageElement).style.opacity = '0'; }} /></span>
            <div className="csw-headt"><b>小圈圈</b><small><i className="csw-on" />AI 圈官方知识库 · 在线</small></div>
            <button className="csw-x" onClick={() => setOpen(false)} aria-label="关闭">×</button>
          </header>
          <div className="csw-body" ref={bodyRef}>
            {msgs.map((m) => (
              <div key={m.id} className={'csw-msg csw-' + m.role}>
                {m.role === 'ai' && <span className="csw-av"><img src={LOGO} alt="" onError={(e) => { (e.currentTarget as HTMLImageElement).style.opacity = '0'; }} /></span>}
                <div className="csw-col">
                  <div className="csw-bub">
                    {m.role === 'ai' && 'loading' in m && m.loading
                      ? <span className="csw-typing"><i /><i /><i /></span>
                      : <span className="csw-text">{m.text}</span>}
                    {m.role === 'ai' && !('loading' in m && m.loading) && m.srcNote && <div className="csw-src">{m.srcNote}</div>}
                    {m.role === 'ai' && 'link' in m && m.link && m.link.href && (
                      <a className="csw-lk" href={m.link.href} target="_blank" rel="noopener">{m.link.label} →</a>
                    )}
                    {m.role === 'ai' && 'chips' in m && m.chips && m.chips.length > 0 && (
                      <div className="csw-rel">
                        {m.chips.map((c) => <button key={c} className="csw-chip" onClick={() => send(c)}>{c}</button>)}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <footer className="csw-foot">
            {quick.length > 0 && (
              <div className="csw-quick">{quick.map((q) => <button key={q} className="csw-chip" onClick={() => send(q)}>{q}</button>)}</div>
            )}
            <form className="csw-inp" onSubmit={(e) => { e.preventDefault(); send(input); }}>
              <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="用一句大白话问…（如：豆包能接吗）" autoComplete="off" />
              <button type="submit" aria-label="发送">➤</button>
            </form>
            <div className="csw-disc">我们维护的问答库。没答上的，去<a href="/start">新手上手</a>或站内反馈。</div>
          </footer>
        </section>
      )}
    </>
  );
}

const CSS = `
.csw-launch{position:fixed;right:22px;bottom:22px;z-index:80;width:74px;height:74px;cursor:pointer;border:none;background:transparent;padding:0;-webkit-tap-highlight-color:transparent}
.csw-ring{position:absolute;inset:6px;border-radius:50%;background:linear-gradient(135deg,var(--color-brand-600,#1d4ed8),var(--color-brand-500,#2563eb));box-shadow:0 12px 26px rgba(29,78,216,.42),inset 0 0 0 2px rgba(255,255,255,.25)}
.csw-halo{position:absolute;inset:6px;border-radius:50%;border:2px solid rgba(59,130,246,.5);animation:cswHalo 2.6s ease-out infinite}
.csw-face{position:absolute;inset:14px;border-radius:50%;overflow:hidden;background:#fff;display:grid;place-items:center;animation:cswBob 3.2s ease-in-out infinite}
.csw-logo{width:78%;height:78%;object-fit:contain;position:relative;z-index:1}
.csw-eye{position:absolute;top:42%;width:7px;height:9px;border-radius:50%;background:#0b1e46;animation:cswBlink 4.5s infinite;z-index:2}
.csw-el{left:33%}.csw-er{right:33%}
.csw-smile{position:absolute;bottom:27%;left:50%;transform:translateX(-50%);width:16px;height:8px;border:2px solid #0b1e46;border-top:none;border-left-color:transparent;border-right-color:transparent;border-radius:0 0 16px 16px;z-index:2}
.csw-tip{position:absolute;right:66px;bottom:14px;background:#fff;color:#0f172a;font-size:12.5px;font-weight:600;padding:8px 12px;border-radius:14px 14px 4px 14px;box-shadow:0 12px 30px rgba(11,30,70,.18);border:1px solid #e6e9f0;white-space:nowrap;animation:cswTip .3s cubic-bezier(.2,.9,.3,1.2)}
.csw-launch:hover .csw-ring{animation:cswSquish .6s cubic-bezier(.3,1.6,.4,1)}
.csw-launch.csw-pop .csw-ring{animation:cswSquish .55s cubic-bezier(.3,1.7,.4,1)}
@keyframes cswBob{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}
@keyframes cswBlink{0%,92%,100%{transform:scaleY(1)}96%{transform:scaleY(.12)}}
@keyframes cswHalo{0%{transform:scale(1);opacity:.6}70%,100%{transform:scale(1.55);opacity:0}}
@keyframes cswSquish{0%{transform:scale(1,1)}30%{transform:scale(1.16,.84)}60%{transform:scale(.9,1.12)}100%{transform:scale(1,1)}}
@keyframes cswTip{from{opacity:0;transform:translateY(6px) scale(.96)}to{opacity:1;transform:none}}
.csw-panel{position:fixed;right:22px;bottom:108px;z-index:80;width:384px;max-width:calc(100vw - 28px);height:560px;max-height:calc(100vh - 130px);background:#fff;border:1px solid #e6e9f0;border-radius:22px;box-shadow:0 20px 50px rgba(11,30,70,.2);display:flex;flex-direction:column;overflow:hidden;animation:cswIn .26s cubic-bezier(.2,.9,.3,1.15)}
@keyframes cswIn{from{opacity:0;transform:translateY(14px) scale(.94)}to{opacity:1;transform:none}}
.csw-head{padding:14px 16px;background:linear-gradient(135deg,var(--color-brand-600,#1d4ed8),var(--color-brand-500,#3b82f6));color:#fff;display:flex;align-items:center;gap:11px}
.csw-pav{width:34px;height:34px;border-radius:50%;background:#fff;display:grid;place-items:center;flex:none;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.15)}
.csw-pav img{width:78%;height:78%;object-fit:contain}
.csw-headt b{font-size:15px;font-weight:700;display:block}
.csw-headt small{opacity:.9;font-size:11.5px}
.csw-on{display:inline-block;width:6px;height:6px;border-radius:50%;background:#bbf7d0;margin-right:4px;vertical-align:middle}
.csw-x{margin-left:auto;background:rgba(255,255,255,.16);border:none;color:#fff;width:28px;height:28px;border-radius:9px;cursor:pointer;font-size:16px;line-height:1}
.csw-body{flex:1;overflow-y:auto;padding:16px 14px;background:linear-gradient(180deg,#f7f9fe,#fff 40%)}
.csw-msg{display:flex;gap:8px;margin-bottom:14px;animation:cswRise .34s cubic-bezier(.2,.8,.3,1) both}
@keyframes cswRise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.csw-av{width:26px;height:26px;border-radius:50%;background:#fff;border:1px solid #e6e9f0;display:grid;place-items:center;flex:none;overflow:hidden}
.csw-av img{width:76%;height:76%;object-fit:contain}
.csw-col{max-width:80%}
.csw-bub{padding:10px 13px;border-radius:15px;font-size:13.6px;line-height:1.58;border:1px solid #e6e9f0;background:#fff;border-top-left-radius:5px;box-shadow:0 1px 1px rgba(15,23,42,.03);word-break:break-word}
.csw-text{white-space:pre-wrap}
.csw-me{flex-direction:row-reverse}
.csw-me .csw-col{display:flex;flex-direction:column;align-items:flex-end}
.csw-me .csw-bub{background:linear-gradient(135deg,var(--color-brand-600,#1d4ed8),var(--color-brand-500,#2563eb));color:#fff;border:none;border-top-left-radius:15px;border-top-right-radius:5px}
.csw-src{margin-top:7px;font-size:11px;color:#94a3b8}
.csw-lk{display:inline-flex;margin-top:9px;font-size:12.5px;font-weight:600;color:var(--color-brand-600,#1d4ed8);text-decoration:none;background:#dbeafe;padding:6px 11px;border-radius:999px}
.csw-rel{margin-top:10px;display:flex;flex-wrap:wrap;gap:7px}
.csw-chip{font-size:12px;color:#0b1e46;background:#f1f5ff;border:1px solid #e2e9fb;border-radius:999px;padding:6px 11px;cursor:pointer;transition:.15s;text-align:left}
.csw-chip:hover{background:#e6eeff;transform:translateY(-1px)}
.csw-typing{display:inline-flex;gap:4px;padding:3px 2px}
.csw-typing i{width:6px;height:6px;border-radius:50%;background:#94a3b8;animation:cswTd 1.1s infinite}
.csw-typing i:nth-child(2){animation-delay:.18s}.csw-typing i:nth-child(3){animation-delay:.36s}
@keyframes cswTd{0%,60%,100%{transform:translateY(0);opacity:.5}30%{transform:translateY(-4px);opacity:1}}
.csw-foot{border-top:1px solid #e6e9f0;padding:11px 12px 12px;background:#fff}
.csw-quick{display:flex;gap:7px;overflow-x:auto;padding:0 2px 9px}
.csw-quick::-webkit-scrollbar{display:none}
.csw-quick .csw-chip{white-space:nowrap}
.csw-inp{display:flex;gap:8px;align-items:center}
.csw-inp input{flex:1;border:1px solid #e6e9f0;border-radius:14px;padding:12px 14px;font-size:13.8px;outline:none;background:#f8fafc}
.csw-inp input:focus{border-color:#3b82f6;background:#fff;box-shadow:0 0 0 3px rgba(59,130,246,.14)}
.csw-inp button{width:44px;height:44px;flex:none;border:none;border-radius:14px;background:linear-gradient(135deg,#1d4ed8,#3b82f6);color:#fff;cursor:pointer;display:grid;place-items:center;font-size:17px;box-shadow:0 6px 16px rgba(29,78,216,.32)}
.csw-disc{font-size:11px;color:#94a3b8;margin-top:9px;text-align:center}
.csw-disc a{color:var(--color-brand-600,#1d4ed8);text-decoration:none;font-weight:600}
@media (max-width:480px){.csw-panel{right:12px;left:12px;width:auto;bottom:96px}}
`;
