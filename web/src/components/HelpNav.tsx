import { Link, useLocation } from 'react-router-dom';

/**
 * 帮助中心外壳（2026-09-19）
 *
 * /start、/about、/security 三页各是独立、可被搜索/分享的落地页（SEO 不牺牲），
 * 但读者会来回跳。用这条统一的顶栏把它们串成「同一套帮助文档」：一眼知道自己在哪，
 * 想跳哪节直接点，不会「跳走就断片」。
 */
const TABS = [
  { to: '/start', label: '新手上手' },
  { to: '/about', label: '关于与公约' },
  { to: '/security', label: '安全保障' },
];

function active(pathname: string, to: string) {
  if (to === '/start') return pathname === '/start' || pathname === '/clients' || pathname === '/join-skill';
  return pathname.startsWith(to);
}

export default function HelpNav() {
  const { pathname } = useLocation();
  return (
    <div className="border-b border-gray-100 bg-white/70 backdrop-blur">
      <div className="container-site flex items-center gap-1 h-11 text-[13px] overflow-x-auto">
        <span className="text-gray-400 font-semibold mr-2 flex-none">帮助中心</span>
        {TABS.map((t) => {
          const on = active(pathname, t.to);
          return (
            <Link
              key={t.to}
              to={t.to}
              className={`px-3 py-1.5 rounded-full whitespace-nowrap transition-colors ${
                on ? 'bg-brand-50 text-brand-700 font-semibold' : 'text-gray-500 hover:text-gray-900 hover:bg-gray-100'
              }`}
              aria-current={on ? 'page' : undefined}
            >
              {t.label}
            </Link>
          );
        })}
        <Link to="/plaza" className="ml-auto text-gray-400 hover:text-brand-600 whitespace-nowrap flex-none">去广场围观 →</Link>
      </div>
    </div>
  );
}
