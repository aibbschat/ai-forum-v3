import { useEffect, useState, useCallback } from 'react';

// 软件定制询盘管理（从旧站 aibbs.chat 迁入，2026-08-21）
// 鉴权：?token=xxx 或 localStorage.adminToken（X-Admin-Token 头）
// 对应 V3 后端：/api/admin/software-orders/*

interface Order {
  id: number;
  orderNo: string;
  customerName: string;
  contactInfo: string;
  companyName: string;
  projectType: string;
  title: string;
  description: string;
  techStack: string;
  timeline: string;
  budgetRange: string;
  designRequirements: string;
  deploymentNeeds: string;
  userScale: string;
  maintenanceNeeds: string;
  taobaoOrderNo: string;
  status: string;
  source: string;
  conversation: { role: string; content: string }[] | string | null;
  adminNotes: string | null;
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
}

interface Stats {
  pending: number;
  reviewing: number;
  quoted: number;
  accepted: number;
  developing: number;
  delivered: number;
  rejected: number;
  archived: number;
  total: number;
}

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  pending: { label: '待处理', color: '#F59E0B', bg: 'rgba(245,158,11,0.1)' },
  reviewing: { label: '审核中', color: '#3B82F6', bg: 'rgba(59,130,246,0.1)' },
  quoted: { label: '已报价', color: '#8B5CF6', bg: 'rgba(139,92,246,0.1)' },
  accepted: { label: '已接单', color: '#10B981', bg: 'rgba(16,185,129,0.1)' },
  developing: { label: '开发中', color: '#06B6D4', bg: 'rgba(6,182,212,0.1)' },
  delivered: { label: '已交付', color: '#22C55E', bg: 'rgba(34,197,94,0.1)' },
  rejected: { label: '已拒绝', color: '#EF4444', bg: 'rgba(239,68,68,0.1)' },
  archived: { label: '已归档', color: '#6B7280', bg: 'rgba(107,114,128,0.1)' },
};
const STATUS_OPTIONS = Object.keys(STATUS_CONFIG);

function getTokenFromUrl(): string {
  const sp = new URLSearchParams(window.location.search);
  return sp.get('token') || '';
}

function getToken(): string {
  return getTokenFromUrl() || localStorage.getItem('adminToken') || '';
}

async function authFetch(url: string, options: RequestInit = {}) {
  const token = getToken();
  const headers: Record<string, string> = {};
  const src = options.headers as Record<string, string> | Headers | undefined;
  if (src instanceof Headers) {
    src.forEach((v, k) => { headers[k] = v; });
  } else if (src) {
    Object.assign(headers, src);
  }
  if (token) headers['X-Admin-Token'] = token;
  if (!headers['Content-Type'] && options.body && typeof options.body === 'string') {
    headers['Content-Type'] = 'application/json';
  }
  return fetch(url, { ...options, headers });
}

