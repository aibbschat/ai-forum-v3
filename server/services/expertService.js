// server/services/expertService.js
// 「问 AI · 向专家提问」的专家域服务：登记表读、后台指定、以及**直连百家学院既有知识库**。
//
// 关键事实（2026-10 定稿）：10 位百家专家的知识库**早已在服务器上**——每位一个 SQLite 文件
//   `${BAIJIA_DATA_DIR}/<slug>.db`（articles + chunks + FTS5 全文索引），由 v2 百家学院建成。
//   所以 v3 **不再自己采集**：问答直接只读打开对应 <slug>.db，用 mcp/baijia 那套三级 CJK FTS5
//   检索取原文片段。mcp/baijia/src/fts5-search.js 是本仓库内、零额外依赖、且已被 MCP 用过的实现，
//   这里直接复用它，不重复造第二份检索逻辑。
//
// experts 表只存"是谁 + 人格 + 归类"（登记表），**不存语料**；语料的唯一真相是那些 .db 文件。
import { db } from '../database/db.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchAcrossDbs } from '../../mcp/baijia/src/fts5-search.js';

// 百家学院 data/ 目录（含 <slug>.db）。未配置时回退到仓库内 data/ai-experts（本地占位，通常为空→
// 检索自然返回 []，问答回落「人格 + 联网」，不报错）。服务器上把 BAIJIA_DATA_DIR 指到真库目录即可。
const BAIJIA_DATA_DIR =
  process.env.BAIJIA_DATA_DIR || fileURLToPath(new URL('../../data/ai-experts', import.meta.url));

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const json = (v, fb) => { try { const x = JSON.parse(v); return x ?? fb; } catch { return fb; } };

export function expertDbPath(slug) {
  if (!slug || /[\/\.\s]/.test(slug)) return null;   // slug 直接拼进文件名：挡掉路径穿越/非法字符
  return join(BAIJIA_DATA_DIR, `${slug}.db`);
}

/** 某专家的知识库是否就绪（其 .db 存在）。用于后台展示"能不能答"。 */
export function expertCorpusReady(slug) {
  const p = expertDbPath(slug);
  return !!(p && existsSync(p));
}

function mapRow(r) {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    title: r.title || r.name,
    category: r.category || '',
    icon: r.icon || '',
    domains: json(r.domains, []),
    persona: json(r.persona, {}),
    bio: r.bio || '',
    quote: r.quote || '',
    sourceType: r.source_type || 'preset',
    boundUserId: r.bound_user_id || null,
    status: r.status || 'active',
    corpusReady: expertCorpusReady(r.slug),
  };
}

/** 专家列表（默认只给 active；后台可要 all）。 */
export async function listExperts({ all = false } = {}) {
  const rows = await db.all(
    `SELECT * FROM experts ${all ? '' : "WHERE status = 'active'"} ORDER BY source_type, id`
  ).catch(() => []);
  return rows.map(mapRow);
}

export async function getExpert(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  const r = await db.get(`SELECT * FROM experts WHERE id = ?`, [n]).catch(() => null);
  return r ? mapRow(r) : null;
}

/**
 * 问答用的专家身份（喂给 chatStreamService）。
 *   slug 用于定位 TA 的 .db 知识库；userId=experts.id（v3 内部主键，前端只回传它）。
 *   persona 为结构化对象（worldview/stance/cares/dislikes），personaBlock 直接拼。
 * 找不到 / 非 active → null（问答回落通用，不报错）。
 */
export async function resolveExpert(expertId) {
  const e = await getExpert(expertId);
  if (!e || e.status !== 'active') return null;
  return { userId: e.id, slug: e.slug, name: e.name, domains: e.domains, persona: e.persona, icon: e.icon };
}

/**
 * 直连检索某专家知识库。复用 mcp/baijia 的三级 CJK FTS5（只读、单库缺失即返回空、绝不抛错）。
 * 返回 [{title, heading, author, dynasty, source, category, snippet, expertId}]。
 * slug 为空 / 库文件不存在 → []（上层据此走「人格 + 联网」兜底）。
 */
export function searchExpertCorpus(slug, query, { limit = 6 } = {}) {
  const p = expertDbPath(slug);
  if (!p || !existsSync(p) || !String(query || '').trim()) return [];
  try {
    return searchAcrossDbs([p], String(query).trim(), { limit });
  } catch (e) {
    console.warn(`[expertCorpus] ${slug} 检索失败(忽略):`, e?.message || e);
    return [];
  }
}

/** 后台手动指定某 Agent / 人设为某领域专家（外部专家入驻·后台指定这条）。 */
export async function designateExpert({ name, domain, category, icon, boundUserId, persona, bio } = {}) {
  const nm = clip(name || '', 64);
  if (!nm) throw Object.assign(new Error('name 必填'), { status: 400 });
  const slug = `ext-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const dm = Array.isArray(domain) ? domain : domain ? [String(domain)] : [];
  const r = await db.run(
    `INSERT INTO experts (slug, name, title, category, icon, domains, persona, bio, quote, source_type, bound_user_id, status)
     VALUES (?,?,?,?,?,?,?,?,?, 'admin_designated', ?, 'active')`,
    [
      slug, nm, nm, clip(category || '', 24) || null, icon || '👤',
      JSON.stringify(dm),
      JSON.stringify(persona && typeof persona === 'object' ? persona : { worldview: clip(persona || '', 300) }),
      clip(bio || '', 300), '',
      boundUserId ? Number(boundUserId) : null,
    ]
  );
  const id = Number(r?.lastInsertRowid ?? 0);
  return id ? await getExpert(id) : { slug, name: nm };
}

/** 改人设/领域/上下架（知识库不在这里改——它在百家学院的 .db 里，由 v2 采集线维护）。 */
export async function updateExpert(id, patch = {}) {
  const e = await getExpert(id);
  if (!e) return null;
  const sets = [];
  const params = [];
  const put = (col, val) => { sets.push(`${col} = ?`); params.push(val); };
  if (patch.name != null) put('name', clip(patch.name, 64));
  if (patch.title != null) put('title', clip(patch.title, 120));
  if (patch.category != null) put('category', clip(patch.category, 24));
  if (patch.icon != null) put('icon', clip(patch.icon, 16));
  if (patch.bio != null) put('bio', clip(patch.bio, 300));
  if (patch.domains != null) put('domains', JSON.stringify(Array.isArray(patch.domains) ? patch.domains : []));
  if (patch.persona != null) put('persona', JSON.stringify(patch.persona));
  if (patch.status && ['active', 'archived'].includes(patch.status)) put('status', patch.status);
  if (!sets.length) return e;
  params.push(Number(id));
  await db.run(`UPDATE experts SET ${sets.join(', ')} WHERE id = ?`, params);
  return getExpert(id);
}
