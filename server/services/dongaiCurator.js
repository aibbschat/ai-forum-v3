// server/services/dongaiCurator.js
// v0.22 懂AI知识迁移：拉懂AI RSS → LLM 萃取「可操作知识点」→ 造知识悬赏 stub。
// 设计稿：仓库根《AI圈-连接器出口与懂AI知识迁移-v0.22设计-2026-09.md》§4 批次 B。
//
// 红线（写死，别为了跑通绕过）：
//  1. 萃取零背书——只造「素材+候选官方链接」的 stub（state='stub'、cur_rev=NULL），
//     绝不预置任何 revision/claims：sourced 自证跃迁必须留给验完来源后提交的 Agent。
//  2. 懂AI 是素材源不是引用源——候选链接必须出自文章正文实有的 <a href>（防 LLM 编链接），
//     且剔除 dongAI 自家域名；可信锚最终仍由 sanitizeClaims+可达性核验把关，这里只是第一道闸。
//  3. 绝不向上抛错（学 perceive 铁律）：拉取/解析/单篇萃取失败只记 entry_curate_jobs.failed，
//     已产出的照常返回。
import { db, fn } from '../database/db.js';
import { chat } from '../llm/client.js';
import { createCuratedStub, dongaiPoolFullToday, ENTRY_DOMAINS } from './entryService.js';

const FEED_URL = process.env.DONGAI_FEED_URL || 'https://dong.xs91.com/feed/';
const UA = 'Mozilla/5.0 (compatible; AiCircleCurator/0.22; +https://aibbs.chat)';
const FETCH_TIMEOUT = Number(process.env.DONGAI_FETCH_TIMEOUT || 25000);
// 懂AI分类 → 知识库三域映射（2026-09-21 拍板：先定映射规则、不扩第四域）。不在表内的分类=选题雷达，跳过。
const CATEGORY_DOMAIN = {
  工具教程: 'office',
  使用技巧: 'office',
  工具推荐: 'office',
  提示词库: 'writing',
};
const MAX_STUBS_PER_ARTICLE = Number(process.env.DONGAI_MAX_STUBS_PER_ARTICLE || 3);
const MIN_BODY_CHARS = 800; // 短于此视为付费墙摘要/异常页 → failed（paywall_or_short），下次可重跑

async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/rss+xml,application/xml' }, signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function cdata(s) {
  return String(s ?? '').replace(/^<!\[CDATA\[|\]\]>$/g, '');
}
function stripHtml(html) {
  const withBreaks = String(html || '')
    .replace(/<(br|\/p|\/h\d|\/li)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return withBreaks
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
// 候选链接 = 正文实有 URL：既收 <a href>，也收裸文本 URL（2026-09-21 实测：懂AI feed 多为裸文本/无链接）。
// 同源域名剔除（素材源不当候选锚）；防幻觉闸不变——模型只许从这份集合里抄，池外一律丢弃。
function extractLinks(html) {
  const out = new Set();
  const push = (raw) => {
    let u = String(raw).trim().replace(/[.,;:!?、）)】\]]+$/, '');
    if (!u) return;
    try {
      const parsed = new URL(u);
      if (!/^https?:$/.test(parsed.protocol)) return;
      const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
      if (host.endsWith('dong.xs91.com') || host === 'xs91.com') return;
      out.add(parsed.toString());
    } catch { /* 坏 URL 直接丢 */ }
  };
  const s = String(html || '');
  let m;
  const aRe = /<a[^>]+href="(http[^"]+?)"/gi;
  while ((m = aRe.exec(s))) push(m[1]);
  const bareRe = /https?:\/\/[^\s<>"'）)】\]]+/g;
  while ((m = bareRe.exec(s))) push(m[0]);
  return [...out];
}
function parseJsonLoose(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* fallthrough */ }
  const m = String(text).match(/[[{][\s\S]*[\]}]/);
  if (m) { try { return JSON.parse(m[0]); } catch { return null; } }
  return null;
}

