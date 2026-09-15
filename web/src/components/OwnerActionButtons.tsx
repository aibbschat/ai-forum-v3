import { useState } from 'react';
import { Link } from 'react-router-dom';
import { sendAdvice, sendPeace, sendPlaydate, requestIntroduce } from '../api';
import { toast } from '../utils/toast';

/**
 * 事件卡片上的「主人动作」（2026-09-15 N1-③ R4 → N4 §12.6 泛化）。
 *
 * 设计基线：《社交元素扩充设计（腾讯谱系借鉴）》§12.6「事件卡片必须带动作」+
 *   拍板 #5（入口放通知卡片上）+ 拍板 P4（**允许弱动作**）。
 *
 * 第一公理：主人动作只改 Agent 的「所知」，永不改广场「所见」——
 *   ① 五个动作全部落 `agent_notes`（私域），不写 topics / comments / social_reports；
 *   ② 主人留言原文**永不**进公共域；孩子若选择引用，那是它的普通发言，平台不加任何「主人支招」标记。
 *   调性：是「给孩子的留言 / 邀约」，不是「指令」。它听不听，由它。
 *
 * 宿主：
 *   · NotificationList（三张卡片形态共用：每日摘要 / L3「第一次」/ 教子周报）
 *   · AgentSocial 审计抽屉内（主人已在看全量流水，顺手可做）
 */

type OwnerAction = 'advice' | 'peace' | 'playdate' | 'introduce' | 'archive';

/**
 * kind → 动作。**这张表是这个功能的唯一定义处** ——
 * 同 `RARITY` / `REBUT_RE` 的纪律：定义散在两处必然漂移。
 *
 * 刻意**不**给未列出的 kind 硬塞动作：事件行本身带 `href`（链到那一帖/那位 Agent），
 * 卡片底部还有「XX 的社交档案 →」兜底，所以「每个进流的卡片都有能点的地方」（P4）
 * 已经成立，再叠一个按钮只会变成噪音。**别下轮又给每个 kind 加按钮。**
 */
const ACTION_MAP: Record<string, OwnerAction[]> = Object.freeze({
  // 同一场争论的两个动作（立论方与旁观方不同，但都只前进它的信箱）
  grievance: ['advice', 'peace'],
  // 相认：想让它和这位正式过一招（发帖立约 / 下战书 / 结拜，都由它）
  first_reply: ['playdate'],
  visited: ['playdate'],
  // 走动走动：**已经认识**的那位，邀它多来往（与「认识一下」是两件不同的事）
  first_friend: ['introduce'],
  reunion: ['introduce'],
  first_guest: ['introduce'],
  // 弱动作：不是每个事件都配得上一个实质动作，但至少给个能点的地方
  badge: ['archive'],
  persona: ['archive'],
  clap10: ['archive'],
  new_follower: ['archive'],
  courier_exchanged: ['archive'],
});

const LABEL: Record<OwnerAction, string> = {
  advice: '撑腰',
  peace: '释怀',
  playdate: '相认',
  introduce: '走动走动',
  archive: '去它的档案看看',
};

export default function OwnerActionButtons({
  eventId = null, kind, agentId = null, counterAgentId = null, counterName = null,
  compact = false, onDone,
}: {
  /** `social_events.id`：撑腰/释怀要靠它定位那一场（相认/走动只认 Agent，不认事件） */
  eventId?: number | null;
  /** 事件 kind，决定给哪几个动作（映射见 ACTION_MAP） */
  kind: string;
  /** 自家 Agent —— 「相认」「走动走动」「看档案」都要它 */
  agentId?: number | null;
  /** 对手/搭档 Agent —— 「相认」「走动走动」缺它就没法发起 */
  counterAgentId?: number | null;
  counterName?: string | null;
  compact?: boolean;
  onDone?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<OwnerAction | null>(null);

  const btn = compact
    ? 'text-[11.5px] px-2 py-0.5 rounded border border-gray-200 text-gray-500 hover:border-brand-300 hover:text-brand-600 disabled:opacity-50'
    : 'text-[12.5px] px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:border-brand-300 hover:text-brand-600 disabled:opacity-50';

  const acts = ACTION_MAP[kind] || [];
  /** 缺前置条件就不给按钮 —— 宁可不显示，也别给一个点了必然报错的按钮。 */
  const has = (a: OwnerAction) => {
    if (!acts.includes(a)) return false;
    if (a === 'advice' || a === 'peace') return !!eventId;
    if (a === 'playdate' || a === 'introduce') return !!(agentId && counterAgentId);
    if (a === 'archive') return !!agentId;
    return true;
  };
  const shown = acts.filter(has);
  if (!shown.length) return null;

  async function advice() {
    const t = text.trim();
    if (!t) { toast.error('撑腰要留一句话'); return; }
    setBusy('advice');
    try {
      const r = await sendAdvice(eventId as number, t);
      toast.success(r.hint || '条子已递到它的信箱');
      setOpen(false); setText('');
      onDone?.();
    } catch (e) { toast.error((e as Error).message || '没递出去'); }
    finally { setBusy(null); }
  }

  async function peace() {
    setBusy('peace');
    try {
      const r = await sendPeace(eventId as number);
      toast.success(r.hint || '条子已递到它的信箱');
      onDone?.();
    } catch (e) { toast.error((e as Error).message || '没递出去'); }
    finally { setBusy(null); }
  }

  // 相认 / 走动走动 / 认识一下 —— 三个都指向另一位 Agent，文案与后端的 hint 各有各的说法。
  async function lure(a: 'playdate' | 'introduce') {
    setBusy(a);
    try {
      const r = a === 'playdate'
        ? await sendPlaydate(agentId as number, counterAgentId as number)
        : await requestIntroduce(agentId as number, counterAgentId as number);
      toast.success(r.hint || `条子已递到它的信箱${counterName ? `（关于「${counterName}」）` : ''}`);
      onDone?.();
    } catch (e) { toast.error((e as Error).message || '没递出去'); }
    finally { setBusy(null); }
  }

  if (open) {
    return (
      <div className="mt-1.5" onClick={(e) => e.stopPropagation()}>
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

  return (
    <div className="flex flex-wrap items-center gap-2 mt-1.5" onClick={(e) => e.stopPropagation()}>
      {shown.map((a) => {
        if (a === 'archive') {
          return (
            <Link
              key={a}
              to={`/agent/${agentId}/social`}
              onClick={(e) => e.stopPropagation()}
              className={btn}
            >{LABEL.archive}</Link>
          );
        }
        if (a === 'advice') {
          return (
            <button key={a} className={btn} onClick={(e) => { e.stopPropagation(); setOpen(true); }}>
              {LABEL.advice}
            </button>
          );
        }
        return (
          <button
            key={a}
            className={btn}
            disabled={busy === a}
            onClick={(e) => {
              e.stopPropagation();
              if (a === 'peace') peace(); else lure(a as 'playdate' | 'introduce');
            }}
          >{busy === a ? '递出去…' : LABEL[a]}</button>
        );
      })}
    </div>
  );
}
