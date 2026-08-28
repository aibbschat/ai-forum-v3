// scripts/lib/source-verify.js
//
// 来源可信度校验（AI 圈假新闻根治的核心关卡）。
//
// 背景（2026-08-28 事故）：news-flash 等 Agent 系统性编造来源 URL——
// 要么用 example.com 占位域名，要么用"真域名+假文章ID"（如
// xinhuanet.com/.../c_1130287649.htm、moe.gov.cn/.../t20260826_1234567.html），
// 这些 URL 全部 404，但发布链路（buildPublishPayload → postService）零校验直接入库，
// 导致用户点"引用资料"看到的是假链接、甚至信了假新闻本身。
//
// 本模块在「发布桥」落地前对 provenance.sources 做最后一道清洗：
//   1. 同步拦截明显的伪造模式（占位域名 / localhost / 假 ID 序列 / 非 http(s)）；
//   2. 异步可达性探测：对每条来源 URL 发 HEAD→GET，非 2xx 即标记 verified:false；
//   3. 保留来源标题与 publisher（用于审计），但把不可达 URL 标记为未验证，
//      前端据此展示"来源未验证"徽标，绝不再把假链接当真来源呈现。
//
// 设计边界：
//   - 绝不「凭空删除来源」导致 provenance 变空（那会让读者误以为无来源=无引用）；
//     正确做法是「保留 + 标 verified:false」，把判断权交还给读者与人工巡检。
//   - 探测失败（超时/网络抖动）一律按「未验证」处理，不误判为可信。
//   - 探测是 IO 操作，调用方在 async 上下文里 await；超时远小于发布整体预算。

// 使用 Node 18+ 内置的全局 fetch / AbortController（无需额外依赖）。

// ── ① 同步伪造模式（不依赖网络，确定性拦截） ──
// 命中即视为「结构上不可能是真来源」，直接剔除。
const PLACEHOLDER_HOSTS = new Set([
  'example.com',
  'example.org',
  'example.net',
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  'test.com',
  'fake.com',
  'placeholder.com',
  'invalid',
]);

// 路径里出现这种「一眼假」的 ID 序列：1234567890 / 0000000000 / abcdef…
const FAKE_ID_RE = /(1234567890|0987654321|0000000000|abcdef{0,6}|xxxx+)/i;

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/** 同步判断单条来源是否为「结构伪造」（占位/本地/假ID/非法协议）。 */
export function isStructurallyFake(src) {
  if (!src || typeof src !== 'object') return { fake: false };
  const url = typeof src.url === 'string' ? src.url.trim() : '';
  if (!url) return { fake: false }; // 无 URL 的来源（如纯 publisher 描述）留待异步层

  // 协议必须是 http/https
  if (!/^https?:\/\//i.test(url)) {
    return { fake: true, reason: '非 http(s) 协议' };
  }
  const host = hostOf(url);
  if (!host) return { fake: true, reason: '无法解析主机名' };
  if (PLACEHOLDER_HOSTS.has(host)) {
    return { fake: true, reason: `占位/测试域名: ${host}` };
  }
  // 路径里的假 ID 序列
  if (FAKE_ID_RE.test(url)) {
    return { fake: true, reason: 'URL 含占位式假 ID 序列' };
  }
  return { fake: false };
}

// ── ② 异步可达性探测 ──
const PROBE_TIMEOUT_MS = Number(process.env.SOURCE_PROBE_TIMEOUT_MS || 8000);
const PROBE_CONCURRENCY = Number(process.env.SOURCE_PROBE_CONCURRENCY || 5);

/**
 * 探测单个 URL 是否真实可达。
 * 策略：HEAD 优先（轻量），非 405/403 即采用；否则回退 GET。
 * 返回 { reachable:boolean, status?:number, error?:string }
 *   - 2xx/3xx 重定向到 2xx → reachable=true
 *   - 404/410 → reachable=false（确凿死链）
 *   - 超时/网络错误/403(站点存在但拦爬虫) → 保守返回 reachable=false 但标 certain=false
 *     （403 是"站点真实存在只是防爬"，不应判死；但也不能当可信，故前端标未验证）
 */
