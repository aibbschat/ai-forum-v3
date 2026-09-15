import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { createArticle, getToken, clearToken, uploadImage } from '../api';
import Nav from '../components/Nav';
import { CATEGORY_COLORS } from '../lib';
import { toast } from '../utils/toast';
import { parseBlocks, serializeBlocks, type Block, type ImageBlock, type TextBlock } from '../utils/mdBlocks';

const CATEGORIES = Object.keys(CATEGORY_COLORS);
const DRAFT_KEY = 'aiforum_compose_draft_v1';
const AUTOSAVE_DEBOUNCE = 800;

/** 编辑区内预览图的最大显示高度：再大的截图也只占这么高，绝不撑破编辑框 */
const PREVIEW_MAX_H = 320;

const CONTENT_PLACEHOLDER =
  '正文（支持 Markdown：## 标题、**加粗**、- 列表、> 引用、```代码``` 等）。可直接粘贴或拖入图片，图片会在原位显示为预览图。';

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

/** 找到离光标最近的文本块下标（优先 ctxIdx；否则取最后一个文本块） */
function pickTextBlock(blocks: Block[], wantIdx: number): number {
  if (wantIdx >= 0 && wantIdx < blocks.length && blocks[wantIdx].kind === 'text') return wantIdx;
  for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].kind === 'text') return i;
  return -1;
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
  const taRefs = useRef<(HTMLTextAreaElement | null)[]>([]);
  const titleRef = useRef<HTMLInputElement>(null);
  // 最近一次光标位置（块下标 + 块内选区）。工具栏按钮会先让 textarea 失焦，
  // 所以必须靠 onBlur/onSelect 把位置记下来，等点击回调里再读。
  const caretRef = useRef<{ idx: number; start: number; end: number }>({ idx: -1, start: 0, end: 0 });
  // content 的镜像：异步上传回来时要拿最新的正文（不能读闭包里的旧值）
  const contentRef = useRef(content);
  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  const isAuthed = !!getToken();

  const blocks = useMemo(() => parseBlocks(content), [content]);

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

  /** 把光标送到某个文本块内的指定偏移（React 提交后再做） */
  const placeCaret = useCallback((idx: number, off: number) => {
    requestAnimationFrame(() => {
      const el = taRefs.current[idx];
      if (!el) return;
      el.focus();
      const p = Math.min(Math.max(0, off), el.value.length);
      el.setSelectionRange(p, p);
      caretRef.current = { idx, start: p, end: p };
    });
  }, []);

  const focusContent = useCallback(() => {
    const el = taRefs.current.find((x) => x);
    if (!el) return;
    el.focus();
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, []);

  /** 文本块内容变更（唯一改动 markdown 文本的入口，通过序列化写回 content） */
  const updateTextBlock = useCallback((idx: number, value: string) => {
    setContent((c) => {
      const bs = parseBlocks(c);
      const b = bs[idx];
      if (!b || b.kind !== 'text') return c;
      bs[idx] = { kind: 'text', value };
      return serializeBlocks(bs);
    });
  }, []);

  /** 删除某个图片块（连带收掉一侧多余空行，避免越删越空） */
  const removeBlock = useCallback((i: number) => {
    setContent((c) => {
      const bs: Block[] = parseBlocks(c);
      const victim = bs[i];
      if (!victim || victim.kind !== 'image') return c;
      const rest: Block[] = bs.filter((_, k) => k !== i);
      const prev = rest[i - 1];
      const after = rest[i];
      if (prev && prev.kind === 'text' && after && after.kind === 'text') {
        if (prev.value.endsWith('\n')) rest[i - 1] = { kind: 'text', value: prev.value.slice(0, -1) };
        else if (after.value.startsWith('\n')) rest[i] = { kind: 'text', value: after.value.slice(1) };
      }
      return serializeBlocks(rest);
    });
    toast.info('已移除图片');
  }, []);

  const insertAtCursor = useCallback(
    (before: string, after = '', placeholder = '') => {
      const bs = parseBlocks(contentRef.current);
      const idx = pickTextBlock(bs, caretRef.current.idx);
      if (idx < 0) return;
      const blk = bs[idx] as TextBlock;
      const focused = caretRef.current.idx === idx;
      let start = Math.max(0, Math.min(focused ? caretRef.current.start : blk.value.length, blk.value.length));
      let end = Math.max(start, Math.min(focused ? caretRef.current.end : blk.value.length, blk.value.length));
      const selected = blk.value.slice(start, end) || placeholder;
      bs[idx] = {
        kind: 'text',
        value: blk.value.slice(0, start) + before + selected + after + blk.value.slice(end),
      };
      // 工具栏插入的都是行内语法，不会改变分块结构，所以 idx 仍然有效
      setContent(serializeBlocks(bs));
      placeCaret(idx, start + before.length + selected.length);
    },
    [placeCaret],
  );

  const uploadFiles = useCallback(
    async (files: FileList | File[]) => {
      const imgs = Array.from(files).filter((f) => f.type.startsWith('image/'));
      if (imgs.length === 0) return;
      if (imgs.some((f) => f.size > 4 * 1024 * 1024)) {
        toast.error('单张图片不能超过 4MB');
        return;
      }
      // 上传前记下插入点：上传是异步的，等图片回来时光标多半已失焦，selectionStart 会跑掉
      const caret = { ...caretRef.current };

      setUploading(true);
      try {
        const picked: { alt: string; url: string }[] = [];
        for (const file of imgs) {
          const dataUrl = await readFileAsDataURL(file);
          const r = await uploadImage(dataUrl);
          // 防御：万一同源后端仍是旧实现（回传 data URI），把几 MB 的 base64 插进正文就是满屏乱码
          if (/^data:/i.test(r.url)) throw new Error('图片上传服务异常，请刷新页面后重试');
          picked.push({ alt: file.name.replace(/[[\]]/g, ''), url: r.url });
        }

        const bs = parseBlocks(contentRef.current);
        let idx = pickTextBlock(bs, caret.idx);
        if (idx < 0) {
          bs.push({ kind: 'text', value: '' });
          idx = bs.length - 1;
        }
        const blk = bs[idx] as TextBlock;
        const focused = caret.idx === idx;
        const s = Math.max(0, Math.min(focused ? caret.start : blk.value.length, blk.value.length));
        const e = Math.max(s, Math.min(focused ? caret.end : blk.value.length, blk.value.length));
        const suffix = blk.value.slice(e);

        const block = picked.map((p) => `\n\n![${p.alt}](${p.url})\n\n`).join('');
        bs[idx] = { kind: 'text', value: blk.value.slice(0, s) + block + suffix };
        const nextContent = serializeBlocks(bs);
        setContent(nextContent);

        // 光标落到「最后一张图之后那个文本块」里、原文续写处。
        // 不用绝对偏移回推：插入块前后各带一个空行，绝对偏移在重解析后会差一格，
        // 而「该块值长度 − 未动过的后缀长度」恰好就是续写点。
        const nb = parseBlocks(nextContent);
        const afterIdx = idx + picked.length + 1;
        const afterBlk = nb[afterIdx];
        if (afterBlk && afterBlk.kind === 'text') {
          placeCaret(afterIdx, Math.max(0, afterBlk.value.length - suffix.length));
        } else {
          placeCaret(idx, s + block.length);
        }
        toast.success(`已插入 ${picked.length} 张图片`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '图片上传失败');
      } finally {
        setUploading(false);
      }
    },
    [placeCaret],
  );

  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
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
    },
    [uploadFiles],
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
    },
    [uploadFiles],
  );

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
      focusContent();
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
  const isEmpty = blocks.length === 1 && blocks[0].kind === 'text' && blocks[0].value === '';

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

        {/* 编辑区：按块渲染 —— 文本块是可编辑的 textarea，图片块直接显示预览图而非 markdown 代码 */}
        <div
          onClick={(e) => {
            if (e.target === e.currentTarget) focusContent();
          }}
          onDrop={onDrop}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          className={`w-full min-h-[52vh] max-h-[70vh] overflow-y-auto text-[16px] leading-[1.8] bg-white border rounded-lg p-4 transition-colors ${
            dragOver ? 'border-brand-600 bg-brand-50/30' : errField === 'content' ? 'border-red-400' : 'border-gray-200'
          }`}
        >
          {blocks.map((b, i) => {
            if (b.kind === 'image') {
              return <ImageBlockView key={`i-${i}-${b.url}`} block={b} onRemove={() => removeBlock(i)} />;
            }
            return (
              <AutoTextarea
                key={`t-${i}`}
                value={b.value}
                elRef={(el) => {
                  taRefs.current[i] = el;
                }}
                idx={i}
                caretRef={caretRef}
                placeholder={isEmpty ? CONTENT_PLACEHOLDER : ''}
                onChange={(v) => updateTextBlock(i, v)}
                onPaste={onPaste}
                onFocusBlock={() => {
                  // 聚焦即把上下文切换到这一块，避免工具栏插到别处
                  const el = taRefs.current[i];
                  if (el && caretRef.current.idx !== i) {
                    caretRef.current = { idx: i, start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 };
                  }
                }}
              />
            );
          })}
        </div>

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

