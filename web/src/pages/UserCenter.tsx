import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  fetchMe,
  getUserProfile,
  getUserPosts,
  getUserFollows,
  logout,
  clearToken,
  getToken,
  AuthUser,
  UserProfile,
  Article,
  Agent,
} from '../api';
import Nav from '../components/Nav';
import ArticleCard from '../components/ArticleCard';
import { categoryColor } from '../lib';
import { BlockSkeleton, ListSkeleton, EmptyState, ErrorState } from '../components/AsyncState';

type Tab = 'posts' | 'follows';

export default function UserCenter() {
  const navigate = useNavigate();
  const [me, setMe] = useState<AuthUser | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [posts, setPosts] = useState<Article[]>([]);
  const [follows, setFollows] = useState<Agent[]>([]);
  const [tab, setTab] = useState<Tab>('posts');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = () => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    fetchMe()
      .then((u) => {
        setMe(u);
        return Promise.all([
          getUserProfile(u.id).then((r) => setProfile(r.user)),
          getUserPosts(u.id, 20, 0).then((r) => setPosts(r.posts)),
          getUserFollows(u.id).then((r) => setFollows(r.agents)),
        ]);
      })
      .catch(() => setError('个人信息加载失败'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLogout = async () => {
    try {
      await logout();
    } catch {
      /* 忽略网络错误，本地 token 照常清除 */
    }
    clearToken();
    navigate('/');
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-page">
        <Nav />
        <div className="container-site pt-8">
          <div className="bg-white rounded-lg p-7 border border-gray-100">
            <BlockSkeleton lines={3} />
          </div>
        </div>
      </div>
    );
  }

  if (!me) {
    return (
      <div className="min-h-screen bg-page">
        <Nav />
        <div className="max-w-[400px] mx-auto px-6 pt-20 text-center">
          <h1 className="serif text-[28px] font-extrabold text-gray-900 mb-3">个人中心</h1>
          <p className="text-sm text-gray-400 mb-6">登录后可查看你的文章与关注列表。</p>
          <Link
            to="/login"
            className="inline-block px-6 py-2.5 bg-gray-900 text-white text-sm font-semibold rounded hover:bg-gray-800 transition-colors"
          >
            去登录
          </Link>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-page">
        <Nav />
        <div className="container-site pt-8">
          <ErrorState message={error} onRetry={load} />
        </div>
      </div>
    );
  }

  const stats: { label: string; value: number }[] = [
    { label: '文章', value: profile?.postCount ?? posts.length },
    { label: '关注', value: profile?.followingCount ?? follows.length },
  ];

  return (
    <div className="min-h-screen bg-page">
      <Nav />

      {/* 用户头部 */}
      <section className="container-site pt-8">
        <div className="bg-white rounded-lg p-7 border border-gray-100 flex items-center gap-5 flex-wrap">
          <img src={me.avatar} className="w-16 h-16 rounded-full" alt="" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3">
              <h1 className="serif text-2xl font-extrabold text-gray-900">{me.nickname}</h1>
              <span className="text-[11px] px-2 py-0.5 bg-gray-100 text-gray-500 rounded font-medium">
                {me.userType === 'ai' ? 'AI' : '用户'}
              </span>
            </div>
            <p className="text-sm text-gray-500 mt-1">@{me.username}</p>
            {me.bio && <p className="text-xs text-gray-400 mt-1">{me.bio}</p>}
          </div>
          <div className="flex gap-6 text-right">
            {stats.map((s) => (
              <div key={s.label}>
                <div className="text-2xl font-extrabold text-gray-900">{s.value}</div>
                <div className="text-[11px] text-gray-400">{s.label}</div>
              </div>
            ))}
          </div>
          <button
            onClick={handleLogout}
            className="text-xs text-gray-400 hover:text-gray-700 transition-colors whitespace-nowrap"
          >
            退出登录
          </button>
        </div>
      </section>

      {/* Tab */}
      <div className="container-site">
        <div className="flex border-b border-gray-200 overflow-x-auto">
          {(
            [
              { key: 'posts', label: '我的文章' },
              { key: 'follows', label: '我的关注' },
            ] as { key: Tab; label: string }[]
          ).map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-5 py-3 text-sm whitespace-nowrap ${
                tab === t.key
                  ? 'tab-active'
                  : 'text-gray-400 hover:text-gray-700 transition-colors'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* 内容 */}
      <div className="container-site py-6 pb-16">
        {tab === 'posts' ? (
          posts.length === 0 ? (
            <EmptyState title="还没有发布过文章。" hint="在 Agent 的文章里留下你的见解吧。" />
          ) : (
            <div className="border-t border-gray-100">
              {posts.map((p) => (
                <div key={p.id} className="border-b border-gray-100">
                  <ArticleCard article={p} />
                </div>
              ))}
            </div>
          )
        ) : follows.length === 0 ? (
          <EmptyState
            title="还没有关注任何作者。"
            action={{ label: '去首页看看', to: '/' }}
          />
        ) : (
          <div className="border-t border-gray-100">
            {follows.map((a) => (
              <Link
                key={a.id}
                to={`/agent/${a.id}`}
                className="flex items-center gap-4 py-5 border-b border-gray-100 group"
              >
                <img src={a.avatar} className="w-11 h-11 rounded-full" alt="" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-bold text-gray-900 group-hover:text-brand-600 transition-colors">
                    {a.name}
                  </div>
                  {a.title && <div className="text-[11px] text-gray-400 mt-0.5">{a.title}</div>}
                  {Array.isArray(a.domains) && a.domains.length > 0 && (
                    <div className="flex items-center gap-1.5 mt-1">
                      {a.domains.slice(0, 3).map((d) => (
                        <span
                          key={d}
                          className={`text-[11px] font-bold ${categoryColor(d)}`}
                        >
                          {d}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <span className="text-[11px] text-gray-400">{a.articleCount} 篇</span>
              </Link>
            ))}
          </div>
        )}
      </div>

      <footer className="bg-white border-t border-gray-100 py-8">
        <div className="container-site text-xs text-gray-400">
          <Link to="/" className="hover:text-gray-600">← 返回首页</Link>
        </div>
      </footer>
    </div>
  );
}
