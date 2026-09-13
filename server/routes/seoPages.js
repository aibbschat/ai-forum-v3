// 公开页 SEO 守卫（B3 + B2）：挂在 SPA fallback 之前，对全部公开 HTML 路由按页处理。
//  - 纯爬虫 + 内容路由（/article/:id、/plaza/:id）：返回含正文的 SEO 落地页（非薄卡片）。
//  - 浏览器/其余公开路由：返回 SPA 骨架，但注入按页 title/description/canonical/og/JSON-LD。
//  - 私有/低价值路由：注入 robots noindex,follow。
// 未识别的路径直接 next()（交给 SPA fallback，行为不变）。/api 与 /og 由各自路由先处理。
import { getIndexHtml, applyHeadMeta, buildSeoArticleDoc } from '../lib/seoMeta.js';
import { isPureCrawler } from './og.js';
import * as seo from '../services/seoPageService.js';

function normPath(req) {
  let p = String(req.path || '/');
  if (p.length > 1) p = p.replace(/\/+$/, '') || '/';
  return p;
}

export async function publicPageGuard(req, res, next) {
  const p = normPath(req);
  try {
    const article = /^\/article\/(\d+)$/.exec(p);
    const topic = /^\/plaza\/(\d+)$/.exec(p);
    const agent = /^\/agent\/(\d+)$/.exec(p);

    // 内容路由
    if (article || topic) {
      const data = article
        ? await seo.articleDoc(Number(article[1]), req)
        : await seo.topicDoc(Number(topic[1]), req);
      if (!data) return next(); // 不存在 → 交给 SPA（前端出 404 视图），不误返回 404 卡
      if (isPureCrawler(req)) {
        res.set('Cache-Control', 'public, max-age=300');
        return res.status(200).send(buildSeoArticleDoc(data));
      }
      const html = getIndexHtml();
      if (!html) return res.status(200).send(buildSeoArticleDoc(data));
      res.set('Cache-Control', 'no-cache');
      return res.status(200).send(applyHeadMeta(html, data));
    }

    // Agent 主页
    if (agent) {
      const meta = await seo.agentMeta(Number(agent[1]), req);
      if (!meta) return next();
      const html = getIndexHtml();
      if (!html) return next();
      res.set('Cache-Control', 'no-cache');
      return res.status(200).send(applyHeadMeta(html, meta));
    }

    // 私有/低价值 → noindex
    const noindex = seo.noindexMeta(p, req);
    if (noindex) {
      const html = getIndexHtml();
      if (html) { res.set('Cache-Control', 'no-cache'); return res.status(200).send(applyHeadMeta(html, noindex)); }
      return next();
    }

    // 信息型公开路由
    const meta = seo.staticMeta(p, req);
    if (meta) {
      const html = getIndexHtml();
      if (!html) return next();
      res.set('Cache-Control', 'no-cache');
      return res.status(200).send(applyHeadMeta(html, meta));
    }

    return next();
  } catch (e) {
    console.error('[seoPages] guard failed:', e?.message || e);
    return next();
  }
}
