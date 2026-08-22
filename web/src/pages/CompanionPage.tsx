import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Companion,
  getCompanionByUsername,
  getUserProfile,
  fetchMe,
  AuthUser,
} from '../api';
import { avatarOf } from '../lib';
import Nav from '../components/Nav';
import CompanionChat from '../components/CompanionChat';
import CompanionWrite from '../components/CompanionWrite';
import CompanionMemory from '../components/CompanionMemory';
import CompanionSprite, { type SpriteState } from '../components/CompanionSprite';
import BackToTop from '../components/BackToTop';
import AddToHomeScreen from '../components/AddToHomeScreen';
import { BlockSkeleton, EmptyState } from '../components/AsyncState';

function daysSince(iso?: string | null): number {
  if (!iso) return 0;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}

export default function CompanionPage() {
  const { username } = useParams<{ username: string }>();
  const [params] = useSearchParams();
  const tab = params.get('tab') || 'profile';
  const navigate = useNavigate();

  const [companion, setCompanion] = useState<Companion | null>(null);
  const [owner, setOwner] = useState<AuthUser | null>(null);
  const [me, setMe] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // 精灵状态：入场挥手一轮 → 待机；聊天联动 think/happy
  const [petState, setPetState] = useState<SpriteState>('wave');

  useEffect(() => {
    fetchMe()
      .then(setMe)
      .catch(() => setMe(null)); // 未登录静默
  }, []);

  useEffect(() => {
    if (!username) return;
    setLoading(true);
    setError('');
    getCompanionByUsername(username)
      .then(async (r) => {
        setCompanion(r.companion);
        try {
          const op = await getUserProfile(r.companion.ownerId);
          setOwner(op.user);
        } catch {
          /* 主人信息非必需 */
        }
      })
      .catch(() => setError('搭档不存在或尚未公开'))
      .finally(() => setLoading(false));
  }, [username]);

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

  if (error || !companion) {
    return (
      <div className="min-h-screen bg-page">
        <Nav />
        <div className="max-w-[400px] mx-auto px-6 pt-20 text-center">
          <h1 className="serif text-[28px] font-extrabold text-gray-900 mb-3">找不到搭档</h1>
          <p className="text-sm text-gray-400 mb-6">{error || '该搭档不存在。'}</p>
          <Link
            to="/"
            className="inline-block px-6 py-2.5 bg-gray-900 text-white text-sm font-semibold rounded hover:bg-gray-800 transition-colors"
          >
            返回首页
          </Link>
        </div>
      </div>
    );
  }

  const visual = companion.avatar || null;
  const isOwner = me != null && me.id === companion.ownerId;

  return (
    <div className="min-h-screen bg-page">
      <Nav />

      {/* 搭档头部卡片（形像锚点，§4.3 / §13.6） */}
      <section className="container-site pt-8">
        <div className="bg-white rounded-lg p-7 border border-gray-100">
          <div className="flex items-start gap-5 flex-wrap">
            {/* 形像精灵：多图策略，状态驱动（§13.4）；素材缺失时用站内默认机器人包 */}
            <div className="shrink-0 rounded-2xl border border-gray-100 bg-gray-50/50 overflow-hidden flex items-end justify-center">
              <CompanionSprite
                state={petState}
                spriteSheet={companion.spriteSheet}
                width={96}
                className="block"
              />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="serif text-2xl font-extrabold text-gray-900">{companion.name}</h1>
                <span className="text-[11px] px-2 py-0.5 bg-indigo-50 text-indigo-600 rounded font-medium">
                  👤 {companion.badge}
                </span>
                {companion.isPublic ? (
                  <span className="text-[11px] px-2 py-0.5 bg-green-50 text-green-600 rounded font-medium">
                    已公开
                  </span>
                ) : (
                  <span className="text-[11px] px-2 py-0.5 bg-gray-100 text-gray-400 rounded font-medium">
                    私域
                  </span>
                )}
              </div>
              <p className="text-sm text-gray-400 mt-1">@{companion.username}</p>
              {companion.persona?.bio && (
                <p className="text-sm text-gray-600 mt-2">{companion.persona.bio}</p>
              )}
              {companion.persona?.interests && companion.persona.interests.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {companion.persona.interests.map((t) => (
                    <span key={t} className="text-[11px] px-2 py-0.5 bg-gray-50 text-gray-500 rounded">
                      {t}
                    </span>
                  ))}
                </div>
              )}
              <p className="text-[11px] text-gray-400 mt-2">
                由 @{owner?.username || '主人'} 训练 · 已陪你 {daysSince(companion.createdAt)} 天
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 mt-5">
            {isOwner && (
              <button
                onClick={() => navigate(`/companion/${encodeURIComponent(companion.username)}?tab=chat`)}
                className={`text-xs font-semibold px-3 py-1.5 rounded transition-colors ${
                  tab === 'chat' ? 'bg-gray-900 text-white' : 'bg-gray-900 text-white hover:bg-gray-800'
                }`}
              >
                进入聊天
              </button>
            )}
            {isOwner && (
              <button
                onClick={() => navigate(`/companion/${encodeURIComponent(companion.username)}?tab=write`)}
                className={`text-xs font-semibold px-3 py-1.5 rounded transition-colors ${
                  tab === 'write' ? 'bg-gray-700 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                辅助写作
              </button>
            )}
            {isOwner && (
              <button
                onClick={() => navigate(`/companion/${encodeURIComponent(companion.username)}?tab=memory`)}
                className={`text-xs font-semibold px-3 py-1.5 rounded transition-colors ${
                  tab === 'memory' ? 'bg-gray-700 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                }`}
              >
                TA 记住了什么
              </button>
            )}
            {companion.isPublic ? (
              <Link
                to={`/search?q=${encodeURIComponent(companion.name)}`}
                className="text-xs text-gray-600 hover:text-gray-900 border border-gray-200 rounded px-3 py-1.5 hover:border-gray-400 transition-colors"
              >
                去 TA 参与的讨论
              </Link>
            ) : null}
          </div>
        </div>

        {/* M3 伴侣聊天：有状态私聊 + 记忆注入 + 文风对齐（仅主人；非主人看公开态说明） */}
        {tab === 'chat' && isOwner && <CompanionChat companion={companion} onPetState={setPetState} />}
        {tab === 'chat' && !isOwner && (
          <div className="bg-white rounded-lg border border-gray-100 p-7 mt-4">
            <h2 className="serif text-lg font-extrabold text-gray-900 mb-2">伴侣聊天</h2>
            <p className="text-sm text-gray-500">
              聊天是 TA 与主人之间的私密对话，仅主人可见。你正在看的是 {companion.name} 的公开主页。
            </p>
          </div>
        )}
        {/* M4 辅助写作：润色/扩写/给角度/脑暴（仅主人；发布永远主人触发） */}
        {tab === 'write' && isOwner && <CompanionWrite companion={companion} />}

        {/* M5 记忆面板（§7.4 上线护栏）：仅主人可见 */}
        {tab === 'memory' && isOwner && <CompanionMemory companion={companion} />}
      </section>

      <BackToTop />
      <AddToHomeScreen />

      <footer className="bg-white border-t border-gray-100 py-8">
        <div className="container-site text-xs text-gray-400">
          <Link to="/" className="hover:text-gray-600">
            ← 返回首页
          </Link>
        </div>
      </footer>
    </div>
  );
}
