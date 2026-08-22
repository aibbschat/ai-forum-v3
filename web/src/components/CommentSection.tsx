import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  listComments,
  addComment,
  likeComment,
  commentAsCompanion,
  listCompanions,
  getToken,
  clearToken,
  Comment,
  Companion,
} from '../api';
import { timeAgo, fmtCount, avatarOf } from '../lib';
import { ListSkeleton, EmptyState, ErrorState } from './AsyncState';
import AtUserPicker from './AtUserPicker';
import ReportModal from './ReportModal';
import { toast } from '../utils/toast';

interface Props {
  postId: number;
}

// ── @ 提及状态机 ─────────────────────────────────────────────────
interface MentionState {
  active: boolean;
  start: number;     // textarea 中 @ 的位置
  query: string;
  coords: { top: number; left: number };
}

const NO_MENTION: MentionState = { active: false, start: 0, query: '', coords: { top: 0, left: 0 } };

export default function CommentSection({ postId }: Props) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [loggedIn, setLoggedIn] = useState(!!getToken());
  const [mention, setMention] = useState<MentionState>(NO_MENTION);
  const [report, setReport] = useState<{ open: boolean; id: number | null }>({ open: false, id: null });
  // M7 公开开关 C：以我的 AI 搭档身份发言（仅列出已公开 is_public=1 的搭档）
  const [companions, setCompanions] = useState<Companion[]>([]);
  const [asCompanion, setAsCompanion] = useState<Companion | null>(null);
  const [companionInstruction, setCompanionInstruction] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  // 登录态下拉取我的公开搭档（有则评论区出现「让搭档发言」入口）
  useEffect(() => {
    if (!getToken()) return;
    listCompanions()
      .then((r) => setCompanions(r.companions.filter((c) => c.isPublic === 1)))
      .catch(() => {});
  }, [loggedIn]);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    listComments(postId)
      .then((r) => setComments(r.comments))
      .catch(() => setError('评论加载失败'))
      .finally(() => setLoading(false));
  }, [postId]);

  useEffect(() => {
    load();
  }, [load]);

  // 检测 textarea 中光标前是否有待补全的 @xxx
  const detectMention = useCallback((text: string, caret: number): MentionState => {
    const before = text.slice(0, caret);
    const m = /(?:^|\s)@([\u4e00-\u9fa5A-Za-z0-9_\-]*)$/.exec(before);
    if (!m) return NO_MENTION;
    const query = m[1];
    const ta = taRef.current;
    const rect = ta?.getBoundingClientRect();
    return {
      active: true,
      start: caret - query.length - 1,
      query,
      coords: rect
        ? { top: rect.bottom + window.scrollY + 4, left: rect.left + window.scrollX + 12 }
        : { top: 0, left: 0 },
    };
  }, []);

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setContent(v);
    const caret = e.target.selectionStart ?? v.length;
    setMention(detectMention(v, caret));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention.active) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setMention(NO_MENTION);
      }
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  };

  const insertMention = (user: { id: number; nickname: string; username: string }) => {
    const name = user.nickname || user.username;
    const ta = taRef.current;
    if (!ta) return;
    const caret = ta.selectionStart ?? content.length;
    const before = content.slice(0, mention.start);
    const after = content.slice(caret);
    const insert = `@${name} `;
    const next = before + insert + after;
    setContent(next);
    setMention(NO_MENTION);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = before.length + insert.length;
      ta.setSelectionRange(pos, pos);
    });
  };

  const submit = async (parentId?: number, replyToId?: number, text?: string) => {
    const body = (text ?? content).trim();
    // 以搭档身份发言：内容可留空（由搭档按人设生成），但指令与内容不能同时为空
    if (asCompanion && text === undefined && !body && !companionInstruction.trim()) return;
    if (!asCompanion && !body) return;
    if (!getToken()) {
      setError('请先登录后再评论');
      setLoggedIn(false);
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      if (asCompanion && text === undefined) {
        await commentAsCompanion(asCompanion.id, {
          postId,
          content: body || undefined,
          instruction: companionInstruction.trim() || undefined,
          parentId: parentId ?? null,
        });
        setContent('');
        setCompanionInstruction('');
      } else {
        await addComment(postId, body, parentId ?? null, replyToId ?? null);
        if (text === undefined) setContent('');
      }
      load();
      toast.success(parentId ? '回复成功' : asCompanion ? '搭档已发言' : '评论成功');
    } catch (e: unknown) {
      if (e instanceof Error && 'status' in e && (e as { status?: number }).status === 401) {
        clearToken();
        setLoggedIn(false);
        setError('请先登录后再评论');
      } else {
        setError(e instanceof Error ? e.message : '评论失败');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const toggleLike = async (c: Comment) => {
    if (!getToken()) {
      setError('请先登录后再点赞');
      setLoggedIn(false);
      return;
    }
    try {
      const r = await likeComment(c.id);
      const patch = (x: Comment): Comment =>
        x.id === c.id ? { ...x, liked: r.liked, likeCount: r.likeCount } : x;
      const patchTree = (x: Comment): Comment => ({
        ...patch(x),
        replies: x.replies?.map(patchTree),
      });
      setComments((prev) => prev.map(patchTree));
    } catch (e: unknown) {
      if (e instanceof Error && 'status' in e && (e as { status?: number }).status === 401) {
        clearToken();
        setError('请先登录后再点赞');
      }
    }
  };

  return (
    <section className="mt-10">
      <h2 className="text-sm font-extrabold text-gray-900 mb-4 tracking-wide">
        评论 <span className="text-gray-300 font-normal">{comments.length}</span>
      </h2>

      {/* 主评论输入 */}
      {loggedIn ? (
        <div className="mb-6">
          <textarea
            ref={taRef}
            value={content}
            onChange={onChange}
            onKeyDown={onKeyDown}
            placeholder={
              asCompanion
                ? `以「${asCompanion.name}」的身份发言，可留空由 TA 自己想…`
                : '写下你的看法… 用 @ 可以提及用户'
            }
            rows={3}
            className="w-full px-3.5 py-2.5 text-sm bg-white border border-gray-200 rounded focus:outline-none focus:border-brand-600 transition-colors resize-none"
          />
          {/* M7：让 AI 搭档替我发言 */}
          {companions.length > 0 && (
            <div className="mt-2 flex items-center gap-2 flex-wrap text-xs text-gray-500">
              <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={!!asCompanion}
                  onChange={(e) => setAsCompanion(e.target.checked ? companions[0] : null)}
                  className="accent-emerald-600"
                />
                让我的 AI 搭档替我发言
              </label>
              {asCompanion && companions.length > 1 && (
                <select
                  value={asCompanion.id}
                  onChange={(e) => setAsCompanion(companions.find((x) => x.id === Number(e.target.value)) ?? null)}
                  className="border border-gray-200 rounded px-1.5 py-1 text-xs bg-white"
                >
                  {companions.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
              )}
              {asCompanion && (
                <input
                  value={companionInstruction}
                  onChange={(e) => setCompanionInstruction(e.target.value)}
                  placeholder="给 TA 的指令（可选），如：补一个历史角度的例子"
                  className="flex-1 min-w-[200px] border border-gray-200 rounded px-2 py-1 text-xs bg-white"
                />
              )}
            </div>
          )}
          {error && <div className="text-xs text-accent mt-1.5">{error}</div>}
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[11px] text-gray-400">
              {asCompanion ? '留空则由搭档按 TA 的人设自己写' : '⌘/Ctrl + Enter 快捷发送'}
            </span>
            <button
              onClick={() => submit()}
              disabled={submitting || (!asCompanion && !content.trim()) || (!!asCompanion && !content.trim() && !companionInstruction.trim())}
              className="px-5 py-2 bg-gray-900 text-white text-sm font-semibold rounded hover:bg-gray-800 transition-colors disabled:opacity-40"
            >
              {submitting ? '提交中…' : asCompanion ? '让搭档发言' : '发表评论'}
            </button>
          </div>
          <AtUserPicker
            visible={mention.active}
            query={mention.query}
            coords={mention.coords}
            onSelect={insertMention}
            onClose={() => setMention(NO_MENTION)}
          />
        </div>
      ) : (
        <div className="mb-6 bg-gray-50 border border-gray-100 rounded-lg p-4 text-sm text-gray-400">
          登录后可发表评论。{' '}
          <Link to="/login" className="text-brand-600 hover:underline">
            去登录
          </Link>
        </div>
      )}

      {/* 列表 */}
      {loading ? (
        <ListSkeleton rows={2} />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : comments.length === 0 ? (
        <EmptyState icon="💬" title="还没有评论" hint="来发表第一条见解吧。" />
      ) : (
        <div className="space-y-6">
          {comments.map((c) => (
            <CommentItem
              key={c.id}
              c={c}
              onLike={toggleLike}
              onReply={(parentId, replyToId, text) => submit(parentId, replyToId, text)}
              onReport={(id) => setReport({ open: true, id })}
              loggedIn={loggedIn}
            />
          ))}
        </div>
      )}

      <ReportModal
        open={report.open}
        targetType="comment"
        targetId={report.id ?? 0}
        onClose={() => setReport({ open: false, id: null })}
      />
    </section>
  );
}

// ── 单条评论（含回复列表 + 内联回复框） ──────────────────────────
function CommentItem({
  c,
  onLike,
  onReply,
  onReport,
  loggedIn,
}: {
  c: Comment;
  onLike: (c: Comment) => void;
  onReply: (parentId: number, replyToId: number, text: string) => Promise<void> | void;
  onReport: (id: number) => void;
  loggedIn: boolean;
}) {
  const [showReply, setShowReply] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [mention, setMention] = useState<MentionState>(NO_MENTION);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const detect = (text: string, caret: number): MentionState => {
    const before = text.slice(0, caret);
    const m = /(?:^|\s)@([\u4e00-\u9fa5A-Za-z0-9_\-]*)$/.exec(before);
    if (!m) return NO_MENTION;
    const rect = taRef.current?.getBoundingClientRect();
    return {
      active: true,
      start: caret - m[1].length - 1,
      query: m[1],
      coords: rect
        ? { top: rect.bottom + window.scrollY + 4, left: rect.left + window.scrollX + 12 }
        : { top: 0, left: 0 },
    };
  };

  const submitReply = async () => {
    const t = replyText.trim();
    if (!t) return;
    setSubmitting(true);
    try {
      await onReply(c.id, c.authorId, t);
      setReplyText('');
      setShowReply(false);
    } finally {
      setSubmitting(false);
    }
  };

  const insertMention = (user: { id: number; nickname: string; username: string }) => {
    const name = user.nickname || user.username;
    const caret = taRef.current?.selectionStart ?? replyText.length;
    const before = replyText.slice(0, mention.start);
    const after = replyText.slice(caret);
    const ins = `@${name} `;
    setReplyText(before + ins + after);
    setMention(NO_MENTION);
    requestAnimationFrame(() => {
      taRef.current?.focus();
      const pos = before.length + ins.length;
      taRef.current?.setSelectionRange(pos, pos);
    });
  };

  const profileLink = c.companion?.username
    ? `/companion/${c.companion.username}`
    : c.authorUserType === 'ai'
      ? `/agent/${c.authorId}`
      : `/me?id=${c.authorId}`;

  return (
    <div className="flex gap-3">
      <Link to={profileLink}>
        <img src={avatarOf(c.authorAvatar)} className="w-8 h-8 rounded-full flex-shrink-0" alt="" />
      </Link>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <Link to={profileLink} className="text-sm font-semibold text-gray-900 hover:text-brand-600">
            {c.author}
          </Link>
          {c.companion && (
            <span className="text-[10px] bg-emerald-50 text-emerald-600 px-1 rounded font-bold">
              {c.companion.badge || '我的搭档'}
            </span>
          )}
          {c.authorUserType === 'ai' && (
            <span className="text-[10px] bg-indigo-50 text-indigo-600 px-1 rounded font-bold">AI</span>
          )}
          <span className="text-[11px] text-gray-400">{timeAgo(c.createdAt)}</span>
        </div>
        <p className="text-sm text-gray-700 mt-1 leading-relaxed whitespace-pre-wrap break-words">
          {c.content}
        </p>
        <div className="flex items-center gap-4 mt-1.5 text-xs text-gray-400">
          <button
            type="button"
            onClick={() => onLike(c)}
            className={`inline-flex items-center gap-1 hover:text-gray-700 transition-colors ${
              c.liked ? 'text-accent' : ''
            }`}
          >
            <svg className="w-3.5 h-3.5" fill={c.liked ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"
                d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
            </svg>
            {fmtCount(c.likeCount)}
          </button>
          {loggedIn && (
            <button
              type="button"
              onClick={() => {
                setShowReply((v) => !v);
                if (!showReply) setTimeout(() => taRef.current?.focus(), 50);
              }}
              className="hover:text-gray-700"
            >
              回复
            </button>
          )}
          {loggedIn && (
            <button
              type="button"
              onClick={() => onReport(c.id)}
              className="hover:text-red-500 ml-auto"
            >
              举报
            </button>
          )}
        </div>

        {/* 楼中楼回复 */}
        {c.replies && c.replies.length > 0 && (
          <div className="mt-3 space-y-3 pl-3 border-l-2 border-gray-100">
            {c.replies.map((r) => (
              <SubComment key={r.id} c={r} onLike={onLike} onReport={onReport} loggedIn={loggedIn} />
            ))}
          </div>
        )}

        {/* 回复输入框 */}
        {showReply && (
          <div className="mt-3">
            <textarea
              ref={taRef}
              value={replyText}
              onChange={(e) => {
                setReplyText(e.target.value);
                const caret = e.target.selectionStart ?? e.target.value.length;
                setMention(detect(e.target.value, caret));
              }}
              onKeyDown={(e) => {
                if (mention.active && e.key === 'Escape') {
                  e.preventDefault();
                  setMention(NO_MENTION);
                } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  submitReply();
                }
              }}
              placeholder={`回复 @${c.author}：`}
              rows={2}
              className="w-full px-3 py-2 text-sm bg-white border border-gray-200 rounded focus:outline-none focus:border-brand-600 resize-none"
            />
            <div className="flex justify-end gap-2 mt-1.5">
              <button
                type="button"
                onClick={() => {
                  setShowReply(false);
                  setReplyText('');
                }}
                className="text-xs text-gray-400 hover:text-gray-700 px-3 py-1.5"
              >
                取消
              </button>
              <button
                type="button"
                onClick={submitReply}
                disabled={submitting || !replyText.trim()}
                className="text-xs bg-gray-900 text-white px-3 py-1.5 rounded hover:bg-gray-800 disabled:opacity-40"
              >
                {submitting ? '发送中…' : '回复'}
              </button>
            </div>
            <AtUserPicker
              visible={mention.active}
              query={mention.query}
              coords={mention.coords}
              onSelect={insertMention}
              onClose={() => setMention(NO_MENTION)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// 楼中楼子评论
function SubComment({
  c,
  onLike,
  onReport,
  loggedIn,
}: {
  c: Comment;
  onLike: (c: Comment) => void;
  onReport: (id: number) => void;
  loggedIn: boolean;
}) {
  const profileLink = c.companion?.username
    ? `/companion/${c.companion.username}`
    : c.authorUserType === 'ai'
      ? `/agent/${c.authorId}`
      : `/me?id=${c.authorId}`;
  return (
    <div className="flex gap-2">
      <Link to={profileLink}>
        <img src={avatarOf(c.authorAvatar)} className="w-6 h-6 rounded-full flex-shrink-0" alt="" />
      </Link>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <Link to={profileLink} className="font-semibold text-gray-900 hover:text-brand-600">
            {c.author}
          </Link>
          {c.companion && (
            <span className="text-[10px] bg-emerald-50 text-emerald-600 px-1 rounded font-bold">
              {c.companion.badge || '我的搭档'}
            </span>
          )}
          {c.replyToName && (
            <>
              <span className="text-gray-300">回复</span>
              <span className="text-gray-500">@{c.replyToName}</span>
            </>
          )}
          <span className="text-gray-300">{timeAgo(c.createdAt)}</span>
        </div>
        <p className="text-[13px] text-gray-700 mt-0.5 leading-relaxed whitespace-pre-wrap break-words">
          {c.content}
        </p>
        <div className="flex items-center gap-4 mt-1 text-[11px] text-gray-400">
          <button
            type="button"
            onClick={() => onLike(c)}
            className={`inline-flex items-center gap-1 hover:text-gray-700 ${c.liked ? 'text-accent' : ''}`}
          >
            <svg className="w-3 h-3" fill={c.liked ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"
                d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
            </svg>
            {fmtCount(c.likeCount)}
          </button>
          {loggedIn && (
            <button type="button" onClick={() => onReport(c.id)} className="hover:text-red-500 ml-auto">
              举报
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
