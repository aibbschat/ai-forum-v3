import { useEffect, useMemo, useState } from 'react';

interface TocItem {
  id: string;
  text: string;
  level: number;
}

interface Props {
  /** 选择器，通常是 '.article-content'；组件会在该容器内扫描 h2/h3 */
  selector?: string;
}

/**
 * 文章目录（TOC）+ 顶部阅读进度条。
 * - 从正文 h2/h3 自动抽取，不依赖 markdown 插件
 * - 滚动时高亮当前章节（IntersectionObserver）
 * - 顶部 2px 进度条反映阅读进度
 */
export default function TableOfContents({ selector = '.article-content' }: Props) {
  const [items, setItems] = useState<TocItem[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [progress, setProgress] = useState(0);

  // 抽取标题
  useEffect(() => {
    const root = document.querySelector(selector);
    if (!root) return;
    const heads = Array.from(root.querySelectorAll('h2, h3')) as HTMLElement[];
    const list: TocItem[] = heads.map((h, i) => {
      let id = h.id;
      if (!id) {
        id = `sec-${i}-${(h.textContent || '').trim().slice(0, 24).replace(/\s+/g, '-')}`;
        h.id = id;
      }
      return {
        id,
        text: (h.textContent || '').trim(),
        level: h.tagName === 'H2' ? 2 : 3,
      };
    });
    setItems(list);
    if (list[0]) setActiveId(list[0].id);
  }, [selector]);

  // 高亮当前章节 + 进度
  useEffect(() => {
    if (items.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        // 选择最靠近顶部且正在进入视口的标题
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveId(visible[0].target.id);
      },
      { rootMargin: '-80px 0px -70% 0px', threshold: 0 }
    );
    items.forEach((it) => {
      const el = document.getElementById(it.id);
      if (el) observer.observe(el);
    });
    const onScroll = () => {
      const h = document.documentElement;
      const scrolled = h.scrollTop;
      const total = h.scrollHeight - h.clientHeight;
      setProgress(total > 0 ? Math.min(1, scrolled / total) : 0);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', onScroll);
    };
  }, [items]);

  const go = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    const y = el.getBoundingClientRect().top + window.scrollY - 72;
    window.scrollTo({ top: y, behavior: 'smooth' });
    setActiveId(id);
  };

  if (items.length < 2) {
    // 太短就不显示目录，但仍显示进度条
    return <ProgressBar progress={progress} />;
  }

  return (
    <>
      <ProgressBar progress={progress} />
      <nav
        aria-label="目录"
        className="hidden xl:block fixed top-24 right-[max(1rem,calc((100vw-var(--container-max))/2-220px))] w-[200px] text-sm"
      >
        <div className="border-l border-gray-200 pl-4">
          <div className="text-[11px] font-bold text-gray-400 tracking-widest mb-3">目录</div>
          <ul className="space-y-1.5">
            {items.map((it) => (
              <li key={it.id} style={{ paddingLeft: it.level === 3 ? 12 : 0 }}>
                <button
                  type="button"
                  onClick={() => go(it.id)}
                  className={`block text-left text-[13px] leading-snug transition-colors ${
                    activeId === it.id
                      ? 'text-brand-600 font-semibold'
                      : 'text-gray-400 hover:text-gray-700'
                  }`}
                >
                  {it.text}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </nav>
    </>
  );
}

function ProgressBar({ progress }: { progress: number }) {
  return (
    <div
      className="fixed top-0 left-0 right-0 h-[3px] bg-brand-600 z-[60] origin-left"
      style={{ transform: `scaleX(${progress})` }}
      aria-hidden
    />
  );
}
