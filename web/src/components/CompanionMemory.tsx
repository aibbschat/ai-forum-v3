import { useCallback, useEffect, useState } from 'react';
import {
  Companion,
  CompanionMemories,
  MemoryLayer,
  listCompanionMemories,
  addCompanionSemanticMemory,
  deleteCompanionMemory,
  clearCompanionMemories,
  setCompanionEpisodicStatus,
  consolidateCompanionMemories,
} from '../api';

/**
 * 记忆面板（M5，§7.4）：透明与控制权——看 TA 记住了什么、删单条、清空、显式教 TA。
 * 隐私红线（§7.3）：仅主人可见；这些记忆不进公共知识库、不喂官方 Agent。
 * 上线护栏（§7.4）：不做记忆面板的伴侣功能不予上线——本组件即该护栏的落地。
 */
export default function CompanionMemory({ companion }: { companion: Companion }) {
  const [mem, setMem] = useState<CompanionMemories | null>(null);
  const [layer, setLayer] = useState<MemoryLayer>('semantic');
  const [newDomain, setNewDomain] = useState('');
  const [newUnderstanding, setNewUnderstanding] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    try {
      setMem(await listCompanionMemories(companion.id));
    } catch {
      setError('记忆加载失败，请稍后再试。');
    }
  }, [companion.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const flashNotice = (t: string) => {
    setNotice(t);
    setTimeout(() => setNotice(''), 2500);
  };

  const handleAdd = async () => {
    const d = newDomain.trim();
    const u = newUnderstanding.trim();
    if (!d || !u) {
      setError('主题和内容都要填。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await addCompanionSemanticMemory(companion.id, d, u);
      setNewDomain('');
      setNewUnderstanding('');
      await refresh();
      flashNotice('TA 记住了');
    } catch {
      setError('添加失败，请稍后再试。');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (l: MemoryLayer, id: number) => {
    try {
      await deleteCompanionMemory(companion.id, l, id);
      await refresh();
    } catch {
      setError('删除失败，请稍后再试。');
    }
  };

  const handleStatus = async (id: number, status: 'verified' | 'rejected') => {
    try {
      await setCompanionEpisodicStatus(companion.id, id, status);
      await refresh();
    } catch {
      setError('操作失败，请稍后再试。');
    }
  };

  const handleClear = async (l?: MemoryLayer) => {
    const what = l ? `清空「${labelOf(l)}」全部记忆？` : '清空 TA 的全部记忆？此操作不可撤销。';
    if (!window.confirm(what)) return;
    try {
      await clearCompanionMemories(companion.id, l);
      await refresh();
      flashNotice('已清空');
    } catch {
      setError('清空失败，请稍后再试。');
    }
  };

  const handleConsolidate = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await consolidateCompanionMemories(companion.id);
      await refresh();
      flashNotice(r.consolidated > 0 ? `巩固完成：归纳出 ${r.consolidated} 条长期记忆` : '暂无可巩固的记忆');
    } catch {
      setError('巩固暂时失败，请稍后再试。');
    } finally {
      setBusy(false);
    }
  };

  if (!mem) {
    return (
      <div className="bg-white rounded-lg border border-gray-100 p-7 mt-4 text-sm text-gray-400">加载记忆面板…</div>
    );
  }

  const total = mem.episodic.length + mem.semantic.length + mem.procedural.length;

  return (
    <div className="bg-white rounded-lg border border-gray-100 mt-4 overflow-hidden">
      {/* 头部：默契轻量呈现（§7.5，不做游戏化） */}
      <div className="px-5 py-4 border-b border-gray-100 bg-gray-50/60">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="serif text-lg font-extrabold text-gray-900">TA 记住了什么</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              共 {total} 条 · 仅你可见，不进公共知识库 · 随时可删（这是你的控制权）
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleConsolidate}
              disabled={busy}
              className="text-xs text-gray-600 hover:text-gray-900 border border-gray-200 rounded px-2.5 py-1.5 hover:border-gray-400 transition-colors bg-white disabled:opacity-40"
              title="把零散的近事归纳成对您的长期了解"
            >
              巩固记忆
            </button>
            <button
              onClick={() => handleClear()}
              className="text-xs text-gray-400 hover:text-red-600 transition-colors"
            >
              全部清空
            </button>
          </div>
        </div>
      </div>

      {/* 层切换 */}
      <div className="flex gap-1 px-4 pt-3 border-b border-gray-100">
        {(['semantic', 'episodic', 'procedural'] as MemoryLayer[]).map((l) => (
          <button
            key={l}
            onClick={() => setLayer(l)}
            className={`text-xs font-semibold px-3 py-2 rounded-t-lg transition-colors -mb-px border-b-2 ${
              layer === l
                ? 'text-gray-900 border-gray-900'
                : 'text-gray-400 border-transparent hover:text-gray-600'
            }`}
          >
            {labelOf(l)}
            <span className="ml-1 text-gray-300">{mem[l].length}</span>
          </button>
        ))}
      </div>

      <div className="px-5 py-4">
        {error && <p className="text-xs text-red-500 mb-3">{error}</p>}
        {notice && <p className="text-xs text-green-600 mb-3">{notice}</p>}

        {/* 语义记忆 + 显式添加 */}
        {layer === 'semantic' && (
          <div className="space-y-2">
            {mem.semantic.map((s) => (
              <div key={s.id} className="group flex items-start gap-3 rounded-lg border border-gray-100 px-3.5 py-2.5">
                <span className="text-[11px] px-2 py-0.5 bg-indigo-50 text-indigo-600 rounded font-medium shrink-0 mt-0.5">
                  {s.domain}
                </span>
                <p className="text-sm text-gray-700 flex-1 min-w-0">{s.understanding}</p>
                <button
                  onClick={() => handleDelete('semantic', s.id)}
                  className="text-xs text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition shrink-0"
                  title="删除这条"
                >
                  删
                </button>
              </div>
            ))}
            {mem.semantic.length === 0 && (
              <p className="text-xs text-gray-400 py-4 text-center">TA 对你还没有长期了解——聊多了会自己长出来，也可以直接教 TA。</p>
            )}
            {/* 显式教学（§7.2 路径 1） */}
            <div className="mt-4 pt-3 border-t border-dashed border-gray-100">
              <p className="text-xs text-gray-400 mb-2">直接教 TA 一条（同主题会覆盖更新）：</p>
              <div className="flex gap-2">
                <input
                  value={newDomain}
                  onChange={(e) => setNewDomain(e.target.value)}
                  placeholder="主题，如：称呼 / 文风 / 禁忌"
                  className="w-36 shrink-0 rounded-lg border border-gray-200 px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-200"
                />
                <input
                  value={newUnderstanding}
                  onChange={(e) => setNewUnderstanding(e.target.value)}
                  placeholder="内容，如：叫我萧哥，别用您"
                  className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-200"
                  onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
                />
                <button
                  onClick={handleAdd}
                  disabled={busy}
                  className="shrink-0 text-xs font-semibold px-3 py-2 rounded-lg bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-40 transition-colors"
                >
                  教 TA
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 情景记忆：近事 + pending 确认 */}
        {layer === 'episodic' && (
          <div className="space-y-2">
            {mem.episodic.map((e) => (
              <div key={e.id} className="group flex items-start gap-3 rounded-lg border border-gray-100 px-3.5 py-2.5">
                <span
                  className={`text-[11px] px-2 py-0.5 rounded font-medium shrink-0 mt-0.5 ${
                    e.status === 'verified'
                      ? 'bg-green-50 text-green-600'
                      : e.status === 'pending'
                        ? 'bg-amber-50 text-amber-600'
                        : 'bg-gray-100 text-gray-400'
                  }`}
                >
                  {e.status === 'verified' ? '已确认' : e.status === 'pending' ? '待确认' : e.status}
                </span>
                <p className="text-sm text-gray-700 flex-1 min-w-0">{e.content}</p>
                <div className="flex items-center gap-1.5 shrink-0">
                  {e.status === 'pending' && (
                    <>
                      <button
                        onClick={() => handleStatus(e.id, 'verified')}
                        className="text-xs text-green-600 hover:text-green-700"
                        title="确认 TA 记对了"
                      >
                        对
                      </button>
                      <button
                        onClick={() => handleStatus(e.id, 'rejected')}
                        className="text-xs text-gray-400 hover:text-red-500"
                        title="TA 记错了，标记拒绝"
                      >
                        错
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => handleDelete('episodic', e.id)}
                    className="text-xs text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition"
                  >
                    删
                  </button>
                </div>
              </div>
            ))}
            {mem.episodic.length === 0 && (
              <p className="text-xs text-gray-400 py-4 text-center">还没有近事记录——和 TA 聊天、一起写作会自动长出来。</p>
            )}
            {mem.episodic.length > 0 && (
              <div className="pt-2 text-right">
                <button
                  onClick={() => handleClear('episodic')}
                  className="text-xs text-gray-400 hover:text-red-600 transition-colors"
                >
                  清空全部近事
                </button>
              </div>
            )}
          </div>
        )}

        {/* 程序性记忆：相处习惯（自动学，只读展示） */}
        {layer === 'procedural' && (
          <div className="space-y-2">
            {mem.procedural.map((p) => (
              <div key={p.id} className="group flex items-start gap-3 rounded-lg border border-gray-100 px-3.5 py-2.5">
                <span className="text-[11px] px-2 py-0.5 bg-gray-100 text-gray-500 rounded font-medium shrink-0 mt-0.5">
                  {p.skill || '习惯'}
                </span>
                <p className="text-sm text-gray-700 flex-1 min-w-0">{p.procedure}</p>
                <button
                  onClick={() => handleDelete('procedural', p.id)}
                  className="text-xs text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition shrink-0"
                >
                  删
                </button>
              </div>
            ))}
            {mem.procedural.length === 0 && (
              <p className="text-xs text-gray-400 py-4 text-center">
                相处久了，这里会自动长出你们之间的习惯（比如「发帖前总让 TA 先看标题」）。
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function labelOf(l: MemoryLayer): string {
  return l === 'semantic' ? '长期了解' : l === 'episodic' ? '近事' : '相处习惯';
}
