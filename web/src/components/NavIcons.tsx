/**
 * 导航用图标：与 logo 同源的语言（开口环 + 入圈者），
 * 统一 stroke 1.8 / viewBox 24 / currentColor，替掉原先的系统 emoji 🤖。
 * 尺寸由 className 控制，14px 起仍可读。
 */
type P = { className?: string };

/** Agent 广场：开口环 + 一颗正在入圈的点 */
export const RingDotIcon = ({ className = 'w-4 h-4' }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path d="M21 12a9 9 0 11-9-9" strokeLinecap="round" />
    <circle cx="17.6" cy="6.4" r="2.6" fill="currentColor" stroke="none" />
  </svg>
);

/** 我的 Agent：双环，表达「你名下有多个 Agent」 */
export const DoubleRingIcon = ({ className = 'w-4 h-4' }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <circle cx="9" cy="9.5" r="5.2" />
    <circle cx="17.6" cy="15.2" r="3.4" fill="currentColor" stroke="none" />
    <path d="M12.4 12.2l2.6 2.1" strokeLinecap="round" />
  </svg>
);

/** 外链角标 ↗ */
export const ExternalIcon = ({ className = 'w-3 h-3' }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
  </svg>
);

/** 下拉指示 */
export const ChevronDownIcon = ({ className = 'w-3.5 h-3.5' }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const EnvelopeIcon = ({ className = 'w-5 h-5' }: P) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l9 6 9-6M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
  </svg>
);

/** 移动端抽屉里的行图标 */
export const NavRowIcon = ({ name, className = 'w-4 h-4' }: P & { name: string }) => {
  const paths: Record<string, React.ReactNode> = {
    home: <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h10M4 18h7" />,
    // 广场：与 RingDotIcon 同形，供移动端抽屉行使用
    ring: (
      <>
        <path strokeLinecap="round" d="M21 12a9 9 0 11-9-9" />
        <circle cx="17.6" cy="6.4" r="2.6" fill="currentColor" stroke="none" />
      </>
    ),
    search: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path strokeLinecap="round" d="M20 20l-4-4" />
      </>
    ),
    chat: <path strokeLinecap="round" strokeLinejoin="round" d="M20.5 11.6c0 3.8-3.8 6.9-8.5 6.9-1 0-2-.15-2.9-.43L4 20l1.2-3.4A6.6 6.6 0 013.5 11.6C3.5 7.8 7.3 4.7 12 4.7s8.5 3.1 8.5 6.9z" />,
    book: <path strokeLinecap="round" strokeLinejoin="round" d="M4 5.5A2.5 2.5 0 016.5 3H12v18H6.5A2.5 2.5 0 004 18.5v-13zM20 5.5A2.5 2.5 0 0017.5 3H12v18h5.5a2.5 2.5 0 012.5 2.5v-18z" />,
    write: <path strokeLinecap="round" strokeLinejoin="round" d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" />,
    bell: <path strokeLinecap="round" strokeLinejoin="round" d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 10-12 0v3.2a2 2 0 01-.6 1.4L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />,
  };
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      {paths[name] ?? paths.home}
    </svg>
  );
};
