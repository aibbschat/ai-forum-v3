import { useState } from 'react';
import { Link } from 'react-router-dom';

const NAV_LINKS = [
  { label: '首页', to: '/' },
  { label: '关于', to: '/search' },
];

export default function Nav() {
  const [open, setOpen] = useState(false);

  return (
    <nav className="bg-white border-b border-gray-100 sticky top-0 z-50">
      <div className="container-site h-14 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/" className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gray-900 flex items-center justify-center">
              <span className="text-white text-sm font-bold serif">洞</span>
            </div>
            <span className="text-lg font-extrabold tracking-tight">专业洞察</span>
            <span className="text-xs text-gray-400 ml-1 hidden sm:inline">by AI 圈</span>
          </Link>
        </div>

        {/* 桌面导航 */}
        <div className="hidden md:flex items-center gap-5">
          {NAV_LINKS.map((l) => (
            <Link key={l.label} to={l.to} className="text-sm text-gray-500 hover:text-gray-900 transition-colors">
              {l.label}
            </Link>
          ))}
          <Link to="/search" className="text-sm text-gray-500 hover:text-gray-900 transition-colors">搜索</Link>
          <Link to="/me" className="w-8 h-8 rounded-full bg-gray-200 hover:bg-gray-300 transition-colors" aria-label="个人中心" />
        </div>

        {/* 移动端汉堡 */}
        <button
          className="md:hidden w-9 h-9 flex items-center justify-center rounded hover:bg-gray-100 transition-colors"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? '关闭菜单' : '打开菜单'}
          aria-expanded={open}
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            {open ? (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16" />
            )}
          </svg>
        </button>
      </div>

      {/* 移动端下拉菜单 */}
      {open && (
        <div className="md:hidden bg-white border-t border-gray-100">
          <div className="container-site py-2 flex flex-col">
            <Link to="/" onClick={() => setOpen(false)} className="py-2.5 text-sm text-gray-600 hover:text-gray-900">首页</Link>
            <Link to="/search" onClick={() => setOpen(false)} className="py-2.5 text-sm text-gray-600 hover:text-gray-900">搜索</Link>
            <Link to="/me" onClick={() => setOpen(false)} className="py-2.5 text-sm text-gray-600 hover:text-gray-900">个人中心</Link>
          </div>
        </div>
      )}
    </nav>
  );
}
