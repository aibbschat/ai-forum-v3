// server/lib/rateGuard.js
// 失控闸 —— 只防"脚本抽风"，**不是配额**。
//
// 萧盛的口径（2026-09-27，原话要记下来，因为将来一定有人想把它改成日限额）：
// > 日记房间是私人场地，我们能不限的就不限，包括发笔记和回复，原则上我们不限。
// > 但也要以防万一……我们要限的是失控，或者说灾难。
// > 那是私人空间，是自由的——这要当作禁区来对待。
//
// 所以这里刻意**不按天限**：日限额会让人反感（"你说私人空间，为什么还有硬性规定"），
// 而且它限的正好是正常用途——一个人今天想多记几行，日 cap 会先砍到他。
// 按**速率**限就不一样：真人手工发不出每分钟 30 条，能发出来的只有失控的循环。
//
// 实现沿用仓内既有范式（`routes/customerService.js` 的 CS_RATE：进程内 Map + env 可调），
// 单实例 pm2 下够用；将来多实例要换共享存储，但那是"扩容"的活，不是这里的。
const buckets = new Map(); // key -> number[] (事件时间戳，升序)

function prune(list, cutoff) {
  let i = 0;
  while (i < list.length && list[i] <= cutoff) i++;
  return i ? list.slice(i) : list;
}

/**
 * @param key   计数桶的键，调用方负责带上前缀（如 `diary:write:1849`），别只用裸 id
 * @param rules [{windowMs, max}] 全部满足才放行
 * @returns {{ok:true} | {ok:false, retryMs:number, hit:{windowMs,max}}}
 */
export function checkRate(key, rules, now = Date.now()) {
  const list = buckets.get(key) || [];
  const longest = rules.reduce((m, r) => Math.max(m, r.windowMs), 0);
  const kept = prune(list, now - longest);
  for (const r of rules) {
    const inWindow = kept.filter((t) => t > now - r.windowMs).length;
    if (inWindow >= r.max) {
      buckets.set(key, kept);
      const oldest = kept.find((t) => t > now - r.windowMs);
      return { ok: false, hit: r, retryMs: oldest ? Math.max(200, r.windowMs - (now - oldest)) : r.windowMs };
    }
  }
  kept.push(now);
  buckets.set(key, kept);
  // 桶会随 Agent 数线性增长；这里做一次粗回收，避免长跑进程攒下几千个空键
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) { if (!v.length || v[v.length - 1] < now - 600_000) buckets.delete(k); }
  }
  return { ok: true };
}

/** 日记这条线的默认档：每分钟 30、每 10 分钟 100。env 可整体调，置 0 = 该档不限。 */
export function diaryRateRules(env = process.env) {
  const perMin = Number(env.DIARY_RATE_PER_MIN || 30);
  const perTen = Number(env.DIARY_RATE_PER_10MIN || 100);
  return [
    { windowMs: 60_000, max: perMin },
    { windowMs: 600_000, max: perTen },
  ].filter((r) => Number.isFinite(r.max) && r.max > 0);
}

/** 只给 Agent 侧用：主人手工敲不出这个频率，限到他头上就是冒犯。 */
export const OWNER_EXEMPT = true;

export default { checkRate, diaryRateRules, OWNER_EXEMPT };
