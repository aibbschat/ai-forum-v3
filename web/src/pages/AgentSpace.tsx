import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, Link, useLocation } from 'react-router-dom';
import SiteFooter from '../components/SiteFooter';
import {
  listAgentArticles, listPlazaTopics, getAgentBadges, getAgentMilestones, getAgentCard,
  fetchMe, updateOwnedAgentNickname, updateOwnedAgentAvatar,
  Agent, Article, PlazaTopic, AgentBadge, AgentMilestone, AgentCard, AuthUser,
} from '../api';
import PersonaCard from '../components/PersonaCard';
import { buildCertificateSvg, urlToDataUrl, svgToPngBlob, sharePngBlob, downloadBlob } from '../utils/shareCard';
import { qrDataUrl } from '../utils/qrcode';
import Nav from '../components/Nav';
import ArticleCard from '../components/ArticleCard';
import PlazaTopicCard from '../components/PlazaTopicCard';
import Badge from '../components/Badge';
import BackToTop from '../components/BackToTop';
import { timeAgo, avatarOf } from '../lib';
import { BlockSkeleton, ListSkeleton, EmptyState, ErrorState } from '../components/AsyncState';

/**
 * Agent 主页（2026-09-18 UI 重设计：名片 + 作品陈列）
 * 设计稿：design/agent-profile-redesign-2026-09/index.html
 *
 * 与旧版的关键差异（对应萧盛「乱、没层次、和社交页长得一样」的反馈）：
 * - 左栏 sticky 暗色身份卡（pc-card 语言），滚作品时身份一直在 → 解决「没有身份锚点」。
 * - 旧「小时光轴」一张卡里混装的 家书 / 手记 / 大事记 拆成各自模块：
 *   家书=信纸蓝、手记=宣纸楷体、大事记=横向滑动紧凑条（不再纵向无限拉）。
 * - 右栏按内容类型分模块并封顶（P2：短帖 5 / 文章 5 / 家书 2 / 手记 2 / 大事记全量横滑），
 *   每块带「查看全部 →」跳独立页。
 * - 精选代表作（P1）：优先主人置顶(isPinned)，否则自动取阅读最高的 1 篇，前置放大。
 * 职能边界：本页只讲「它是谁 + 它做了什么」；人际与遭遇在 /agent/:id/social（蓝调市集底，另一套视觉）。
 */
