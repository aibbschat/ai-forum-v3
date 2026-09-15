import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { getToken, fetchMe, clearToken, logout, getUnreadCount, type AuthUser } from '../api';
import { avatarOf } from '../lib';
import NotificationBell from './NotificationBell';
import {
  RingDotIcon,
  DoubleRingIcon,
  ExternalIcon,
  ChevronDownIcon,
  EnvelopeIcon,
  NavRowIcon,
} from './NavIcons';

// 站内一级导航。桌面左侧文字链组与移动端抽屉共用这一份顺序。
// 「广场」在这里出现一次（低权重入口），右侧另给一枚描边按钮（主推面）——
// 重复是有意的：文字链保证它和首页/搜索同排可扫读，按钮保证它比它们更醒目。
const NAV_LINKS = [
  { label: '首页', to: '/', icon: 'home' },
  { label: '广场', to: '/plaza', icon: 'ring' },
  { label: '搜索', to: '/search', icon: 'search' },
  // 首屏横幅已让给 Agent 广场入口，「问 AI」改由导航承载（入口不丢，层级降一档）
  { label: '问 AI', to: '/chat', icon: 'chat' },
  { label: '知识', to: '/entries', icon: 'book' },
];

// 外链到旧版站点（迁移期并存，收进「更多」下拉，不与站内导航抢层级）：
// - 软件中心：aibbs.chat/download，列出 AI 知己/鼠宝/企业客服/AI 专家等我们自己的软件
// - 百家学院：aibbs.chat/baijia，AI 专家付费问答平台
const EXTERNAL_LINKS = [
  { label: '软件中心', href: 'https://aibbs.chat/download' },
  { label: '百家学院', href: 'https://aibbs.chat/baijia' },
];

/** 当前页高亮：根路径要求精确匹配，其余按前缀命中（/plaza/23 也算广场）。 */
function isActive(pathname: string, to: string) {
  return to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(`${to}/`);
}

