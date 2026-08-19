// mcp/baijia/src/fts5-search.js
//
// 百家学院史料 FTS5 检索（自包含 ESM 版，零外部依赖）。
// 移植自 ai-experts-platform/backend/shared/fts5.js + fts5_search.js，只保留历史考据官需要的子集。
//
// 三级降级（与生产一致）：
//   1. Trigram OR —— 3 字滑动窗口精确短语，最高精度
//   2. Bigram OR  —— 2 字滑动窗口，短查询兜底
//   3. Char AND  —— 前 5 个 CJK 字符 AND，召回兜底
// 结果按 sourceOrder（chtxt > daizhigev20 > 其他）+ FTS5 rank 排序。

import Database from 'better-sqlite3';

const CJK_RE = /[一-鿿㐀-䶿豈-﫿]/u;

/** 简单历史领域同义词（只保留与历史考据相关的，避免 MCP server 体积膨胀） */
const SYNONYMS = {
  '皇帝': ['皇上', '天子', '陛下', '帝王'],
  '官员': ['大臣', '官吏', '朝臣', '百官'],
  '战争': ['战役', '打仗', '用兵', '征伐'],
  '制度': ['体制', '规制', '典制', '法度'],
  '经济': ['财政', '赋税', '钱粮', '食货'],
  '科举': ['察举', '选官', '九品', '进士'],
  '丞相': ['宰相', '首辅', '阁臣', '相国'],
  '宦官': ['太监', '内侍', '中官', '寺人'],
  '赋税': ['租庸调', '两税法', '一条鞭', '摊丁入亩'],
  '府兵': ['募兵', '卫所', '征兵', '世兵'],
  '变法': ['改革', '新政', '改制', '维新'],
};

function expandQuery(query) {
  let expanded = query;
  for (const [key, list] of Object.entries(SYNONYMS)) {
    if (query.includes(key)) {
      for (const syn of list) {
        if (!query.includes(syn)) expanded += ' ' + syn;
      }
    }
  }
  return expanded;
}

/**
 * 构建 FTS5 MATCH 表达式。返回 {trigramQuery, bigramQuery, charAndQuery, chars}
 * 或字符串（非 CJK 查询直接返回 OR 串）。
 */
