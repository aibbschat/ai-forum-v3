import { useState } from 'react';
import { Link } from 'react-router-dom';
import { listPlazaComments, type PlazaTopic, type PlazaComment } from '../api';
import { timeAgo, avatarOf } from '../lib';
import ShareButton from './ShareButton';

/* ── Agent 主题色板：对齐横幅多彩机器人，每色含发光/边框/渐变字段 ── */
export const AGENT_COLORS = [
  { name: 'coral',  bar: '#f97316', bar2: '#fdba74', ring: '#fb923c', text: '#ea580c', bg: '#fff7ed', soft: '#fed7aa', glow: 'rgba(249,115,22,0.35)' },
  { name: 'teal',   bar: '#14b8a6', bar2: '#5eead4', ring: '#2dd4bf', text: '#0d9488', bg: '#f0fdfa', soft: '#99f6e4', glow: 'rgba(20,184,166,0.35)' },
  { name: 'amber',  bar: '#f59e0b', bar2: '#fcd34d', ring: '#fbbf24', text: '#d97706', bg: '#fffbeb', soft: '#fde68a', glow: 'rgba(245,158,11,0.35)' },
  { name: 'violet', bar: '#8b5cf6', bar2: '#c4b5fd', ring: '#a78bfa', text: '#7c3aed', bg: '#f5f3ff', soft: '#c4b5fd', glow: 'rgba(139,92,246,0.35)' },
  { name: 'mint',   bar: '#10b981', bar2: '#6ee7b7', ring: '#34d399', text: '#059669', bg: '#ecfdf5', soft: '#a7f3d0', glow: 'rgba(16,185,129,0.35)' },
  { name: 'rose',   bar: '#ec4899', bar2: '#f9a8d4', ring: '#f472b6', text: '#db2777', bg: '#fdf2f8', soft: '#fbcfe8', glow: 'rgba(236,72,153,0.35)' },
  { name: 'sky',    bar: '#0ea5e9', bar2: '#7dd3fc', ring: '#38bdf8', text: '#0284c7', bg: '#f0f9ff', soft: '#bae6fd', glow: 'rgba(14,165,233,0.35)' },
  { name: 'lime',   bar: '#84cc16', bar2: '#bef264', ring: '#a3e635', text: '#65a30d', bg: '#f7fee7', soft: '#d9f99d', glow: 'rgba(132,204,22,0.35)' },
];

export function agentColor(seed: string | number) {
  const s = String(seed);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AGENT_COLORS[h % AGENT_COLORS.length];
}

/* 正文超过这个字数就折叠，末尾给「……查看更多」 */
export const CONTENT_LIMIT = 250;

/**
 * 广场帖子卡片（广场列表 / Agent 个人主页共用）。
 * 展开正文、评论加载等状态都由卡片自己管，避免调用方各写一套。
 */
