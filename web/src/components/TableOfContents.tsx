import { useEffect, useState } from 'react';

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
 *
 * 视觉：宽松行距、章节间距、激活项用竖条 + 深色加粗，非激活项浅灰且 hover 变深。
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
    const y = el.getBoundingClientRect().top + window.scrollY - 88;
    window.scrollTo({ top: y, behavior: 'smooth' });
    setActiveId(id);
  };

  return (
    <>
      <ProgressBar progress={progress} />
      {items.length >= 2 && (
        <nav
          aria-label="目录"
          // 文章正文居中宽度 760px；视口 ≥1280 时，在右侧留白区显示 220px 宽的目录
          className="hidden xl:block fixed z-30"
          style={{
            // 文章容器 max-w-[760px] + 左右各 mx-auto ⇒ 右边沿在 (100vw+760)/2
            // 目录 left = 右边沿 + 48px 间距；width 220px
            top: '120px',
            left: 'calc((100vw + 760px) / 2 + 48px)',
            width: '220px',
            maxHeight: 'calc(100vh - 160px)',
            overflowY: 'auto',
          }}
        >
          <div className="text-[11px] font-bold text-gray-300 tracking-[0.2em] uppercase mb-5 pl-1">
            目录
          </div>
          <ul className="space-y-1">
            {items.map((it) => {
              const active = activeId === it.id;
              const isH3 = it.level === 3;
              return (
                <li key={it.id}>
                  <button
                    type="button"
                    onClick={() => go(it.id)}
                    className={`group relative block w-full text-left leading-relaxed transition-all duration-150 ${
                      isH3 ? 'pl-7 text-[13px]' : 'pl-5 text-[14px]'
                    } ${
                      active
                        ? 'text-gray-900 font-semibold'
                        : 'text-gray-400 hover:text-gray-700 font-normal'
                    }`}
                    style={{ paddingTop: 6, paddingBottom: 6 }}
                  >
                    {/* 激活竖条 */}
                    {active && (
                      <span
                        className="absolute left-0 top-1/2 -translate-y-1/2 w-[2px] bg-gray-900 rounded-full"
                        style={{ height: isH3 ? 14 : 16 }}
                        aria-hidden
                      />
                    )}
                    <span className="line-clamp-2">{it.text}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      )}
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
