// 三态统一组件：loading 骨架 / empty 空态 / error 错误+重试。
// 严格对齐 article-prototype.html 的视觉语言（灰底、浅边框、衬线标题、蓝 link）。

import { Link } from 'react-router-dom';

export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div className={`animate-pulse rounded bg-gray-200/70 ${className}`} aria-hidden="true" />
  );
}

// 文章列表骨架（首页/搜索/个人空间共用）
export function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="加载中">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex gap-5 py-6 border-b border-gray-100">
          <div className="flex-1 min-w-0 space-y-3">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
            <div className="flex items-center gap-3 pt-2">
              <Skeleton className="h-4 w-4 rounded-full" />
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-16" />
            </div>
          </div>
          <Skeleton className="w-[168px] h-[112px] rounded hidden md:block flex-shrink-0" />
        </div>
      ))}
    </div>
  );
}

// 内容区居中骨架（文章详情 / 个人空间头部等）
export function BlockSkeleton({ lines = 4 }: { lines?: number }) {
  return (
    <div className="space-y-3 py-6" aria-busy="true" aria-label="加载中">
      <Skeleton className="h-4 w-1/3" />
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className="h-4 w-full" />
      ))}
    </div>
  );
}

export function EmptyState({
  icon = '📭',
  title = '暂无内容',
  hint,
  action,
}: {
  icon?: string;
  title?: string;
  hint?: string;
  action?: { label: string; to?: string; onClick?: () => void };
}) {
  return (
    <div className="py-16 text-center">
      <div className="text-3xl mb-3 opacity-80">{icon}</div>
      <p className="text-sm text-gray-500">{title}</p>
      {hint && <p className="text-xs text-gray-400 mt-1.5">{hint}</p>}
      {action && action.to && (
        <Link to={action.to} className="inline-block mt-5 text-sm font-semibold text-brand-600 hover:underline">
          {action.label}
        </Link>
      )}
      {action && action.onClick && (
        <button
          onClick={action.onClick}
          className="inline-block mt-5 text-sm font-semibold text-brand-600 hover:underline"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

export function ErrorState({ message = '加载失败，请稍后重试', onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <div className="py-16 text-center">
      <div className="text-3xl mb-3 opacity-70">⚠️</div>
      <p className="text-sm text-gray-500">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-5 px-5 py-2 text-xs font-semibold text-white bg-gray-900 rounded hover:bg-gray-800 transition-colors"
        >
          重试
        </button>
      )}
    </div>
  );
}
