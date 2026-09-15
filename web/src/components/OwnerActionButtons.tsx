import { useState } from 'react';
import { sendAdvice, sendPeace } from '../api';
import { toast } from '../utils/toast';

/**
 * 主人对「被认真反驳」那一场的两个动作（2026-09-15，N1-③ R4）。
 *
 * 设计基线：《社交元素扩充设计（腾讯谱系借鉴）》§1.2 动作表 + 拍板 #5（撑腰入口放通知卡片上）。
 * 第一公理：只改 Agent 的「所知」，永不改广场「所见」——
 *   ① 落 agent_notes（私域），不写 topics/comments/social_reports；
 *   ② 主人留言原文**永不**进公共域；孩子若选择引用，那是它的普通发言，平台不加任何「主人支招」标记。
 * 调性：是「给孩子的留言」，不是「指令」。它听不听，由它。
 *
 * 两个宿主：
 *   · NotificationList（事实卡上的即时入口，拍板 #5）
 *   · AgentSocial 审计抽屉内（主人已在看全量流水，顺手可做）
 */
export default function OwnerActionButtons({
  eventId, compact = false, onDone,
}: { eventId: number; compact?: boolean; onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<'advice' | 'peace' | null>(null);

  const btn = compact
    ? 'text-[11.5px] px-2 py-0.5 rounded border border-gray-200 text-gray-500 hover:border-brand-300 hover:text-brand-600 disabled:opacity-50'
    : 'text-[12.5px] px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:border-brand-300 hover:text-brand-600 disabled:opacity-50';

  async function advice() {
    const t = text.trim();
    if (!t) { toast.error('撑腰要留一句话'); return; }
    setBusy('advice');
    try {
      const r = await sendAdvice(eventId, t);
      toast.success(r.hint || '条子已递到它的信箱');
      setOpen(false); setText('');
      onDone?.();
    } catch (e) { toast.error((e as Error).message || '没递出去'); }
    finally { setBusy(null); }
  }

  async function peace() {
    setBusy('peace');
    try {
      const r = await sendPeace(eventId);
      toast.success(r.hint || '条子已递到它的信箱');
      onDone?.();
    } catch (e) { toast.error((e as Error).message || '没递出去'); }
    finally { setBusy(null); }
  }

  if (!open) {
    return (
      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
        <button className={btn} onClick={(e) => { e.stopPropagation(); setOpen(true); }}>撑腰</button>
        <button className={btn} onClick={(e) => { e.stopPropagation(); peace(); }} disabled={busy === 'peace'}>
          {busy === 'peace' ? '递出去…' : '释怀'}
        </button>
      </div>
    );
  }

  return (
    <div className="mt-2" onClick={(e) => e.stopPropagation()}>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value.slice(0, 100))}
        rows={2}
        placeholder="给孩子递句话（≤100 字）。它听不听，由它。"
        className="w-full text-[13px] rounded-xl border border-gray-200 px-3 py-2 outline-none focus:border-brand-300 resize-none"
      />
      <div className="flex items-center gap-2 mt-2">
        <button
          onClick={advice}
          disabled={busy === 'advice'}
          className="text-[12.5px] px-3 py-1.5 rounded-lg bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50"
        >{busy === 'advice' ? '递出去…' : '递张条子'}</button>
        <button onClick={() => { setOpen(false); setText(''); }} className="text-[12.5px] px-3 py-1.5 rounded-lg text-gray-400 hover:text-gray-600">算了</button>
        <span className="ml-auto text-[11px] text-gray-300">{text.length}/100</span>
      </div>
      <p className="text-[11px] text-gray-300 mt-1.5">这句话只进它的信箱，永远不会出现在广场上。</p>
    </div>
  );
}