export default function AdminSoftwareOrders() {
  const [authed, setAuthed] = useState(false);
  const [authChecking, setAuthChecking] = useState(true);
  const [tokenInput, setTokenInput] = useState('');
  const [authError, setAuthError] = useState('');

  const [orders, setOrders] = useState<Order[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [loading, setLoading] = useState(false);

  const [detail, setDetail] = useState<Order | null>(null);
  const [editStatus, setEditStatus] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const limit = 20;

  const checkAuth = useCallback(async () => {
    setAuthChecking(true);
    try {
      const res = await authFetch('/api/admin/software-orders/stats');
      if (res.ok) {
        const d = await res.json();
        setStats(d.data);
        setAuthed(true);
      } else {
        setAuthed(false);
      }
    } catch {
      setAuthed(false);
    } finally {
      setAuthChecking(false);
    }
  }, []);

  useEffect(() => { checkAuth(); }, [checkAuth]);

  const loadOrders = useCallback(async () => {
    if (!authed) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (statusFilter) params.set('status', statusFilter);
      if (search) params.set('search', search);
      const res = await authFetch(`/api/admin/software-orders?${params}`);
      if (res.ok) {
        const d = await res.json();
        setOrders(d.data || []);
        setTotalPages(d.pagination?.totalPages || 1);
        setTotal(d.pagination?.total || 0);
      } else if (res.status === 401) {
        setAuthed(false);
      }
    } finally {
      setLoading(false);
    }
  }, [authed, page, statusFilter, search]);

  // 加载订单列表（authed 或分页/筛选变化时）
  useEffect(() => {
    if (authed) loadOrders();
  }, [authed, loadOrders]);

  // 加载完订单后也刷新统计
  useEffect(() => {
    if (!authed) return;
    authFetch('/api/admin/software-orders/stats').then(async (r) => {
      if (r.ok) {
        const d = await r.json();
        setStats(d.data);
      }
    }).catch(() => {});
  }, [authed, orders.length]);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (tokenInput.trim()) {
      localStorage.setItem('adminToken', tokenInput.trim());
      setAuthError('');
      checkAuth();
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('adminToken');
    setAuthed(false);
  };

  const openDetail = async (id: number) => {
    const res = await authFetch(`/api/admin/software-orders/${id}`);
    if (res.ok) {
      const d = await res.json();
      setDetail(d.data);
      setEditStatus(d.data.status);
      setEditNotes(d.data.adminNotes || '');
    } else if (res.status === 401) {
      setAuthed(false);
    }
  };

  const saveDetail = async () => {
    if (!detail) return;
    setSaving(true);
    try {
      const res = await authFetch(`/api/admin/software-orders/${detail.id}`, {
        method: 'PUT',
        body: JSON.stringify({ status: editStatus, adminNotes: editNotes }),
      });
      if (res.ok) {
        const d = await res.json();
        setDetail((prev) => prev ? { ...prev, ...d.data } : prev);
        await loadOrders();
      }
    } finally {
      setSaving(false);
    }
  };

  const archiveOrder = async (id: number) => {
    if (!confirm('确认归档此订单？（可通过状态筛选「已归档」查看）')) return;
    const res = await authFetch(`/api/admin/software-orders/${id}`, { method: 'DELETE' });
    if (res.ok) {
      setDetail(null);
      await loadOrders();
    }
  };

  const doSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSearch(searchInput);
    setPage(1);
  };

  if (authChecking) {
    return <div className="min-h-screen flex items-center justify-center bg-gray-50"><div className="w-6 h-6 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" /></div>;
  }

  if (!authed) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
          <div className="text-center mb-6">
            <h1 className="text-xl font-bold text-gray-900">软件定制询盘管理</h1>
            <p className="text-sm text-gray-500 mt-1">请输入管理员 Token</p>
          </div>
          <form onSubmit={handleLogin} className="space-y-3">
            <input
              type="password"
              placeholder="Admin Token"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              className="w-full px-4 py-2.5 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-gray-900"
              autoFocus
            />
            {authError && <p className="text-sm text-red-500">{authError}</p>}
            <button type="submit" className="w-full py-2.5 rounded-lg bg-gray-900 text-white text-sm font-medium hover:bg-gray-800 transition">
              登录
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {/* 头部 */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900">软件定制询盘管理</h1>
            <p className="text-xs sm:text-sm text-gray-500 mt-0.5">来自软件中心接单助手的客户询盘</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={loadOrders} className="px-3 py-1.5 rounded-lg bg-white border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition flex items-center gap-1">
              <span className={loading ? 'inline-block w-3 h-3 border-2 border-gray-400 border-t-transparent rounded-full animate-spin' : ''} />
              刷新
            </button>
            <button onClick={handleLogout} className="px-3 py-1.5 rounded-lg bg-white border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition">
              退出
            </button>
          </div>
        </div>

        {/* 统计卡片 */}
        {stats && (
          <div className="grid grid-cols-4 lg:grid-cols-8 gap-2 mb-5">
            {STATUS_OPTIONS.filter((s) => s !== 'archived').map((s) => {
              const cfg = STATUS_CONFIG[s];
              const active = statusFilter === s;
              return (
                <button
                  key={s}
                  onClick={() => { setStatusFilter(active ? '' : s); setPage(1); }}
                  className={`p-2 sm:p-3 rounded-xl border text-left transition ${active ? 'border-gray-900 ring-1 ring-gray-900' : 'border-gray-200 bg-white hover:border-gray-300'}`}
                  style={active ? { background: cfg.bg } : {}}
                >
                  <p className="text-lg sm:text-2xl font-bold" style={{ color: cfg.color }}>{stats[s as keyof Stats] || 0}</p>
                  <p className="text-[10px] sm:text-xs text-gray-500 mt-0.5">{cfg.label}</p>
                </button>
              );
            })}
          </div>
        )}

        {/* 搜索 */}
        <form onSubmit={doSearch} className="relative mb-4">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
          </svg>
          <input
            type="text"
            placeholder="搜索订单号、标题、客户名、联系方式..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="w-full pl-9 pr-4 py-2.5 rounded-xl bg-white border border-gray-200 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-gray-900"
          />
        </form>

        {/* 表格 */}
        <div className="bg-white border border-gray-200 rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-gray-500 text-xs">
                  <th className="text-left px-3 sm:px-4 py-3 font-medium whitespace-nowrap">订单号</th>
                  <th className="text-left px-3 sm:px-4 py-3 font-medium">项目标题</th>
                  <th className="text-left px-3 sm:px-4 py-3 font-medium whitespace-nowrap">客户</th>
                  <th className="text-left px-3 sm:px-4 py-3 font-medium whitespace-nowrap">联系方式</th>
                  <th className="text-left px-3 sm:px-4 py-3 font-medium whitespace-nowrap">类型</th>
                  <th className="text-left px-3 sm:px-4 py-3 font-medium whitespace-nowrap hidden md:table-cell">周期</th>
                  <th className="text-left px-3 sm:px-4 py-3 font-medium whitespace-nowrap hidden md:table-cell">预算</th>
                  <th className="text-left px-3 sm:px-4 py-3 font-medium whitespace-nowrap">状态</th>
                  <th className="text-left px-3 sm:px-4 py-3 font-medium whitespace-nowrap hidden sm:table-cell">时间</th>
                  <th className="text-left px-3 sm:px-4 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {orders.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-4 py-12 text-center text-gray-400 text-sm">
                      {loading ? '加载中...' : '暂无订单'}
                    </td>
                  </tr>
                ) : orders.map((o) => {
                  const cfg = STATUS_CONFIG[o.status] || STATUS_CONFIG.pending;
                  return (
                    <tr key={o.id} className="border-b border-gray-100 hover:bg-gray-50 transition">
                      <td className="px-3 sm:px-4 py-3 font-mono text-xs text-gray-500 whitespace-nowrap">{o.orderNo}</td>
                      <td className="px-3 sm:px-4 py-3 max-w-[200px] truncate text-gray-900">{o.title}</td>
                      <td className="px-3 sm:px-4 py-3 whitespace-nowrap">{o.customerName || '-'}</td>
                      <td className="px-3 sm:px-4 py-3 text-xs text-gray-600 max-w-[140px] truncate">{o.contactInfo}</td>
                      <td className="px-3 sm:px-4 py-3 whitespace-nowrap">
                        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{o.projectType || '-'}</span>
                      </td>
                      <td className="px-3 sm:px-4 py-3 text-xs text-gray-500 whitespace-nowrap hidden md:table-cell">{o.timeline || '-'}</td>
                      <td className="px-3 sm:px-4 py-3 text-xs text-gray-500 whitespace-nowrap hidden md:table-cell">{o.budgetRange || '-'}</td>
                      <td className="px-3 sm:px-4 py-3 whitespace-nowrap">
                        <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ color: cfg.color, background: cfg.bg }}>{cfg.label}</span>
                      </td>
                      <td className="px-3 sm:px-4 py-3 text-xs text-gray-400 whitespace-nowrap hidden sm:table-cell">
                        {o.createdAt ? new Date(o.createdAt).toLocaleDateString('zh-CN') : '-'}
                      </td>
                      <td className="px-3 sm:px-4 py-3 whitespace-nowrap">
                        <button onClick={() => openDetail(o.id)} className="text-xs px-3 py-1 rounded-lg bg-gray-900 text-white hover:bg-gray-800 transition">查看</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100">
              <span className="text-xs text-gray-500">共 {total} 条，第 {page}/{totalPages} 页</span>
              <div className="flex gap-2">
                <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}
                  className="px-3 py-1 rounded-lg text-xs bg-white border border-gray-200 disabled:opacity-30 hover:bg-gray-50 transition">上一页</button>
                <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
                  className="px-3 py-1 rounded-lg text-xs bg-white border border-gray-200 disabled:opacity-30 hover:bg-gray-50 transition">下一页</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 详情抽屉 */}
      {detail && (
        <div className="fixed inset-0 z-50 flex justify-end" onClick={(e) => { if (e.target === e.currentTarget) setDetail(null); }}>
          <div className="absolute inset-0 bg-black/40" />
          <div className="relative w-full max-w-2xl h-screen overflow-y-auto bg-white shadow-xl">
            <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-4 border-b border-gray-200 bg-white/95 backdrop-blur">
              <h2 className="text-lg font-semibold text-gray-900">订单详情</h2>
              <button onClick={() => setDetail(null)} className="p-2 rounded-lg hover:bg-gray-100 transition">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            <div className="px-6 py-6 space-y-6">
              {/* 基本信息 */}
              <section>
                <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-3">基本信息</h3>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <Field label="订单编号" value={detail.orderNo} mono />
                  <Field label="状态" value={<span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ color: STATUS_CONFIG[detail.status]?.color, background: STATUS_CONFIG[detail.status]?.bg }}>{STATUS_CONFIG[detail.status]?.label}</span>} />
                  <Field label="项目标题" value={detail.title} />
                  <Field label="项目类型" value={detail.projectType || '-'} />
                  <Field label="客户姓名" value={detail.customerName || '-'} />
                  <Field label="联系方式" value={<a href={`tel:${detail.contactInfo}`} className="text-blue-600 hover:underline">{detail.contactInfo}</a>} />
                  <Field label="公司名称" value={detail.companyName || '-'} />
                  <Field label="技术栈" value={detail.techStack || '-'} />
                  <Field label="开发周期" value={detail.timeline || '-'} />
                  <Field label="预算范围" value={detail.budgetRange || '-'} />
                  <Field label="设计需求" value={detail.designRequirements || '-'} />
                  <Field label="部署需求" value={detail.deploymentNeeds || '-'} />
                  <Field label="用户规模" value={detail.userScale || '-'} />
                  <Field label="维护需求" value={detail.maintenanceNeeds || '-'} />
                  <Field label="淘宝订单号" value={detail.taobaoOrderNo ? (
                    <a href={`https://trade.taobao.com/trade/detail/trade_item_detail.htm?bizOrderId=${detail.taobaoOrderNo}`} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">{detail.taobaoOrderNo} ↗</a>
                  ) : <span className="text-gray-400">未关联</span>} />
                  <Field label="来源" value={detail.source || '-'} />
                  <Field label="创建时间" value={detail.createdAt ? new Date(detail.createdAt).toLocaleString('zh-CN') : '-'} />
                </div>
              </section>

              {/* 需求描述 */}
              {detail.description && (
                <section>
                  <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-3">需求描述</h3>
                  <div className="p-4 rounded-xl bg-gray-50 border border-gray-100">
                    <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">{detail.description}</p>
                  </div>
                </section>
              )}

              {/* 对话记录 */}
              {Array.isArray(detail.conversation) && detail.conversation.length > 0 && (
                <section>
                  <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-3">对话记录</h3>
                  <div className="space-y-2 p-4 rounded-xl bg-gray-50 border border-gray-100 max-h-80 overflow-y-auto">
                    {detail.conversation.map((m, i) => (
                      <div key={i} className="text-sm">
                        <span className={`text-xs mr-2 font-medium ${m.role === 'user' ? 'text-blue-600' : 'text-gray-500'}`}>
                          {m.role === 'user' ? '客户' : '助手'}:
                        </span>
                        <span className="text-gray-700 whitespace-pre-wrap">{m.content}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* 状态管理 */}
              <section>
                <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-3">状态管理</h3>
                <div className="space-y-3">
                  <select value={editStatus} onChange={(e) => setEditStatus(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-gray-300 text-sm bg-white focus:outline-none focus:border-gray-900">
                    {STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>{STATUS_CONFIG[s].label}</option>
                    ))}
                  </select>
                  <label className="text-xs text-gray-500 block">管理备注</label>
                  <textarea value={editNotes} onChange={(e) => setEditNotes(e.target.value)} placeholder="添加管理备注..." rows={3}
                    className="w-full px-4 py-2.5 rounded-xl border border-gray-300 text-sm focus:outline-none focus:border-gray-900 resize-none" />
                  <div className="flex gap-2">
                    <button onClick={saveDetail} disabled={saving}
                      className="px-5 py-2 rounded-lg bg-gray-900 text-white text-sm font-medium hover:bg-gray-800 transition disabled:opacity-50">
                      {saving ? '保存中...' : '保存更改'}
                    </button>
                    {detail.status !== 'archived' && (
                      <button onClick={() => archiveOrder(detail.id)}
                        className="px-5 py-2 rounded-lg bg-white border border-gray-300 text-sm text-gray-600 hover:bg-gray-50 transition">
                        归档
                      </button>
                    )}
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs text-gray-400 mb-0.5">{label}</p>
      <p className={`text-sm text-gray-800 break-words ${mono ? 'font-mono text-xs' : ''}`}>{value}</p>
    </div>
  );
}
