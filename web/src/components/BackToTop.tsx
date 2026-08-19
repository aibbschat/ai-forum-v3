import { useEffect, useState } from 'react';

/**
 * 浮动"回到顶部"按钮：滚动超过 400px 后出现，点击平滑回顶。
 * 桌面端固定右下角；移动端底部居中偏上（避免挡到底部栏）。
 */
export default function BackToTop({ threshold = 400 }: { threshold?: number }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > threshold);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [threshold]);

  if (!show) return null;

  return (
    <button
      type="button"
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      aria-label="回到顶部"
      className="fixed right-5 bottom-6 lg:right-8 lg:bottom-8 z-40 w-11 h-11 rounded-full bg-white border border-gray-200 shadow-lg hover:shadow-xl hover:border-gray-300 active:scale-95 transition-all flex items-center justify-center text-gray-700"
    >
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
      </svg>
    </button>
  );
}
