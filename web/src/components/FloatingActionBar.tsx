import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ShareButton from './ShareButton';
import { getToken, clearToken } from '../api';
import { toast } from '../utils/toast';

interface Props {
  liked: boolean;
  likeCount: number;
  commentCount: number;
  bookmarked: boolean;
  bookmarkLoading: boolean;
  onLike: () => void;
  onBookmark: () => void;
  onReport: () => void;
  shareUrl: string;
  shareTitle: string;
  shareDescription?: string;
}

/**
 * 文章悬浮操作条：
 * - 桌面端（lg+）：文章左侧垂直一列图标按钮（点赞 / 评论 / 收藏 / 分享 / 举报）
 * - 移动端：屏幕底部固定的横向操作条，滑过 hero 后淡入
 *
 * 所有按钮复用文章页的真实回调，不重复实现业务逻辑。
 */
export default function FloatingActionBar(props: Props) {
  const {
    liked,
    likeCount,
    commentCount,
    bookmarked,
    bookmarkLoading,
    onLike,
    onBookmark,
    onReport,
    shareUrl,
    shareTitle,
    shareDescription,
  } = props;

  const [show, setShow] = useState(false);
  const [loggedIn, setLoggedIn] = useState(!!getToken());
  const navigate = useNavigate();

  useEffect(() => {
    const onScroll = () => {
      // 滚过 hero（约 320px）后出现
      setShow(window.scrollY > 320);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const requireAuth = (action: () => void) => {
    if (!getToken()) {
      clearToken();
      setLoggedIn(false);
      toast.error('请先登录');
      navigate('/login');
      return;
    }
    action();
  };

  const scrollToComments = () => {
    const el = document.getElementById('comments');
    if (!el) return;
    const y = el.getBoundingClientRect().top + window.scrollY - 72;
    window.scrollTo({ top: y, behavior: 'smooth' });
  };

  // ── 桌面端：左侧垂直悬浮（≥ lg = 1024px）────────────────────
  return (
    <>
      <div
        className={`hidden lg:flex fixed z-30 flex-col items-center gap-1 transition-all duration-300 ${
          show ? 'opacity-100 translate-x-0' : 'opacity-0 -translate-x-3 pointer-events-none'
        }`}
        style={{
          // 文章 max-w-760 居中；左侧操作列在文章左边距 32px
          top: '50%',
          transform: show ? 'translateY(-50%)' : 'translateY(-50%) translateX(-12px)',
          left: 'max(24px, calc((100vw - 760px) / 2 - 72px))',
        }}
      >
        <div className="bg-white/95 backdrop-blur border border-gray-100 rounded-full shadow-sm py-2 px-1.5 flex flex-col items-center gap-1">
          <IconBtn
            active={liked}
            activeClass="text-accent"
            label={likeCount > 0 ? String(likeCount) : '点赞'}
            onClick={() => requireAuth(onLike)}
            title={liked ? '取消点赞' : '点赞'}
          >
            <svg className="w-[18px] h-[18px]" fill={liked ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"
                d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
            </svg>
          </IconBtn>

          <IconBtn
            label={commentCount > 0 ? String(commentCount) : '评论'}
            onClick={scrollToComments}
            title="跳到评论"
          >
            <svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"
                d="M8 10h.01M12 10h.01M16 10h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
          </IconBtn>

          <IconBtn
            active={bookmarked}
            activeClass="text-brand-600"
            label={bookmarked ? '已收藏' : '收藏'}
            onClick={() => requireAuth(onBookmark)}
            disabled={bookmarkLoading}
            title={bookmarked ? '取消收藏' : '收藏'}
          >
            <svg className="w-[18px] h-[18px]" fill={bookmarked ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"
                d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-4-7 4V5z" />
            </svg>
          </IconBtn>

          <ShareButton
            url={shareUrl}
            title={shareTitle}
            description={shareDescription}
            variant="icon"
            className="!w-11 !h-11 !rounded-full flex-col !text-gray-500 hover:!text-gray-900 hover:!bg-gray-50"
          >
            <svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"
                d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
            </svg>
            <span className="text-[10px] leading-none mt-0.5 font-medium">分享</span>
          </ShareButton>

          <div className="w-6 h-px bg-gray-100 my-1" />

          <IconBtn
            label="举报"
            onClick={() => requireAuth(onReport)}
            title="举报这篇文章"
            danger
          >
            <svg className="w-[16px] h-[16px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"
                d="M3 21l5.25-5.25M17 11l4-4-4-4M21 7H9" />
            </svg>
          </IconBtn>
        </div>
      </div>

      {/* ── 移动端：底部固定操作条（< lg）────────────────────── */}
      <div
        className={`lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur border-t border-gray-100 pb-safe transition-transform duration-300 ${
          show ? 'translate-y-0' : 'translate-y-full'
        }`}
      >
        <div className="flex items-center justify-around py-2 px-2">
          <MobileBtn
            active={liked}
            activeClass="text-accent"
            label={likeCount > 0 ? String(likeCount) : '点赞'}
            onClick={() => requireAuth(onLike)}
          >
            <svg className="w-5 h-5" fill={liked ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"
                d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
            </svg>
          </MobileBtn>

          <MobileBtn label={`${commentCount || ''} 评论`} onClick={scrollToComments}>
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"
                d="M8 10h.01M12 10h.01M16 10h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
          </MobileBtn>

          <MobileBtn
            active={bookmarked}
            activeClass="text-brand-600"
            label={bookmarked ? '已收藏' : '收藏'}
            onClick={() => requireAuth(onBookmark)}
            disabled={bookmarkLoading}
          >
            <svg className="w-5 h-5" fill={bookmarked ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"
                d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-4-7 4V5z" />
            </svg>
          </MobileBtn>

          <ShareButton
            url={shareUrl}
            title={shareTitle}
            description={shareDescription}
            variant="icon"
            className="!w-auto !h-auto !rounded-lg flex-col !px-3 !py-1.5 !gap-0.5 !text-gray-500 hover:!text-gray-900 hover:!bg-transparent"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"
                d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
            </svg>
            <span className="text-[11px] leading-none font-medium">分享</span>
          </ShareButton>

          <MobileBtn label="举报" onClick={() => requireAuth(onReport)} danger>
            <svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"
                d="M3 21l5.25-5.25M17 11l4-4-4-4M21 7H9" />
            </svg>
          </MobileBtn>
        </div>
      </div>

      {/* 登录状态变更时同步（由外部登录后回来） */}
      {!loggedIn && getToken() ? setLoggedIn(true) : null}
    </>
  );
}

// ── 桌面端圆形图标按钮 ──────────────────────────────────────
function IconBtn({
  children,
  label,
  onClick,
  active,
  activeClass = '',
  disabled,
  title,
  danger,
  as: Tag = 'button',
}: {
  children: React.ReactNode;
  label?: string;
  onClick?: () => void;
  active?: boolean;
  activeClass?: string;
  disabled?: boolean;
  title?: string;
  danger?: boolean;
  as?: 'button' | 'span';
}) {
  return (
    <Tag
      type={Tag === 'button' ? 'button' : undefined}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`group relative flex flex-col items-center justify-center w-11 h-11 rounded-full transition-colors disabled:opacity-40 ${
        active
          ? activeClass
          : danger
            ? 'text-gray-400 hover:text-red-500 hover:bg-red-50'
            : 'text-gray-500 hover:text-gray-900 hover:bg-gray-50'
      }`}
    >
      {children}
      {label && (
        <span className="text-[10px] leading-none mt-0.5 font-medium tabular-nums">{label}</span>
      )}
    </Tag>
  );
}

// ── 移动端横向按钮 ─────────────────────────────────────────
function MobileBtn({
  children,
  label,
  onClick,
  active,
  activeClass = '',
  disabled,
  danger,
  as: Tag = 'button',
}: {
  children: React.ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
  activeClass?: string;
  disabled?: boolean;
  danger?: boolean;
  as?: 'button' | 'span';
}) {
  return (
    <Tag
      type={Tag === 'button' ? 'button' : undefined}
      onClick={onClick}
      disabled={disabled}
      className={`flex flex-col items-center justify-center gap-0.5 px-3 py-1.5 rounded-lg transition-colors disabled:opacity-40 ${
        active
          ? activeClass
          : danger
            ? 'text-gray-400 hover:text-red-500'
            : 'text-gray-500 hover:text-gray-900'
      }`}
    >
      {children}
      <span className="text-[11px] leading-none font-medium">{label}</span>
    </Tag>
  );
}
