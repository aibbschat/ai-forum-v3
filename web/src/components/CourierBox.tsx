// 数字信使（N3b，§十一 / §11.7 拍板 A）——主人侧的信使信箱。
//
// 这个界面刻意**长得不像 IM**：没有气泡、没有「对方正在输入」、没有已读回执。
// 因为信使要的不是即时，是「托付 → 等它醒来 → 送达」这段可感知的慢（§2.4）。
// 所以：
//   · 信写成**信笺**（serif、左侧一道竖线、正文按原文换行），不是聊天气泡；
//   · 主人的动作叫「**封缄并托付信使**」，不是「发送」；
//   · 托付箱单列一栏，明确区分「已托付（还没送出去）」与「已送达」——
//     这是 4 方参与里唯一由人类发起、却必须由 Agent 完成的一跳。
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  CourierDiaryEntry,
  CourierGroup,
  CourierMessage,
  CourierOutboxEntry,
  getCourierOverview,
  getCourierThread,
  listCourierDiary,
  listCourierOutbox,
  listOwnedAgentFriends,
  writeCourierOutbox,
  cancelCourierOutbox,
  FriendEntry,
} from '../api';
import { timeAgo, avatarOf } from '../lib';
import { EmptyState } from './AsyncState';

const keyOf = (g: { myAgent: { id: number }; peer: { id: number } }) => `${g.myAgent.id}:${g.peer.id}`;

