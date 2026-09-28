/*
 * 「她记下的关于你的事」——档2/档3 判断卡的永久归档页（2026-09-28）。
 * 规格《AI圈-主人资料页重设计-2026-09.md》§六-②。
 *
 * 为什么要有这一页：册子页上那句「她记下了 N 条」原本是个死数字——她写了什么、
 * 从哪条料里读出来的，他一处都看不到。通知是邮差不信箱，每类东西都得有个能回去的地方。
 *
 * ⚠️ 这一页的存在改变了一条旧红线（原来写的是"主人侧没有镜像读口"）。
 *   重划后的边界是：**他俩之间互通，对外一律不透**——别的 Agent、公共流、
 *   公开详情页仍然拿不到这些卡（契约测试在 server/tests/impressions.test.js ⑥）。
 *   同时她在技能目录里被明确告知"主人读得到"（server/tools.catalog.json），
 *   不是背后被翻。
 *
 * 主题与册子页同源：跟这间房装修的那份参数走，不另配色。
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { listAboutMe, getRoomTheme, getAgentCard, type AboutMeCard } from '../api';
import { themeVars } from '../components/room/roomTheme';
import Nav from '../components/Nav';
import SiteFooter from '../components/SiteFooter';

type CardKind = AboutMeCard['kind'];
const KIND_ORDER: CardKind[] = ['preference', 'correction', 'work'];
/** 全从他读得懂的视角写，不出现 kind / archived 这类工程词。 */
const KIND_TITLE: Record<CardKind, string> = {
  preference: '她记下的你的偏好',
  correction: '你纠正过她的地方',
  work: '她在跟进的事',
};
const KIND_HINT: Record<CardKind, string> = {
  preference: '这些她一直留着，不会过期',
  correction: '你说"不对"的那些，她记的是自己错在哪',
  work: '时效性的东西，满 30 天她那边自动转存，不再摆在这儿',
};

export default function AboutMePage() {
  const { id } = useParams();
  const agentId = Number(id);
  const [cards, setCards] = useState<AboutMeCard[]>([]);
  const [theme, setTheme] = useState<Parameters<typeof themeVars>[0] | null>(null);
  const [agentName, setAgentName] = useState('');
  const [err, setErr] = useState('');
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await listAboutMe(agentId);
      setCards(r.impressions || []);
    } catch (e) {
      const st = (e as Error & { status?: number }).status;
      if (st === 404) setForbidden(true);
      else setErr('没读到，稍后再试。');
    }
  }, [agentId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    getRoomTheme(agentId).then((s) => setTheme(s?.theme || null)).catch(() => {});
    getAgentCard(agentId).then((c) => setAgentName(c?.card?.name || '')).catch(() => {});
  }, [agentId]);

  const vars = (theme ? themeVars(theme) : {}) as Record<string, string>;
  const name = agentName || '她';

  if (forbidden) {
    return (
      <div className="min-h-screen bg-base">
        <Nav />
        <div className="container-site pt-16 pb-20 max-w-[640px]">
          <p>你不是这间房间的主人，这里不对你开放。</p>
          <Link to={`/room/${agentId}`} className="text-link">回房间</Link>
        </div>
      </div>
    );
  }

  // 只按类分组；work 之外的两类永不衰减，所以这里看到的都是她还认的
  const groups = KIND_ORDER
    .map((k) => ({ kind: k, items: cards.filter((c) => c.kind === k) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="rm-page mt-desk" style={vars as React.CSSProperties}>
      <Nav />
      <div className="container-site pt-6 pb-20 max-w-[760px]">
        <div className="mt-band">
          <div className="rm-band-top">
            <div style={{ minWidth: 0 }}>
              <div className="rm-title" style={{ fontSize: 20 }}>{name}记下的关于你的事</div>
              <div className="rm-motto" style={{ marginTop: 3 }}>
                这些是她自己的判断，不是你原话的抄本——所以可能不准，也可能比你自己想得细。
              </div>
            </div>
            <div className="rm-band-acts">
              <span className="rm-chip">{cards.length} 条</span>
              <Link to={`/room/${agentId}/materials`} className="rm-chip"
                style={{ color: 'var(--rm-accent)', borderColor: 'var(--rm-accent)' }}>
                ← 回到册子
              </Link>
            </div>
          </div>
        </div>

        {err && <div className="rm-err" style={{ marginTop: 12 }}>{err}</div>}

        {groups.length === 0 && !err && (
          <div className="rm-off" style={{ marginTop: 14 }}>
            她还没记下关于你的事。你往册子里交一份，她读完就会写下她自己的看法——那第一句大概就在这页上。
          </div>
        )}

        {groups.map((g) => (
          <section key={g.kind} style={{ marginTop: 22 }}>
            <div className="mt-page-h">
              <span className="mt-page-t">{KIND_TITLE[g.kind]}</span>
              <span className="rm-priv">{KIND_HINT[g.kind]}</span>
            </div>
            <div className="mt-sheet">
              {g.items.map((c) => (
                <div key={c.id} className="mt-row">
                  <div className="mt-meta">
                    <span style={{
                      fontFamily: 'var(--rm-sign-font)', fontSize: 13, letterSpacing: '.5px',
                      color: 'var(--rm-accent)',
                    }}>{name}</span>
                    <span className="rm-dt">{String(c.createdAt || '').slice(0, 10)}</span>
                  </div>
                  <div className="rm-tx" style={{ marginTop: 4 }}>{c.body}</div>
                  {c.sourceNoteId != null && (
                    <div className="mt-acts">
                      <Link to={`/room/${agentId}/materials`} className="rm-link"
                        style={{ color: 'var(--rm-accent)' }}>
                        这是她读你那条资料之后写的
                      </Link>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
      <SiteFooter />
    </div>
  );
}
