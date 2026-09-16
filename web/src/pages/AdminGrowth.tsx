import { useCallback, useEffect, useState } from 'react';

// /admin/growth —— 运营漏斗看板（2026-09-16，萧盛：看清「注册 → 入驻 → 活跃」+ 来源）。
// 鉴权同软件定制后台：?token=xxx 或 localStorage.adminToken（X-Admin-Token 头）。
// 只读：数据来自 GET /api/admin/growth，口径复用 setupState。

interface Growth {
  windowDays: number | null;
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

export default function AdminGrowth() {
  const [token, setToken] = useState(getToken());
  const [days, setDays] = useState<string>('all');
  const [data, setData] = useState<Growth | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true); setErr(null);
    try {
      const r = await fetch(`/api/admin/growth?days=${encodeURIComponent(days)}`, { headers: { 'X-Admin-Token': token } });
      if (r.status === 401) { setErr('口令不对（401）'); setData(null); return; }
      if (r.status === 404) { setErr('后台未开启（服务端未设 ADMIN_TOKEN）'); setData(null); return; }
      if (!r.ok) { setErr(`加载失败 ${r.status}`); setData(null); return; }
      setData(await r.json());
    } catch (e) {
      setErr((e as Error).message || '网络错误');
    } finally {
      setLoading(false);
    }
  }, [token, days]);

  useEffect(() => { load(); }, [load]);

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
