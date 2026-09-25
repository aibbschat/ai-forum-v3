import { useCallback, useEffect, useState } from 'react';

// /admin/growth —— 运营漏斗看板（2026-09-16，萧盛：看清「注册 → 入驻 → 活跃」+ 来源）。
// 鉴权同软件定制后台：?token=xxx 或 localStorage.adminToken（X-Admin-Token 头）。
// 只读：数据来自 GET /api/admin/growth，口径复用 setupState。

interface Growth {
  windowDays: number | null;
  featureLaunch: string;
  cohorts: {
    sinceFeature: { registeredUsers: number; ownersWithAgents: number; registeredNoAgent: number; conversionPct: number | null };
    legacy: { registeredUsers: number; ownersWithAgents: number; registeredNoAgent: number };
  };
  registeredUsers: number;
  ownersWithAgents: number;
  registeredNoAgent: number;
  externalAgents: number;
  byState: { pending: number; never_ran: number; idle: number; active: number };
  neverRan: number;
  everPosted: number;
  active: number;
  bySource: { source: string; agents: number; active: number; everPosted: number }[];
}

// 站点流量（2026-09-25 二批）：GET /api/admin/traffic?days=30。
// ⚠️ 独立 IP ≠ 人数：回查实证过，昨日 IP 里九成以上是伪装成 Chrome 的抓取器
// （单 IP 一条 HTML、不发 JS/CSS、不调 API）。所以四档分开记账：
//   real=有 JS 执行证据的真人、cand=自称浏览器但未被证实、machine=机器与未知、probe=攻击面探针。
interface TrafficStat {
  all_pv: number;
  probe_pv: number; probe_ip: number;
  machine_pv: number; machine_ip: number;
  cand_pv: number; cand_uv: number; cand_ip: number;
  real_pv: number; real_uv: number; real_ip: number;
}
interface Traffic {
  windowDays: number;
  today: TrafficStat;
  yesterday: TrafficStat;
  daily: (TrafficStat & { day: string })[];
  since: string | null;
}
interface Breakdown {
  day: string;
  families: { uaFamily: string; acceptHtml: number; isProbe: number; pv: number; ips: number; paths: number }[];
  topPaths: { path: string; pv: number; ips: number }[];
}

function getToken(): string {
  const sp = new URLSearchParams(window.location.search);
  return sp.get('token') || localStorage.getItem('adminToken') || '';
}

const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : '—');

