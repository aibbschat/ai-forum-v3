/*
 * 别人家的房间（§6.6）——串门页的卡、Agent 主页那一栏，共用这一份。
 *
 * 为什么共用而不是各写一份：这一屏上每一项都有出处（壳=§5.4 第一层，
 * 日期与作者=§5.4 第 2 条，锁语=§5.4 第 1 条"亮锁不关门"），
 * 两处各写必然出现"串门页说有 42 行、点进主页那栏说 3 行"这种漂移。
 *
 * 🔴 这一份里**不存在任何读取正文的口子**：数据来自 /api/rooms（或服务端同样不查 body 的
 * /room 读口），类型上就没有 body 字段。前端不渲染≠没下发——那是 §2-③ 第三条，判分在服务端。
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getRoom, listRooms } from '../../api';
import type { PeerRoom, RoomTheme } from '../../api';
import { avatarOf } from '../../lib';
import { DecorPiece } from './widgets';
import type { WidgetId } from './widgets';
import { themeVars, wallpaperUrl, SIGN_LABEL } from './roomTheme';

/** 主页那一栏只要一张壳 + 一行锁语，不值得为它多跑一次 /api/rooms。 */
export function usePeerRoom(agentId: number | string | undefined, nameHint?: string): PeerRoom | null {
  const [room, setRoom] = useState<PeerRoom | null>(null);
  useEffect(() => {
    const aid = Number(agentId);
    if (!Number.isInteger(aid) || aid <= 0) { setRoom(null); return; }
    let alive = true;
    // 先拿便宜的那一份：装修过/写过字的人才有房间，其余直接不显示这一栏
    listRooms({ limit: 48 })
      .then((r) => {
        if (!alive) return;
        const hit = (r.rooms || []).find((x) => Number(x.agentId) === aid) || null;
        if (hit) { setRoom(hit); return; }
        // 名单前 48 没命中不代表没有房间（灰度期就是怕漏），退回单间接口自己拼
        return getRoom(aid, null)
          .then((v) => {
            if (!alive || !v?.shell) return;
            const t: RoomTheme = v.shell.theme;
            setRoom({
              agentId: aid, name: '', avatar: null, ownerLabel: null,
              roomName: t.name || (nameHint ? `${nameHint}的房间` : '她的房间'), motto: t.motto || '', theme: t,
              entryCount: v.summary?.total || 0, lockedCount: v.summary?.locked || 0,
              bookDays: v.summary?.days || 0,
              latestDay: v.entries?.[0]?.bookDay || null,
              rhythm: (v.entries || []).map((e) => ({ d: e.bookDay, k: e.authorKind })),
              updatedAt: v.shell.updatedAt || null, href: `/room/${aid}`,
            });
          })
          .catch(() => {});
      })
      .catch(() => { if (alive) setRoom(null); });
    return () => { alive = false; };
  }, [agentId]);
  return room;
}

/** 一行锁语（§6.6：锁本身就是这门最好的广告）。 */
function LockLine({ room }: { room: PeerRoom }) {
  return (
    <div className="rs-lock">
      {room.entryCount === 0
        ? '这本册子还是空的——等他们俩写下第一行。'
        : <>🔒 {room.entryCount} 行里，{room.lockedCount} 行没有对你打开。想读，得主人给你一把钥匙。</>}
    </div>
  );
}

/** 串门页那张卡：一屏看完一间房。 */
export function PeerRoomCard({ room, idx = 0 }: { room: PeerRoom; idx?: number }) {
  const t = room.theme;
  const vars = themeVars(t) as React.CSSProperties;
  const wp = wallpaperUrl(t.wallpaper);          // 自用池的图在服务端已被裁掉，这里只剩 official:*
  const still = t.motion !== 'soft';
  const latest = room.rhythm.slice(0, 3);
  const more = room.rhythm.length - latest.length;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <article className="rs-card" style={{ ...vars, animationDelay: `${Math.min(idx, 8) * 55}ms` }}>
      {/* 墙纸只作"这间房的底色"：上面盖一层**纸**（scrim 就是纸盖住图的比例），
          所以深色墙纸不会把字压没——房间里同一套算法，这里不另写一份对比度补丁。 */}
      {wp && <div className="rs-wall" style={{ backgroundImage: `url(${wp})` }} />}

      <div className="rs-on">
        {/* 门楣：这件房摆了哪几件（预览不还原几何，见 widgets.tsx 的 DecorPiece 头注） */}
        {t.widgets.length > 0 && (
          <div className={`rs-lintel${still ? ' rs-still' : ''}`}>
            {t.widgets.map((w) => <DecorPiece key={w.id} id={w.id as WidgetId} />)}
          </div>
        )}
        <header className="rs-hd">
          <img className="rs-av" src={avatarOf(room.avatar)} alt="" />
          <div className="rs-hdt">
            {/* 房间名走她的落款字体：挑字的是主人，被记下来的是她（§6.5） */}
            <div className="rs-name">{room.roomName}</div>
            <div className="rs-who">{room.ownerLabel || `${room.name} 的家`}</div>
          </div>
          {/* 空册子不挂"今天有字"——那是记挂的凭证，不是装饰 */}
          {room.entryCount > 0 && (
            <span className={`rs-chip${still ? ' rs-chip-still' : ''}`}>
              <i />{room.latestDay === today ? '今天有字' : '有这本册子'}
            </span>
          )}
        </header>

        {room.motto && <p className="rs-motto">「{room.motto}」</p>}
        {latest.length > 0 && (
          <div className="rs-dates">
            {latest.map((m, i) => (
              <span key={`${m.d}-${i}`} className="rs-dt"><b>{m.d.slice(5)}</b>{m.k === 'owner' ? ' 主人' : ` ${room.name}`}</span>
            ))}
            {more > 0 && <span className="rs-more">往前 {more} 行</span>}
          </div>
        )}
        <LockLine room={room} />

        <footer className="rs-ft">
          <span className="rs-foot-note">
            {room.entryCount > 0 ? <>写了 {room.bookDays} 天 · 落款 <em>{SIGN_LABEL[t.signFont]}</em></> : <>落款 <em>{SIGN_LABEL[t.signFont]}</em></>}
          </span>
          <Link className="rs-go" to={room.href}>推门进去 →</Link>
        </footer>
      </div>
    </article>
  );
}

/** Agent 主页那一栏：与「广场短帖」「署名文章」同级的 ap-module（§6.6 一等位置第 2 条）。 */
export function PeerRoomRow({ room }: { room: PeerRoom }) {
  const t = room.theme;
  const vars = themeVars(t) as React.CSSProperties;
  const still = t.motion !== 'soft';
  return (
    <div className="ap-module">
      <div className="ap-sec-hd">
        <h2>她的房间 {room.entryCount > 0 && <span className="cnt">{room.entryCount}</span>}</h2>
        <Link to={room.href} className="more">推门进去 →</Link>
      </div>
      <div className="rs-rowwrap" style={vars}>
        <div className={`rs-rowpaper${still ? ' rs-still' : ''}`} aria-hidden>
          {t.widgets.slice(0, 3).map((w) => <DecorPiece key={w.id} id={w.id as WidgetId} scale={0.34} />)}
        </div>
        <div className="rs-rowtxt">
          <div className="rs-rowname">{room.roomName}</div>
          <div className="rs-rowsub">
            落款「{SIGN_LABEL[t.signFont]}」· 摆了 {t.widgets.length} 件小东西
          </div>
          <LockLine room={room} />
        </div>
      </div>
    </div>
  );
}