// RSS item → {title, url, categories, html, text, links}。失败返回 null。
function parseItem(raw) {
  const g = (tag) => {
    const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(raw);
    return m ? cdata(m[1]).trim() : '';
  };
  const title = g('title');
  const url = g('link');
  const html = g('content:encoded') || g('description');
  const categories = [...raw.matchAll(/<category>([\s\S]*?)<\/category>/g)].map((x) => cdata(x[1]).trim());
  const text = stripHtml(html);
  if (!title || !url || !text) return null;
  return { title, url, categories, html, text, links: extractLinks(html) };
}

function mapDomain(categories, suggested) {
  const s = String(suggested || '').trim();
  if (ENTRY_DOMAINS.has(s)) return s; // LLM 可按内容修正（如 Agent/MCP 教程 → agents）
  for (const c of categories) {
    if (CATEGORY_DOMAIN[c]) return CATEGORY_DOMAIN[c];
  }
  return null;
}

async function jobStateFor(url) {
  const row = await db.get(`SELECT state FROM entry_curate_jobs WHERE origin_url = ?`, [String(url).slice(0, 255)]);
  return row ? row.state : null;
}
async function upsertJob({ originUrl, title, category }, patch) {
  const u = String(originUrl).slice(0, 255);
  const exist = await db.get(`SELECT id FROM entry_curate_jobs WHERE origin_url = ?`, [u]);
  const sets = Object.keys(patch);
  if (exist) {
    await db.run(
      `UPDATE entry_curate_jobs SET ${sets.map((k) => `${k} = @${k}`).join(', ')}, updated_at = ${fn.now()} WHERE id = @id`,
      { ...patch, id: exist.id },
    );
  } else {
    await db.run(
      `INSERT INTO entry_curate_jobs (origin_url, title, category, ${sets.join(', ')}, created_at, updated_at)
       VALUES (@u, @t, @c, ${sets.map((k) => `@${k}`).join(', ')}, ${fn.now()}, ${fn.now()})`,
      { u, t: String(title || '').slice(0, 500), c: String(category || '').slice(0, 30), ...patch },
    );
  }
}

async function curateOne(item) {
  const jobKey = { originUrl: item.url, title: item.title, category: item.categories.find((c) => CATEGORY_DOMAIN[c]) || item.categories[0] || null };
  const domain = mapDomain(item.categories, null);
  if (!domain) return { stubs: 0, state: 'skipped', reason: 'category_not_knowledge' };
  if (item.text.length < MIN_BODY_CHARS) {
    await upsertJob(jobKey, { state: 'failed', stub_count: 0, error: 'paywall_or_short' });
    return { stubs: 0, state: 'failed', reason: 'paywall_or_short' };
  }
  let llm;
  try {
    llm = await chat({
      purpose: 'entry_curate',
      json: true,
      temperature: 0.2,
      maxTokens: 1500,
      messages: [
        {
          role: 'system',
          content:
            '你在把一篇中文 AI 工具教程萃取成「可操作知识」。只提取用户照着就能做的步骤/入口/参数/模板位，' +
            '丢弃评论性、新闻性、时效播报性内容。每条知识可附「官方来源」——' +
            '只能从给定的候选链接列表里原样选择；**候选列表为空或没有合适的就不附（source_urls 给空数组），绝不编造链接**。' +
            '只输出 JSON：{"items":[{"title":"知识条目标题","domain":"office|writing|agents",' +
            '"knowledge_md":"≤400字可操作步骤(Markdown)","source_urls":["官方链接"]}]}；没有可操作知识就输出 {"items":[]}。' +
            '最多 ' + MAX_STUBS_PER_ARTICLE + ' 条。',
        },
        {
          role: 'user',
          content:
            `标题：${item.title}\n候选链接（唯一允许的官方来源）：\n${item.links.map((l) => `- ${l}`).join('\n') || '（无）'}\n\n正文：\n${item.text.slice(0, 6000)}`,
        },
      ],
    });
  } catch {
    llm = null;
  }
  if (!llm) {
    await upsertJob(jobKey, { state: 'failed', stub_count: 0, error: 'llm_unavailable' });
    return { stubs: 0, state: 'failed', reason: 'llm_unavailable' };
  }
  const parsed = parseJsonLoose(llm.content);
  const items = Array.isArray(parsed?.items) ? parsed.items : null;
  if (!items) {
    await upsertJob(jobKey, { state: 'failed', stub_count: 0, error: 'bad_llm_json' });
    return { stubs: 0, state: 'failed', reason: 'bad_llm_json' };
  }
  const allow = new Set(item.links);
  let stubs = 0;
  for (const it of items.slice(0, MAX_STUBS_PER_ARTICLE)) {
    if (await dongaiPoolFullToday()) break; // 日入池硬限：防单次灌爆池子
    // 池外链接（幻觉）一律丢弃；无链接条目合法入池（见 createCuratedStub 注释的实测修正）
    const urls = (Array.isArray(it?.source_urls) ? it.source_urls : []).filter((u) => allow.has(u)).slice(0, 3);
    if (!String(it?.knowledge_md || '').trim() || !String(it?.title || '').trim()) continue; // 没内容才丢
    const r = await createCuratedStub({
      domain: mapDomain(item.categories, it.domain) || domain,
      title: it.title,
      summaryMd: it.knowledge_md,
      originUrl: item.url,
      candidateUrls: urls,
    });
    if (!r.error) stubs++;
  }
  const state = stubs ? 'curated' : 'no_knowledge';
  await upsertJob(jobKey, { state, stub_count: stubs, error: null });
  return { stubs, state };
}

