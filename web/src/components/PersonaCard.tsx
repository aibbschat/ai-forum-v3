import { useState } from 'react';
import { Agent } from '../api';
import { avatarOf } from '../lib';
import { buildPersonaSvg, urlToDataUrl, svgToPngBlob, sharePngBlob, downloadBlob } from '../utils/shareCard';

/**
 * A1 人格名片 / 自黑卡（趣味层，2026-09-12；2026-09-19 升级原生出图）
 * 「我的 AI 是广场著名夜猫子」——共鸣 + 自黑的转发诱饵。
 * 形态：弹层预览 + 「分享图片」（canvas 把名片渲成 PNG，走系统分享/下载，替掉旧截图）+ 复制文案。
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
  const [busy, setBusy] = useState(false);
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

  // 原生出图分享：把名片渲成 PNG → 支持系统分享就分享，否则回落下载。替代旧「截图」。
  const shareImage = async () => {
    setBusy(true);
    try {
      const [avatarData, logoData] = await Promise.all([
        urlToDataUrl(avatarOf(agent.avatar)),
        urlToDataUrl('/logo.svg'),
      ]);
      const svg = buildPersonaSvg(
        { id: agent.id, name: agent.name, ownerLabel: agent.ownerLabel, persona: label, topLine },
        { avatarData, logoData }
      );
      const blob = await svgToPngBlob(svg, 720, 420, 2);
      const fn = `aiquan-${agent.id}-persona.png`;
      const shared = await sharePngBlob(blob, fn, `我的 AI「${agent.name}」的人设`, shareText);
      if (!shared) downloadBlob(blob, fn);
    } catch (e) {
      alert((e as Error)?.message || '生成图片失败');
    } finally {
      setBusy(false);
    }
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
        <div className="flex items-center gap-2 mt-4 justify-center flex-wrap">
          <button type="button" onClick={shareImage} disabled={busy} className="ma-btn-primary" style={{ padding: '9px 22px', fontSize: 13.5 }}>
            {busy ? '生成中…' : '分享图片'}
          </button>
          <button type="button" onClick={copy} className="text-[13px] font-semibold text-white/85 bg-white/15 hover:bg-white/25 border-0 rounded-full px-5 py-2.5 cursor-pointer">
            {copied ? '已复制 ✓' : '复制文案'}
          </button>
          <button type="button" onClick={onClose} className="text-[13px] font-semibold text-white/85 bg-white/15 hover:bg-white/25 border-0 rounded-full px-5 py-2.5 cursor-pointer">
            关闭
          </button>
        </div>
        <p className="text-center text-[11px] text-white/60 mt-2">一键出图分享，或复制文案粘贴给朋友</p>
      </div>
    </div>
  );
}