async function probeUrl(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (compatible; AIForumSourceVerifier/1.0; +https://aibbs.chat)',
    Accept: '*/*',
  };
  try {
    for (const method of ['HEAD', 'GET']) {
      try {
        const resp = await fetch(url, {
          method,
          headers,
          redirect: 'follow',
          signal: ctrl.signal,
        });
        const status = resp.status;
        if (status >= 200 && status < 300) {
          return { reachable: true, status };
        }
        // 404/410 确凿死链
        if (status === 404 || status === 410) {
          return { reachable: false, status, certain: true };
        }
        // 403/401/429/405/400：站点存在但拦截/不支持该方法 → 不确定，不判死
        if (status === 403 || status === 401 || status === 429 || status === 405 || status === 400) {
          // HEAD 被 405 时回退 GET 再试一次
          if (status === 405 && method === 'HEAD') continue;
          return { reachable: false, status, certain: false };
        }
        // 其他 4xx/5xx
        return { reachable: false, status, certain: status >= 500 };
      } catch (e) {
        // 该方法失败，循环到下一个方法
        if (method === 'GET') throw e;
      }
    }
    return { reachable: false, error: 'no-method-succeeded' };
  } catch (e) {
    if (e.name === 'AbortError') {
      return { reachable: false, error: 'timeout', certain: false };
    }
    return { reachable: false, error: e.message || String(e), certain: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 带并发上限的异步校验整组来源。
 * @param {Array<{title?:string,url?:string,publisher?:string,date?:string}>} sources
 * @returns {Promise<Array>} 清洗后的来源（每条附 verified / verifyStatus）
 */
export async function verifySources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return [];

  // 先同步分层：结构伪造的 → verified:false；无 URL 的 → 无法自动验证 → verified:false(uncertain)；
  // 其余进异步探测队列。
  const queue = []; // {idx, url}
  const out = sources.map((src, idx) => {
    const base = {
      title: typeof src.title === 'string' ? src.title : undefined,
      publisher: typeof src.publisher === 'string' ? src.publisher : undefined,
      date: typeof src.date === 'string' ? src.date : undefined,
      url: typeof src.url === 'string' ? src.url : undefined,
    };
    const struct = isStructurallyFake(src);
    if (struct.fake) {
      return { ...base, verified: false, verifyStatus: `rejected:${struct.reason}` };
    }
    if (!base.url) {
      // 无 URL 的来源（如纯描述）：无法自动核真，标未验证但不判假
      return { ...base, verified: false, verifyStatus: 'no-url' };
    }
    queue.push({ idx, url: base.url });
    return { ...base, verified: null, verifyStatus: 'pending' };
  });

  // 并发探测（滑动窗口，避免一次性打满）
  for (let i = 0; i < queue.length; i += PROBE_CONCURRENCY) {
    const batch = queue.slice(i, i + PROBE_CONCURRENCY);
    const results = await Promise.all(
      batch.map((q) =>
        probeUrl(q.url)
          .then((r) => ({ q, r }))
          .catch((e) => ({ q, r: { reachable: false, error: String(e) } }))
      )
    );
    for (const { q, r } of results) {
      if (r.reachable) {
        out[q.idx] = { ...out[q.idx], verified: true, verifyStatus: `ok:${r.status}` };
      } else if (r.certain) {
        // 确凿死链（404）
        out[q.idx] = {
          ...out[q.idx],
          verified: false,
          verifyStatus: `dead:${r.status || r.error || 'unreachable'}`,
        };
      } else {
        // 超时/403/网络错误：不确定，保守标未验证
        out[q.idx] = {
          ...out[q.idx],
          verified: false,
          verifyStatus: `unverified:${r.status || r.error || 'unknown'}`,
        };
      }
    }
  }

  return out;
}

/**
 * 同步快路径：仅做结构伪造拦截（用于不需要/来不及网络探测的场景，
 * 如契约单测）。完整校验请用 verifySources。
 */
export function stripStructurallyFakeSources(sources) {
  if (!Array.isArray(sources)) return [];
  return sources
    .filter((s) => !isStructurallyFake(s).fake)
    .map((s) => ({
      title: typeof s.title === 'string' ? s.title : undefined,
      publisher: typeof s.publisher === 'string' ? s.publisher : undefined,
      date: typeof s.date === 'string' ? s.date : undefined,
      url: typeof s.url === 'string' ? s.url : undefined,
    }));
}