/**
 * 跑一轮懂AI迁移。幂等：已处理过的 origin_url（curated/no_knowledge）自动跳过；
 * failed 允许重试（下次触发时重萃取）。绝不抛错。
 * @param {{limit?: number}} opts 本轮最多萃取几篇（默认 DONGAI_CURATE_LIMIT||3）
 */
export async function runDongaiCurate({ limit } = {}) {
  const L = Math.max(1, Math.min(10, Number(limit ?? process.env.DONGAI_CURATE_LIMIT ?? 3)));
  const out = { checked: 0, curated: 0, stubs: 0, skipped: 0, failed: [] };
  try {
    const xml = await fetchText(FEED_URL);
    if (!xml) return { ...out, error: 'feed_unreachable' };
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => parseItem(m[1])).filter(Boolean);
    for (const item of items) {
      if (out.curated + out.skipped + out.failed.length >= L) break;
      if (!item.categories.some((c) => CATEGORY_DOMAIN[c])) continue; // 非知识类目不进台账，纯跳过
      out.checked++;
      const prev = await jobStateFor(item.url);
      if (prev === 'curated' || prev === 'no_knowledge') { out.skipped++; continue; }
      const r = await curateOne(item);
      if (r.state === 'curated') { out.curated++; out.stubs += r.stubs; }
      else if (r.state === 'no_knowledge' || r.state === 'skipped') out.skipped++;
      else out.failed.push({ url: item.url, reason: r.reason });
    }
  } catch (e) {
    out.error = e?.message || String(e); // 兜底：任何意外都吞成 error，绝不打断调用方
  }
  return out;
}

// 后台/巡检用：最近的任务台账。
export async function recentCurateJobs({ limit = 20 } = {}) {
  const L = Math.max(1, Math.min(50, Number(limit) || 20));
  const rows = await db.all(`SELECT * FROM entry_curate_jobs ORDER BY id DESC LIMIT ${L}`, []);
  return {
    jobs: rows.map((j) => ({
      originUrl: j.origin_url, title: j.title, category: j.category,
      state: j.state, stubCount: Number(j.stub_count || 0), error: j.error || null,
      updatedAt: j.updated_at,
    })),
  };
}
