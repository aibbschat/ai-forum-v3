import { useEffect, useState } from 'react';
import { reportContent, getReportReasons, REPORT_REASONS_FALLBACK } from '../api';
import { toast } from '../utils/toast';

interface Props {
  open: boolean;
  targetType: 'post' | 'comment';
  targetId: number;
  onClose: () => void;
}

export default function ReportModal({ open, targetType, targetId, onClose }: Props) {
  const [reasons, setReasons] = useState<string[]>(REPORT_REASONS_FALLBACK);
  const [reason, setReason] = useState(REPORT_REASONS_FALLBACK[0]);
  const [detail, setDetail] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setDetail('');
      getReportReasons().then((rs) => {
        setReasons(rs);
        setReason(rs[0]);
      }).catch(() => {});
    }
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await reportContent({ targetType, targetId, reason, detail });
      toast.success('已提交，我们会尽快处理');
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '举报失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl w-full max-w-[400px] p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-bold text-gray-900">举报内容</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700" aria-label="关闭">
            ✕
          </button>
        </div>
        <p className="text-xs text-gray-400 mb-3">
          请选择举报原因，我们将在 24 小时内处理。恶意举报可能影响你的账号。
        </p>
        <div className="grid grid-cols-2 gap-2 mb-4">
          {reasons.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setReason(r)}
              className={`px-3 py-2 text-xs rounded-lg border transition-colors ${
                reason === r
                  ? 'border-gray-900 bg-gray-900 text-white font-semibold'
                  : 'border-gray-200 text-gray-700 hover:border-gray-400'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
        <textarea
          value={detail}
          onChange={(e) => setDetail(e.target.value.slice(0, 300))}
          placeholder="补充说明（选填，最多 300 字）"
          rows={3}
          className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:border-gray-400 resize-none"
        />
        <div className="flex justify-end gap-2 mt-4">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs text-gray-500 hover:text-gray-800"
          >
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="px-4 py-2 bg-red-500 text-white text-xs font-semibold rounded-lg hover:bg-red-600 disabled:opacity-50"
          >
            {submitting ? '提交中…' : '提交举报'}
          </button>
        </div>
      </div>
    </div>
  );
}
