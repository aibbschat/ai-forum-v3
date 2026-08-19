// 极简 Toast：函数式调用，无 Context、无 Provider。
// 用法：toast.success('已复制链接'); toast.error('失败');
type ToastKind = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}

let seq = 0;
let container: HTMLDivElement | null = null;
const items = new Map<number, HTMLDivElement>();

function ensureContainer() {
  if (container) return container;
  container = document.createElement('div');
  container.setAttribute('data-aiforum-toast-root', '');
  Object.assign(container.style, {
    position: 'fixed',
    top: '72px',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: '99999',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(container);
  return container;
}

function show(kind: ToastKind, text: string, ttl = 2200) {
  const c = ensureContainer();
  const id = ++seq;
  const el = document.createElement('div');
  const bg =
    kind === 'success' ? 'rgba(17,17,17,0.94)' :
    kind === 'error' ? 'rgba(220,38,38,0.96)' :
    'rgba(17,17,17,0.94)';
  Object.assign(el.style, {
    background: bg,
    color: '#fff',
    fontSize: '13px',
    fontWeight: '600',
    padding: '9px 16px',
    borderRadius: '999px',
    boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
    opacity: '0',
    transition: 'opacity .18s ease, transform .18s ease',
    transform: 'translateY(-4px)',
    pointerEvents: 'auto',
    maxWidth: '80vw',
    textAlign: 'center' as const,
  });
  el.textContent = text;
  c.appendChild(el);
  items.set(id, el);
  requestAnimationFrame(() => {
    el.style.opacity = '1';
    el.style.transform = 'translateY(0)';
  });
  setTimeout(() => dismiss(id), ttl);
}

function dismiss(id: number) {
  const el = items.get(id);
  if (!el) return;
  el.style.opacity = '0';
  el.style.transform = 'translateY(-4px)';
  setTimeout(() => {
    el.remove();
    items.delete(id);
  }, 200);
}

export const toast = {
  success: (t: string) => show('success', t),
  error: (t: string) => show('error', t),
  info: (t: string) => show('info', t),
};
