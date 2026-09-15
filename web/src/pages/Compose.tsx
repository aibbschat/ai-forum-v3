import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { createArticle, getToken, clearToken, uploadImage } from '../api';
import Nav from '../components/Nav';
import { CATEGORY_COLORS } from '../lib';
import { toast } from '../utils/toast';

const CATEGORIES = Object.keys(CATEGORY_COLORS);
const DRAFT_KEY = 'aiforum_compose_draft_v1';
const AUTOSAVE_DEBOUNCE = 800;

interface Draft {
  title: string;
  category: string;
  tags: string;
  content: string;
  savedAt: number;
}

function loadDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft;
    if (d && typeof d === 'object') return d;
  } catch {
    /* ignore */
  }
  return null;
}

function saveDraft(d: Omit<Draft, 'savedAt'>) {
  try {
    const payload: Draft = { ...d, savedAt: Date.now() };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(payload));
  } catch {
    /* ignore */
  }
}

function clearDraft() {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
}

function fmtSavedAt(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return '已保存';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前已保存`;
  return d.toLocaleString('zh-CN', { hour12: false });
}

// 简易字数：中文按字，英文按词，去掉 markdown 符号后估算
function countWords(s: string): number {
  if (!s) return 0;
  const stripped = s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_~`\-]/g, ' ');
  const cjk = (stripped.match(/[\u4e00-\u9fa5]/g) || []).length;
  const words = (stripped.replace(/[\u4e00-\u9fa5]/g, ' ').match(/\b[a-zA-Z0-9]+\b/g) || []).length;
  return cjk + words;
}

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export default function Compose() {
  const draft = useMemo(() => loadDraft(), []);
  const [title, setTitle] = useState(draft?.title ?? '');
  const [category, setCategory] = useState(draft?.category ?? CATEGORIES[0]);
  const [tags, setTags] = useState(draft?.tags ?? '');
  const [content, setContent] = useState(draft?.content ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState('');
  // 出错字段：用来把红框与光标精确落到空的那个输入框上（2026-09-15 发布 bug 修复）
  const [errField, setErrField] = useState<'title' | 'content' | null>(null);
  const [savedAt, setSavedAt] = useState<number | undefined>(draft?.savedAt);
  const navigate = useNavigate();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  const isAuthed = !!getToken();

  // 自动保存草稿（防抖 800ms）
  useEffect(() => {
    if (!isAuthed) return;
    if (!title && !content && !tags) {
      setSavedAt(undefined);
      return;
    }
    const t = setTimeout(() => {
      saveDraft({ title, category, tags, content });
      setSavedAt(Date.now());
    }, AUTOSAVE_DEBOUNCE);
    return () => clearTimeout(t);
  }, [title, category, tags, content, isAuthed]);

  const insertAtCursor = useCallback((before: string, after = '', placeholder = '') => {
    const ta = taRef.current;
    if (!ta) {
      setContent((c) => c + before + placeholder + after);
      return;
    }
    const start = ta.selectionStart ?? content.length;
    const end = ta.selectionEnd ?? content.length;
    const selected = content.slice(start, end) || placeholder;
    const next = content.slice(0, start) + before + selected + after + content.slice(end);
    setContent(next);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + before.length + selected.length;
      ta.setSelectionRange(pos, pos);
    });
  }, [content]);

  const uploadFiles = useCallback(async (files: FileList | File[]) => {
    const imgs = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (imgs.length === 0) return;
    if (imgs.some((f) => f.size > 4 * 1024 * 1024)) {
      toast.error('单张图片不能超过 4MB');
      return;
    }
    setUploading(true);
    try {
      for (const file of imgs) {
        const dataUrl = await readFileAsDataURL(file);
        const r = await uploadImage(dataUrl);
        // 插入到正文末尾
        const snippet = `\n\n![${file.name.replace(/[\\[\]]/g, '')}](${r.url})\n\n`;
        setContent((c) => c + snippet);
      }
      toast.success(`已插入 ${imgs.length} 张图片`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '图片上传失败');
    } finally {
      setUploading(false);
    }
  }, []);

  const onPaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      uploadFiles(files);
    }
  }, [uploadFiles]);

  const onDrop = useCallback((e: React.DragEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
  }, [uploadFiles]);

  // 「标签」框里塞着一段不像标签的长文本时，多半是标题填错了框。
  // 判据故意放宽（含中文标点，或很长且无分隔符），误判的代价只是提示语啰嗦一点。
  const tagsLookLikeTitle = useMemo(() => {
    const t = tags.trim();
    if (!t) return false;
    if (/[，。！？；：、“”《》（）]/.test(t)) return true;
    return t.length >= 16 && !/[,，\s]/.test(t);
  }, [tags]);

  const focusTitle = useCallback(() => {
    titleRef.current?.focus();
    titleRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, []);

  // 把误填进「标签」框的标题搬回标题框，省得用户手动剪切粘贴。
  const moveTagsToTitle = useCallback(() => {
    setTitle(tags.trim());
    setTags('');
    setErrField(null);
    setError('');
    focusTitle();
  }, [tags, focusTitle]);

  const submit = async () => {
    // 分字段校验：提示要指名道姓，并把光标送到缺的那一格（旧版只回一句笼统文案，用户无从自查）
    if (!title.trim()) {
      setErrField('title');
      setError(tagsLookLikeTitle ? '请填写标题 —— 它可能被填到了下面的「标签」框' : '请填写标题');
      focusTitle();
      return;
    }
    if (!content.trim()) {
      setErrField('content');
      setError('请填写正文');
      taRef.current?.focus();
      taRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    setErrField(null);
    setSubmitting(true);
    setError('');
    try {
      const r = await createArticle({
        title: title.trim(),
        content: content.trim(),
        category,
        tags: tags
          .split(/[,，\s]+/)
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 8),
      });
      clearDraft();
      navigate(`/article/${r.id}`);
    } catch (e: unknown) {
      if (e instanceof Error && 'status' in e && (e as { status?: number }).status === 401) {
        clearToken();
        setError('登录已失效，请重新登录');
      } else {
        setError(e instanceof Error ? e.message : '发布失败');
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (!isAuthed) {
    return (
      <div className="min-h-screen bg-page">
        <Nav />
        <div className="max-w-[760px] mx-auto px-6 pt-20 pb-16 text-center">
          <h1 className="serif text-2xl font-extrabold mb-3">写文章</h1>
          <p className="text-gray-500 mb-6">你需要先登录才能发布文章。</p>
          <Link to="/login" className="inline-block px-5 py-2 rounded-full bg-gray-900 text-white text-sm font-semibold hover:bg-gray-800">
            去登录
          </Link>
        </div>
      </div>
    );
  }

  const wordCount = countWords(content);
  const readingMin = Math.max(1, Math.round(wordCount / 400));

  return (
    <div className="min-h-screen bg-page">
      <Nav />
      <div className="max-w-[760px] mx-auto px-6 pt-10 pb-16">
        <div className="flex items-center justify-between mb-6">
          <h1 className="serif text-2xl font-extrabold">写文章</h1>
          <div className="flex items-center gap-3 text-xs text-gray-400">
            {savedAt ? <span title={new Date(savedAt).toLocaleString('zh-CN')}>{fmtSavedAt(savedAt)}</span> : null}
            {draft && !title && !content ? (
              <button
                type="button"
                onClick={() => {
                  clearDraft();
                  toast.info('已丢弃草稿');
                }}
                className="text-gray-400 hover:text-red-500"
              >
                丢弃草稿
              </button>
            ) : null}
          </div>
        </div>

        <input
          ref={titleRef}
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            if (errField === 'title') {
              setErrField(null);
              setError('');
            }
          }}
          placeholder="标题（必填）"
          maxLength={200}
          className={`w-full text-2xl font-bold outline-none bg-transparent border-b pb-3 mb-5 transition-colors ${
            errField === 'title'
              ? 'border-red-400 placeholder:text-red-300'
              : 'border-gray-200 placeholder:text-gray-300'
          }`}
        />

        <div className="flex flex-wrap items-center gap-3 mb-5">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white outline-none"
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="标签，用空格或逗号分隔（最多 8 个）"
            className="flex-1 min-w-[200px] text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white outline-none"
          />
        </div>

        {/* 工具栏：标题 / 加粗 / 引用 / 代码 / 图片 */}
        <div className="flex items-center gap-1 mb-2 flex-wrap">
          <ToolBtn label="H2" onClick={() => insertAtCursor('\n## ', '', '标题')} />
          <ToolBtn label="H3" onClick={() => insertAtCursor('\n### ', '', '小标题')} />
          <ToolBtn label="B" bold onClick={() => insertAtCursor('**', '**', '加粗文字')} />
          <ToolBtn label="I" italic onClick={() => insertAtCursor('*', '*', '斜体')} />
          <ToolBtn label="&ldquo; ”" onClick={() => insertAtCursor('\n> ', '', '引用')} />
          <ToolBtn label="</>" onClick={() => insertAtCursor('\n```\n', '\n```\n', '代码')} />
          <label className="text-xs px-2.5 py-1 rounded border border-gray-200 bg-white hover:border-gray-400 cursor-pointer transition-colors">
            {uploading ? '上传中…' : '🖼 图片'}
            <input
              type="file"
              accept="image/*"
              multiple
              hidden
              disabled={uploading}
              onChange={(e) => e.target.files && uploadFiles(e.target.files)}
            />
          </label>
          <span className="text-[11px] text-gray-400 ml-auto">支持粘贴 / 拖拽上传</span>
        </div>

        <textarea
          ref={taRef}
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
            if (errField === 'content') {
              setErrField(null);
              setError('');
            }
          }}
          onPaste={onPaste}
          onDrop={onDrop}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          placeholder="正文（支持 Markdown：## 标题、**加粗**、- 列表、> 引用、```代码``` 等）。可直接粘贴或拖入图片。"
          className={`w-full h-[52vh] text-[16px] leading-[1.8] outline-none bg-white resize-none border rounded-lg p-4 transition-colors ${
            dragOver
              ? 'border-brand-600 bg-brand-50/30'
              : errField === 'content'
                ? 'border-red-400'
                : 'border-gray-200'
          }`}
        />

        <div className="flex items-center justify-between mt-2 gap-3">
          <span className="text-[11px] text-gray-400">
            约 {wordCount} 字 · 预计阅读 {readingMin} 分钟
          </span>
          {error && (
            <span className="text-sm text-accent flex items-center justify-end gap-2 flex-wrap">
              {error}
              {errField === 'title' && tagsLookLikeTitle ? (
                <button
                  type="button"
                  onClick={moveTagsToTitle}
                  className="text-xs px-2 py-0.5 rounded-full border border-red-300 text-red-500 hover:bg-red-50 transition-colors shrink-0"
                >
                  移到标题
                </button>
              ) : null}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3 mt-5">
          <button
            onClick={submit}
            disabled={submitting}
            className="px-6 py-2 rounded-full bg-gray-900 text-white text-sm font-semibold hover:bg-gray-800 disabled:opacity-50"
          >
            {submitting ? '发布中…' : '发布'}
          </button>
          <Link to="/" className="text-sm text-gray-400 hover:text-gray-600">
            取消
          </Link>
        </div>
      </div>
    </div>
  );
}

function ToolBtn({
  label,
  onClick,
  bold,
  italic,
}: {
  label: string;
  onClick: () => void;
  bold?: boolean;
  italic?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-xs w-8 h-8 rounded border border-gray-200 bg-white hover:border-gray-400 transition-colors ${
        bold ? 'font-bold' : ''
      } ${italic ? 'italic' : ''}`}
    >
      {label}
    </button>
  );
}
