import { Router } from 'express';
import { db } from '../database/db.js';

const router = Router();

function getPublicBase(req) {
  // SITE_PUBLIC_URL 显式配置最高优先级（生产建议设置为 https://aibbs.chat）。
  // 否则按请求 Host 兜底；nginx 已把 Host 透传过来。
  if (process.env.SITE_PUBLIC_URL) return process.env.SITE_PUBLIC_URL.replace(/\/$/, '');
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}`;
}

const ALLOWED_SITEMAP_CATEGORIES = new Set([
  '科技', '财经', '历史', '心理', '社会', '文化', '教育', 'AI之眼', '观察哨', '思维漫游',
]);

router.get('/robots.txt', (req, res) => {
  const base = getPublicBase(req);
  res.type('text/plain').send(
    [
      'User-agent: *',
      'Allow: /',
      'Disallow: /admin/',
      'Disallow: /api/',
      'Disallow: /chat',
      '',
      `Sitemap: ${base}/sitemap.xml`,
      '',
    ].join('\n'),
  );
});

router.get('/sitemap.xml', async (req, res) => {
  const base = getPublicBase(req);
  const now = new Date().toISOString();
  const staticPaths = [
    { path: '/', priority: '1.0' },
    { path: '/plaza', priority: '0.9' },
    { path: '/plaza/tags', priority: '0.7' },
    { path: '/start', priority: '0.85' },
    { path: '/join-skill', priority: '0.85' },
    { path: '/agents', priority: '0.8' },
    { path: '/security', priority: '0.7' },
    { path: '/thoughts', priority: '0.6' },
    { path: '/about', priority: '0.5' },
    { path: '/releases', priority: '0.4' },
  ];
  // 分类改用干净路由 /category/:name（弃用 /?category= 查询串，利于 canonical 归一）。
  for (const cat of ALLOWED_SITEMAP_CATEGORIES) {
    staticPaths.push({ path: `/category/${encodeURIComponent(cat)}`, priority: '0.7' });
  }

  let articles = [];
  try {
    // 取最近 5000 篇（远超当前量级；sitemap 单文件上限 5 万）。
    articles = await db.all(
      `SELECT id, updated_at, created_at, category
         FROM posts
        WHERE post_type = 'article'
        ORDER BY id DESC
        LIMIT 5000`,
    );
  } catch (e) {
    console.warn(`[seo/sitemap] 文章拉取失败：${e.message}`);
  }

  // 广场帖（公开、未折叠/未删除），最近 2000 条。
  let topics = [];
  try {
    topics = await db.all(
      `SELECT id, created_at
         FROM topics
        WHERE status = 1 AND COALESCE(visibility, 'public') NOT IN ('folded', 'removed')
        ORDER BY id DESC
        LIMIT 2000`,
    );
  } catch (e) {
    console.warn(`[seo/sitemap] 广场帖拉取失败：${e.message}`);
  }

  // 活跃 Agent 主页，最近/最多 1000 个。
  let agents = [];
  try {
    agents = await db.all(
      `SELECT user_id AS id FROM agent_profiles WHERE is_active = 1 ORDER BY user_id ASC LIMIT 1000`,
    );
  } catch (e) {
    console.warn(`[seo/sitemap] Agent 主页拉取失败：${e.message}`);
  }

  function isoOf(row) {
    const last = (row.updated_at || row.created_at || now);
    return last instanceof Date ? last.toISOString() : new Date(last).toISOString();
  }

  const urls = [
    ...staticPaths.map((p) => `
  <url>
    <loc>${base}${p.path}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>hourly</changefreq>
    <priority>${p.priority}</priority>
  </url>`),
    ...articles.map((a) => {
      const last = (a.updated_at || a.created_at || now);
      const iso = last instanceof Date ? last.toISOString() : new Date(last).toISOString();
      const isAIEye = a.category === 'AI之眼' || a.category === '观察哨' || a.category === '思维漫游';
      return `
  <url>
    <loc>${base}/article/${a.id}</loc>
    <lastmod>${iso}</lastmod>
    <changefreq>daily</changefreq>
    <priority>${isAIEye ? '0.8' : '0.6'}</priority>
  </url>`;
    }),
    ...topics.map((t) => `
  <url>
    <loc>${base}/plaza/${t.id}</loc>
    <lastmod>${isoOf(t)}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.5</priority>
  </url>`),
    ...agents.map((g) => `
  <url>
    <loc>${base}/agent/${g.id}</loc>
    <changefreq>daily</changefreq>
    <priority>0.6</priority>
  </url>`),
  ];

  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}
</urlset>
`,
  );
});

export default router;
