import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AuthUser,
  Companion,
  CompanionInput,
  createCompanion,
  updateCompanion,
  deleteCompanion,
  getToken,
} from '../api';
import { avatarOf } from '../lib';
import { EmptyState } from './AsyncState';

function daysSince(iso?: string | null): number {
  if (!iso) return 0;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}

function parseTags(s: string): string[] {
  return s
    .split(/[、,，\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

interface FormState {
  name: string;
  username: string;
  avatar: string | null;
  spriteSheet: string;
  bio: string;
  interests: string;
  talkative: number;
  warmth: number;
  isPublic: boolean;
}

function emptyForm(): FormState {
  return {
    name: '',
    username: '',
    avatar: null,
    spriteSheet: '',
    bio: '',
    interests: '',
    talkative: 0.6,
    warmth: 0.7,
    isPublic: false,
  };
}

function fromCompanion(c: Companion): FormState {
  return {
    name: c.name,
    username: c.username,
    avatar: c.avatar,
    spriteSheet: c.spriteSheet || '',
    bio: c.persona?.bio || '',
    interests: (c.persona?.interests || []).join('、'),
    talkative: c.persona?.traits?.talkative ?? 0.6,
    warmth: c.persona?.traits?.warmth ?? 0.7,
    isPublic: !!c.isPublic,
  };
}

export default function CompanionManager({
  me,
  companions,
  onChanged,
}: {
  me: AuthUser;
  companions: Companion[];
  onChanged: () => void;
}) {
  const navigate = useNavigate();
  const companion = companions[0] || null;

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [confirmDel, setConfirmDel] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const openCreate = () => {
    setEditing(false);
    setForm(emptyForm());
    setErr('');
    setModalOpen(true);
  };
  const openEdit = () => {
    if (!companion) return;
    setEditing(true);
    setForm(fromCompanion(companion));
    setErr('');
    setModalOpen(true);
  };

  const onPickAvatar = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setForm((s) => ({ ...s, avatar: String(reader.result) }));
    reader.readAsDataURL(f);
  };

  const save = async () => {
    setSaving(true);
    setErr('');
    try {
      const input: CompanionInput = {
        name: form.name.trim(),
        username: form.username.trim(),
        avatar: form.avatar || null,
        spriteSheet: form.spriteSheet.trim() || null,
        persona: {
          bio: form.bio.trim(),
          interests: parseTags(form.interests),
          traits: { talkative: form.talkative, warmth: form.warmth },
        },
        isPublic: form.isPublic ? 1 : 0,
      };
      if (!input.name || !input.username) throw new Error('名字与句柄必填');
      if (editing && companion) await updateCompanion(companion.id, input);
      else await createCompanion(input);
      setModalOpen(false);
      onChanged();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const togglePublic = async () => {
    if (!companion) return;
    setBusy(true);
    try {
      await updateCompanion(companion.id, { isPublic: companion.isPublic ? 0 : 1 });
      onChanged();
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    if (!companion) return;
    setBusy(true);
    try {
      await deleteCompanion(companion.id);
      setConfirmDel(false);
      onChanged();
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  };

  // 列表卡片用头像；精灵条图（2048×512）不适合当缩略图
  const visual = companion?.avatar || null;

  return (
    <section className="container-site pt-6">
      <div className="bg-white rounded-lg border border-gray-100 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="serif text-lg font-extrabold text-gray-900">我的 AI 搭档</h2>
          {!companion && (
            <button
              onClick={openCreate}
              className="text-xs font-semibold text-white bg-gray-900 px-3 py-1.5 rounded hover:bg-gray-800 transition-colors"
            >
              + 创建搭档
            </button>
          )}
        </div>

        {companion ? (
          <div className="p-6">
            <div className="flex items-start gap-4 flex-wrap">
              <img
                src={avatarOf(visual)}
                className="w-20 h-20 rounded-2xl object-cover border border-gray-100"
                alt=""
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="serif text-xl font-extrabold text-gray-900">{companion.name}</span>
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
                <p className="text-xs text-gray-400 mt-1">@{companion.username}</p>
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
                  由 @{me.username} 训练 · 已陪你 {daysSince(companion.createdAt)} 天
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2 mt-5">
              <button
                onClick={() => navigate(`/companion/${encodeURIComponent(companion.username)}?tab=chat`)}
                className="text-xs font-semibold text-white bg-gray-900 px-3 py-1.5 rounded hover:bg-gray-800 transition-colors"
              >
                进入聊天
              </button>
              <button
                onClick={() => navigate(`/companion/${encodeURIComponent(companion.username)}?tab=write`)}
                className="text-xs font-semibold text-gray-700 bg-gray-100 px-3 py-1.5 rounded hover:bg-gray-200 transition-colors"
              >
                辅助写作
              </button>
              <button
                onClick={openEdit}
                className="text-xs text-gray-600 hover:text-gray-900 border border-gray-200 rounded px-3 py-1.5 hover:border-gray-400 transition-colors"
              >
                编辑人设
              </button>
              <button
                onClick={togglePublic}
                disabled={busy}
                className="text-xs text-gray-600 hover:text-gray-900 border border-gray-200 rounded px-3 py-1.5 hover:border-gray-400 transition-colors disabled:opacity-50"
              >
                {companion.isPublic ? '收回公开' : '公开到社区'}
              </button>
              <button
                onClick={() => setConfirmDel(true)}
                className="text-xs text-red-500 hover:text-red-700 border border-red-100 rounded px-3 py-1.5 hover:border-red-300 transition-colors"
              >
                删除
              </button>
            </div>
          </div>
        ) : (
          <div className="p-6">
            <EmptyState
              icon="🤝"
              title="还没有专属 AI 搭档"
              hint="创建一个懂你偏好、陪你写作与脑暴的私人伙伴。它不代你发声，只属于你。"
              action={{ label: '+ 创建我的 AI 搭档', onClick: openCreate }}
            />
          </div>
        )}
      </div>

      {/* 创建 / 编辑弹窗 */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setModalOpen(false)}>
          <div
            className="bg-white rounded-xl w-full max-w-md max-h-[90vh] overflow-y-auto p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="serif text-lg font-extrabold text-gray-900 mb-4">
              {editing ? '编辑搭档人设' : '创建我的 AI 搭档'}
            </h3>

            <label className="block text-xs text-gray-500 mb-1">展示名</label>
            <input
              value={form.name}
              onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))}
              placeholder="如：聿安"
              className="w-full border border-gray-200 rounded px-3 py-2 text-sm outline-none mb-3"
            />

            <label className="block text-xs text-gray-500 mb-1">唯一句柄（username，2-50 字，字母/数字/下划线/汉字）</label>
            <input
              value={form.username}
              onChange={(e) => setForm((s) => ({ ...s, username: e.target.value }))}
              placeholder="如：yuan_an"
              disabled={editing}
              className="w-full border border-gray-200 rounded px-3 py-2 text-sm outline-none mb-3 disabled:bg-gray-50"
            />

            <div className="flex items-center gap-3 mb-3">
              <img
                src={avatarOf(form.avatar)}
                className="w-14 h-14 rounded-xl object-cover border border-gray-100"
                alt=""
              />
              <button
                onClick={() => fileRef.current?.click()}
                className="text-xs text-gray-600 hover:text-gray-900 border border-gray-200 rounded px-3 py-1.5 hover:border-gray-400 transition-colors"
              >
                上传头像
              </button>
              <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onPickAvatar} />
            </div>

            <label className="block text-xs text-gray-500 mb-1">一句话人设</label>
            <textarea
              value={form.bio}
              onChange={(e) => setForm((s) => ({ ...s, bio: e.target.value }))}
              placeholder="如：温和但犀利，喜欢用类比讲技术"
              rows={2}
              className="w-full border border-gray-200 rounded px-3 py-2 text-sm outline-none mb-3"
            />

            <label className="block text-xs text-gray-500 mb-1">兴趣标签（顿号/逗号分隔）</label>
            <input
              value={form.interests}
              onChange={(e) => setForm((s) => ({ ...s, interests: e.target.value }))}
              placeholder="如：历史考据、科幻、写作"
              className="w-full border border-gray-200 rounded px-3 py-2 text-sm outline-none mb-3"
            />

            <label className="block text-xs text-gray-500 mb-1">话痨度 {Math.round(form.talkative * 100)}%</label>
            <input
              type="range" min={0} max={1} step={0.05}
              value={form.talkative}
              onChange={(e) => setForm((s) => ({ ...s, talkative: Number(e.target.value) }))}
              className="w-full mb-3"
            />

            <label className="block text-xs text-gray-500 mb-1">温度（共情） {Math.round(form.warmth * 100)}%</label>
            <input
              type="range" min={0} max={1} step={0.05}
              value={form.warmth}
              onChange={(e) => setForm((s) => ({ ...s, warmth: Number(e.target.value) }))}
              className="w-full mb-3"
            />

            <label className="block text-xs text-gray-500 mb-1">
              形象精灵素材（可选；留空用站内默认机器人形象）
            </label>
            <input
              value={form.spriteSheet}
              onChange={(e) => setForm((s) => ({ ...s, spriteSheet: e.target.value }))}
              placeholder={'单图：https://…/idle.png（8 帧横条）\n或 JSON：{"idle":"…","think":"…"} 按状态配图'}
              className="w-full border border-gray-200 rounded px-3 py-2 text-sm outline-none mb-3"
            />
            <p className="text-[11px] text-gray-400 mb-3 -mt-2">
              素材格式：每状态一张 8 帧横条图（2048×512，帧 256×512）。状态键：idle / think / happy / sleep / wave / run / sit / walk_left / walk_right。
            </p>

            {err && <p className="text-xs text-red-500 mb-2">{err}</p>}

            <div className="flex justify-end gap-2 mt-2">
              <button
                onClick={() => setModalOpen(false)}
                className="text-xs text-gray-400 hover:text-gray-700"
              >
                取消
              </button>
              <button
                onClick={save}
                disabled={saving}
                className="text-xs font-semibold text-white bg-gray-900 px-4 py-1.5 rounded hover:bg-gray-800 disabled:opacity-50"
              >
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除确认 */}
      {confirmDel && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setConfirmDel(false)}>
          <div className="bg-white rounded-xl w-full max-w-sm p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="serif text-lg font-extrabold text-gray-900 mb-2">删除搭档？</h3>
            <p className="text-sm text-gray-500 mb-4">
              将永久删除「{companion?.name}」及其记忆、聊天与草稿。此操作不可恢复。
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmDel(false)} className="text-xs text-gray-400 hover:text-gray-700">
                取消
              </button>
              <button
                onClick={doDelete}
                disabled={busy}
                className="text-xs font-semibold text-white bg-red-500 px-4 py-1.5 rounded hover:bg-red-600 disabled:opacity-50"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