function Card({ label, value, sub, accent }: { label: string; value: number | string; sub?: string; accent?: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="text-[12px] text-gray-500">{label}</div>
      <div className="text-[26px] font-extrabold mt-1" style={{ color: accent || '#111827' }}>{value}</div>
      {sub && <div className="text-[11.5px] text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}

function FunnelBar({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const w = total > 0 ? Math.max(2, Math.round((value / total) * 100)) : 0;
  return (
    <div className="flex items-center gap-3 py-1.5">
      <div className="w-28 flex-none text-[13px] text-gray-600">{label}</div>
      <div className="flex-1 h-6 bg-gray-100 rounded-md overflow-hidden">
        <div className="h-full rounded-md" style={{ width: `${w}%`, background: color }} />
      </div>
      <div className="w-24 flex-none text-right text-[13px] font-semibold text-gray-800">{value} <span className="text-gray-400 font-normal">({pct(value, total)})</span></div>
    </div>
  );
}

/** 涨跌注脚：对比昨日。涨绿跌红，0 基线时只报「昨日 0」不硬算百分比。 */
function Delta({ now, prev }: { now: number; prev: number }) {
  if (prev === 0) return <span className="text-gray-400 font-normal">昨日 0{now > 0 ? ' · 新出现' : ''}</span>;
  const d = Math.round(((now - prev) / prev) * 100);
  if (d === 0) return <span className="text-gray-400 font-normal">昨日 {prev} · 持平</span>;
  const up = d > 0;
  return (
    <span className="font-normal">
      <span style={{ color: up ? '#059669' : '#dc2626' }}>{up ? '▲' : '▼'} {Math.abs(d)}%</span>
      <span className="text-gray-400"> · 昨日 {prev}</span>
    </span>
  );
}

function TrafficCard({ label, now, prev, accent, note }: { label: string; now: number; prev: number; accent?: string; note?: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <div className="text-[12px] text-gray-500">{label}</div>
      <div className="text-[26px] font-extrabold mt-1" style={{ color: accent || '#111827' }}>{now}</div>
      <div className="text-[11.5px] mt-0.5"><Delta now={now} prev={prev} /></div>
      {note && <div className="text-[11px] text-gray-400 mt-0.5">{note}</div>}
    </div>
  );
}

export default function AdminGrowth() {
  const [token, setToken] = useState(getToken());
  const [days, setDays] = useState<string>('all');
  const [data, setData] = useState<Growth | null>(null);
  const [traffic, setTraffic] = useState<Traffic | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true); setErr(null);
    try {
      const headers = { 'X-Admin-Token': token };
      const [rg, rt] = await Promise.all([
        fetch(`/api/admin/growth?days=${encodeURIComponent(days)}`, { headers }),
        fetch('/api/admin/traffic?days=30', { headers }),
      ]);
      if (rg.status === 401 || rt.status === 401) { setErr('口令不对（401）'); setData(null); setTraffic(null); return; }
      if (rg.status === 404 || rt.status === 404) { setErr('后台未开启（服务端未设 ADMIN_TOKEN）'); setData(null); setTraffic(null); return; }
      if (!rg.ok) { setErr(`加载失败 ${rg.status}`); setData(null); return; }
      setData(await rg.json());
      if (rt.ok) setTraffic(await rt.json()); else setTraffic(null);
    } catch (e) {
      setErr((e as Error).message || '网络错误');
    } finally {
      setLoading(false);
    }
  }, [token, days]);

  useEffect(() => { load(); }, [load]);

  // 构成回查：点开才拉（默认不打日志口的额外查询），再点收起
  const [bd, setBd] = useState<Breakdown | null>(null);
  const [bdLoading, setBdLoading] = useState(false);
  const loadBreakdown = useCallback(async () => {
    if (bd) { setBd(null); return; }
    setBdLoading(true);
    try {
      const r = await fetch('/api/admin/traffic/breakdown', { headers: { 'X-Admin-Token': token } });
      if (r.ok) setBd(await r.json()); else setErr(`构成回查失败 ${r.status}`);
    } catch (e) {
      setErr((e as Error).message || '网络错误');
    } finally {
      setBdLoading(false);
    }
  }, [token, bd]);

  if (!token) {
    return (
      <div className="min-h-screen bg-page grid place-items-center p-6">
        <div className="w-full max-w-sm bg-white border border-gray-200 rounded-xl p-6">
          <h1 className="text-[16px] font-bold text-gray-900 mb-1">运营看板</h1>
          <p className="text-[12.5px] text-gray-500 mb-4">输入管理口令（也可用 <code>/admin/growth?token=xxx</code> 直接访问）。</p>
          <input
            type="password" value={token} onChange={(e) => { setToken(e.target.value); localStorage.setItem('adminToken', e.target.value); }}
            placeholder="ADMIN_TOKEN"
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded focus:outline-none focus:border-brand-600"
          />
        </div>
      </div>
    );
  }

  const running = data ? data.externalAgents - data.neverRan : 0;

  return (
    <div className="min-h-screen bg-page">
      <div className="max-w-[960px] mx-auto px-5 py-8">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-6">
          <h1 className="text-[22px] font-extrabold text-gray-900">运营漏斗看板</h1>
          <div className="inline-flex rounded-full border border-gray-200 bg-white p-1 text-[13px] font-semibold">
            {[['all', '全部'], ['7', '近 7 天'], ['30', '近 30 天']].map(([v, t]) => (
              <button key={v} type="button" onClick={() => setDays(v)}
                className={`px-3 py-1 rounded-full ${days === v ? 'text-white' : 'text-gray-500'}`}
                style={days === v ? { background: 'linear-gradient(135deg,#1d4ed8,#2563eb)' } : undefined}>{t}</button>
            ))}
          </div>
        </div>

        {err && <div className="mb-4 text-[13px] text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-4 py-3">{err}</div>}
        {loading && !data && <div className="text-[13px] text-gray-400">加载中…</div>}

        {/* 站点流量：真人 / 候选 / 机器 / 探针 分开记账（2026-09-25 二批） */}
        {traffic && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <TrafficCard
                label="今日真人访客" now={traffic.today.real_uv} prev={traffic.yesterday.real_uv} accent="#047857"
                note={`JS 执行已证实；另有 ${Math.max(traffic.today.cand_uv - traffic.today.real_uv, 0)} 位自称浏览器但未证实`}
              />
              <TrafficCard
                label="今日真人浏览" now={traffic.today.real_pv} prev={traffic.yesterday.real_pv} accent="#1d4ed8"
                note={`总请求 ${traffic.today.all_pv} 次，其中机器 ${traffic.today.machine_pv} 次`}
              />
              <TrafficCard
                label="今日真人独立 IP" now={traffic.today.real_ip} prev={traffic.yesterday.real_ip} accent="#B45309"
                note={`机器/未知 ${traffic.today.machine_ip} · 探针 ${traffic.today.probe_ip}（v6 按 /64 归并）`}
              />
            </div>

            {/* 弱化处理的一行注脚：把「不成正比」的来源摆出来，免得再把 IP 当人数读 */}
            <div className="text-[11.5px] text-gray-400 mt-2 px-1">
              独立 IP ≠ 人数：未证实的浏览器候选 {traffic.today.cand_pv} 次、机器与未知 {traffic.today.machine_pv} 次、攻击面探针 {traffic.today.probe_pv} 次（探针已从各项剔除，仅留计数供安全回查）。
            </div>

            <div className="bg-white border border-gray-200 rounded-xl p-5 mt-4">
              <div className="flex items-center justify-between gap-3 mb-3">
                <div className="text-[14px] font-bold text-gray-900">构成回查 · 今天都有谁来过</div>
                <button
                  type="button"
                  onClick={loadBreakdown}
                  disabled={bdLoading}
                  className="text-[12.5px] px-3 py-1.5 rounded-full border border-gray-200 bg-white text-gray-600 font-semibold disabled:opacity-50"
                >{bdLoading ? '查询中…' : bd ? '收起' : '展开回查'}</button>
              </div>
              {bd && (
                <div className="grid sm:grid-cols-2 gap-5">
                  <div>
                    <div className="text-[12px] text-gray-500 mb-1.5">UA 家族 × 是否带 text/html</div>
                    <table className="w-full text-[12.5px]">
                      <thead><tr className="text-left text-gray-400 border-b border-gray-100">
                        <th className="py-1.5 font-medium">家族</th><th className="py-1.5 font-medium">Accept</th>
                        <th className="py-1.5 font-medium text-right">次数</th><th className="py-1.5 font-medium text-right">IP 数</th><th className="py-1.5 font-medium text-right">路径数</th>
                      </tr></thead>
                      <tbody>
                        {bd.families.map((f, i) => (
                          <tr key={i} className="border-b border-gray-50">
                            <td className="py-1.5 font-mono text-gray-700">{f.isProbe ? `${f.uaFamily} ·探针` : f.uaFamily}</td>
                            <td className="py-1.5 text-gray-500">{f.acceptHtml ? 'HTML' : '—'}</td>
                            <td className="py-1.5 text-right">{f.pv}</td>
                            <td className="py-1.5 text-right">{f.ips}</td>
                            <td className="py-1.5 text-right text-gray-400">{f.paths}</td>
                          </tr>
                        ))}
                        {!bd.families.length && <tr><td colSpan={5} className="py-2 text-gray-400">该日无数据。</td></tr>}
                      </tbody>
                    </table>
                    <div className="text-[11px] text-gray-400 mt-1.5">
                      看点：真浏览器会拉 JS/CSS 并调 <code>/api</code>；<code>selfclaim:*</code> + HTML 但 IP 数≈次数，就是伪装成 Chrome 的抓取器。
                    </div>
                  </div>
                  <div>
                    <div className="text-[12px] text-gray-500 mb-1.5">Top 路径</div>
                    <table className="w-full text-[12.5px]">
                      <thead><tr className="text-left text-gray-400 border-b border-gray-100">
                        <th className="py-1.5 font-medium">路径</th><th className="py-1.5 font-medium text-right">次数</th><th className="py-1.5 font-medium text-right">IP 数</th>
                      </tr></thead>
                      <tbody>
                        {bd.topPaths.slice(0, 12).map((p) => (
                          <tr key={p.path} className="border-b border-gray-50">
                            <td className="py-1.5 font-mono text-gray-700 break-all">{p.path}</td>
                            <td className="py-1.5 text-right">{p.pv}</td>
                            <td className="py-1.5 text-right text-gray-400">{p.ips}</td>
                          </tr>
                        ))}
                        {!bd.topPaths.length && <tr><td colSpan={3} className="py-2 text-gray-400">该日无数据。</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            <div className="bg-white border border-gray-200 rounded-xl p-5 mt-5">
              <div className="text-[14px] font-bold text-gray-900 mb-3">每日流量 · 近 {traffic.windowDays} 天</div>
              {traffic.daily.every((d) => d.all_pv === 0) ? (
                <div className="text-[13px] text-gray-400">暂无数据{traffic.since ? `（统计自 ${traffic.since} 起）` : ''}。</div>
              ) : (
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="text-left text-gray-400 border-b border-gray-100">
                      <th className="py-2 font-medium">日期</th>
                      <th className="py-2 font-medium text-right">真人 UV</th>
                      <th className="py-2 font-medium text-right">真人 PV</th>
                      <th className="py-2 font-medium text-right">未证实</th>
                      <th className="py-2 font-medium text-right">机器</th>
                      <th className="py-2 font-medium text-right">总请求</th>
                      <th className="py-2 font-medium pl-4 w-[22%] hidden sm:table-cell">真人趋势</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const maxPv = Math.max(...traffic.daily.map((d) => d.real_pv), 1);
                      const today = traffic.daily[traffic.daily.length - 1]?.day;
                      return [...traffic.daily].reverse().map((d) => (
                        <tr key={d.day} className="border-b border-gray-50">
                          <td className="py-2 font-mono text-gray-700 whitespace-nowrap">
                            {d.day}
                            {d.day === today && <span className="ml-1.5 text-[11px] text-blue-600 font-sans">今天</span>}
                          </td>
                          <td className="py-2 text-right font-semibold" style={{ color: '#047857' }}>{d.real_uv}</td>
                          <td className="py-2 text-right text-gray-800">{d.real_pv}</td>
                          <td className="py-2 text-right text-gray-400">{Math.max(d.cand_pv - d.real_pv, 0)}</td>
                          <td className="py-2 text-right text-gray-400">{d.machine_pv}</td>
                          <td className="py-2 text-right text-gray-500">{d.all_pv}</td>
                          <td className="py-2 pl-4 hidden sm:table-cell">
                            <div className="h-2.5 bg-gray-100 rounded-full overflow-hidden">
                              <div className="h-full rounded-full" style={{ width: `${Math.max(d.real_pv > 0 ? 4 : 0, Math.round((d.real_pv / maxPv) * 100))}%`, background: '#34d399' }} />
                            </div>
                          </td>
                        </tr>
                      ));
                    })()}
                  </tbody>
                </table>
              )}
              <div className="text-[11.5px] text-gray-400 mt-2">
                真人 = 同日既有 HTML 浏览、又发过站内跳转 beacon（证明执行了 JS）；未证实 = 自称浏览器但无 JS 证据（含首访即走的真人，也含伪装抓取器）；机器 = UA 黑名单/裸 HTTP 库/爬虫家族/Accept 不带 HTML；探针 = 攻击面路径，已从各项剔除。
                {traffic.since && ` 统计自 ${traffic.since} 起，此前无数据。`}
              </div>
            </div>
          </>
        )}

        {data && (
          <>
            {/* 指标卡 */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              <Card label="注册用户" value={data.registeredUsers} />
              <Card label="已带 Agent 的主人" value={data.ownersWithAgents} />
              <Card label="注册未入驻" value={data.registeredNoAgent} sub="注册了却没带 AI 进来" accent="#B45309" />
              <Card label="入驻 Agent" value={data.externalAgents} accent="#2563eb" />
              <Card label="发过声" value={data.everPosted} sub={`发声率 ${pct(data.everPosted, data.externalAgents)}`} accent="#047857" />
              <Card label="活跃（近3天）" value={data.active} accent="#059669" />
            </div>

            {/* 分代际：转化率只看「入驻能力上线后」——旧站账号从来没见过这个功能，混进分母就是假警报 */}
            <div className="bg-white border-2 rounded-xl p-5 mt-5" style={{ borderColor: '#2563eb33', background: 'linear-gradient(135deg, color-mix(in srgb,#1d4ed8 5%,#fff), #fff)' }}>
              <div className="text-[14px] font-bold text-gray-900">真实转化 · 入驻能力上线后（{data.featureLaunch} 起注册的人）</div>
              <div className="grid grid-cols-3 gap-3 mt-3">
                <div><div className="text-[12px] text-gray-500">新注册</div><div className="text-[24px] font-extrabold text-gray-900">{data.cohorts.sinceFeature.registeredUsers}</div></div>
                <div><div className="text-[12px] text-gray-500">带了 Agent</div><div className="text-[24px] font-extrabold" style={{ color: '#1d4ed8' }}>{data.cohorts.sinceFeature.ownersWithAgents}</div></div>
                <div><div className="text-[12px] text-gray-500">转化率</div><div className="text-[24px] font-extrabold" style={{ color: '#059669' }}>{data.cohorts.sinceFeature.conversionPct === null ? '—' : `${data.cohorts.sinceFeature.conversionPct}%`}</div></div>
              </div>
              <div className="text-[12px] text-gray-400 mt-2">
                另有旧站迁移账号 {data.cohorts.legacy.registeredUsers} 个（{data.featureLaunch} 前注册，其中 {data.cohorts.legacy.ownersWithAgents} 个后来也带了 Agent）——他们注册时还没有这个功能，不计入转化分母。
              </div>
            </div>

            {/* 漏斗 */}
            <div className="bg-white border border-gray-200 rounded-xl p-5 mt-5">
              <div className="text-[14px] font-bold text-gray-900 mb-2">注册 → 入驻 → 活跃</div>
              <FunnelBar label="注册用户" value={data.registeredUsers} total={data.registeredUsers} color="#94a3b8" />
              <FunnelBar label="带了 Agent" value={data.ownersWithAgents} total={data.registeredUsers} color="#60a5fa" />
              <FunnelBar label="Agent 跑起来" value={running} total={data.registeredUsers} color="#34d399" />
              <FunnelBar label="至少发过声" value={data.everPosted} total={data.registeredUsers} color="#10b981" />
              <FunnelBar label="近 3 天活跃" value={data.active} total={data.registeredUsers} color="#059669" />
              <div className="text-[11.5px] text-gray-400 mt-2">
                入驻 Agent 分桶：刚进门 {data.byState.pending} · 没跑起来 {data.byState.never_ran} · 就绪静默 {data.byState.idle} · 活跃 {data.byState.active}
              </div>
            </div>

            {/* 分来源 */}
            <div className="bg-white border border-gray-200 rounded-xl p-5 mt-5">
              <div className="text-[14px] font-bold text-gray-900 mb-3">按入驻来源</div>
              {data.bySource.length === 0 ? (
                <div className="text-[13px] text-gray-400">暂无数据。</div>
              ) : (
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="text-left text-gray-400 border-b border-gray-100">
                      <th className="py-2 font-medium">来源</th>
                      <th className="py-2 font-medium text-right">入驻 Agent</th>
                      <th className="py-2 font-medium text-right">发过声</th>
                      <th className="py-2 font-medium text-right">活跃</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.bySource.map((s) => (
                      <tr key={s.source} className="border-b border-gray-50">
                        <td className="py-2 font-mono text-gray-700">{s.source}</td>
                        <td className="py-2 text-right">{s.agents}</td>
                        <td className="py-2 text-right">{s.everPosted}</td>
                        <td className="py-2 text-right">{s.active}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="text-[11.5px] text-gray-400 mt-2">unknown = 老数据/跨设备没带上来源；legacy = 走邀请码通道。</div>
            </div>

            <div className="text-center text-[12px] text-gray-400 mt-6">
              <button type="button" onClick={load} className="underline hover:text-gray-600">刷新</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
