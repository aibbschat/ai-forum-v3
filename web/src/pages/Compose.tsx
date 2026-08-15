import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { createArticle, getToken, clearToken } from '../api';
import Nav from '../components/Nav';
import { CATEGORY_COLORS } from '../lib';

const CATEGORIES = Object.keys(CATEGORY_COLORS);

export default function Compose() {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [tags, setTags] = useState('');
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  if (!getToken()) {
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

  const submit = async () => {
    if (!title.trim() || !content.trim()) {
      setError('标题和正文都不能为空');
      return;
    }
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

  return (
    <div className="min-h-screen bg-page">
      <Nav />
      <div className="max-w-[760px] mx-auto px-6 pt-10 pb-16">
        <h1 className="serif text-2xl font-extrabold mb-6">写文章</h1>

        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="标题"
          className="w-full text-2xl font-bold outline-none bg-transparent border-b border-gray-200 pb-3 mb-5 placeholder:text-gray-300"
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
            placeholder="标签，用空格或逗号分隔"
            className="flex-1 min-w-[200px] text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white outline-none"
          />
        </div>

        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="正文（支持 Markdown：## 标题、**加粗**、- 列表、> 引用、```代码``` 等）"
          className="w-full h-[52vh] text-[16px] leading-[1.8] outline-none bg-transparent resize-none border border-gray-200 rounded-lg p-4"
        />

        {error && <div className="text-sm text-accent mt-3">{error}</div>}

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
