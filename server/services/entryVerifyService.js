// 共创知识 Entry 来源核验（M3.5）。复用文章 provenance 的可达性探测：
// 把 claims 里 pending 的 URL 异步 HEAD/GET 探测 → 回填 verified/verifyStatus → 重算可信阶梯。
// 关键：不在写请求里做网络探测（BYOB 红线：外部 Agent 同步等响应，不能被第三方站点拖挂），
// 由后台 worker 周期批处理，探测完的条目才可能从 proposed 升 sourced。
import { db } from '../database/db.js';
import { verifySources } from '../../scripts/lib/source-verify.js';
import { evaluateAndApply } from './entryService.js';

const BATCH = Math.max(1, Number(process.env.ENTRY_VERIFY_BATCH || 20));

export async function runEntryVerificationTick() {
  let rows = [];
  try {
    rows = await db.all(
      `SELECT id, entry_id, claims FROM entry_revisions
        WHERE claims LIKE '%"verifyStatus":"pending"%'
        ORDER BY id ASC LIMIT ${BATCH}`,
    );
  } catch (e) {
    console.warn('[entryVerify] 扫描失败（忽略）:', e?.message || e);
    return { processed: 0 };
  }

  let processed = 0;
  for (const r of rows) {
    let claims;
    try { claims = JSON.parse(r.claims || '[]'); } catch { continue; }
    const pend = [];
    claims.forEach((c, i) => {
      const va = c && c.verified_against;
      if (va && va.verifyStatus === 'pending' && /^https?:\/\//i.test(va.url || '')) pend.push({ i, url: va.url });
    });
    if (!pend.length) continue;

    // verifySources 按序返回，逐条回填
    let verified;
    try { verified = await verifySources(pend.map((p) => ({ url: p.url }))); }
    catch { continue; }
    pend.forEach((p, k) => {
      const v = verified[k] || {};
      claims[p.i].verified_against.verified = v.verified === true;
      claims[p.i].verified_against.verifyStatus = v.verifyStatus || 'pending';
      if (v.verified === true) claims[p.i].verified_against.checked_at = new Date().toISOString().slice(0, 10);
    });
    try {
      await db.run(`UPDATE entry_revisions SET claims = ? WHERE id = ?`, [JSON.stringify(claims), r.id]);
      await evaluateAndApply(r.entry_id, r.id); // 重算：可引用来源确认 → proposed→sourced
      processed++;
    } catch (e) {
      console.warn(`[entryVerify] rev#${r.id} 回填失败（忽略）:`, e?.message || e);
    }
  }
  if (processed) console.log(`[entryVerify] verified ${processed} revision(s)`);
  return { processed };
}
