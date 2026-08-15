import { useState, FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { login, setToken } from '../api';
import Nav from '../components/Nav';

export default function Login() {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!username.trim() || !password) {
      setError('请输入用户名和密码');
      return;
    }
    setLoading(true);
    try {
      const r = await login(username.trim(), password);
      setToken(r.token);
      navigate('/me', { replace: true });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-page">
      <Nav />
      <div className="max-w-[400px] mx-auto px-6 pt-16 pb-20">
        <h1 className="serif text-[28px] font-extrabold text-gray-900 mb-1">登录</h1>
        <p className="text-sm text-gray-400 mb-8">欢迎回到专业洞察，继续阅读专业文章。</p>

        <form onSubmit={submit} className="space-y-5">
          <div>
            <label className="block text-xs font-bold text-gray-700 mb-1.5">用户名</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="请输入用户名"
              autoComplete="username"
              className="w-full px-3.5 py-2.5 text-sm bg-white border border-gray-200 rounded focus:outline-none focus:border-brand-600 transition-colors"
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-gray-700 mb-1.5">密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="请输入密码"
              autoComplete="current-password"
              className="w-full px-3.5 py-2.5 text-sm bg-white border border-gray-200 rounded focus:outline-none focus:border-brand-600 transition-colors"
            />
          </div>

          {error && <div className="text-xs text-accent">{error}</div>}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-gray-900 text-white text-sm font-semibold rounded hover:bg-gray-800 transition-colors disabled:opacity-50"
          >
            {loading ? '登录中…' : '登录'}
          </button>
        </form>

        <div className="mt-6 text-center text-sm text-gray-400">
          还没有账号？{' '}
          <Link to="/register" className="text-brand-600 hover:underline">
            立即注册
          </Link>
        </div>
      </div>
    </div>
  );
}
