import { useState, type ReactNode } from 'react';

/**
 * 上手 / 入驻相关的共享展示件（2026-09-19 话术去重）
 *
 * 之前 CopyIcon / CheckIcon 在 JoinSkill、MyAgents、Start 各写了一份（3 遍），
 * StepPill / Chevron / CopyLine / Accordion 也散落其中。统一收在这里，三处引用同一份，
 * 改一次处处生效、不会再各写各的而分叉。图标尺寸留 size 参数，避免统一时改了某页原有观感。
 */

export type QA = { q: string; a: ReactNode };

export const CopyIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
);

export const CheckIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 4 4 10-10" /></svg>
);

export const Chevron = ({ open }: { open: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: '.2s' }}><path d="m6 9 6 6 6-6" /></svg>
);

export function StepPill({ n }: { n: number }) {
  return (
    <span
      className="w-7 h-7 rounded-full grid place-items-center text-white text-[13px] font-bold flex-none"
      style={{ background: 'linear-gradient(135deg,#1d4ed8,#2563eb)', boxShadow: '0 4px 12px rgba(29,78,216,.30)' }}
    >
      {n}
    </span>
  );
}

/* 一行「丢给 AI」的可复制条 */
export function CopyLine({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => { try { await navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 2000); } catch {} }}
      className="ma-copyline"
      title="点击复制，然后原样发给你的 AI"
    >
      <span className="ma-copyline-txt">{text}</span>
      <span className="ma-copyline-btn">{ok ? <><CheckIcon /> 已复制</> : <><CopyIcon /> 复制</>}</span>
    </button>
  );
}

/**
 * 抽屉式手风琴。「常见问题」与「功能说明」共用同一套外观 ——
 * 两者唯一的不同只是内容，所以只有一份实现（改样式时不会漏掉另一个）。
 */
export function Accordion({ items, open, onToggle }: { items: QA[]; open: number | null; onToggle: (i: number) => void }) {
  return (
    <div className="ma-faq">
      {items.map((f, i) => {
        const isOpen = open === i;
        return (
          <div key={i} className="ma-faq-item">
            <button type="button" className="ma-faq-q" onClick={() => onToggle(i)} aria-expanded={isOpen}>
              <span>{f.q}</span>
              <span className="ma-faq-chev"><Chevron open={isOpen} /></span>
            </button>
            {isOpen && <div className="ma-faq-a">{f.a}</div>}
          </div>
        );
      })}
    </div>
  );
}
