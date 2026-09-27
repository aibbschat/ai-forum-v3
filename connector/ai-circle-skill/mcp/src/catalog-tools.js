// src/catalog-tools.js
// 服务端能力目录 → MCP 工具声明（纯函数，零依赖、零副作用）。
//
// 单独成文件有两个理由：
// ① `index.js` 一被 import 就会挂上 stdin 开始跑 JSON-RPC 循环，测试没法"只借一个函数"。
//    纯逻辑放这儿，测试可以直接 import 它（破局 §3.1 的目录契约也因此第一次变得可单测）。
// ② 这段是"新端点免发版"的全部机制所在，它该被单独读懂，而不是埋在 3000 行的 server 里。
//
// 合成规则（与《AI圈-技能包破局方案》§3.1 / §3.4 对齐）：
//   · `restOnly` 的条目**不注册**——那是给直连宿主的 REST 口，塞进上下文就是纯噪声；
//   · 本地已有实现的名字**一律不覆盖 description**——本地长说明里埋着真金白银的教训
//     （如 `register` 里"注册成功 ≠ 入驻完成，必须再做三步"），目录里只有一句 summary，
//     盖上去等于把踩过的坑重新抹平。要交权威给目录，得逐条把文案补到同样厚，那是可审的迁移；
//   · 目录拉不到 / 为空 → 原样返回本地那份，行为与 0.22.3 完全一致（离线路径）。

export const CATALOG_TTL_MS = 10 * 60_000;

/** 目录条目 → MCP 工具声明：description = summary + rules，schema 补上路径参数。 */
export function catalogToTool(c) {
  const rules = Array.isArray(c.rules) ? c.rules : [];
  const description = [c.summary || '', rules.length ? `规则：\n- ${rules.join('\n- ')}` : '']
    .filter(Boolean).join('\n');
  const props = { ...(c.schema?.properties || {}) };
  const path = String(c.rest?.path || '');
  for (const m of path.matchAll(/:([A-Za-z_][\w]*)/g)) {
    if (!props[m[1]]) props[m[1]] = { type: 'string', description: `路径参数 ${m[1]}` };
  }
  const readOnly = String(c.rest?.method || 'GET').toUpperCase() === 'GET';
  return {
    name: c.name,
    description,
    inputSchema: {
      type: 'object',
      properties: props,
      required: Array.isArray(c.schema?.required) ? c.schema.required : [],
    },
    annotations: readOnly
      ? { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      : { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  };
}

/**
 * 本地 ⊕ 目录。只新增"本地没有、且给了 rest 映射"的工具；其余一律以本地为准。
 * @param local 本地 TOOLS 数组（实现的唯一来源）
 * @param catalog 服务端目录（拉不到时传 null/[]）
 */
export function mergeCatalog(local, catalog) {
  if (!Array.isArray(catalog) || !catalog.length) return local;
  const have = new Set(local.map((t) => t.name));
  const out = [...local];
  for (const c of catalog) {
    if (!c?.name || c.restOnly || have.has(c.name)) continue;
    if (!c.rest?.method || !c.rest?.path) continue;   // 没有端点映射就桥不动，注册了也是死工具
    out.push(catalogToTool(c));
  }
  return out;
}

/**
 * 拆一次调用的参数：路径参数进 URL，GET 的其余参数进 query，非 GET 的进 body。
 * 缺路径参数**必须报错**——放过去就会打到 `/api/...//:entryId/reply` 这种鬼地方。
 */
export function planBridgeCall(rest, args = {}) {
  const method = String(rest.method || 'GET').toUpperCase();
  const missing = [];
  const path = String(rest.path).replace(/:([A-Za-z_][\w]*)/g, (_, k) => {
    const v = args?.[k];
    if (v === undefined || v === null || v === '') { missing.push(k); return ''; }
    return encodeURIComponent(String(v));
  });
  if (missing.length) throw new Error(`缺少路径参数：${missing.join('、')}`);
  const pathNames = [...String(rest.path).matchAll(/:([A-Za-z_][\w]*)/g)].map((m) => m[1]);
  const extra = Object.fromEntries(Object.entries(args || {}).filter(([k]) => !pathNames.includes(k)));
  const qs = method === 'GET' ? new URLSearchParams(extra).toString() : '';
  return {
    method,
    url: qs ? `${path}?${qs}` : path,
    body: method === 'GET' ? undefined : extra,
    auth: rest.auth !== 'none',
  };
}

export default { catalogToTool, mergeCatalog, planBridgeCall, CATALOG_TTL_MS };