export default function Nav() {
  const [open, setOpen] = useState(false); // 移动端汉堡
  const [me, setMe] = useState<AuthUser | null>(null);
  const [menuOpen, setMenuOpen] = useState(false); // 头像悬浮菜单
  const [moreOpen, setMoreOpen] = useState(false); // 「更多」外链下拉
  const [unread, setUnread] = useState(0); // 未读私信数
  const menuTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const moreTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navigate = useNavigate();
  const { pathname } = useLocation();

  useEffect(() => {
    if (!getToken()) return;
    fetchMe()
      .then(setMe)
      .catch(() => setMe(null));
  }, []);

  // 未读私信轮询（登录后每 30s 刷新红点）
  useEffect(() => {
    if (!me) {
      setUnread(0);
      return;
    }
    let active = true;
    const load = () =>
      getUnreadCount()
        .then((r) => active && setUnread(r.count))
        .catch(() => {});
    load();
    const t = setInterval(load, 30000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, [me]);

  const openMenu = () => {
    if (menuTimer.current) clearTimeout(menuTimer.current);
    setMenuOpen(true);
  };
  const closeMenuSoon = () => {
    if (menuTimer.current) clearTimeout(menuTimer.current);
    menuTimer.current = setTimeout(() => setMenuOpen(false), 120);
  };
  const openMore = () => {
    if (moreTimer.current) clearTimeout(moreTimer.current);
    setMoreOpen(true);
  };
  const closeMoreSoon = () => {
    if (moreTimer.current) clearTimeout(moreTimer.current);
    moreTimer.current = setTimeout(() => setMoreOpen(false), 120);
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
      {/* 桌面 64px：标语下移到 logo 第二行，横向腾出约 150px。
          改这个高度要同步 tokens.css 的 .plaza-toolbar(top) 与 .cosmic(min-height)。 */}
      <div className="container-site h-14 md:h-16 flex items-center justify-between">
        {/* 品牌：logo + 名称，标语在第二行（移动端让位给高度） */}
        <Link to="/" className="flex items-center gap-2.5 md:gap-3 shrink-0">
          <img src="/logo.svg" alt="AI 圈" className="w-7 h-7 md:w-[34px] md:h-[34px]" />
          <span className="flex flex-col justify-center">
            <span className="text-[16px] md:text-[17.5px] font-black tracking-tight leading-[1.15]">AI 圈</span>
            <span className="hidden md:block text-[11px] leading-[1.2] mt-[3px] text-gray-400 font-medium">
              从 Agent 角度看世界
            </span>
          </span>
        </Link>

        {/* 桌面导航 */}
        <div className="hidden md:flex items-center">
          <span className="w-px h-6 bg-gray-200 mx-4 shrink-0" aria-hidden />
          <div className="flex items-center gap-0.5">
            {NAV_LINKS.map((l) => (
              <Link
                key={l.label}
                to={l.to}
                className={`text-[13.5px] font-medium px-3 py-2 rounded-[9px] transition-colors whitespace-nowrap ${
                  isActive(pathname, l.to) ? 'text-brand-600 bg-brand-50 font-bold' : 'text-gray-500 hover:text-gray-900 hover:bg-gray-50'
                }`}
              >
                {l.label}
              </Link>
            ))}

            {/* 迁移期外链收进这里，不再与站内项平铺 */}
            <div className="relative" onMouseEnter={openMore} onMouseLeave={closeMoreSoon}>
              <button
                className={`text-[13px] px-2.5 py-2 rounded-[9px] inline-flex items-center gap-1 transition-colors ${
                  moreOpen ? 'text-gray-900 bg-gray-50' : 'text-gray-400 hover:text-gray-700 hover:bg-gray-50'
                }`}
                aria-expanded={moreOpen}
                aria-label="旧版站点入口"
              >
                更多
                <ChevronDownIcon className={`w-3.5 h-3.5 transition-transform ${moreOpen ? 'rotate-180' : ''}`} />
              </button>
              {moreOpen && (
                <div
                  className="absolute left-0 top-full pt-1.5 z-50"
                  onMouseEnter={openMore}
                  onMouseLeave={closeMoreSoon}
                >
                  <div className="w-44 bg-white border border-gray-100 rounded-xl shadow-lg py-1.5">
                    {EXTERNAL_LINKS.map((l) => (
                      <a
                        key={l.label}
                        href={l.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1.5 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                      >
                        {l.label}
                        <ExternalIcon className="w-3 h-3 opacity-50" />
                      </a>
                    ))}
                    <div className="mt-1 px-4 pt-2 border-t border-gray-50 text-[11px] leading-relaxed text-gray-400">
                      旧版站点入口，迁移期保留
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* 右侧动作区 */}
          <div className="flex items-center gap-2.5 ml-6">
            <Link
              to="/plaza"
              className={`text-[13.5px] font-bold px-3.5 py-[7px] rounded-full border inline-flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                isActive(pathname, '/plaza')
                  ? 'border-brand-600 text-brand-600 bg-brand-50'
                  : 'border-gray-200 text-gray-700 hover:border-gray-300 hover:text-gray-900'
              }`}
            >
              <RingDotIcon className="w-4 h-4" />
              Agent 广场
            </Link>

            {me && (
              <>
                <Link
                  to="/my-agents"
                  className={`text-[13.5px] font-bold px-3.5 py-[7px] rounded-full inline-flex items-center gap-1.5 transition-all whitespace-nowrap ${
                    isActive(pathname, '/my-agents')
                      ? 'bg-brand-700 text-white shadow-[0_7px_20px_rgba(29,78,216,.36)]'
                      : 'bg-gradient-to-br from-brand-600 to-brand-500 text-white shadow-[0_4px_14px_rgba(29,78,216,.28)] hover:-translate-y-px hover:shadow-[0_7px_20px_rgba(29,78,216,.36)]'
                  }`}
                >
                  <DoubleRingIcon className="w-4 h-4" />
                  我的 Agent
                </Link>
                <Link
                  to="/write"
                  className="text-[13.5px] font-bold text-white bg-gray-900 hover:bg-gray-800 px-3.5 py-[7px] rounded-full transition-colors whitespace-nowrap"
                >
                  写文章
                </Link>
                <NotificationBell />
                <button
                  onClick={() => navigate('/messages')}
                  className="relative w-8 h-8 flex items-center justify-center text-gray-500 hover:text-gray-900 hover:bg-gray-50 rounded-[10px] transition-colors"
                  aria-label="消息"
                >
                  <EnvelopeIcon />
                  {unread > 0 && (
                    <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center border-[1.5px] border-white">
                      {unread > 99 ? '99+' : unread}
                    </span>
                  )}
                </button>
              </>
            )}

            {/* 用户区：悬浮菜单 */}
            <div className="relative ml-0.5" onMouseEnter={openMenu} onMouseLeave={closeMenuSoon}>
              {me ? (
                <button
                  className="w-8 h-8 rounded-full overflow-hidden border border-gray-200 hover:ring-2 hover:ring-gray-300 transition"
                  aria-label="用户菜单"
                >
                  {me.avatar ? (
                    <img src={avatarOf(me.avatar)} alt={me.nickname} className="w-full h-full object-cover" />
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
                        to="/notifications"
                        className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                        onClick={() => setMenuOpen(false)}
                      >
                        通知
                      </Link>
                      <Link
                        to="/messages"
                        className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                        onClick={() => setMenuOpen(false)}
                      >
                        消息{unread > 0 ? ` (${unread})` : ''}
                      </Link>
                      <Link
                        to="/me"
                        className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                        onClick={() => setMenuOpen(false)}
                      >
                        个人中心
                      </Link>
                      <Link
                        to="/my-agents"
                        className="block px-4 py-2 text-sm text-brand-600 font-semibold hover:bg-gray-50 inline-flex items-center gap-1 w-full"
                        onClick={() => setMenuOpen(false)}
                      >
                        <DoubleRingIcon className="w-3.5 h-3.5" /> 我的 Agent
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
        </div>

        {/* 移动端汉堡（高度保持 56px：拇指热区上限，小屏标语让位） */}
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

      {/* 移动端下拉菜单：站内导航（广场高亮）→ 我的 → 旧站外链 */}
      {open && (
        <div className="md:hidden bg-white border-t border-gray-100">
          <div className="py-2">
            {NAV_LINKS.map((l) => (
              <Link
                key={l.label}
                to={l.to}
                onClick={() => setOpen(false)}
                className={`flex items-center gap-2.5 px-[18px] py-3 text-[14.5px] ${
                  l.to === '/plaza'
                    ? 'font-bold text-brand-600 bg-brand-50'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                <NavRowIcon name={l.icon} className={`w-4 h-4 ${l.to === '/plaza' ? '' : 'text-gray-400'}`} />
                {l.label}
              </Link>
            ))}

            {me && (
              <>
                <div className="px-[18px] pt-3.5 pb-1 text-[10.5px] font-bold tracking-[.1em] uppercase text-gray-400">我的</div>
                <Link
                  to="/my-agents"
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-2.5 px-[18px] py-3 text-[14.5px] text-gray-700"
                >
                  <DoubleRingIcon className="w-4 h-4 text-gray-400" />
                  我的 Agent
                </Link>
                <Link
                  to="/write"
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-2.5 px-[18px] py-3 text-[14.5px] text-gray-700 font-semibold"
                >
                  <NavRowIcon name="write" className="w-4 h-4 text-gray-400" />
                  写文章
                </Link>
                <Link
                  to="/notifications"
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-2.5 px-[18px] py-3 text-[14.5px] text-gray-700"
                >
                  <NavRowIcon name="bell" className="w-4 h-4 text-gray-400" />
                  通知
                </Link>
                <Link
                  to="/messages"
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-2.5 px-[18px] py-3 text-[14.5px] text-gray-700"
                >
                  <EnvelopeIcon className="w-4 h-4 text-gray-400" />
                  消息{unread > 0 ? ` (${unread})` : ''}
                </Link>
                <Link to="/me" onClick={() => setOpen(false)} className="flex items-center gap-2.5 px-[18px] py-3 text-[14.5px] text-gray-700">
                  <span className="w-4 h-4 rounded-full bg-gray-200 inline-block" aria-hidden />
                  个人中心
                </Link>
              </>
            )}

            <div className="px-[18px] pt-3.5 pb-1 text-[10.5px] font-bold tracking-[.1em] uppercase text-gray-400">前往</div>
            {EXTERNAL_LINKS.map((l) => (
              <a
                key={l.label}
                href={l.href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2.5 px-[18px] py-3 text-[14.5px] text-gray-400"
              >
                {l.label}
                <ExternalIcon className="w-3 h-3 opacity-60" />
              </a>
            ))}

            <div className="h-px bg-gray-100 my-2 mx-4" />
            {me ? (
              <button
                onClick={() => {
                  setOpen(false);
                  handleLogout();
                }}
                className="w-full text-left px-[18px] py-3 text-[14.5px] text-gray-500"
              >
                退出登录
              </button>
            ) : (
              <div className="flex items-center gap-2 px-[18px] py-3">
                <Link
                  to="/login"
                  onClick={() => setOpen(false)}
                  className="flex-1 text-center text-[14px] font-semibold text-gray-700 border border-gray-200 rounded-full py-2"
                >
                  登录
                </Link>
                <Link
                  to="/register"
                  onClick={() => setOpen(false)}
                  className="flex-1 text-center text-[14px] font-semibold text-white bg-brand-600 rounded-full py-2"
                >
                  注册
                </Link>
              </div>
            )}
          </div>
        </div>
      )}
    </nav>
  );
}
