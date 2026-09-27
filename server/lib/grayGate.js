// server/lib/grayGate.js
// 灰度闸的**唯一**实现（2026-09-27 收敛）。
//
// 为什么要有这个文件：此前四个便签类（circle_digest / deed_digest / material_brief /
// owner_recall）各自手抄了一份「逗号 ID 名单」解析，于是四个闸都只会**一个个手加 agentId**——
// 测试跑完想让全体用，就得逐只往 `.env` 里塞 ID，而名单一旦写错还是静默失效。
// 这是为测试期设计的形状，不是为上线设计的（2026-09-27 萧盛判定：傻瓜设计）。
//
// 约定（**不动「置空即回滚」这条硬约束**）：
//   · 未设 / 空串        → **全关**（回滚面：清空变量 + 重启，事故半径＝0）
//   · 含 `*` 或 `all`    → **全开**（全量开放，不必再一个个加；大小写不敏感、任一位置即可）
//   · 其余               → 逗号 ID 名单（最小生效单位，可把事故半径锁到单只）
//
// 注意 `all` 只在这里代表"全开"，**不**代表某个叫 all 的 agentId——ID 一律是正整数。

/** 通配符字面量（与 `all` 等价，两个都认）。 */
export const GRAY_ALL = '*';

/** 名单串里是否出现通配符（`*` / `all`）。 */
export function isGrayAll(raw) {
  return String(raw ?? '').split(',').some((s) => {
    const t = s.trim().toLowerCase();
    return t === GRAY_ALL || t === 'all';
  });
}

/**
 * 解析名单串 → `{ all, ids, bad }`。
 *   · 通配符不进 `ids`（它是"全开"语义，不是某一号）；
 *   · `bad` 收集写错的项，**交给调用方出声**（各模块的 warn 前缀不同，这里不自作主张）。
 */
export function parseGray(raw) {
  const ids = new Set();
  const bad = [];
  for (const s of String(raw ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const t = s.toLowerCase();
    if (t === GRAY_ALL || t === 'all') continue;
    const n = Number(s);
    if (Number.isInteger(n) && n > 0) ids.add(n);
    else bad.push(s);
  }
  return { all: isGrayAll(raw), ids, bad };
}

/** 这只 Agent 在这个闸里放行吗（通配 = 人人放行）。 */
export function grayEnabled(raw, agentId) {
  const g = parseGray(raw);
  return g.all || g.ids.has(Number(agentId));
}

export default { GRAY_ALL, isGrayAll, parseGray, grayEnabled };