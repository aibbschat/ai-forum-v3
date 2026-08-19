import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SHARE_TARGETS, buildQr } from '../utils/share';
import { toast } from '../utils/toast';

interface ShareButtonProps {
  url: string;
  title: string;
  description?: string;
  /** 触发按钮样式变体 */
  variant?: 'icon' | 'pill' | 'ghost';
  /** 自定义触发按钮 inner */
  children?: React.ReactNode;
  className?: string;
}

/**
 * 通用分享按钮：点击弹菜单（桌面）/ 系统原生（手机）。
 * 同时包含微信/小红书二维码弹窗。
 */
export default function ShareButton({
  url,
  title,
  description,
  variant = 'ghost',
  children,
  className = '',
}: ShareButtonProps) {
  const [open, setOpen] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [qrTitle, setQrTitle] = useState(title);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const showQr = async (targetUrl: string, t: string) => {
    setQrTitle(t);
    setQrOpen(true);
    setOpen(false);
    if (!qr) {
      try {
        const d = await buildQr(targetUrl);
        setQr(d);
      } catch {
        toast.error('二维码生成失败');
        setQrOpen(false);
      }
    }
  };

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    // 始终显示我们自己的社交菜单（微博/豆瓣/知乎/微信二维码...），
    // 用户可在菜单里选「系统分享」去调起 AirDrop / 邮件 / 备忘录等系统级目标。
    // 这样在 macOS Safari/Chrome 等支持 navigator.share 的桌面浏览器上，
    // 也不会只弹一个缺社交平台的原生分享面板。
    toggleMenu();
  };

  const toggleMenu = () => {
    if (open) {
      setOpen(false);
      return;
    }
    if (btnRef.current && window.innerWidth >= 768) {
      const r = btnRef.current.getBoundingClientRect();
      // 宫格尺寸：5 列 × 2 行，每个 cell ~60px 宽，含 padding
      const menuW = 320;
      const menuH = 156;
      const margin = 8;

      // 水平：默认把菜单左边对齐按钮左边；超出右边则左推；左边不够则贴左
      let left = r.left;
      if (left + menuW > window.innerWidth - margin) {
        left = r.right - menuW;
      }
      left = Math.max(margin, Math.min(left, window.innerWidth - menuW - margin));

      // 垂直：优先按钮下方；下方不够则上方；都不够则贴底
      let top = r.bottom + 8;
      if (top + menuH > window.innerHeight - margin) {
        const above = r.top - 8 - menuH;
        if (above >= margin) {
          top = above;
        } else {
          top = Math.max(margin, window.innerHeight - menuH - margin);
        }
      }
      setPos({ top, left });
    } else {
      setPos(null); // 移动端走底部居中面板
    }
    setOpen(true);
  };

  const runTarget = async (key: string) => {
    const target = SHARE_TARGETS.find((t) => t.key === key);
    if (!target) return;
    await target.run({ url, title, description, showQr });
    setOpen(false);
  };

  const baseCls =
    variant === 'icon'
      ? 'w-8 h-8 flex items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 transition-colors'
      : variant === 'pill'
      ? 'inline-flex items-center gap-1.5 text-sm font-semibold text-gray-700 border border-gray-200 rounded-full px-3 py-1.5 hover:border-gray-400 transition-colors'
      : 'inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors';

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={handleClick}
        className={`${baseCls} ${className}`}
        aria-label="分享"
      >
        {children ?? (
          <>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 12v7a2 2 0 002 2h12a2 2 0 002-2v-7M16 6l-4-4-4 4M12 2v13" />
            </svg>
            {variant === 'pill' ? '分享' : null}
          </>
        )}
      </button>

      {open && !qrOpen && createPortal(
        <>
          {pos ? (
            <div
              ref={menuRef}
              className="fixed z-[9999] bg-white rounded-2xl shadow-2xl border border-gray-100 p-3 w-[320px] animate-slide-up"
              style={{ top: pos.top, left: pos.left }}
            >
              <div className="grid grid-cols-5 gap-1">
                {SHARE_TARGETS.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => runTarget(t.key)}
                    className="flex flex-col items-center gap-1.5 py-2 rounded-lg hover:bg-gray-50 active:bg-gray-100 transition-colors"
                  >
                    <span className="text-2xl leading-none">{t.emoji}</span>
                    <span className="text-[11px] text-gray-600 leading-tight">{t.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            // 移动端：底部抽屉
            <div className="fixed inset-0 z-[9999] flex items-end" onClick={() => setOpen(false)}>
              <div className="absolute inset-0 bg-black/40" />
              <div
                ref={menuRef}
                className="relative w-full bg-white rounded-t-2xl p-4 pb-6 animate-slide-up"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="w-10 h-1 bg-gray-200 rounded-full mx-auto mb-4" />
                <div className="grid grid-cols-5 gap-2">
                  {SHARE_TARGETS.map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => runTarget(t.key)}
                      className="flex flex-col items-center gap-1.5 py-2 active:bg-gray-50 rounded-lg"
                    >
                      <span className="text-2xl">{t.emoji}</span>
                      <span className="text-xs text-gray-600">{t.label}</span>
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="mt-4 w-full py-2.5 text-sm text-gray-500 border-t border-gray-100"
                >
                  取消
                </button>
              </div>
            </div>
          )}
        </>,
        document.body
      )}

      {qrOpen && createPortal(
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 p-4"
          onClick={() => setQrOpen(false)}
        >
          <div
            className="bg-white rounded-2xl p-6 max-w-[320px] w-full text-center"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-bold text-gray-900">扫码分享</h3>
              <button
                type="button"
                onClick={() => setQrOpen(false)}
                className="text-gray-400 hover:text-gray-700"
                aria-label="关闭"
              >
                ✕
              </button>
            </div>
            {qr ? (
              <img src={qr} alt="二维码" className="w-[220px] h-[220px] mx-auto mb-3" />
            ) : (
              <div className="w-[220px] h-[220px] mx-auto mb-3 bg-gray-50 rounded animate-pulse" />
            )}
            <p className="text-xs text-gray-500 line-clamp-2 break-all mb-2">{qrTitle}</p>
            <p className="text-[11px] text-gray-400">微信 / 小红书 扫一扫打开</p>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
