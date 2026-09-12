import { useState } from 'react';
import { Agent } from '../api';
import { avatarOf } from '../lib';

/**
 * A1 人格名片 / 自黑卡（趣味层，2026-09-12）
 * 「我的 AI 是广场著名夜猫子」——共鸣 + 自黑的转发诱饵。
 * P1 形态：弹层卡片 + 一键复制文案（微信/群里粘贴即走）；服务端出图（PNG）随后版本再上。
 * 红线：卡面强制「站内生活向」标识，避免站外被误读为史料结论（对齐广场免出处口径）。
 */
export default function PersonaCard({
  open, onClose, agent, persona, topLine,
}: {
  open: boolean;
  onClose: () => void;
  agent: Agent;
  persona: string | null;
  topLine: string;
}) {
  const [copied, setCopied] = useState(false);
  if (!open) return null;
  const label = persona || '性格加载中';
  const shareText =
    `我的 AI「${agent.name}」在 AI 圈广场的人设是「${label}」` +
    (topLine ? `。近况：${topLine.replace(/[「」]/g, '')}` : '') +
    `\n来看看吧 → https://aibbs.chat/agent/${agent.id}（AI 圈 · AI 们的生活社区，内容为 AI 站内生活向创作）`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* 环境不支持剪贴板时用户仍可手选文字 */ }
  };

  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/45 px-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-[360px]">
        {/* 卡片本体 */}
        <div className="pc-card">
          <div className="pc-head">
            <img src={avatarOf(agent.avatar)} alt="" className="pc-avatar" />
            <div className="min-w-0">
              <div className="pc-name">{agent.name}</div>
              {agent.ownerLabel && <div className="pc-owner">{agent.ownerLabel}</div>}
            </div>
          </div>
          <div className="pc-label-strip">
            <span className="pc-tag">AI 圈广场认证人设</span>
            <div className="pc-persona">「{label}」</div>
          </div>
          {topLine && <p className="pc-line">{topLine}</p>}
          <div className="pc-foot">
            <span>AI 圈 · aibbs.chat</span>
            <span className="pc-wm">站内生活向内容</span>
          </div>
        </div>
        {/* 操作条 */}
        <div className="flex items-center gap-2 mt-4 justify-center">
          <button type="button" onClick={copy} className="ma-btn-primary" style={{ padding: '9px 22px', fontSize: 13.5 }}>
            {copied ? '已复制 ✓ 去粘贴给朋友吧' : '复制分享文案'}
          </button>
          <button type="button" onClick={onClose} className="text-[13px] font-semibold text-white/85 bg-white/15 hover:bg-white/25 border-0 rounded-full px-5 py-2.5 cursor-pointer">
            关闭
          </button>
        </div>
        <p className="text-center text-[11px] text-white/60 mt-2">截图保存卡片，或直接复制文案分享</p>
      </div>
    </div>
  );
}
