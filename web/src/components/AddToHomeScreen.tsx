import { useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISS_KEY = 'aiforum_a2hs_dismissed_at';
const SHOW_EVERY_DAYS = 14;

/**
 * "添加到主屏"提示：仅在 beforeinstallprompt 事件触发时可用（Android/桌面 Chromium）。
 * iOS Safari 不触发该事件，所以组件会自动改显式"在 Safari 中分享 → 添加到主屏"指引。
 * 同一个用户最多每 14 天提示一次（localStorage 记录）。
 */
export default function AddToHomeScreen() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIos, setShowIos] = useState(false);

  useEffect(() => {
    const lastDismiss = Number(localStorage.getItem(DISMISS_KEY) || 0);
    const tooSoon = Date.now() - lastDismiss < SHOW_EVERY_DAYS * 86400_000;
    if (tooSoon) return;

    // 已安装则不提示
    // @ts-expect-error iOS Safari standalone
    if (window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches) return;

    const onBIP = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onBIP);

    // iOS 判断：iPhone/iPad + Safari + 未安装
    const ua = window.navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua) && !(window as unknown as { MSStream?: unknown }).MSStream;
    const isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(ua);
    if (isIOS && isSafari) setShowIos(true);

    return () => window.removeEventListener('beforeinstallprompt', onBIP);
  }, []);

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
    setDeferred(null);
    setShowIos(false);
  };

  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice.catch(() => {});
    setDeferred(null);
  };

  if (!deferred && !showIos) return null;

  return (
    <div className="fixed bottom-4 inset-x-4 md:left-auto md:right-6 md:bottom-6 md:max-w-[320px] z-40">
      <div className="bg-white rounded-2xl shadow-2xl border border-gray-100 p-4">
        <div className="flex items-start gap-3">
          <img src="/logo.svg" alt="" className="w-10 h-10 rounded-xl" />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold text-gray-900">把 AI 圈添加到主屏</div>
            <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">
              {deferred
                ? '像原生 App 一样从主屏直接进入，离线也能看缓存文章。'
                : '在 Safari 底部分享按钮中选择「添加到主屏幕」。'}
            </p>
            <div className="flex gap-2 mt-3">
              {deferred && (
                <button
                  type="button"
                  onClick={install}
                  className="px-3 py-1.5 bg-gray-900 text-white text-xs font-semibold rounded-full hover:bg-gray-800"
                >
                  立即添加
                </button>
              )}
              <button
                type="button"
                onClick={dismiss}
                className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-700"
              >
                以后再说
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
