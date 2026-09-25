// server/lib/trafficClassify.js
// 「这一行到底是不是人」的判据（2026-09-25 二批）。
//
// 来由：首版流量看板上线当晚回查，独立 IP 150 与 Agent 接入量完全不成正比。
// 把 175 行逐条对回 Nginx 原始日志后定性：143 行是**伪装成 Chrome 的抓取器**
// —— UA 写 `Mozilla/5.0 ... Chrome/144`，但一个 IP 只发一条 HTML、随后既不拉 JS/CSS、
// 也不调任何 /api（真浏览器做不到这样），路径还按文章 id 递增遍历；
// 另夹着 /phpinfo、/_profiler/phpinfo 这类漏洞探针。
//
// 首版只按 UA 黑名单过滤（bot|crawl|spider|python…），对这种「披浏览器皮的客户端」无效。
// 所以补三条能落库、能事后回查的判据：
//   ① ua_family  ：UA 家族粗分（含"自称 Mozilla"这一类，不判定真伪，只留证据）；
//   ② accept_html：Accept 头是否含 text/html —— 真浏览器必带，多数脚本库不带；
//   ③ is_probe   ：命中攻击面路径（phpinfo/wp-admin/.env/actuator…），整行不计入任何统计。
// 真伪的最终硬证据是**有没有执行 JS**（=同日同 ip/vid 是否发过 /api/track beacon），
// 那一步在 services/trafficService.js 里做，因为它是跨行推断，不该在写入时假装知道。
//
// 另外把 IP 口径也修了：v6 客户端按 /64 前缀归并。
// 移动网络一个用户常常在 /64 里换尾址，按完整地址去重会把一个人算成好几个「独立 IP」。

/** 已知自动化客户端的 UA 家族（含常见 LLM/搜索爬虫，便于回查时一眼分辨）。 */
const NAMED_FAMILIES = [
  [/^(Go-http-client)/i, 'go-http'],
  [/^(python-requests|python-httpx|aiohttp|httpx)/i, 'python'],
  [/^(curl|wget)/i, 'cmdline'],
  [/^(okhttp|Java\/|Apache-HttpClient|HttpClient)/i, 'java'],
  [/^(axios|node-fetch|undici|node|Bun)/i, 'node'],
  [/^(Wget|Ruby|libwww|HTTPie|Nutch|Scrapy|PostmanRuntime|Insomnia|Paw)/i, 'tool'],
  [/GPTBot|OAI-SearchBot|ChatGPT-Agent|CoHere-ai|perplexitybot|ccbot|meta-externalagent|Amazonbot|applebot|duckassistbot|Google-Extended|ClaudeBot|Bytespider|PetalBot/i, 'ai-crawler'],
  [/Googlebot|bingbot|Baiduspider|Sogou|360Spider|YisouSpider|yandex|DuckDuckBot|Slurp/i, 'search-crawler'],
  [/MicroMessenger/i, 'wechat'],
  [/QQ\/|QQBrowser|MQQBrowser/i, 'qq-browser'],
];

/** UA → 家族标签（≤60 字符，落 ua_family）。未知一律归到可辨识的最粗一类，绝不自造"真人"结论。 */
export function uaFamily(ua) {
  const s = String(ua || '').trim();
  if (!s || s === '-') return 'empty';
  for (const [re, name] of NAMED_FAMILIES) if (re.test(s)) return name;
  // 自称浏览器：只记家族，真伪交给 beacon（Chrome 144 单发不带 JS 就是这一类的破绽所在）
  const m = /(Chrome|Edg|OPR|Firefox|Safari)\/(\d+)/i.exec(s);
  if (/^Mozilla\/5\.0/.test(s) && m) return `selfclaim:${m[1].toLowerCase()}`;
  if (/^Mozilla\/5\.0/.test(s)) return 'selfclaim:generic';
  return 'other';
}

/** Accept 头是否含 text/html —— 真浏览器导航请求必带。 */
export function acceptHasHtml(req) {
  return /text\/html/i.test(String(req.headers?.accept || '')) ? 1 : 0;
}

/**
 * 攻击面/扫描探针路径：这类请求根本不是「来看内容」，一律排除出统计口径。
 * ⚠️ 名单里刻意不写「反斜杠+斜杠」组合（正则字面量中 `\/` 会被解析成转义斜杠、
 *    `\\/` 则直接提前终结字面量 —— 这类路径的判法改用下方独立的字符串检查）。
 */
const PROBE_RE = /(wp-admin|wp-login|wp-content|wp-json|phpmyadmin|_profiler|phpinfo|\.env|\.git|\.svn|\.aws|\.ssh|id_rsa|actuator|druid|solr|cgi-bin|eval-stdin|xmlrpc|config\.inc|composer\.json|\.sql$|\.bak$)/i;
const PROBE_SUBSTR = ['../', '..\\', '/shell', '/.env', '/.git'];
export function isProbePath(path) {
  const p = String(path || '');
  if (PROBE_SUBSTR.some((s) => p.includes(s))) return 1;
  return PROBE_RE.test(p) ? 1 : 0;
}

/**
 * IP 归并口径：v4 原样；v6 折到 /64 前缀（先展开 `::` 缩写，再取前 4 组）。
 * 目的：移动网络一个用户常在 /64 内换尾址，按完整地址去重会把一个人算成多个「独立 IP」。
 * 返回串只用于哈希，不落原文。
 */
export function ipScope(ip) {
  const s = String(ip || 'na').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!s.includes(':')) return s;                       // v4 原样
  const bare = s.split('%')[0];                          // 去 zone id（fe80::1%eth0）
  if (bare.startsWith('::ffff:') || /^::\d+\.\d+\.\d+\.\d+$/.test(bare)) {
    const tail = bare.split(':').pop();
    if (tail && tail.includes('.')) return tail;         // v4-mapped 按 v4 计
  }
  // 展开 :: 缩写：不能 filter(Boolean)，那会丢掉 :: 的位置
  let groups;
  if (bare.includes('::')) {
    const [headRaw, tailRaw] = bare.split('::');
    const head = headRaw ? headRaw.split(':') : [];
    const tail = tailRaw ? tailRaw.split(':') : [];
    groups = [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  } else {
    groups = bare.split(':');
  }
  if (groups.length < 8) groups = [...groups, ...Array(8 - groups.length).fill('0')];
  // 组内去前导零：2001:db8::1 与 2001:0db8:0000:...:1 必须折出同一个键，否则同一人还是两个 IP
  const norm = groups.slice(0, 4).map((g) => g.replace(/^0+/, '') || '0');
  return `${norm.join(':')}::/64`;
}
