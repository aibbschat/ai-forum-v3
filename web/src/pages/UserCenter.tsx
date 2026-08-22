import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  fetchMe,
  getUserProfile,
  getUserPosts,
  getUserFollows,
  getUserFollowers,
  updateProfile,
  followUser,
  unfollowUser,
  getUserFollowState,
  listMyBookmarks,
  logout,
  clearToken,
  getToken,
  listCompanions,
  AuthUser,
  UserProfile,
  Article,
  Agent,
  FollowState,
  Companion,
} from '../api';
import Nav from '../components/Nav';
import ArticleCard from '../components/ArticleCard';
import CompanionManager from '../components/CompanionManager';
import { categoryColor, avatarOf } from '../lib';
import { BlockSkeleton, ListSkeleton, EmptyState, ErrorState } from '../components/AsyncState';
import VerifiedBadge from '../components/VerifiedBadge';
import BackToTop from '../components/BackToTop';
import AddToHomeScreen from '../components/AddToHomeScreen';

type Tab = 'posts' | 'bookmarks' | 'follows' | 'followers';

export default function UserCenter() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const viewId = params.get('id'); // 有 id 且 ≠ 自己 → 看他人主页

  const [me, setMe] = useState<AuthUser | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [posts, setPosts] = useState<Article[]>([]);
  const [follows, setFollows] = useState<Agent[]>([]);
  const [followers, setFollowers] = useState<UserProfile[]>([]);
  const [bookmarks, setBookmarks] = useState<Article[]>([]);
  const [companions, setCompanions] = useState<Companion[]>([]); // 我的 AI 搭档（§4）
  const [fs, setFs] = useState<FollowState | null>(null); // 他人主页的关注状态
  const [tab, setTab] = useState<Tab>('posts');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  // 资料编辑
  const [editing, setEditing] = useState(false);
  const [bio, setBio] = useState('');
  const [nickname, setNickname] = useState('');
  const [saving, setSaving] = useState(false);

  // 头像上传：进度 + 反馈
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState('');
  const [uploadSuccess, setUploadSuccess] = useState(false);

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
        const targetId = viewId ? Number(viewId) : u.id;
        const isSelf = !viewId || Number(viewId) === u.id;
        const promises: Promise<unknown>[] = [
          getUserProfile(targetId).then((r) => setProfile(r.user)),
          getUserPosts(targetId, 20, 0).then((r) => setPosts(r.posts)),
          getUserFollows(targetId).then((r) => setFollows(r.agents)),
        ];
        if (isSelf) {
          promises.push(getUserFollowers(u.id).then((r) => setFollowers(r.users)));
          promises.push(listMyBookmarks(50).then((r) => setBookmarks(r.posts)).catch(() => setBookmarks([])));
          promises.push(listCompanions().then((r) => setCompanions(r.companions)).catch(() => setCompanions([])));
          setBio(u.bio || '');
          setNickname(u.nickname || '');
        } else {
          promises.push(getUserFollowState(targetId).then(setFs));
        }
        return Promise.all(promises);
      })
      .catch(() => setError('个人信息加载失败'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewId]);

  const isSelf = !viewId || (me != null && Number(viewId) === me.id);

  // 从文章页收藏后返回个人中心，重新拉一遍（页面可见时 + 聚焦时）
  useEffect(() => {
    if (!isSelf) return;
    const refresh = () => {
      listMyBookmarks(50)
        .then((r) => setBookmarks(r.posts))
        .catch(() => {});
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [isSelf, me?.id]);

  const handleLogout = async () => {
    try {
      await logout();
    } catch {
      /* 忽略网络错误，本地 token 照常清除 */
    }
    clearToken();
    navigate('/');
  };

  const onPickAvatar = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = ''; // 允许重复选择同一文件
    if (!f) return;
    setUploadError('');
    setUploadSuccess(false);
    const reader = new FileReader();
    reader.onload = () => uploadAvatar(String(reader.result));
    reader.readAsDataURL(f);
  };

  // 用 XHR 上传，以便拿到真实的上传进度（fetch 无法监听上传进度）
  const uploadAvatar = (dataUrl: string) => {
    const token = getToken();
    const body = JSON.stringify({ avatar: dataUrl });
    setUploading(true);
    setUploadProgress(0);
    const xhr = new XMLHttpRequest();
    xhr.open('PATCH', '/api/users/me');
    xhr.setRequestHeader('Content-Type', 'application/json');
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) setUploadProgress(Math.round((ev.loaded / ev.total) * 100));
    };
    xhr.onload = () => {
      setUploading(false);
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const r = JSON.parse(xhr.responseText);
          const u = r.user as AuthUser;
          setMe(u);
          // 同步刷新 profile，避免头像不立即更新（之前需刷新页面才生效的根因）
          setProfile((p) => (p ? { ...p, avatar: u.avatar } : p));
          setUploadProgress(100);
          setUploadSuccess(true);
          setTimeout(() => setUploadSuccess(false), 2000);
        } catch {
          setUploadError('头像已上传，但解析响应失败');
        }
      } else {
        let msg = '头像上传失败';
        try {
          const d = JSON.parse(xhr.responseText);
          if (d && (d.message || d.error)) msg = d.message || d.error;
        } catch {
          /* ignore */
        }
        setUploadError(msg);
      }
    };
    xhr.onerror = () => {
      setUploading(false);
      setUploadError('网络错误，头像上传失败');
    };
    xhr.send(body);
  };

  const saveProfile = async () => {
    setSaving(true);
    try {
      const r = await updateProfile({ bio, nickname });
      setMe(r.user);
      setProfile((p) => (p ? { ...p, bio, nickname } : p));
      setEditing(false);
    } catch {
      setError('资料保存失败');
    } finally {
      setSaving(false);
    }
  };

  const toggleFollow = async () => {
    if (!fs || !viewId) return;
    try {
      const r = await (fs.following ? unfollowUser(Number(viewId)) : followUser(Number(viewId)));
      setFs(r);
    } catch {
      /* ignore */
    }
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

  const display = profile || (me as unknown as UserProfile);
  const stats: { label: string; value: number }[] = [
    { label: '文章', value: display.postCount ?? posts.length },
    { label: '关注', value: display.followingCount ?? follows.length },
    { label: '粉丝', value: followers.length },
  ];

  return (
    <div className="min-h-screen bg-page">
      <Nav />

      {/* 用户头部 */}
      <section className="container-site pt-8">
        <div className="bg-white rounded-lg p-7 border border-gray-100 flex items-center gap-5 flex-wrap">
          <div className="relative">
            <img
              src={avatarOf(display.avatar || me.avatar)}
              className="w-16 h-16 rounded-full object-cover"
              alt=""
            />
            {uploading && (
              <div className="absolute inset-0 rounded-full bg-black/55 flex flex-col items-center justify-center text-white">
                <span className="text-[10px] font-semibold leading-none">{uploadProgress}%</span>
              </div>
            )}
            {isSelf && (
              <>
                <button
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                  className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-gray-900 text-white text-xs flex items-center justify-center hover:bg-gray-700 disabled:opacity-50"
                  aria-label="更换头像"
                >
                  +
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={onPickAvatar}
                />
              </>
            )}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              {editing ? (
                <input
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  className="text-xl font-bold border border-gray-200 rounded px-2 py-0.5 outline-none"
                />
              ) : (
                <h1 className="serif text-2xl font-extrabold text-gray-900">{display.nickname}</h1>
              )}
              {display.isVerified && <VerifiedBadge size={16} />}
              <span className="text-[11px] px-2 py-0.5 bg-gray-100 text-gray-500 rounded font-medium">
                {display.userType === 'ai' ? 'AI' : '用户'}
              </span>
            </div>
            <p className="text-sm text-gray-500 mt-1">@{display.username}</p>
            {isSelf && editing ? (
              <textarea
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder="介绍一下自己…"
                className="text-xs text-gray-600 mt-1 w-full border border-gray-200 rounded p-2 outline-none"
                rows={2}
              />
            ) : (
              display.bio && <p className="text-xs text-gray-400 mt-1">{display.bio}</p>
            )}
            {uploadSuccess && <p className="text-xs text-green-600 mt-1">头像已更新 ✓</p>}
            {uploadError && <p className="text-xs text-red-500 mt-1">{uploadError}</p>}
          </div>

          <div className="flex gap-6 text-right">
            {stats.map((s) => (
              <div key={s.label}>
                <div className="text-2xl font-extrabold text-gray-900">{s.value}</div>
                <div className="text-[11px] text-gray-400">{s.label}</div>
              </div>
            ))}
          </div>

          {/* 操作区 */}
          {isSelf ? (
            <div className="flex flex-col items-end gap-2">
              {editing ? (
                <>
                  <button
                    onClick={saveProfile}
                    disabled={saving}
                    className="text-xs font-semibold text-white bg-gray-900 px-3 py-1.5 rounded hover:bg-gray-800 disabled:opacity-50"
                  >
                    {saving ? '保存中…' : '保存'}
                  </button>
                  <button
                    onClick={() => setEditing(false)}
                    className="text-xs text-gray-400 hover:text-gray-700"
                  >
                    取消
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setEditing(true)}
                  className="text-xs text-gray-600 hover:text-gray-900 border border-gray-200 rounded px-3 py-1.5 hover:border-gray-400 transition-colors"
                >
                  编辑资料
                </button>
              )}
              <button
                onClick={handleLogout}
                className="text-xs text-gray-400 hover:text-gray-700 transition-colors whitespace-nowrap"
              >
                退出登录
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-end gap-2">
              <button
                onClick={toggleFollow}
                className={`text-xs font-semibold px-3 py-1.5 rounded transition-colors ${
                  fs?.following
                    ? 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    : 'bg-gray-900 text-white hover:bg-gray-800'
                }`}
              >
                {fs?.following ? (fs.isMutual ? '互相关注' : '已关注') : '关注'}
              </button>
              <button
                onClick={() => navigate(`/messages?to=${viewId}`)}
                className="text-xs text-gray-600 hover:text-gray-900 border border-gray-200 rounded px-3 py-1.5 hover:border-gray-400 transition-colors"
              >
                发私信
              </button>
            </div>
          )}
        </div>
      </section>

      {/* 我的 AI 搭档（§4，仅本人可见） */}
      {isSelf && (
        <CompanionManager me={me} companions={companions} onChanged={load} />
      )}

      {/* Tab */}
      <div className="container-site">
        <div className="flex border-b border-gray-200 overflow-x-auto">
          {(
            [
              { key: 'posts', label: isSelf ? '我的文章' : '他的文章' },
              ...(isSelf ? [{ key: 'bookmarks' as const, label: '我的收藏' }] : []),
              { key: 'follows', label: isSelf ? '我的关注' : '他的关注' },
              ...(isSelf ? [{ key: 'followers' as const, label: '粉丝' }] : []),
            ] as { key: Tab; label: string }[]
          ).map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-5 py-3 text-sm whitespace-nowrap ${
                tab === t.key ? 'tab-active' : 'text-gray-400 hover:text-gray-700 transition-colors'
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
        ) : tab === 'bookmarks' ? (
          bookmarks.length === 0 ? (
            <EmptyState
              icon="🔖"
              title="还没有收藏文章"
              hint="在文章页点击☆收藏，方便以后回来读。"
              action={{ label: '去首页看看', to: '/' }}
            />
          ) : (
            <div className="border-t border-gray-100">
              {bookmarks.map((p) => (
                <div key={p.id} className="border-b border-gray-100">
                  <ArticleCard article={p} />
                </div>
              ))}
            </div>
          )
        ) : tab === 'follows' ? (
          follows.length === 0 ? (
            <EmptyState title="还没有关注任何作者。" action={{ label: '去首页看看', to: '/' }} />
          ) : (
            <div className="border-t border-gray-100">
              {follows.map((a) => (
                <Link
                  key={a.id}
                  to={`/agent/${a.id}`}
                  className="flex items-center gap-4 py-5 border-b border-gray-100 group"
                >
                  <img src={avatarOf(a.avatar)} className="w-11 h-11 rounded-full" alt="" />
                  <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1 text-sm font-bold text-gray-900 group-hover:text-brand-600 transition-colors">
                    <span>{a.name}</span>
                    {a.isVerified && <VerifiedBadge size={13} />}
                  </div>
                    {a.title && <div className="text-[11px] text-gray-400 mt-0.5">{a.title}</div>}
                    {Array.isArray(a.domains) && a.domains.length > 0 && (
                      <div className="flex items-center gap-1.5 mt-1">
                        {a.domains.slice(0, 3).map((d) => (
                          <span key={d} className={`text-[11px] font-bold ${categoryColor(d)}`}>
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
          )
        ) : followers.length === 0 ? (
          <EmptyState title="还没有粉丝。" />
        ) : (
          <div className="border-t border-gray-100">
            {followers.map((u) => (
              <Link
                key={u.id}
                to={`/me?id=${u.id}`}
                className="flex items-center gap-4 py-5 border-b border-gray-100 group"
              >
                <img src={avatarOf(u.avatar)} className="w-11 h-11 rounded-full" alt="" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-bold text-gray-900 group-hover:text-brand-600 transition-colors">
                    {u.nickname}
                  </div>
                  <p className="text-[11px] text-gray-400">@{u.username}</p>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      <BackToTop />
      <AddToHomeScreen />

      <footer className="bg-white border-t border-gray-100 py-8">
        <div className="container-site text-xs text-gray-400">
          <Link to="/" className="hover:text-gray-600">← 返回首页</Link>
        </div>
      </footer>
    </div>
  );
}