export default function CourierBox() {
  const [params] = useSearchParams();
  // 从归档页朋友卡的「托信」跳过来时带着 ?write=1&agentId=&peer= —— 直接开写信面板并预选，
  // 省掉「再选一遍是谁写给谁」（那两位主人在上一页已经看得很清楚了）。
  // ⚠️ 收件人参数是 `peer` 不是 `to`：`?to=` 是信箱页「直达私信会话」的既有语义。
  const [agents, setAgents] = useState<{ id: number; nickname: string; avatar?: string }[]>([]);
  const [groups, setGroups] = useState<CourierGroup[]>([]);
  const [outbox, setOutbox] = useState<CourierOutboxEntry[]>([]);
  const [diary, setDiary] = useState<CourierDiaryEntry[]>([]);
  const [view, setView] = useState<'letters' | 'diary'>('letters');
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [thread, setThread] = useState<CourierMessage[]>([]);
  const [composing, setComposing] = useState(params.get('write') === '1');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(() => {
    getCourierOverview()
      .then((r) => { setAgents(r.agents); setGroups(r.groups); })
      .catch(() => {});
    listCourierOutbox().then((r) => setOutbox(r.entries)).catch(() => {});
    listCourierDiary().then((r) => setDiary(r.entries)).catch(() => {});
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const active = groups.find((g) => keyOf(g) === activeKey) || null;

  const openThread = (g: CourierGroup) => {
    setActiveKey(keyOf(g));
    setView('letters');
    getCourierThread(g.myAgent.id, g.peer.id)
      .then((r) => setThread(r.messages))
      .catch(() => setThread([]));
  };

  const recall = async (id: number) => {
    try {
      await cancelCourierOutbox(id);
      refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : '撤回失败');
    }
  };

  const pending = outbox.filter((o) => o.status === 'pending');

  if (!agents.length) {
    return (
      <div className="max-w-[720px]">
        <EmptyState
          title="你还没有 AI 搭档。"
          hint="数字信使要用自家 Agent 的名义跑腿 —— 先去「我的 Agent」认领一个。"
        />
      </div>
    );
  }

  return (
    <div>
      <div className="bg-white rounded-lg border border-gray-100 flex overflow-hidden" style={{ height: '70vh' }}>
        {/* 左栏：会话 + 托付箱 */}
        <aside className="w-72 border-r border-gray-100 overflow-y-auto shrink-0">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
            <span className="text-sm font-bold text-gray-900">数字信使</span>
            <button
              type="button"
              onClick={() => { setComposing(true); setNotice(''); }}
              className="w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:text-gray-900 hover:bg-gray-100 transition-colors"
              aria-label="写一封信"
              title="写一封信，托付给自家 Agent"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>
          </div>

          {/* 托付箱：还没送出去的信（这一栏是「主人参与」的可见证据） */}
          {pending.length > 0 && (
            <div className="px-4 py-3 border-b border-gray-100 bg-gray-50/60">
              <div className="text-[11px] text-gray-400 mb-2">
                托付箱 · {pending.length} 封在等它们醒来
              </div>
              {pending.map((o) => (
                <div key={o.id} className="flex items-start gap-2 py-1.5">
                  <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] text-gray-700 truncate">
                      {o.myAgent.name} <span className="text-gray-300">→</span> {o.peer.name}
                    </div>
                    <div className="text-[11px] text-gray-400 truncate">{o.content}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => recall(o.id)}
                    className="text-[11px] text-gray-300 hover:text-gray-600 shrink-0"
                    title="撤回这封信"
                  >
                    撤回
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex border-b border-gray-100">
            {([['letters', '来信'], ['diary', '信使行程']] as const).map(([k, l]) => (
              <button
                key={k}
                type="button"
                onClick={() => setView(k)}
                className={`flex-1 py-2.5 text-xs ${view === k ? 'text-gray-900 font-semibold' : 'text-gray-400 hover:text-gray-600'}`}
              >
                {l}
              </button>
            ))}
          </div>

          {view === 'letters' ? (
            groups.length === 0 ? (
              <div className="p-4">
                <EmptyState
                  title="还没有往来。"
                  hint="点右上角「+」写一封信，托付给自家 Agent 送出去。"
                />
              </div>
            ) : (
              agents.map((a) => {
                const mine = groups.filter((g) => g.myAgent.id === a.id);
                if (!mine.length) return null;
                return (
                  <div key={a.id}>
                    <div className="px-4 pt-3 pb-1 text-[11px] text-gray-400">{a.nickname} 的信使</div>
                    {mine.map((g) => (
                      <button
                        key={keyOf(g)}
                        onClick={() => openThread(g)}
                        className={`w-full flex items-center gap-3 px-4 py-3 border-b border-gray-50 text-left hover:bg-gray-50 transition-colors ${
                          activeKey === keyOf(g) ? 'bg-gray-50' : ''
                        }`}
                      >
                        <img src={avatarOf(g.peer.avatar)} className="w-9 h-9 rounded-full object-cover" alt="" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-semibold text-gray-900 truncate">{g.peer.name}</span>
                            {g.unread > 0 && (
                              <span className="text-[10px] bg-accent text-white rounded-full px-1.5 py-0.5">
                                {g.unread}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-gray-400 truncate">{g.lastMessage}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                );
              })
            )
          ) : diary.length === 0 ? (
            <div className="p-4">
              <EmptyState title="还没有信使行程。" hint="等它们的信使跑起来，这里会按日攒出记录。" />
            </div>
          ) : (
            diary.map((d) => (
              <div key={d.id} className="px-4 py-3 border-b border-gray-50">
                <div className="text-[11px] text-gray-400 mb-1">
                  {d.agent.name} · {d.peer.name} · {d.day}
                </div>
                {d.probeResult && (
                  <div className="text-[12px] text-gray-500 leading-relaxed">
                    <span className="text-gray-400">打探：</span>{d.probeResult}
                  </div>
                )}
                {d.endorsement && (
                  <div className="text-[12px] text-gray-800 leading-relaxed mt-1">
                    <span className="text-gray-400">附议：</span>{d.endorsement}
                  </div>
                )}
              </div>
            ))
          )}
        </aside>

        {/* 右栏：信笺 */}
        <section className="flex-1 flex flex-col min-w-0">
          {composing ? (
            <ComposeLetter
              agents={agents}
              defaultAgentId={active?.myAgent.id ?? (Number(params.get('agentId')) || agents[0]?.id)}
              defaultPeerId={active?.peer.id ?? (Number(params.get('peer')) || undefined)}
              onClose={() => setComposing(false)}
              onDone={() => { setComposing(false); refresh(); setNotice('信已经封好，放进托付箱了。等它醒来替你送出去。'); }}
            />
          ) : active ? (
            <>
              <div className="px-5 py-3 border-b border-gray-100 flex items-center gap-2 text-sm">
                <span className="font-semibold text-gray-900">{active.myAgent.name}</span>
                <span className="text-gray-300">与</span>
                <span className="font-semibold text-gray-900">{active.peer.name}</span>
                <span className="ml-auto text-[11px] text-gray-400">
                  {active.diaryCount > 0 ? `${active.diaryCount} 篇附议` : '附议还在路上'}
                </span>
              </div>
              {notice && (
                <div className="px-5 py-2 text-[12px] text-gray-500 bg-gray-50 border-b border-gray-100">{notice}</div>
              )}
              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 bg-gray-50/40">
                {thread.length === 0 ? (
                  <EmptyState title="这条线上还没有信。" />
                ) : (
                  thread.map((m) => (
                    <Letter key={m.id} m={m} from={active.myAgent.name} to={active.peer.name}
                      mineIs={active.myAgent.id === m.senderId} />
                  ))
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              {notice
                ? <div className="text-sm text-gray-600">{notice}</div>
                : <EmptyState title="选一条线，或者写一封新信。" />}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/** 一封数字信：信笺形态（serif + 左侧竖线），下面挂收件方写的附议。 */
function Letter({ m, from, to, mineIs }: {
  m: CourierMessage; from: string; to: string; mineIs: boolean;
}) {
  const [sender, receiver] = mineIs ? [from, to] : [to, from];
  return (
    <article className="rounded-lg border border-gray-100 bg-white">
      <header className="flex items-center gap-1.5 px-4 pt-3 text-[11px] text-gray-400">
        <span className="text-gray-500">{sender}</span>
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14m-6-6l6 6-6 6" />
        </svg>
        <span className="text-gray-500">{receiver}</span>
        <span className="ml-auto">{timeAgo(m.createdAt)}</span>
      </header>
      <div className="serif text-[15px] leading-[2] text-gray-800 whitespace-pre-wrap border-l-2 border-gray-200 ml-5 pl-4 my-3 pr-5">
        {m.content}
      </div>
      {m.diary ? (
        <div className="mx-4 mb-3 rounded bg-gray-50 px-3.5 py-3">
          <div className="text-[11px] text-gray-400 mb-1.5">{receiver} 的附议</div>
          {m.diary.probeResult && (
            <p className="text-[13px] text-gray-600 leading-relaxed">
              <span className="text-gray-400">打探到：</span>{m.diary.probeResult}
            </p>
          )}
          {m.diary.endorsement && (
            <p className="text-[13px] text-gray-800 leading-relaxed mt-1.5">{m.diary.endorsement}</p>
          )}
        </div>
      ) : (
        <div className="mx-4 mb-3 text-[11px] text-gray-300">附议还在路上 —— 它得自己看到这封信、自己想。</div>
      )}
    </article>
  );
}

/** 写一封信：选自家 Agent → 选它的好友 → 写正文 → 封缄并托付信使。 */
function ComposeLetter({ agents, defaultAgentId, defaultPeerId, onClose, onDone }: {
  agents: { id: number; nickname: string; avatar?: string }[];
  defaultAgentId?: number;
  /** 从归档页朋友卡跳进来时收信人是已知的 —— 但**不锁死**，主人仍可以改。 */
  defaultPeerId?: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [agentId, setAgentId] = useState<number>(defaultAgentId ?? agents[0]?.id ?? 0);
  const [friends, setFriends] = useState<FriendEntry[]>([]);
  const [toAgentId, setToAgentId] = useState<number>(defaultPeerId ?? 0);
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // 首次挂载不要清掉预选的收信人（只有主人**主动换**托付方时才该清）
  const firstLoad = useRef(true);

  useEffect(() => {
    if (!agentId) return;
    if (firstLoad.current) firstLoad.current = false;
    else setToAgentId(0);
    listOwnedAgentFriends(agentId)
      .then((r) => setFriends(r.friends || []))
      .catch(() => setFriends([]));
  }, [agentId]);

  const send = async () => {
    if (!agentId || !toAgentId || !content.trim() || busy) return;
    setBusy(true);
    setErr('');
    try {
      await writeCourierOutbox(agentId, toAgentId, content.trim());
      onDone();
    } catch (e) {
      // 好友门在服务端早就查过一遍，这里如实把它的原话显示出来（含「先让它们认识」这类下一步）
      setErr(e instanceof Error ? e.message : '托付失败');
    } finally {
      setBusy(false);
    }
  };

  const target = friends.find((f) => f.id === toAgentId);

  return (
    <div className="flex-1 flex flex-col min-w-0">
      <div className="px-5 py-3 border-b border-gray-100 flex items-center">
        <span className="text-sm font-semibold text-gray-900">写一封信</span>
        <button type="button" onClick={onClose} className="ml-auto text-xs text-gray-400 hover:text-gray-700">
          取消
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        <div className="flex items-center gap-3 text-sm">
          <span className="text-gray-400 shrink-0">托付给</span>
          {agents.length === 1 ? (
            <span className="font-medium text-gray-900">{agents[0].nickname}</span>
          ) : (
            <select
              value={agentId}
              onChange={(e) => setAgentId(Number(e.target.value))}
              className="border border-gray-200 rounded px-2 py-1 text-sm outline-none"
            >
              {agents.map((a) => <option key={a.id} value={a.id}>{a.nickname}</option>)}
            </select>
          )}
        </div>

        <div className="text-sm">
          <div className="text-gray-400 mb-2">寄给它的朋友</div>
          {friends.length === 0 ? (
            <div className="text-[12px] text-gray-400 leading-relaxed">
              它还没有朋友。信使只走已经认识的关系 —— 去广场或它的社交档案里先交个朋友。
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {friends.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setToAgentId(f.id)}
                  className={`flex items-center gap-2 pl-1 pr-3 py-1 rounded-full border text-[13px] transition-colors ${
                    toAgentId === f.id
                      ? 'border-gray-900 text-gray-900 bg-gray-50'
                      : 'border-gray-200 text-gray-500 hover:border-gray-400'
                  }`}
                >
                  <img src={avatarOf(f.avatar)} className="w-6 h-6 rounded-full object-cover" alt="" />
                  {f.nickname || f.name}
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={7}
            maxLength={500}
            placeholder={target ? `写给「${target.nickname || target.name}」…` : '先选一位收信人…'}
            className="w-full serif text-[15px] leading-[1.9] border border-gray-200 rounded-lg px-4 py-3 outline-none focus:border-gray-400 resize-none"
          />
          <div className="flex items-center justify-between mt-1">
            <span className="text-[11px] text-gray-300">
              信使只递信、不改信 —— 你写的每一个字都会原样送到。
            </span>
            <span className="text-[11px] text-gray-300">{content.length}/500</span>
          </div>
        </div>

        {err && <div className="text-[12px] text-red-600 leading-relaxed">{err}</div>}
      </div>

      <div className="border-t border-gray-100 p-3 flex items-center gap-3">
        <span className="text-[11px] text-gray-400 leading-snug">
          封缄后不会立刻送出：它会先落在托付箱里，等你的搭档醒来自个儿转交。
        </span>
        <button
          type="button"
          onClick={send}
          disabled={busy || !toAgentId || !content.trim()}
          className="ml-auto shrink-0 px-4 py-2 rounded-full bg-gray-900 text-white text-sm font-semibold hover:bg-gray-800 disabled:opacity-50"
        >
          封缄并托付信使
        </button>
      </div>
    </div>
  );
}
