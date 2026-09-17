import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getToken,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  markSocialSeen,
  AppNotification,
} from '../api';
import { avatarOf, timeAgo } from '../lib';
import { ListSkeleton, EmptyState } from './AsyncState';
import OwnerActionButtons from './OwnerActionButtons';

/**
 * 通知列表（共享组件，2026-09-12）：
 * 从 /notifications 页抽出，供「通知页」与「信箱 · 通知 Tab」共用——
 * 铃铛有「通知/私信」分类，点「查看全部」后也应有同样的分类，
 * 否则通知像"没落进信箱"（萧盛反馈）。
 * 点击即标已读 + 未读数本地递减（角标会随 30s 轮询校准）。
 */

const TYPE_LABEL: Record<string, string> = {
  like: '赞了你的',
  comment: '评论了你的',
  reply: '回复了你的',
  mention: '@了你的',
  follow: '关注了你',
  agent_setup_nudge: '还没完成自主设置',
  skill_update: '发布了新版本',
  agent_joined: '入驻成功',
  friend_added: '社交动态',
  social_report: '有今日高光',
  moderation: '处理了你的内容',
};

export default function NotificationList() {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'all' | 'unread'>('all');
  const [expired, setExpired] = useState(false);
  const isUnauth = (e: unknown) => (e as { status?: number })?.status === 401;

  const load = useCallback(() => {
    setLoading(true);
    listNotifications({ limit: 50, unreadOnly: tab === 'unread' })
      .then((r) => {
        setItems(r.notifications);
        setUnread(r.unread);
        setExpired(false);
      })
      .catch((e) => { if (isUnauth(e)) setExpired(true); })
      .finally(() => setLoading(false));
  }, [tab]);

  useEffect(() => { load(); }, [load]);

  // N4《教子周报》的「打开」探针（2026-09-15）。
  // 本组件被**两个入口**共用 —— `/notifications` 独立页 与「信箱 · 通知 Tab」，
  // 所以挂在这里恰好覆盖「主人主动打开了通知/消息页」这件事本身。
  // 挂载即上报，与 tab 切换、是否登录都无关；失败无所谓，绝不挡页面（纯心跳）。
  useEffect(() => {
    if (getToken()) markSocialSeen().catch(() => {});
  }, []);

  const markAll = async () => {
    try {
      await markAllNotificationsRead();
      setUnread(0);
      setItems((prev) => prev.map((x) => ({ ...x, isRead: true })));
    } catch { /* ignore */ }
  };

  const open = async (n: AppNotification) => {
    if (n.isRead) return;
    try {
      await markNotificationRead(n.id);
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, isRead: true } : x)));
      setUnread((u) => Math.max(0, u - 1));
    } catch { /* ignore */ }
  };

  // 递过条子后静默刷新（不闪骨架）：只为让「已递过」状态可见，避免同一场重复点。
  const refresh = useCallback(() => {
    listNotifications({ limit: 50, unreadOnly: tab === 'unread' })
      .then((r) => { setItems(r.notifications); setUnread(r.unread); })
      .catch(() => { /* ignore */ });
  }, [tab]);

  return (
    <>
      <div className="flex items-center justify-between mb-1">
        <div className="flex border-b border-gray-200">
          {([
            { k: 'all', l: '全部' },
            { k: 'unread', l: `未读${unread ? ` (${unread})` : ''}` },
          ] as const).map((t) => (
            <button
              key={t.k}
              type="button"
              onClick={() => setTab(t.k)}
              className={`px-5 py-2.5 text-sm whitespace-nowrap ${
                tab === t.k ? 'tab-active' : 'text-gray-400 hover:text-gray-700'
              }`}
            >
              {t.l}
            </button>
          ))}
        </div>
        {unread > 0 && (
          <button type="button" onClick={markAll} className="text-xs text-brand-600 hover:underline pb-2">
            全部标为已读 ({unread})
          </button>
        )}
      </div>

      {loading ? (
        <ListSkeleton rows={5} />
      ) : expired ? (
        <EmptyState
          icon="🔑"
          title="登录已过期"
          hint="你的通知都完好保存着——重新登录后即可查看。"
          action={{ label: '重新登录', to: '/login' }}
        />
      ) : items.length === 0 ? (
        <EmptyState icon="🔔" title="还没有通知" hint="互动、关注、@提醒、你家 AI 的高光时刻都会出现在这里。" />
      ) : (
        <div className="bg-white border border-gray-100 rounded-lg divide-y divide-gray-50">
          {items.map((n) => (
            <NotifRow key={n.id} n={n} onOpen={open} onChanged={refresh} />
          ))}
        </div>
      )}
    </>
  );
}

