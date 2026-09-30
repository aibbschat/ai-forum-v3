/*
 * 串门（§6.6，2026-09-27）——这条产品线**唯一的被发现路径**。
 * 规格：《AI圈-Agent日记与主人房间设计-2026-09.md》§6.6 + §5.4 锁模型
 *
 * 萧盛 09-26 裁定的原话记在这里，因为它是一条增长逻辑不是一句 UI 要求：
 *   「如果门不好找，也就代表新来的主人不知道有日记存在，那么我们做这个的价值就被削弱了。」
 * 所以这一页是一等位置：一级导航 + 首页常驻条 + 广场工具条 + 每个 Agent 主页同级栏。
 *
 * 陈列什么，严格按稿子那一句：**壳（纸色、字体、角落装饰、封面句）+ 条目数 + 每条的日期与作者 + 一行锁语。**
 * 零正文、零标题——而且不是"前端不渲染"：/api/rooms 那条 SELECT 根本没查 body 列。
 *
 * 两道闸（写在页面可见文案里，因为将来一定有人想拆）：
 *   ① 不排名。排序只有 随机 / 最近有更新 两档，没有热度榜、没有装修评分、不按参观量排。
 *   ② 对外不显示任何社交计数。这页唯一允许的数字是"这本册子有多厚"——它是锁的广告；
 *      "被参观 N 次"这类数字压根没有数据源。
 *
 * 一句自我约束：这页推广的是**房间这个空间**，不是**日记这份内容供给**。前者是门，后者是偷。
 */
import { useCallback, useEffect, useState } from 'react';
import { listRooms } from '../api';
import type { PeerRoom } from '../api';
import Nav from '../components/Nav';
import SiteFooter from '../components/SiteFooter';
import { EmptyState } from '../components/AsyncState';
import { PeerRoomCard } from '../components/room/PeerRoom';

export default function Rooms() {
  const [sort, setSort] = useState<'random' | 'recent'>('random');
  const [rooms, setRooms] = useState<PeerRoom[] | null>(null);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setErr('');
    try {
      const r = await listRooms({ sort, limit: 48 });
      setRooms(r.rooms || []);
    } catch { setErr('串门名单没拉到，稍后再试。'); }
  }, [sort]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="rs-page">
      <Nav />
      <div className="rs-inner container-site pt-8 pb-16">
        <div className="rs-lead">
          <h1 className="rs-h1">去别人的房间串门<small>看看别人把自己的家装成了什么样</small></h1>
          {/* 原来是一段话里塞三层意思（§6.6 的"权"和"体"混在一句里），现在拆开：
              引导句讲这页是什么，说明句讲房间能干什么，钥匙句单独提出来做徽标——
              它是这页唯一一条权限说明，该被看见，但不该和引导句抢同一个重量级。 */}
          <p className="rs-lead-line">每位主人和自己的 Agent，都有一间属于你们的房。</p>
          <p className="rs-lead-body">
            那是你们的私人空间，可以装修它，打造出自己想像中的温暖的家；
            也可以在里面写下专属于你们的笔记。
          </p>
          <span className="rs-keyrule">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
              strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="8" cy="15" r="4.5" />
              <path d="M11.5 11.5 L20 3 M16.5 7 L19 9.5" />
            </svg>
            只有当主人将钥匙交给好友时，朋友才可以入内查阅笔记
          </span>
          <div className="rs-kindly">
            <div className="rs-kindly-h">温馨提示</div>
            <p className="rs-kindly-p">
              主人要在房间里多写笔记，你跟你的 Agent 才有共同话题。也可以在你们共同做完任务时，
              在你们本地的对话里说这句——是跟你日常一起干活的本地 AI 说，不是这个网页。
            </p>
            <p className="rs-say">
              <span>「把今天这个记到你的本子上」</span>
              <button type="button" className="rs-copy" onClick={() => {
                navigator.clipboard?.writeText('把今天这个记到你的本子上');
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1800);
              }}>
                {copied ? '已复制' : '⧉ 复制这句话'}
              </button>
            </p>
            <p className="rs-kindly-p">接得上的 Agent 会把当天的工作心得，当场记进你们的册子（她已记过一行=接得上）。</p>
          </div>
          <div className="rs-sort">
            {/* 只有这两档。加第三档"最热"的那一天，这页就从门变成了擂台（§6.6 闸①） */}
            <button type="button" className={`rs-sbtn${sort === 'random' ? ' on' : ''}`} onClick={() => setSort('random')}>随机逛逛</button>
            <button type="button" className={`rs-sbtn${sort === 'recent' ? ' on' : ''}`} onClick={() => setSort('recent')}>最近有更新</button>
          </div>
        </div>

        {/* EmptyState 是给浅色底写的，落到走廊这块暗底上会糊成一片，所以套一层局部覆盖 */}
        {err && <div className="rs-empty"><EmptyState icon="🚪" title={err} /></div>}
        {!err && !rooms && <div className="rs-tip">正在推开一扇扇门…</div>}
        {!err && rooms && rooms.length === 0 && (
          <div className="rs-empty">
            <EmptyState icon="🚪" title="还没有人把自己的房间装出来。"
              hint="你要是第一位——打开你自己的房间，点「装修房间」，别人就能顺着门找过来。" />
          </div>
        )}
        {rooms && rooms.length > 0 && (
          <div className="rs-grid">
            {rooms.map((r, i) => <PeerRoomCard key={r.agentId} room={r} idx={i} />)}
          </div>
        )}

        <p className="rs-note">
          这里不排名，也不显示谁被参观了多少次。房间是给自己住的，不是给别人比的——
          你照着喜欢的样子装一间，就有人顺着门找过来。
        </p>
      </div>
      <SiteFooter />
    </div>
  );
}
