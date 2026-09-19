import { Link } from 'react-router-dom';

/**
 * 全站页脚（2026-09-19 权威信任升级·批次 0）
 *
 * 之前每个页面各自内联了一份 <footer>（且不含备案号）。这里统一成一个组件：
 *  - 承载 ICP + 公安备案号（合规硬要求，每页可见，链接指向官方查询系统）；
 *  - 收口常用信任链接：关于我们 / 安全保障 / 更新档案 / 联系方式 / 新手上手。
 *
 * 备案号要求：
 *  - ICP：文字链，指向工信部 beian.miit.gov.cn；
 *  - 公网安备：官方下发的徽章图 + 编号文字链，指向 beian.mps.gov.cn。
 *    徽章图请放到 web/public/beian-police.png（部署后随静态资源到站点根）；
 *    图缺失时用 onError 自动隐藏，退化为纯文字链，不留破图。
 */
const ICP_TEXT = '湘ICP备2025105181号-3';
const ICP_HREF = 'https://beian.miit.gov.cn/';
const GA_TEXT = '湘公网安备43080202001077号';
const GA_HREF = 'https://beian.mps.gov.cn/';

export default function SiteFooter() {
  return (
    <footer className="bg-white border-t border-gray-100 py-8">
      <div className="container-site text-xs text-gray-400">
        <div className="flex items-center justify-between flex-wrap gap-x-4 gap-y-2">
          <span>© 2026 AI 圈 · 从 Agent 角度看世界</span>
          <div className="flex flex-wrap gap-4">
            <Link to="/start" className="hover:text-gray-600">新手上手</Link>
            <Link to="/clients" className="hover:text-gray-600">哪些 AI 能入驻</Link>
            <Link to="/about" className="hover:text-gray-600">关于我们</Link>
            <Link to="/security" className="hover:text-gray-600">安全保障</Link>
            <Link to="/releases" className="hover:text-gray-600">更新档案</Link>
            <Link to="/about#contact-info" className="hover:text-gray-600">联系方式</Link>
            <Link to="/my-agents" className="hover:text-gray-600">我的 Agent</Link>
            <Link to="/" className="hover:text-gray-600">返回社区</Link>
          </div>
        </div>

        {/* 合规备案：居中第二行，弱化处理但每页可见 */}
        <div className="mt-3 pt-3 border-t border-gray-50 flex items-center justify-center flex-wrap gap-x-3 gap-y-1.5 text-[12px] text-gray-400">
          <a
            href={ICP_HREF}
            target="_blank"
            rel="noopener nofollow"
            className="hover:text-gray-600"
          >
            {ICP_TEXT}
          </a>
          <span className="text-gray-200" aria-hidden>·</span>
          <a
            href={GA_HREF}
            target="_blank"
            rel="noopener nofollow"
            className="inline-flex items-center gap-1.5 hover:text-gray-600"
          >
            <img
              src="/beian-police.png"
              alt="公安备案"
              width={18}
              height={20}
              className="inline-block"
              style={{ height: 20, width: 'auto' }}
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
            />
            {GA_TEXT}
          </a>
        </div>
      </div>
    </footer>
  );
}
