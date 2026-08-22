import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Companion,
  CompanionDraft,
  AssistAction,
  listCompanionDrafts,
  createCompanionDraft,
  updateCompanionDraft,
  deleteCompanionDraft,
  setCompanionDraftStatus,
  assistCompanionDraft,
} from '../api';
import { avatarOf } from '../lib';

const DRAFT_KEY = 'aiforum_compose_draft_v1';

const ACTIONS: { key: AssistAction; label: string; hint: string }[] = [
  { key: 'polish', label: '润色', hint: '修错收紧，保留你的声音' },
  { key: 'expand', label: '扩写', hint: '补细节论据，不注水' },
  { key: 'angles', label: '给角度', hint: '出切入角度，不改原文' },
  { key: 'brainstorm', label: '脑暴', hint: '出点子和结构建议' },
];

/**
 * 辅助写作（M4，§6）：草稿 → 搭档润色/扩写/给角度/脑暴 → 你确认 → 你自己发布。
 * 铁律（§5.3/§6.2）：这里没有「发布」按钮，只有「带到写作区」——发布永远由主人触发。
 */
export default function CompanionWrite({ companion }: { companion: Companion }) {
  const navigate = useNavigate();
  const [drafts, setDrafts] = useState<CompanionDraft[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [content, setContent] = useState('');
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState<AssistAction | 'save' | null>(null);
  const [suggestions, setSuggestions] = useState('');
  const [status, setStatus] = useState<CompanionDraft['status']>('draft');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const active = drafts.find((d) => d.id === activeId) || null;

  const refreshDrafts = useCallback(async () => {
    try {
      const r = await listCompanionDrafts(companion.id);
      setDrafts(r.drafts);
      return r.drafts;
    } catch {
      return [];
    }
  }, [companion.id]);

  useEffect(() => {
    void refreshDrafts();
  }, [refreshDrafts]);

  const flashNotice = (t: string) => {
    setNotice(t);
    setTimeout(() => setNotice(''), 2500);
  };

  const openDraft = (d: CompanionDraft) => {
    setActiveId(d.id);
    setContent(d.draftContent);
    setStatus(d.status);
    setSuggestions('');
    setError('');
  };

  const handleNewDraft = async () => {
    const text = content.trim();
    if (!text) {
      setError('先写点什么，再存草稿。');
      return;
    }
    setBusy('save');
    setError('');
    try {
      const r = await createCompanionDraft(companion.id, text);
      setDrafts((ds) => [r.draft, ...ds]);
      setActiveId(r.draft.id);
      setStatus(r.draft.status);
      flashNotice('草稿已保存');
    } catch {
      setError('保存失败，请稍后再试。');
    } finally {
      setBusy(null);
    }
  };

  const handleSave = async () => {
    if (activeId == null) return handleNewDraft();
    setBusy('save');
    setError('');
    try {
      const r = await updateCompanionDraft(activeId, content.trim());
      setDrafts((ds) => ds.map((d) => (d.id === r.draft.id ? r.draft : d)));
      setStatus(r.draft.status);
      flashNotice('已保存');
    } catch {
      setError('保存失败，请稍后再试。');
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async () => {
    if (activeId == null) return;
    if (!window.confirm('删除这份草稿？')) return;
    try {
      await deleteCompanionDraft(activeId);
      const rest = await refreshDrafts();
      setActiveId(rest.length > 0 ? rest[0].id : null);
      setContent(rest.length > 0 ? rest[0].draftContent : '');
      setStatus(rest.length > 0 ? rest[0].status : 'draft');
    } catch {
      setError('删除失败，请稍后再试。');
    }
  };

  const handleAssist = async (action: AssistAction) => {
    const text = content.trim();
    if (!text) {
      setError('草稿是空的。');
      return;
    }
    // 无草稿时先自动存一份
    let draftId = activeId;
    if (draftId == null) {
      try {
        const r = await createCompanionDraft(companion.id, text);
        setDrafts((ds) => [r.draft, ...ds]);
        draftId = r.draft.id;
        setActiveId(draftId);
      } catch {
        setError('保存草稿失败，无法辅助。');
        return;
      }
    } else {
      await updateCompanionDraft(draftId, text).catch(() => undefined);
    }

    setBusy(action);
    setError('');
    setSuggestions('');
    try {
      const r = await assistCompanionDraft(companion.id, draftId, action, instruction.trim() || undefined);
      if (r.revised != null) {
        setContent(r.revised);
        setStatus('polishing');
        setDrafts((ds) => ds.map((d) => (d.id === draftId ? { ...d, draftContent: r.revised!, status: 'polishing' } : d)));
        flashNotice(`${ACTIONS.find((a) => a.key === action)?.label}完成，改稿已回填，可继续手改`);
      } else if (r.suggestions) {
        setSuggestions(r.suggestions);
      }
    } catch (err) {
      const e = err as Error & { status?: number };
      setError(e?.status === 503 ? '搭档暂时不在状态，稍后再试。' : '辅助失败，请稍后再试。');
    } finally {
      setBusy(null);
    }
  };

  const handleConfirm = async () => {
    if (activeId == null) return;
    try {
      const r = await setCompanionDraftStatus(activeId, 'confirmed');
      setStatus(r.draft.status);
      flashNotice('已确认定稿');
    } catch {
      setError('操作失败，请稍后再试。');
    }
  };

  const handleToCompose = () => {
    if (!content.trim()) {
      setError('内容是空的。');
      return;
    }
    // 复用 Compose 的本地草稿通道（§5.3「复制到写作区」）：预填后由主人亲自发布。
    // category 字段省略 → Compose 端回落默认分类（空串会让 select 匹配不到选项）。
    const payload: Record<string, unknown> = { content: content.trim(), savedAt: Date.now() };
    if (active?.sourcePostId) payload.sourcePostId = active.sourcePostId;
    localStorage.setItem(DRAFT_KEY, JSON.stringify(payload));
    navigate('/write');
  };

  return (
    <div className="bg-white rounded-lg border border-gray-100 mt-4 overflow-hidden">
      {/* 工具条：草稿列表 */}
      <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-gray-100 bg-gray-50/60">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-semibold text-gray-500 shrink-0">草稿</span>
          <select
            value={activeId ?? ''}
            onChange={(e) => {
              const id = e.target.value ? Number(e.target.value) : null;
              const d = drafts.find((x) => x.id === id);
              if (d) openDraft(d);
              else {
                setActiveId(null);
                setContent('');
                setStatus('draft');
              }
            }}
            className="text-xs text-gray-700 bg-white border border-gray-200 rounded px-2 py-1 max-w-[200px] truncate focus:outline-none focus:ring-1 focus:ring-indigo-200"
          >
            <option value="">＋ 新草稿</option>
            {drafts.map((d) => (
              <option key={d.id} value={d.id}>
                {d.draftContent.slice(0, 24) || '(空)'} · {d.status}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleSave}
            disabled={busy != null}
            className="text-xs text-gray-600 hover:text-gray-900 border border-gray-200 rounded px-2.5 py-1 hover:border-gray-400 transition-colors bg-white disabled:opacity-40"
          >
            {busy === 'save' ? '保存中…' : '保存'}
          </button>
          {activeId != null && (
            <button onClick={handleDelete} className="text-xs text-gray-400 hover:text-red-600 transition-colors">
              删除
            </button>
          )}
        </div>
      </div>

      <div className="px-4 py-4">
        {/* 状态 + 搭档标识 */}
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <img
            src={avatarOf(companion.spriteSheet || companion.avatar || null)}
            alt=""
            className="w-6 h-6 rounded-full object-cover border border-gray-100"
          />
          <span className="text-xs text-gray-500">
            {companion.name} 在旁待命 · 当前状态：
            <span
              className={`ml-1 font-medium ${
                status === 'confirmed' ? 'text-green-600' : status === 'polishing' ? 'text-amber-600' : 'text-gray-500'
              }`}
            >
              {status === 'confirmed' ? '已定稿' : status === 'polishing' ? '润色中' : '草稿'}
            </span>
          </span>
        </div>

        {/* 草稿正文 */}
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={`写点什么，让 ${companion.name} 帮你打磨…（TA 会保留你的文风，改稿直接回填到这里）`}
          rows={12}
          className="w-full resize-y rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300"
        />

        {/* 额外要求 + 动作按钮 */}
        <div className="flex flex-wrap items-center gap-2 mt-3">
          <input
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="额外要求（可选），如：收紧一点、别动结尾"
            className="flex-1 min-w-[200px] rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-200"
          />
          {ACTIONS.map((a) => (
            <button
              key={a.key}
              onClick={() => handleAssist(a.key)}
              disabled={busy != null}
              title={a.hint}
              className={`text-xs font-semibold px-3 py-2 rounded-lg transition-colors disabled:opacity-40 ${
                busy === a.key
                  ? 'bg-gray-900 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {busy === a.key ? 'TA 在写…' : a.label}
            </button>
          ))}
        </div>

        {error && <p className="text-xs text-red-500 mt-2">{error}</p>}
        {notice && <p className="text-xs text-green-600 mt-2">{notice}</p>}

        {/* 建议面板（给角度/脑暴） */}
        {suggestions && (
          <div className="mt-4 rounded-xl border border-indigo-100 bg-indigo-50/40 p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-bold text-indigo-700">{companion.name} 的建议</h3>
              <button
                onClick={() => setSuggestions('')}
                className="text-xs text-gray-400 hover:text-gray-600"
              >
                收起
              </button>
            </div>
            <div className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">{suggestions}</div>
          </div>
        )}

        {/* 主人动作：确认定稿 / 带到写作区（唯一发布路径，由主人亲手触发） */}
        <div className="flex flex-wrap items-center gap-2 mt-4 pt-3 border-t border-gray-100">
          <button
            onClick={handleToCompose}
            className="text-xs font-semibold px-3 py-2 rounded-lg bg-gray-900 text-white hover:bg-gray-800 transition-colors"
          >
            带到写作区发布
          </button>
          {activeId != null && status !== 'confirmed' && (
            <button
              onClick={handleConfirm}
              className="text-xs font-semibold px-3 py-2 rounded-lg bg-green-50 text-green-700 hover:bg-green-100 transition-colors"
            >
              确认定稿
            </button>
          )}
          <p className="text-[11px] text-gray-300">
            发布永远由你亲手完成；TA 只帮你写，不替你发。
          </p>
        </div>
      </div>
    </div>
  );
}
