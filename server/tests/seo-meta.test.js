import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, mdToSafeHtml, stripMd, applyHeadMeta, buildSeoArticleDoc } from '../lib/seoMeta.js';
import { normalizeArticle } from '../services/normalize.js';

test('esc: HTML 实体转义', () => {
  assert.equal(esc('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});

test('mdToSafeHtml: 先转义，注入脚本不会被执行', () => {
  const html = mdToSafeHtml('# 标题\n\n<script>alert(1)</script>');
  assert.ok(html.includes('<h2>标题</h2>'), 'H1 降级为 h2');
  assert.ok(!/<script>/i.test(html), '不应出现裸 <script>');
  assert.ok(html.includes('&lt;script&gt;'), 'script 被转义为实体');
});

test('mdToSafeHtml: 段落/列表/链接 nofollow，图片被丢弃', () => {
  const html = mdToSafeHtml('看这里 [官网](https://example.com) 与 `code`\n\n- 甲\n- 乙\n\n![图](https://x/y.png)');
  assert.ok(/<a href="https:\/\/example\.com" rel="nofollow noopener noreferrer">官网<\/a>/.test(html));
  assert.ok(html.includes('<code>code</code>'));
  assert.ok(html.includes('<ul><li>甲</li></ul>') && html.includes('<ul><li>乙</li></ul>'));
  assert.ok(!html.includes('<img'), '内联图片应被移除');
  assert.ok(/<p>/.test(html), '有段落');
});

test('mdToSafeHtml: 超长正文按行预算截断', () => {
  const long = Array.from({ length: 200 }, (_, i) => `第${i}段正文内容重复填充凑字数凑字数凑字数。`).join('\n\n');
  const html = mdToSafeHtml(long, { maxChars: 200 });
  const text = html.replace(/<[^>]+>/g, '');
  assert.ok(text.length < 600, `截断后应远小于原文，实际 ${text.length}`);
});

test('stripMd: 去标记并截断', () => {
  assert.equal(stripMd('# 标题\n这是**正文**内容', 5), '标题 这是正文内容'.slice(0, 5));
});

// 2026-09-15 线上 article/1135 实测：整篇只有一张图时，og:description / JSON-LD 里
// 漏出的是 `![截屏...](/covers/inline-xxx.png)` 原文。以下用例锁死这个回归。
test('stripMd: 剥离图片语法（og:description 漏码根因）', () => {
  const md = '![截屏2026-09-15 09.16.03.png](/covers/inline-1789435666993-9ra5ec.png)';
  assert.equal(stripMd(md), '', '纯图片正文应剥成空串');
  const mixed = '# 标题\n\n![图](/covers/a.png)\n\n正文第一段';
  const out = stripMd(mixed);
  assert.ok(!out.includes('!['), `不应残留图片语法: ${out}`);
  assert.ok(!out.includes('/covers/'), `不应残留图片 URL: ${out}`);
  assert.ok(out.includes('标题') && out.includes('正文第一段'));
});

test('stripMd: 列表标记 / 表格竖线 / 有序列表', () => {
  assert.equal(stripMd('- 甲\n- 乙'), '甲 乙');
  assert.equal(stripMd('1. 第一\n2. 第二'), '第一 第二');
  assert.ok(!stripMd('| 列一 | 列二 |\n| --- | --- |\n| a | b |').includes('|'));
});

test('normalizeArticle: excerpt 是纯文本，不漏 Markdown 图片语法', () => {
  const a = normalizeArticle({
    id: 1135,
    title: '图片上传测试',
    content: '# 标题\n\n![截屏.png](/covers/inline-1.png)\n\n这是正文第一段内容。',
  });
  assert.ok(!a.excerpt.includes('!['), `excerpt 不应含图片语法: ${a.excerpt}`);
  assert.ok(!a.excerpt.includes('/covers/'), `excerpt 不应含图片 URL: ${a.excerpt}`);
  assert.ok(!a.excerpt.includes('#'), 'excerpt 不应含标题标记');
  assert.ok(a.excerpt.includes('这是正文第一段内容'));
});

test('normalizeArticle: 纯图片文章 excerpt 为空（由 SEO 层退到标题兜底）', () => {
  const a = normalizeArticle({ id: 1, title: 'T', content: '![x](/covers/y.png)' });
  assert.equal(a.excerpt, '');
});

const SHELL = `<!doctype html><html><head>
<title>OLD</title>
<meta name="description" content="old desc">
<link rel="canonical" href="https://old.example/">
<meta property="og:title" content="OLD OG">
<meta name="twitter:card" content="summary">
</head><body><div id="root"></div></body></html>`;

test('applyHeadMeta: 覆盖而非堆叠，无重复 canonical/title', () => {
  const out = applyHeadMeta(SHELL, {
    title: '新标题',
    description: '新描述',
    canonical: 'https://aibbs.chat/article/9',
    ogType: 'article',
    ogImage: 'https://aibbs.chat/og-share.png',
    jsonLd: [{ '@type': 'Article', headline: '新标题' }],
  });
  assert.equal((out.match(/<link rel="canonical"/g) || []).length, 1, 'canonical 只应一个');
  assert.equal((out.match(/<title>/g) || []).length, 1, 'title 只应一个');
  assert.ok(out.includes('<title>新标题</title>'));
  assert.ok(!out.includes('OLD'), '旧标题应被移除');
  assert.ok(out.includes('href="https://aibbs.chat/article/9"'));
  assert.ok(out.includes('property="og:url"'), 'og:url 应等于 canonical');
  assert.ok(/<script type="application\/ld\+json">/.test(out), '应注入 JSON-LD');
  assert.ok(!out.includes('</script>alert'), 'JSON-LD 不应逃逸');
});

test('applyHeadMeta: noindex robots 注入', () => {
  const out = applyHeadMeta(SHELL, { title: '登录', robots: 'noindex,follow' });
  assert.ok(out.includes('<meta name="robots" content="noindex,follow"'));
  assert.ok(!out.includes('content="old desc"'));
});

test('buildSeoArticleDoc: 纯爬虫落地页含正文与 meta', () => {
  const doc = buildSeoArticleDoc({
    title: '孙心然夺冠',
    description: '摘要',
    canonical: 'https://aibbs.chat/article/1061',
    ogType: 'article',
    ogImage: 'https://aibbs.chat/og-share.png',
    twitterCard: 'summary_large_image',
    authorName: '小观',
    publishedAt: '2026-09-13T00:00:00Z',
    bodyHtml: '<p>这是一场艰难的决赛，连打三盘。</p>',
    jsonLd: [{ '@type': 'Article', headline: '孙心然夺冠' }],
  });
  assert.ok(doc.includes('<h1>孙心然夺冠</h1>'));
  assert.ok(doc.includes('这是一场艰难的决赛'), '正文应出现在 body 中');
  assert.ok(doc.includes('property="og:image"'));
  assert.ok(doc.includes('application/ld+json'));
  assert.ok(doc.length > 800, '应是有内容的完整文档，而非薄卡片');
});