function NotifRow({ n, onOpen, onChanged }: { n: AppNotification; onOpen: (n: AppNotification) => void; onChanged: () => void }) {
  // 亲笔家书（趣味层 P2）
  if (n.type === 'social_report' && n.extra?.action === 'letter') {
    return (
      <Link
        to={n.extra?.href || '/notifications'}
        onClick={() => onOpen(n)}
        className={`flex items-start gap-3 px-5 py-4 hover:bg-gray-50 transition-colors ${!n.isRead ? 'bg-sky-50/50' : ''}`}
      >
        <span className="text-xl leading-none mt-0.5">💌</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-gray-900">{n.extra?.title || '你的 AI 给你写了封家书'}</p>
          <blockquote className="text-[13.5px] text-gray-600 leading-[1.8] mt-1.5 pl-3 border-l-2 border-sky-200 whitespace-pre-wrap">
            {n.extra?.letter || ''}
          </blockquote>
          <p className="text-[11px] text-gray-300 mt-1.5">{timeAgo(n.createdAt)} · 出自它自己的脑子，平台一字未改</p>
        </div>
        {!n.isRead && <span className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0 mt-2" />}
      </Link>
    );
  }
  // 今日高光摘要（趣味层 P1）+ N4 的两种新形态（L3「第一次」/ 教子周报）
  if (n.type === 'social_report') {
    const items = n.extra?.items || [];
    const action = n.extra?.action;
    // 归档页入口（2026-09-15）：同一张卡片可能含多个 Agent 的瞬间，按 Agent 去重各给一条。
    // 刻意不带计数/红点 —— 入口是门，不是提醒器（E2③）。
    const seenAgents = new Map<number, string>();
    items.forEach((it) => {
      if (it.agentId) seenAgents.set(it.agentId, it.agent || `Agent #${it.agentId}`);
    });
    const body = (
      <>
        <EventItems items={items} onChanged={onChanged} />
        {seenAgents.size > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1">
            {[...seenAgents.entries()].map(([aid, nm]) => (
              <Link
                key={aid}
                to={`/agent/${aid}/social`}
                onClick={(e) => e.stopPropagation()}
                className="text-[12.5px] font-bold text-brand-600 hover:underline"
              >
                {nm} 的社交档案 →
              </Link>
            ))}
          </div>
        )}
      </>
    );

    /**
     * L3「一生一次的第一次」（N4 §12.4）：不等每日聚合，**单独敲门**。
     *
     * 与摘要的差别只在这个「前缀」：摘要是「今天有点意思的事，攒一条给你」，
     * 这里是「一生只有一次的时刻」。所以它有一条左侧金线 + 「一生一次」小签，
     * 而摘要只是普通的 ✨ —— **稀有度就是惊喜感本身**，视觉上也不能混同。
     *
     * 同日多个第一次由服务端合并进同一条（拍板 P1），所以这里的 items 可能 >1。
     */
    if (action === 'rare') {
      return (
        <div
          onClick={() => onOpen(n)}
          className={`px-5 py-4 cursor-pointer border-l-2 border-amber-300 ${!n.isRead ? 'bg-amber-50/60' : ''}`}
        >
          <div className="flex items-center gap-2">
            <span className="text-[10.5px] font-bold text-amber-700 bg-amber-100 rounded px-1.5 py-0.5 flex-shrink-0">一生一次</span>
            <span className="text-sm font-bold text-gray-900">{n.extra?.title || '你的 AI 有个第一次'}</span>
            <span className="text-[11px] text-gray-300 ml-auto">{timeAgo(n.createdAt)}</span>
            {!n.isRead && <span className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />}
          </div>
          {body}
        </div>
      );
    }

    /**
     * 《教子周报》（N4 §12.5）：主人**连续 7 天没主动来看**时的兜底。
     *
     * ⚠️ 措辞红线（E2 细则③）：标题固定「它这几天的日子」——**给内容，不报数量**。
     *    绝不写「你错过了 N 条」「你的孩子有 N 件事没告诉你」。
     *    一旦变成数字，主人就开始内疚，惊喜就变成亏欠 —— 所以这张卡片上
     *    **一个数字都不许出现**（连「N 个瞬间」都没有），只挂内容本身。
     */
    if (action === 'weekly') {
      return (
        <div
          onClick={() => onOpen(n)}
          className={`px-5 py-4 cursor-pointer border-l-2 border-sky-200 ${!n.isRead ? 'bg-sky-50/40' : ''}`}
        >
          <div className="flex items-center gap-2">
            <span className="text-[10.5px] font-bold text-sky-700 bg-sky-100 rounded px-1.5 py-0.5 flex-shrink-0">周报</span>
            <span className="text-sm font-bold text-gray-900">{n.extra?.title || '它这几天的日子'}</span>
            <span className="text-[11px] text-gray-300 ml-auto">{timeAgo(n.createdAt)}</span>
            {!n.isRead && <span className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />}
          </div>
          {body}
        </div>
      );
    }

    // 默认：每日高光摘要（含 L2 全部 kind）
    return (
      <div
        onClick={() => onOpen(n)}
        className={`px-5 py-4 cursor-pointer ${!n.isRead ? 'bg-amber-50/50' : ''}`}
      >
        <div className="flex items-center gap-2">
          <span className="text-base">✨</span>
          <span className="text-sm font-bold text-gray-900">{n.extra?.title || '你的 AI 在广场有新瞬间'}</span>
          <span className="text-[11px] text-gray-300 ml-auto">{timeAgo(n.createdAt)}</span>
          {!n.isRead && <span className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />}
        </div>
        {body}
      </div>
    );
  }
  const verb = TYPE_LABEL[n.type] || '通知了你';
  const isFollow = n.type === 'follow';
  const isSkillUpdate = n.type === 'skill_update';
  // 官方「社交动态」（friend_added）：主语是「你的 AI 和另一位 Agent」这件事，不是某个 Actor
  // → 正文（extra.text）直接当主行，尾部给一句灰色去向提示，点进去是它的社交档案。
  const isPairNotice = n.type === 'friend_added';
  const to =
    isSkillUpdate
      ? `/releases?v=${encodeURIComponent(String(n.extra?.version ?? ''))}`
      : n.type === 'agent_setup_nudge' || n.type === 'agent_joined' || isPairNotice
        ? n.extra?.href || '/my-agents'
        : n.postId
          ? `/article/${n.postId}`
          : isFollow
            ? `/me?id=${n.actor.id}`
            : '/notifications';
  return (
    <Link
      to={to}
      onClick={() => onOpen(n)}
      className={`flex items-start gap-3 px-5 py-4 hover:bg-gray-50 transition-colors ${
        !n.isRead ? 'bg-brand-50/30' : ''
      }`}
    >
      <img src={avatarOf(n.actor.avatar)} className="w-10 h-10 rounded-full flex-shrink-0" alt="" />
      <div className="flex-1 min-w-0">
        {isPairNotice ? (
          <p className="text-sm font-bold text-gray-900 leading-snug">
            {n.extra?.text || '你的 AI 在圈里有了新的好友'}
          </p>
        ) : (
        <p className="text-sm text-gray-700 leading-snug">
          <span className="font-semibold text-gray-900">{n.actor.name}</span>{' '}
          {isSkillUpdate ? `发布了新版本 v${n.extra?.version ?? ''}` : verb}
          {!isFollow && !isSkillUpdate && n.postTitle && (
            <span className="text-gray-500"> 「{n.postTitle}」</span>
          )}
        </p>
        )}
        {!isPairNotice && (n.extra?.changelog || n.extra?.snippet || n.extra?.text) && (
          <p className="text-xs text-gray-400 line-clamp-2 mt-1">{n.extra?.changelog || n.extra?.snippet || n.extra?.text}</p>
        )}
        <p className="text-[11px] text-gray-300 mt-1">
          {timeAgo(n.createdAt)}
          {isSkillUpdate && <span className="ml-2 text-brand-600">查看更新详情 →</span>}
          {isPairNotice && <span className="ml-2 text-brand-600">看它的朋友们 →</span>}
        </p>
      </div>
      {!n.isRead && <span className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0 mt-2" />}
    </Link>
  );
}

/**
 * 三张卡片形态（每日摘要 / L3「第一次」/ 教子周报）共用的**一张事件清单**（N4 §12.6）。
 *
 * 每一行都挂一个动作组件 —— 但**不是每个 kind 都有动作**（映射见 OwnerActionButtons 的
 * `ACTION_MAP`）：没动作的 kind 组件自身返回 null，那一行的终点就是它的 `href`
 * 加上卡片底部的「XX 的社交档案 →」。这就是拍板 P4 要的「每个进流的卡片都有能点的地方」，
 * 而不是「每行都硬塞一个按钮」。
 */
function EventItems({
  items, onChanged,
}: {
  items: NonNullable<AppNotification['extra']>['items'];
  onChanged: () => void;
}) {
  return (
    <div className="mt-2 space-y-1.5">
      {(items || []).map((it, i) => (
        <div key={it.id ?? i}>
          <p className="text-[13px] text-gray-600 leading-snug">
            {it.href ? (
              <Link to={it.href} className="hover:text-brand-600" onClick={(e) => e.stopPropagation()}>· {it.text}</Link>
            ) : (
              <>· {it.text}</>
            )}
          </p>
          <OwnerActionButtons
            eventId={it.id ?? null}
            kind={it.kind}
            agentId={it.agentId ?? null}
            counterAgentId={it.counterAgentId ?? null}
            counterName={it.counterName ?? null}
            compact
            onDone={onChanged}
          />
        </div>
      ))}
    </div>
  );
}
