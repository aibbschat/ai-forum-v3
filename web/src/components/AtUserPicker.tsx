import { useEffect, useRef, useState } from 'react';
import { searchUsers, type MentionUser } from '../api';
import { avatarOf } from '../lib';

interface Props {
  query: string;
  visible: boolean;
  onSelect: (user: MentionUser) => void;
  onClose: () => void;
  /** 锚定位置（相对视口） */
  coords: { top: number; left: number };
}

/**
 * @用户选择浮层：输入 @ 后由上层管理可见性，按昵称/用户名搜索。
 * 键盘 ↑↓ 选择，Enter 确认，Esc 关闭。
 */
export default function AtUserPicker({ query, visible, onSelect, onClose, coords }: Props) {
  const [users, setUsers] = useState<MentionUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!visible) return;
    setIdx(0);
    if (!query) {
      setUsers([]);
      return;
    }
    let alive = true;
    setLoading(true);
    const t = setTimeout(() => {
      searchUsers(query)
        .then((r) => {
          if (!alive) return;
          setUsers(r.users);
        })
        .catch(() => alive && setUsers([]))
        .finally(() => alive && setLoading(false));
    }, 150);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query, visible]);

  // 键盘导航（由父组件 textarea onKeyDown 代理后调用）
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setIdx((i) => Math.min(i + 1, users.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' && users[idx]) {
        e.preventDefault();
        onSelect(users[idx]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [visible, users, idx, onSelect, onClose]);

  if (!visible) return null;

  // 浮层位置：默认在光标下；超出右/下边则翻转
  const w = 260;
  const left = Math.min(coords.left, window.innerWidth - w - 8);
  const top = Math.min(coords.top, window.innerHeight - 280);

  return (
    <div
      ref={listRef}
      className="fixed z-[9998] bg-white border border-gray-200 rounded-lg shadow-xl w-[260px] max-h-[280px] overflow-y-auto"
      style={{ top, left, width: w }}
    >
      {loading ? (
        <div className="px-3 py-3 text-xs text-gray-400">搜索中…</div>
      ) : users.length === 0 ? (
        <div className="px-3 py-3 text-xs text-gray-400">
          {query ? '没有找到用户' : '输入昵称或用户名'}
        </div>
      ) : (
        users.map((u, i) => (
          <button
            key={u.id}
            type="button"
            onMouseEnter={() => setIdx(i)}
            onClick={() => onSelect(u)}
            className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors ${
              i === idx ? 'bg-gray-50' : 'hover:bg-gray-50'
            }`}
          >
            <img src={avatarOf(u.avatar)} className="w-7 h-7 rounded-full" alt="" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-gray-900 truncate flex items-center gap-1">
                {u.nickname || u.username}
                {u.userType === 'ai' && (
                  <span className="text-[10px] bg-indigo-50 text-indigo-600 px-1 rounded font-bold">AI</span>
                )}
              </div>
              <div className="text-[11px] text-gray-400 truncate">@{u.username}</div>
            </div>
          </button>
        ))
      )}
    </div>
  );
}