/** 自增高文本块：高度跟着内容走，视觉上多块拼起来像一整块编辑区 */
function AutoTextarea({
  value,
  idx,
  caretRef,
  placeholder,
  onChange,
  onPaste,
  onFocusBlock,
  elRef,
}: {
  value: string;
  idx: number;
  caretRef: React.MutableRefObject<{ idx: number; start: number; end: number }>;
  placeholder: string;
  onChange: (v: string) => void;
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onFocusBlock: () => void;
  elRef: (el: HTMLTextAreaElement | null) => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  const remember = (el: HTMLTextAreaElement) => {
    caretRef.current = { idx, start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 };
  };

  return (
    <textarea
      ref={(el) => {
        ref.current = el;
        elRef(el);
      }}
      value={value}
      rows={1}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onPaste={onPaste}
      onFocus={onFocusBlock}
      onSelect={(e) => remember(e.currentTarget)}
      onBlur={(e) => remember(e.currentTarget)}
      onKeyUp={(e) => remember(e.currentTarget)}
      onClick={(e) => remember(e.currentTarget)}
      className="block w-full resize-none overflow-hidden border-0 outline-none bg-transparent p-0 text-[16px] leading-[1.8] font-normal text-gray-900 placeholder:text-gray-300"
    />
  );
}

/** 图片块：直接渲染预览图。高度上限写死，任何大图都不会撑破编辑框。 */
function ImageBlockView({ block, onRemove }: { block: ImageBlock; onRemove: () => void }) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);

  if (block.legacyEmbedded) {
    return (
      <div className="my-3 rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-[12px] text-amber-800">
        <div className="font-medium mb-1">这里有一段旧的「内嵌图片数据」</div>
        <div className="text-amber-700 mb-2">
          它是早期上传 bug 的产物，会把正文撑到几 MB。建议移除后重新上传这张图。
        </div>
        <div className="flex gap-3">
          <button type="button" onClick={onRemove} className="text-red-600 hover:underline">
            移除这段数据
          </button>
          <button type="button" onClick={() => window.open(block.url, '_blank')} className="hover:underline">
            仍要查看
          </button>
        </div>
      </div>
    );
  }

  return (
    <figure className="group my-3 rounded-lg border border-gray-100 bg-gray-50/60 p-2">
      <img
        src={block.url}
        alt={block.alt}
        onLoad={(e) => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
        onError={() => setFailed(true)}
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? '点击收起' : '点击放大显示'}
        className="mx-auto block max-w-full cursor-zoom-in rounded object-contain"
        style={{ maxHeight: expanded ? 'none' : PREVIEW_MAX_H }}
      />
      <figcaption className="mt-1.5 flex items-center gap-2 text-[11px] text-gray-400">
        <span className="truncate">{block.alt || '图片'}</span>
        {dims ? (
          <span className="shrink-0">
            {dims.w}×{dims.h}
            {!expanded && dims.h > PREVIEW_MAX_H ? ' · 已缩放显示' : ''}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="ml-auto shrink-0 hover:text-gray-700"
        >
          {expanded ? '收起' : '放大'}
        </button>
        <button type="button" onClick={onRemove} className="shrink-0 hover:text-red-500">
          删除
        </button>
      </figcaption>
      {failed ? <div className="mt-1 text-[11px] text-red-500">图片加载失败：{block.url}</div> : null}
    </figure>
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
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`text-xs w-8 h-8 rounded border border-gray-200 bg-white hover:border-gray-400 transition-colors ${
        bold ? 'font-bold' : ''
      } ${italic ? 'italic' : ''}`}
    >
      {label}
    </button>
  );
}
