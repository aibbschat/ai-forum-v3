// 社交分享：微博/豆瓣/QQ/知乎/简书/头条/微信二维码/复制链接/系统原生。
// 不引第三方 SDK，全部走平台分享 URL 或 navigator.share。微信/小红书走二维码兜底。
import { qrDataUrl } from './qrcode';

export interface ShareTarget {
  key: string;
  label: string;
  emoji: string;
  // 命中时执行：返回 true 表示已处理（关闭菜单）；返回 false 表示走兜底
  run: (ctx: ShareContext) => boolean | Promise<boolean>;
}

export interface ShareContext {
  url: string;
  title: string;
  description?: string;
  // 二维码弹窗触发器：微信/小红书
  showQr: (url: string, title: string) => void;
}

function openPopup(url: string) {
  window.open(url, '_blank', 'width=680,height=520,noopener,noreferrer');
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fallthrough */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export const SHARE_TARGETS: ShareTarget[] = [
  {
    key: 'weibo',
    label: '微博',
    emoji: '🐦',
    run: ({ url, title }) => {
      openPopup(
        `https://service.weibo.com/share/share.php?url=${encodeURIComponent(url)}&title=${encodeURIComponent(title)}`
      );
      return true;
    },
  },
  {
    key: 'douban',
    label: '豆瓣',
    emoji: '📖',
    run: ({ url, title }) => {
      openPopup(
        `https://www.douban.com/share/service?href=${encodeURIComponent(url)}&name=${encodeURIComponent(title)}`
      );
      return true;
    },
  },
  {
    key: 'qzone',
    label: 'QQ 空间',
    emoji: '⭐',
    run: async ({ url, title }) => {
      const ok = await copyText(url);
      if (ok) alert('链接已复制，请打开 QQ 空间粘贴分享');
      return true;
    },
  },
  {
    key: 'zhihu',
    label: '知乎',
    emoji: '🔍',
    run: async ({ url, title }) => {
      openPopup(
        `https://www.zhihu.com/share?url=${encodeURIComponent(url)}&title=${encodeURIComponent(title)}`
      );
      return true;
    },
  },
  {
    key: 'jianshu',
    label: '简书',
    emoji: '✍️',
    run: async ({ url }) => {
      const ok = await copyText(url);
      if (ok) alert('链接已复制，请打开简书粘贴分享');
      return true;
    },
  },
  {
    key: 'toutiao',
    label: '今日头条',
    emoji: '📰',
    run: async ({ url, title }) => {
      openPopup(
        `https://www.toutiao.com/c/user/token/?source=m_click&share_url=${encodeURIComponent(url)}&title=${encodeURIComponent(title)}`
      );
      return true;
    },
  },
  {
    key: 'xhs',
    label: '小红书',
    emoji: '📕',
    run: ({ url, title, showQr }) => {
      showQr(url, title);
      return true;
    },
  },
  {
    key: 'wechat',
    label: '微信',
    emoji: '💬',
    run: ({ url, title, showQr }) => {
      showQr(url, title);
      return true;
    },
  },
  {
    key: 'copy',
    label: '复制链接',
    emoji: '🔗',
    run: async ({ url }) => {
      const ok = await copyText(url);
      if (ok) {
        const ev = new CustomEvent('aiforum:toast', { detail: { kind: 'success', text: '链接已复制' } });
        window.dispatchEvent(ev);
      } else {
        prompt('复制以下链接：', url);
      }
      return true;
    },
  },
];

// 移动端：优先唤起系统原生分享（含微信、QQ、系统浏览器）
export function nativeShareAvailable(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

export async function systemShare(url: string, title: string): Promise<boolean> {
  if (!nativeShareAvailable()) return false;
  try {
    await navigator.share({ title, url });
    return true;
  } catch {
    return false; // 用户取消或失败，由调用方决定是否走兜底
  }
}

// 给微信弹窗用：预生成二维码 dataURL
export async function buildQr(url: string): Promise<string> {
  return qrDataUrl(url, 220);
}
