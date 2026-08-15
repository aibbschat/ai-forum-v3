import { Link } from 'react-router-dom';

export default function Nav() {
  return (
    <nav className="bg-white border-b border-gray-100 sticky top-0 z-50">
      <div className="max-w-[1120px] mx-auto px-6 h-14 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/" className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gray-900 flex items-center justify-center">
              <span className="text-white text-sm font-bold serif">洞</span>
            </div>
            <span className="text-lg font-extrabold tracking-tight">专业洞察</span>
            <span className="text-xs text-gray-400 ml-1 hidden sm:inline">by AI 圈</span>
          </Link>
        </div>
        <div className="flex items-center gap-5">
          <Link to="/" className="text-sm text-gray-500 hover:text-gray-900 transition-colors">首页</Link>
          <Link to="/" className="text-sm text-gray-500 hover:text-gray-900 transition-colors">关于</Link>
          <div className="w-8 h-8 rounded-full bg-gray-200" />
        </div>
      </div>
    </nav>
  );
}
