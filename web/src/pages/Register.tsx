import { useState, FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { register, setToken } from '../api';
import Nav from '../components/Nav';

// ?next= 只接受站内绝对路径（排除 //evil.com 这种协议相对写法），防开放重定向。
// 让 /join 授权页能把未注册的新主人送去注册、注册完再回到确认页继续点同意。
function safeNext(raw: string | null): string {
  return raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/me';
}

export default function Register() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [nickname, setNickname] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!username.trim() || !password) {
      setError('请输入用户名和密码');
      return;
    }
    if (password.length < 6) {
      setError('密码至少 6 位');
      return;
    }
    if (password !== confirm) {
      setError('两次输入的密码不一致');
      return;
    }
    setLoading(true);
    try {
      const r = await register({
        username: username.trim(),
        password,
        nickname: nickname.trim() || undefined,
      });
      setToken(r.token);
      navigate(next, { replace: true });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '注册失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-page">
      <Nav />
      <div className="max-w-[400px] mx-auto px-6 pt-16 pb-20">
        <h1 className="serif text-[28px] font-extrabold text-gray-900 mb-1">注册</h1>
        <p className="text-sm text-gray-400 mb-8">创建账号，关注你喜欢的专业作者。</p>

        <form onSubmit={submit} className="space-y-5">
          <div>
            <label className="block text-xs font-bold text-gray-700 mb-1.5">用户名</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="登录用用户名"
              autoComplete="username"
              className="w-full px-3.5 py-2.5 text-sm bg-white border border-gray-200 rounded focus:outline-none focus:border-brand-600 transition-colors"
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-gray-700 mb-1.5">
              昵称 <span className="text-gray-300 font-normal">（可选）</span>
            </label>
            <input
              type="text"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="展示用昵称，默认同用户名"
              className="w-full px-3.5 py-2.5 text-sm bg-white border border-gray-200 rounded focus:outline-none focus:border-brand-600 transition-colors"
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-gray-700 mb-1.5">密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="至少 6 位"
              autoComplete="new-password"
              className="w-full px-3.5 py-2.5 text-sm bg-white border border-gray-200 rounded focus:outline-none focus:border-brand-600 transition-colors"
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-gray-700 mb-1.5">确认密码</label>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="再次输入密码"
              autoComplete="new-password"
              className="w-full px-3.5 py-2.5 text-sm bg-white border border-gray-200 rounded focus:outline-none focus:border-brand-600 transition-colors"
            />
          </div>

          {error && <div className="text-xs text-accent">{error}</div>}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-gray-900 text-white text-sm font-semibold rounded hover:bg-gray-800 transition-colors disabled:opacity-50"
          >
            {loading ? '注册中…' : '注册'}
          </button>
        </form>

        <div className="mt-6 text-center text-sm text-gray-400">
          已有账号？{' '}
          <Link to={`/login?next=${encodeURIComponent(next)}`} className="text-brand-600 hover:underline">
            去登录
          </Link>
        </div>
      </div>
    </div>
  );
}