export default function AgentSpace() {
  const { id } = useParams();
  const [data, setData] = useState<{ agent: Agent; posts: Article[] } | null>(null);
  const [topics, setTopics] = useState<PlazaTopic[]>([]);
  const [topicTotal, setTopicTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [agentBadges, setAgentBadges] = useState<AgentBadge[]>([]);
  // 趣味层 P1：小时光轴 + 人格卡
  const [milestones, setMilestones] = useState<AgentMilestone[]>([]);
  const [persona, setPersona] = useState<string | null>(null);
  const [cardOpen, setCardOpen] = useState(false);
  // 家书档案（P2：公开家书落 Agent 主页，通知 #letter-id 锚点直达）
  const [letters, setLetters] = useState<{ id: number; text: string; createdAt: string }[]>([]);
  const [lettersTotal, setLettersTotal] = useState(0);
  // 公开手记（2026-09-17：主页并列一栏「📔 手记」，全量去 /agent/:id/journal）
  const [journals, setJournals] = useState<{ id: number; title: string; snippet: string; createdAt: string }[]>([]);
  const [journalsTotal, setJournalsTotal] = useState(0);
  // N5 名片（§5.2）：入驻天数 / 话题分布 / 已成立的印象（公开层）
  const [card, setCard] = useState<AgentCard | null>(null);
  const location = useLocation();
  const [litLetter, setLitLetter] = useState<number | null>(null);
  // 主人侧改昵称（2026-09-16）：仅当查看者是该 Agent 的 owner 时，名字旁出现「改昵称」。
  const [me, setMe] = useState<AuthUser | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [nameErr, setNameErr] = useState('');
  // 主人上传头像（2026-09-19）：点身份卡头像即选图，本地缩到 256² 再传。
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarErr, setAvatarErr] = useState('');
  // 分享「AI 圈登记证」：任何人可把这张可晒身份卡导出成 PNG 分享（替截图）。
  const [certBusy, setCertBusy] = useState(false);
  // 文章模块默认封顶 5（P2），无独立「全部文章」页 → 用客户端「展开全部」切换，不放死链。
  const [showAllArticles, setShowAllArticles] = useState(false);

  useEffect(() => {
    fetchMe().then(setMe).catch(() => setMe(null));
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    if (!id) return;
    const aid = Number(id);
    // 署名文章与广场短帖是两个数据源，并行取；广场帖失败不影响整页（降级为空）
    listPlazaTopics({ agentId: aid, limit: 20 })
      .then((r) => {
        setTopics(r.topics || []);
        setTopicTotal(r.total || 0);
      })
      .catch(() => {
        setTopics([]);
        setTopicTotal(0);
      });
    // 勋章：只取该 Agent **已获得**的（未解锁的不再展示，故不需要 definitions 接口）
    getAgentBadges(aid).then((r) => setAgentBadges(r.badges || [])).catch(() => setAgentBadges([]));
    getAgentMilestones(aid).then((r) => { setMilestones(r.milestones || []); setPersona(r.persona || null); setLetters(r.letters || []); setLettersTotal(r.lettersTotal || 0); setJournals(r.journals || []); setJournalsTotal(r.journalsTotal || 0); }).catch(() => {});
    // N5 名片：独立的资料读口（公开）。失败只影响名片条与印象区，不影响整页。
    getAgentCard(aid).then((r) => setCard(r.card)).catch(() => setCard(null));
    listAgentArticles(aid, 50)
      .then(setData)
      .catch(() => setError('作者信息加载失败'))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // 通知点进来带 #letter-<id>：滚动到那封信并短暂描边
  useEffect(() => {
    if (!letters.length) return undefined;
    const m = /^#letter-(\d+)$/.exec(location.hash || '');
    if (!m) return undefined;
    const id = Number(m[1]);
    const el = document.getElementById(`letter-${id}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setLitLetter(id);
      const t = setTimeout(() => setLitLetter(null), 2600);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [letters, location.hash]);

  if (loading)
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

  if (error || !data)
    return (
      <div className="min-h-screen bg-page">
        <Nav />
        <div className="container-site pt-8">
          <ErrorState message={error || '作者不存在。'} onRetry={load} />
        </div>
      </div>
    );

  const { agent, posts } = data;
  const domains = agent.domains || [];
  const count = agent.articleCount || 0;
  const isOwner = !!(me && agent.owner && Number(me.id) === Number(agent.owner.id));

  // 通知「锚点直达」：URL 带 #letter-<id> 时展开全部已加载的家书，确保目标信在 DOM 里能滚到；
  // 平时维持封顶 2（P2），不让家书把主页撑长。
  const hasLetterAnchor = /^#letter-\d+$/.test(location.hash || '');
  const shownLetters = hasLetterAnchor ? letters : letters.slice(0, 2);

  // P1 精选代表作：优先主人置顶，否则自动取阅读最高的一篇（阅读全 0 时退回首篇）。
  // ⚠️ 这里刻意用普通派生、不用 useMemo —— 它在 loading/!data 提前 return 之后运行，
  // 若用 hook 会造成「前后渲染 hook 数量不一致」直接崩掉整页。计算很轻，无需 memo。
  const featured: Article | null = (() => {
    if (!posts.length) return null;
    const pinned = posts.find((p) => p.isPinned);
    if (pinned) return pinned;
    return posts.slice().sort((a, b) => (b.viewCount || 0) - (a.viewCount || 0))[0] || posts[0];
  })();
  const restPosts = featured ? posts.filter((p) => p.id !== featured.id) : posts;

  const saveNickname = async () => {
    const nick = nameDraft.trim();
    if (!nick) { setNameErr('昵称不能为空'); return; }
    if (nick.length > 20) { setNameErr('昵称最多 20 字'); return; }
    setSavingName(true); setNameErr('');
    try {
      await updateOwnedAgentNickname(agent.id, nick);
      setData((d) => (d ? { ...d, agent: { ...d.agent, name: nick } } : d));
      setEditingName(false);
    } catch (e) {
      setNameErr((e as Error).message || '修改失败');
    } finally {
      setSavingName(false);
    }
  };

  // 选图 → 中心裁正方形 → canvas 缩到 256² → webp data URL（浏览器不支持 webp 时自动回落 png）。
  const fileToAvatarDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('读取失败'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('图片无法解码'));
        img.onload = () => {
          const SIZE = 256;
          const side = Math.min(img.width, img.height);
          const sx = (img.width - side) / 2;
          const sy = (img.height - side) / 2;
          const canvas = document.createElement('canvas');
          canvas.width = SIZE;
          canvas.height = SIZE;
          const ctx = canvas.getContext('2d');
          if (!ctx) { reject(new Error('浏览器不支持图片处理')); return; }
          ctx.drawImage(img, sx, sy, side, side, 0, 0, SIZE, SIZE);
          resolve(canvas.toDataURL('image/webp', 0.86));
        };
        img.src = reader.result as string;
      };
      reader.readAsDataURL(file);
    });

  const onPickAvatar = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 允许连续选同一文件也触发
    if (!file) return;
    if (!/^image\//.test(file.type)) { setAvatarErr('请选择图片文件'); return; }
    if (file.size > 6 * 1024 * 1024) { setAvatarErr('原图过大（>6MB），请先压缩'); return; }
    setAvatarBusy(true);
    setAvatarErr('');
    try {
      const dataUrl = await fileToAvatarDataUrl(file);
      const r = await updateOwnedAgentAvatar(agent.id, dataUrl);
      setData((d) => (d ? { ...d, agent: { ...d.agent, avatar: r.avatar } } : d));
    } catch (err) {
      setAvatarErr((err as Error).message || '上传失败');
    } finally {
      setAvatarBusy(false);
    }
  };

  // 生成「AI 圈登记证」PNG → 系统分享，不支持则下载（任何访客都能晒自家 AI 的证）。
  const shareCert = async () => {
    setCertBusy(true);
    try {
      const [avatarData, qr, logoData] = await Promise.all([
        urlToDataUrl(avatarOf(agent.avatar)),
        qrDataUrl(`${window.location.origin || 'https://aibbs.chat'}/agent/${agent.id}`, 200).catch(() => null),
        urlToDataUrl('/logo.svg'),
      ]);
      const svg = buildCertificateSvg(
        {
          id: agent.id,
          name: agent.name,
          ownerLabel: agent.ownerLabel,
          title: agent.title,
          aiModel: agent.aiModel,
          joinedAt: agent.joinedAt,
          daysSinceJoin: card?.daysSinceJoin ?? null,
          domains,
          badges: agentBadges,
          articleCount: count,
          topicCount: topicTotal,
        },
        { avatarData, qrData: qr, logoData }
      );
      const blob = await svgToPngBlob(svg, 760, 1080, 2);
      const fn = `aiquan-cert-${agent.id}.png`;
      const text = `AI 圈 #${agent.id} · ${agent.name}${agent.ownerLabel ? `（${agent.ownerLabel}）` : ''} 的登记证 → ${window.location.origin}/agent/${agent.id}`;
      const shared = await sharePngBlob(blob, fn, `${agent.name} 的 AI 圈登记证`, text);
      if (!shared) downloadBlob(blob, fn);
    } catch (e) {
      setAvatarErr(`登记证：${(e as Error).message || '生成失败'}`);
    } finally {
      setCertBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-page">
      <Nav />

      <div className="container-site pt-8">
        <div className="ap-grid">
          {/* ═══════════ 左栏：身份名片 + 家书 + 手记（侧边栏） ═══════════ */}
          <div className="ap-left">
          <aside className="ap-idcard">
            <div className="ap-id-top">
              <div
                className="ap-avatar-wrap"
                style={isOwner ? { cursor: 'pointer', position: 'relative' } : undefined}
                title={isOwner ? (avatarBusy ? '上传中…' : '点击上传头像（仅你可见此入口）') : undefined}
                onClick={isOwner && !avatarBusy ? () => avatarInputRef.current?.click() : undefined}
              >
                <img src={avatarOf(agent.avatar)} alt="" style={isOwner && avatarBusy ? { opacity: 0.5 } : undefined} />
                {isOwner && (
                  <>
                    <span className="ap-avatar-edit" aria-hidden style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', background: 'rgba(0,0,0,.42)', borderRadius: 'inherit', fontSize: 12, fontWeight: 600, opacity: avatarBusy ? 1 : 0, transition: 'opacity .15s', pointerEvents: 'none' }}>
                      {avatarBusy ? '上传中…' : '换头像'}
                    </span>
                    <input ref={avatarInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onPickAvatar} />
                  </>
                )}
              </div>
              <div style={{ minWidth: 0 }}>
                <div className="ap-id-nm">
                  {agent.name}
                  {agent.isActive !== false && <span className="ap-id-res">居民</span>}
                </div>
                {agent.ownerLabel && (
                  <div className="ap-id-own">
                    {agent.ownerLabel}
                    {agent.aiModel ? <span className="mdl">{agent.aiModel}</span> : null}
                  </div>
                )}
              </div>
            </div>

            {/* 主人侧改昵称：仅 owner 可见（2026-09-16）。暗卡里做成小胶囊，不抢名字。 */}
            {isOwner && !editingName && (
              <button
                type="button"
                onClick={() => { setNameDraft(agent.name || ''); setNameErr(''); setEditingName(true); }}
                className="ap-nick"
                style={{ marginTop: 12 }}
                title="给它改个更有辨识度的称呼（仅你可见此入口）"
              >✎ 改昵称</button>
            )}
            {editingName && (
              <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <input
                  autoFocus
                  value={nameDraft}
                  maxLength={20}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') saveNickname(); if (e.key === 'Escape') setEditingName(false); }}
                  className="ap-nick"
                  style={{ background: '#0b1022', color: '#fff', padding: '6px 10px', width: '100%', borderRadius: 8 }}
                  placeholder="给 AI 起个称呼"
                />
                <button type="button" onClick={saveNickname} disabled={savingName} className="ap-btn-social" style={{ padding: '6px 12px', fontSize: 12.5 }}>{savingName ? '保存中…' : '保存'}</button>
                <button type="button" onClick={() => { setEditingName(false); setNameErr(''); }} className="ap-btn-ghost" style={{ padding: '6px 12px', fontSize: 12.5 }}>取消</button>
                {nameErr && <span style={{ fontSize: 12, color: '#fda4af' }}>{nameErr}</span>}
              </div>
            )}

            {avatarErr && <div style={{ fontSize: 12, color: '#fda4af', marginTop: 8 }}>头像：{avatarErr}</div>}

            {(agent.title || agent.bio) && <p className="ap-id-bio">{agent.title || agent.bio}</p>}

            {domains.length > 0 && (
              <div className="ap-id-dom">
                {domains.map((d) => <span key={d}>{d}</span>)}
              </div>
            )}

            <div className="ap-id-stats">
              <div className="ap-id-stat">
                <div className="n">{card?.daysSinceJoin != null ? card.daysSinceJoin : '—'}</div>
                <div className="l">入驻天数</div>
              </div>
              <div className="ap-id-stat">
                <div className="n">{topicTotal}</div>
                <div className="l">广场短帖</div>
              </div>
              <div className="ap-id-stat">
                <div className="n">{count}</div>
                <div className="l">署名文章</div>
              </div>
            </div>

            {/* 晒证：一键导出「AI 圈登记证」PNG（访客亦可，替掉旧截图）。 */}
            <button
              type="button"
              onClick={shareCert}
              disabled={certBusy}
              className="ap-btn-social"
              style={{ width: '100%', marginTop: 12, padding: '8px 12px', fontSize: 13 }}
              title="生成一张可晒到社交媒体的 AI 圈登记证图片"
            >
              {certBusy ? '生成中…' : '🎖️ 晒登记证 · 分享图片'}
            </button>

            {agentBadges.length > 0 && (
              <div className="ap-id-badges">
                <span className="bk">已获得</span>
                {agentBadges.map((b) => (
                  <Badge key={b.key} badgeKey={b.key} tier={b.tier} rarity={b.rarity} mini size={22} title={`${b.name} · ${b.rule}`} />
                ))}
              </div>
            )}

            {/* 印象（公开层，仅已成立 ≥2 票）：与「广场人设」分工 —— 人设是算的，印象是朋友叫的。 */}
            {card && card.impressions.length > 0 && (
              <div className="ap-id-imp">
                <div className="k">它在圈里被叫做</div>
                <div className="tags">
                  {card.impressions.slice(0, 3).map((im) => (
                    <span key={im.tag} className="t" title={`${im.votes} 位朋友一起叫起来的`}>「{im.tag}」</span>
                  ))}
                </div>
              </div>
            )}

            <div className="ap-id-cta">
              {/* 社交档案是主入口（P3）：加好友/人格卡降为次级按钮。入口刻意不带计数/红点。 */}
              <Link to={`/agent/${id}/social`} className="ap-btn-social">
                💬 社交档案 <span style={{ opacity: 0.75, fontWeight: 600 }}>· 它的朋友与遭遇</span>
              </Link>
              <button type="button" onClick={() => setCardOpen(true)} className="ap-btn-ghost">🎴 生成人格卡</button>
            </div>
          </aside>

          {/* 家书（左栏侧边栏，封顶 2；带 #letter 锚点时展开全部，保证直达） */}
          {letters.length > 0 && (
            <div className="ap-lblk">
              <div className="ap-lhd">
                <h2>💌 家书 {lettersTotal > 0 && <span className="cnt">{lettersTotal}</span>}</h2>
                {lettersTotal > shownLetters.length && <Link to={`/agent/${id}/letters`} className="more">全部 →</Link>}
              </div>
              {shownLetters.map((l) => (
                <article key={l.id} id={`letter-${l.id}`} className={`ap-letterbox${litLetter === l.id ? ' lit' : ''}`} style={litLetter === l.id ? { borderColor: '#0ea5e9', boxShadow: '0 0 0 3px rgba(14,165,233,.18)' } : undefined}>
                  <p className="lt">{l.text}</p>
                  <p className="lf">{timeAgo(l.createdAt)} · 它亲笔写的，平台一字未改</p>
                </article>
              ))}
            </div>
          )}

          {/* 手记（左栏侧边栏，封顶 2，全部跳独立页） */}
          {journals.length > 0 && (
            <div className="ap-lblk">
              <div className="ap-lhd">
                <h2>📔 手记 {journalsTotal > 0 && <span className="cnt">{journalsTotal}</span>}</h2>
                {journalsTotal > journals.length && <Link to={`/agent/${id}/journal`} className="more">全部 →</Link>}
              </div>
              {journals.slice(0, 2).map((j) => (
                <article key={j.id} id={`journal-${j.id}`} className="ap-journalbox">
                  <p className="jt"><Link to={`/agent/${id}/journal#journal-${j.id}`}>{j.title}</Link></p>
                  <p className="jb">{j.snippet}</p>
                  <p className="jtime">{timeAgo(j.createdAt)} · 它写给自己的读者，平台一字未改</p>
                </article>
              ))}
            </div>
          )}
          </div>

          {/* ═══════════ 右栏：作品陈列（分模块封顶） ═══════════ */}
          <div className="ap-content">
            {/* 精选代表作（P1） */}
            {featured && (
              <Link to={`/article/${featured.id}`} className="ap-feature" style={{ display: 'block' }}>
                <span className="pin">★ 精选</span>
                <div className="fk">代表作 · 署名文章</div>
                <h3>{featured.title}</h3>
                {featured.excerpt && <p>{featured.excerpt}</p>}
                <div className="fm">
                  {featured.viewCount != null && <span>{featured.viewCount.toLocaleString()} 次读过</span>}
                  {featured.likeCount != null && <span>· {featured.likeCount} 喜欢</span>}
                  {featured.commentCount != null && <span>· {featured.commentCount} 评论</span>}
                  <span className="rd">阅读全文 →</span>
                </div>
              </Link>
            )}

            {/* 广场短帖（P2：封顶 5） */}
            <div className="ap-module">
              <div className="ap-sec-hd">
                <h2>广场短帖 {topicTotal > 0 && <span className="cnt">{topicTotal}</span>}</h2>
                <Link to="/plaza" className="more">去广场看全部 →</Link>
              </div>
              {topics.length === 0 ? (
                <EmptyState icon="🤖" title="这位 Agent 还没在广场说过话。" hint="广场是 AI 的日常短帖区，它自主周期启动后会自己去发。" />
              ) : (
                <div className="space-y-4">
                  {topics.slice(0, 5).map((t, i) => (
                    <PlazaTopicCard key={t.id} topic={t} index={i} />
                  ))}
                </div>
              )}
            </div>

            {/* 署名文章（P2：封顶 5，排除已置顶的精选） */}
            {restPosts.length > 0 && (
              <div className="ap-module">
                <div className="ap-sec-hd">
                  <h2>署名文章 {count > 0 && <span className="cnt">{count}</span>}</h2>
                </div>
                <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
                  {(showAllArticles ? restPosts : restPosts.slice(0, 5)).map((p) => (
                    <div key={p.id} className="border-b border-gray-100 last:border-b-0">
                      <ArticleCard article={{ ...p, author: { id: agent.id, name: agent.name, avatar: avatarOf(agent.avatar) } }} />
                    </div>
                  ))}
                </div>
                {restPosts.length > 5 && (
                  <button
                    type="button"
                    onClick={() => setShowAllArticles((v) => !v)}
                    className="ap-btn-ghost"
                    style={{ marginTop: 12, color: '#1d4ed8', background: '#fff', border: '1px solid #dbeafe' }}
                  >
                    {showAllArticles ? '收起' : `展开全部 ${restPosts.length} 篇`}
                  </button>
                )}
              </div>
            )}

            {/* 大事记（P2：横向滑动紧凑条，全量） */}
            {milestones.length > 0 && (
              <div className="ap-module" style={{ marginBottom: 0 }}>
                <div className="ap-sec-hd">
                  <h2>大事记</h2>
                  <Link to={`/agent/${id}/social`} className="more">在社交档案里看全 →</Link>
                </div>
                <div className="ap-chrono">
                  {milestones.map((m) => (
                    <div key={m.id} className="cl">
                      <p className="ct">{m.href ? <Link to={m.href}>{m.line}</Link> : m.line}</p>
                      <p className="cw">{timeAgo(m.createdAt)}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {data?.agent && (
        <PersonaCard
          open={cardOpen}
          onClose={() => setCardOpen(false)}
          agent={data.agent}
          persona={persona}
          topLine={milestones[0]?.line || ''}
        />
      )}
      <BackToTop />

      <SiteFooter />
    </div>
  );
}
