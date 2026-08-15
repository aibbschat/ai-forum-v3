import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getToken, fetchMe, clearToken, logout, type AuthUser } from '../api';

const NAV_LINKS = [
  { label: '首页', to: '/' },
  { label: '搜索', to: '/search' },
];

export default function Nav() {
  const [open, setOpen] = useState(false); // 移动端汉堡
  const [me, setMe] = useState<AuthUser | null>(null);
  const [menuOpen, setMenuOpen] = useState(false); // 头像悬浮菜单
  const menuTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (getToken()) {
      fetchMe()
        .then(setMe)
        .catch(() => setMe(null));
    }
  }, []);

  const openMenu = () => {
    if (menuTimer.current) clearTimeout(menuTimer.current);
    setMenuOpen(true);
  };
  const closeMenuSoon = () => {
    if (menuTimer.current) clearTimeout(menuTimer.current);
    menuTimer.current = setTimeout(() => setMenuOpen(false), 120);
  };

  const handleLogout = async () => {
    setMenuOpen(false);
    try {
      await logout();
    } catch {
      /* ignore */
    }
    clearToken();
    setMe(null);
    navigate('/');
  };

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

          {me && (
            <Link
              to="/write"
              className="text-sm font-semibold text-white bg-gray-900 hover:bg-gray-800 px-3.5 py-1.5 rounded-full transition-colors"
            >
              写文章
            </Link>
          )}

          {/* 用户区：悬浮菜单 */}
          <div className="relative" onMouseEnter={openMenu} onMouseLeave={closeMenuSoon}>
            {me ? (
              <button
                className="w-8 h-8 rounded-full overflow-hidden border border-gray-200 hover:ring-2 hover:ring-gray-300 transition"
                aria-label="用户菜单"
              >
                {me.avatar ? (
                  <img src={me.avatar} alt={me.nickname} className="w-full h-full object-cover" />
                ) : (
                  <span className="w-full h-full flex items-center justify-center bg-gray-200 text-gray-600 text-xs">
                    {me.nickname?.[0] || '我'}
                  </span>
                )}
              </button>
            ) : (
              <button
                className="text-sm font-semibold text-gray-700 hover:text-gray-900 transition-colors px-2 py-1"
                aria-label="用户菜单"
              >
                登录
              </button>
            )}

            {menuOpen && (
              <div
                className="absolute right-0 mt-2 w-40 bg-white border border-gray-100 rounded-xl shadow-lg py-1.5 z-50"
                onMouseEnter={openMenu}
                onMouseLeave={closeMenuSoon}
              >
                {me ? (
                  <>
                    <Link
                      to="/me"
                      className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                      onClick={() => setMenuOpen(false)}
                    >
                      个人中心
                    </Link>
                    <button
                      onClick={handleLogout}
                      className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                    >
                      退出登录
                    </button>
                  </>
                ) : (
                  <>
                    <Link
                      to="/register"
                      className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                      onClick={() => setMenuOpen(false)}
                    >
                      注册
                    </Link>
                    <Link
                      to="/login"
                      className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                      onClick={() => setMenuOpen(false)}
                    >
                      登录
                    </Link>
                    <Link
                      to="/me"
                      className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                      onClick={() => setMenuOpen(false)}
                    >
                      个人中心
                    </Link>
                  </>
                )}
              </div>
            )}
          </div>
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
          <div className="px-6 py-2 flex flex-col">
            <Link to="/" onClick={() => setOpen(false)} className="py-2.5 text-sm text-gray-600 hover:text-gray-900">首页</Link>
            <Link to="/search" onClick={() => setOpen(false)} className="py-2.5 text-sm text-gray-600 hover:text-gray-900">搜索</Link>
            {me && (
              <Link to="/write" onClick={() => setOpen(false)} className="py-2.5 text-sm text-gray-900 font-semibold">写文章</Link>
            )}
            <Link to="/me" onClick={() => setOpen(false)} className="py-2.5 text-sm text-gray-600 hover:text-gray-900">个人中心</Link>
            {me ? (
              <button
                onClick={() => {
                  setOpen(false);
                  handleLogout();
                }}
                className="py-2.5 text-left text-sm text-gray-600 hover:text-gray-900"
              >
                退出登录
              </button>
            ) : (
              <>
                <Link to="/login" onClick={() => setOpen(false)} className="py-2.5 text-sm text-gray-600 hover:text-gray-900">登录</Link>
                <Link to="/register" onClick={() => setOpen(false)} className="py-2.5 text-sm text-gray-600 hover:text-gray-900">注册</Link>
              </>
            )}
          </div>
        </div>
      )}
    </nav>
  );
}
