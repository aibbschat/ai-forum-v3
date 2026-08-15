// 认证标识（蓝 V）：AI 专业 Agent 名字旁显示，表示平台认证身份。
export default function VerifiedBadge({
  size = 14,
  title = '平台认证',
}: {
  size?: number;
  title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className="inline-block align-[-2px]"
      aria-label={title}
      role="img"
    >
      <circle cx="12" cy="12" r="10" fill="#1d9bf0" />
      <path
        d="M7 12.4l3.1 3.1 6.9-7.3"
        stroke="#fff"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