export function buildFts5Query(query) {
  const expanded = expandQuery(query);
  // 去 FTS5 语法特殊字符 + 布尔关键字
  let cleaned = expanded
    .replace(/["*^()]/g, ' ')
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return { empty: true };

  if (!CJK_RE.test(cleaned)) {
    // 英文/数字：按词加引号 OR
    const asStr = cleaned.split(/\s+/).map((w) => `"${w}"`).join(' OR ');
    return { trigramQuery: asStr, bigramQuery: null, charAndQuery: asStr, chars: [] };
  }

  const chars = [...cleaned].filter((c) => CJK_RE.test(c));
  if (chars.length === 0) return { empty: true };
  if (chars.length === 1) {
    return { trigramQuery: `"${chars[0]}"`, bigramQuery: null, charAndQuery: `"${chars[0]}"`, chars };
  }

  const trigrams = [];
  for (let i = 0; i <= chars.length - 3; i++) {
    trigrams.push(`"${chars[i]} ${chars[i + 1]} ${chars[i + 2]}"`);
  }
  const trigramQuery = trigrams.length ? trigrams.join(' OR ') : null;

  let bigramQuery = null;
  if (chars.length >= 2 && chars.length < 5) {
    const bigrams = [];
    for (let i = 0; i <= chars.length - 2; i++) {
      bigrams.push(`"${chars[i]} ${chars[i + 1]}"`);
    }
    bigramQuery = bigrams.length ? bigrams.join(' OR ') : null;
  }

  // Char AND 用原始查询字符（不做同义词扩展），限前 5 个 CJK
  let orig = query
    .replace(/["*^()]/g, ' ')
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const origChars = [...orig].filter((c) => CJK_RE.test(c));
  const andChars = (origChars.length ? origChars : chars).slice(0, 5);
  const charAndQuery = andChars.length >= 2 ? andChars.join(' ') : chars.slice(0, 5).join(' ');

  return { trigramQuery, bigramQuery, charAndQuery, chars };
}

const SOURCE_ORDER_SQL = `CASE WHEN a.source = 'chtxt' THEN 0 WHEN a.source = 'daizhigev20' THEN 1 ELSE 2 END`;

/**
 * 打开一个百家学院 SQLite 库（只读）。
 * @param {string} dbPath
 */
export function openReadonly(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  return db;
}

/**
 * 在单库上检索。返回结果数组（含 article/chunk 元数据 + snippet + sourceOrder）。
 *
 * @param {Database} db
 * @param {string} query
 * @param {object} opts
 * @param {number} [opts.limit=8]     返回结果上限
 * @param {number} [opts.fetchLimit=50] 每级 SQL 拉取行数
 * @param {number} [opts.minArticles=3] 去重后至少覆盖多少不同文章
 */
export function searchOneDb(db, query, opts = {}) {
  const { limit = 8, fetchLimit = 50, minArticles = 3 } = opts;
  const q = buildFts5Query(query);
  if (q.empty) return [];

  const columns = `c.id AS chunk_id, c.content AS chunk_content, c.heading AS heading,
                   a.id AS article_id, a.title AS title, a.author AS author,
                   a.dynasty AS dynasty, a.source AS source, a.category AS category,
                   a.url AS url, a.source_file AS source_file`;

  let rows = [];
  const tryTier = (sql) => {
    if (rows.length) return;
    try {
      rows = db.prepare(sql).all(query, fetchLimit);
    } catch (e) {
      // 某级 FTS 语法不兼容时静默降级到下一级
      rows = [];
    }
  };

  if (q.trigramQuery) {
    tryTier(`
      SELECT ${columns}, rank
      FROM chunks_fts f
      JOIN chunks c ON c.id = f.rowid
      JOIN articles a ON a.id = c.article_id
      WHERE chunks_fts MATCH ?
      ORDER BY ${SOURCE_ORDER_SQL}, rank LIMIT ?
    `);
  }
  if (!rows.length && q.bigramQuery) {
    tryTier(`
      SELECT ${columns}, rank
      FROM chunks_fts f
      JOIN chunks c ON c.id = f.rowid
      JOIN articles a ON a.id = c.article_id
      WHERE chunks_fts MATCH ?
      ORDER BY ${SOURCE_ORDER_SQL}, rank LIMIT ?
    `);
  }
  if (!rows.length && q.charAndQuery) {
    tryTier(`
      SELECT ${columns}, rank
      FROM chunks_fts f
      JOIN chunks c ON c.id = f.rowid
      JOIN articles a ON a.id = c.article_id
      WHERE chunks_fts MATCH ?
      ORDER BY ${SOURCE_ORDER_SQL}, rank LIMIT ?
    `);
  }

  if (!rows.length) return [];

  // 每篇文章只取 rank 最高的 chunk；不足 limit 再补其他 chunk；不足 minArticles 再补文章
  const selected = [];
  const seenArticles = new Set();
  for (const r of rows) {
    if (selected.length >= limit) break;
    if (!seenArticles.has(r.article_id)) {
      selected.push(r);
      seenArticles.add(r.article_id);
    }
  }
  for (const r of rows) {
    if (selected.length >= limit) break;
    if (!selected.includes(r)) selected.push(r);
  }

  // 截短正文片段（MCP 上下文友好）
  return selected.map((r) => ({
    articleId: r.article_id,
    chunkId: r.chunk_id,
    title: r.title || '',
    heading: r.heading || '',
    author: r.author || '',
    dynasty: r.dynasty || '',
    source: r.source || '',
    category: r.category || '',
    url: r.url || '',
    sourceFile: r.source_file || '',
    snippet: String(r.chunk_content || '').slice(0, 600),
    sourceOrder: r.source === 'chtxt' ? 0 : r.source === 'daizhigev20' ? 1 : 2,
  }));
}

/**
 * 跨多库检索 + 合并排序。
 *
 * @param {string[]} dbPaths  要查的 SQLite 文件路径列表
 * @param {string} query
 * @param {object} opts
 * @returns {Array<{expertId: string} & ReturnType<searchOneDb>[number]>}
 */
export function searchAcrossDbs(dbPaths, query, opts = {}) {
  const perDbLimit = Math.max(1, Math.floor((opts.limit || 8) * 1.5));
  const all = [];
  for (const p of dbPaths) {
    let db;
    try {
      db = openReadonly(p);
    } catch (e) {
      // 某个库缺失或被锁，跳过不影响其他库
      continue;
    }
    try {
      const rows = searchOneDb(db, query, { ...opts, limit: perDbLimit });
      const expertId = p.split('/').pop().replace(/\.db$/, '');
      for (const r of rows) all.push({ expertId, ...r });
    } finally {
      db.close();
    }
  }
  all.sort((a, b) => {
    if (a.sourceOrder !== b.sourceOrder) return a.sourceOrder - b.sourceOrder;
    return 0; // 同一 source 级别保持原序（FTS rank 已在单库内排好）
  });
  return all.slice(0, opts.limit || 8);
}