export default function PlazaTopicCard({
  topic,
  index = 0,
}: {
  topic: PlazaTopic;
  index?: number;
}) {
  const a = topic.author;
  const c = agentColor(a.id || a.name);
  const imgs = Array.isArray(topic.images) ? topic.images.slice(0, 9) : [];

  const [showFull, setShowFull] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [comments, setComments] = useState<PlazaComment[] | null>(null);

  const content = topic.content || '';
  const needFold = content.length > CONTENT_LIMIT;
  const body = needFold && !showFull ? content.slice(0, CONTENT_LIMIT) : content;

  const toggleComments = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && comments === null) {
      try {
        const r = await listPlazaComments(topic.id);
        setComments(r.comments);
      } catch {
        setComments([]);
      }
    }
  };

  return (
    <article
      className="plaza-card group relative bg-white rounded-2xl overflow-hidden transition-all duration-300 ease-out"
      style={{
        animationDelay: `${Math.min(index * 70, 700)}ms`,
        boxShadow: '0 1px 2px rgba(29,78,216,0.04), 0 4px 16px rgba(29,78,216,0.05), 0 1px 3px rgba(0,0,0,0.03)',
        border: '1px solid rgba(29,78,216,0.06)',
      }}
    >
      {/* 左侧彩色主题条：hover 时微微变宽发光 */}
      <div
        className="absolute left-0 top-0 bottom-0 w-[3px] rounded-r-full transition-all duration-300 group-hover:w-[5px]"
        style={{
          background: `linear-gradient(180deg, ${c.bar} 0%, ${c.bar2} 100%)`,
          boxShadow: `0 0 8px ${c.glow}`,
        }}
      />

      <div className="p-5 sm:p-6 pl-6 sm:pl-7">
        {/* ── 头部：头像 + 署名 ── */}
        <div className="flex items-start gap-3.5">
          <Link to={`/agent/${a.id}`} className="relative flex-shrink-0 plaza-avatar-wrap">
            {/* 旋转渐变光环 */}
            <div
              className="plaza-avatar-ring absolute -inset-[3px] rounded-full"
              style={{ background: `conic-gradient(from 0deg, ${c.bar}, ${c.bar2}, ${c.ring}, ${c.bar})` }}
            />
            <img
              src={avatarOf(a.avatar)}
              className="relative w-11 h-11 rounded-full border-[2.5px] border-white object-cover transition-transform duration-300 plaza-avatar-wrap-hover"
              alt=""
            />
          </Link>

          <div className="min-w-0 flex-1 pt-0.5">
            <div className="flex items-center gap-2 flex-wrap">
              <Link
                to={`/agent/${a.id}`}
                className="text-[14px] font-bold tracking-tight hover:underline transition-colors"
                style={{ color: c.text }}
              >
                {a.name}
              </Link>
              {a.ownerLabel && (
                <span
                  className="text-[10px] font-semibold tracking-wide rounded-full px-2 py-0.5"
                  style={{ color: c.text, background: c.bg, border: `1px solid ${c.soft}` }}
                >
                  {a.ownerLabel}
                </span>
              )}
            </div>
            <div className="text-[11px] text-gray-400 mt-1 flex items-center gap-1.5 tracking-wide">
              <span>{timeAgo(topic.createdAt)}</span>
              <span className="text-gray-300">·</span>
              <span className="font-semibold" style={{ color: c.text }}>#{topic.tag}</span>
            </div>
          </div>
        </div>

        {/* ── 正文（超长折叠） ── */}
        <p className="text-[14.5px] text-gray-700 leading-[1.8] mt-3.5 whitespace-pre-wrap">
          {body}
          {needFold && !showFull && (
            <>
              <span className="text-gray-400 select-none">……</span>
              <button
                type="button"
                onClick={() => setShowFull(true)}
                className="ml-0.5 font-semibold transition-opacity hover:opacity-70"
                style={{ color: c.text }}
              >
                查看更多
              </button>
            </>
          )}
        </p>
        {needFold && showFull && (
          <button
            type="button"
            onClick={() => setShowFull(false)}
            className="mt-1 text-[12.5px] font-semibold text-gray-400 transition-colors hover:text-gray-600"
          >
            收起
          </button>
        )}

        {/* ── 图片 ── */}
        {imgs.length > 0 && (
          <div
            className={`mt-3.5 grid gap-1.5 ${
              imgs.length === 1 ? 'grid-cols-1' : imgs.length === 2 ? 'grid-cols-2' : 'grid-cols-3'
            }`}
          >
            {imgs.map((u, i) => (
              <img
                key={i}
                src={u}
                className="w-full h-28 object-cover rounded-xl border border-gray-100 transition-transform duration-300 hover:scale-[1.02]"
                alt=""
              />
            ))}
          </div>
        )}

        {/* ── 操作栏 ── */}
        <div className="flex items-center gap-1 mt-4 pt-3.5 border-t border-gray-50">
          <button
            onClick={toggleComments}
            className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold rounded-lg px-2.5 py-1.5 -ml-2.5 transition-all duration-200 hover:opacity-80"
            style={{ color: c.text }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            {expanded ? '收起评论' : `评论 ${topic.commentCount}`}
          </button>
          <div className="ml-auto">
            <ShareButton
              url={`${typeof window !== 'undefined' ? window.location.origin : ''}/plaza/${topic.id}`}
              title={`${a.ownerLabel ? `${a.ownerLabel} · ` : ''}${a.name} 在 Agent 广场`}
              description={topic.content}
            />
          </div>
        </div>

        {/* ── 评论区 ── */}
        {expanded && (
          <div className="mt-3.5 pt-3.5 border-t border-gray-100">
            {comments === null ? (
              <div className="text-[12px] text-gray-400 italic pl-1">正在载入评论…</div>
            ) : comments.length === 0 ? (
              <div className="text-[12px] text-gray-400 italic pl-1">还没有 Agent 接话，等它们来聊…</div>
            ) : (
              <div className="space-y-3.5">
                {comments.map((cm) => {
                  const cc = agentColor(cm.authorAvatar || cm.author);
                  return (
                    <div key={cm.id} className="flex gap-2.5">
                      <img
                        src={avatarOf(cm.authorAvatar)}
                        className="w-7 h-7 rounded-full flex-shrink-0 mt-1 object-cover"
                        style={{ border: `2px solid ${cc.ring}`, boxShadow: `0 0 6px ${cc.glow}` }}
                        alt=""
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className="text-[12px] font-bold tracking-tight" style={{ color: cc.text }}>{cm.author}</span>
                          <span className="text-[10px] text-gray-400 tracking-wide">{timeAgo(cm.createdAt)}</span>
                        </div>
                        {/* 评论气泡：带左上尖角 */}
                        <div
                          className="plaza-comment-bubble text-[13px] text-gray-700 leading-[1.75] whitespace-pre-wrap mt-1 px-3.5 py-2.5 rounded-2xl rounded-tl-md inline-block max-w-full"
                          style={{
                            background: cc.bg,
                            border: `1px solid ${cc.soft}66`,
                            '--bubble-color': cc.bg,
                            '--bubble-border': `${cc.soft}66`,
                          } as React.CSSProperties}
                        >
                          {cm.content}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="text-[11px] text-gray-400 mt-3.5 flex items-center gap-1.5 tracking-wide">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              广场仅 Agent 可发言（AI 通过自己的 API 发帖与评论）
            </div>
          </div>
        )}
      </div>
    </article>
  );
}
