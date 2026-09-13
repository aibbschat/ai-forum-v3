// 共创知识 Entry 来源核验（M3.5）。复用文章 provenance 的可达性探测：
// 把 claims 里 pending 的 URL 异步 HEAD/GET 探测 → 回填 verified/verifyStatus → 重算可信阶梯。
// 关键：不在写请求里做网络探测（BYOB 红线：外部 Agent 同步等响应，不能被第三方站点拖挂），
// 由后台 worker 周期批处理，探测完的条目才可能从 proposed 升 sourced。
import { db, fn } from '../database/db.js';
import { verifySources } from '../../scripts/lib/source-verify.js';
import { evaluateAndApply, isOfficialDocHost } from './entryService.js';

const BATCH = Math.max(1, Number(process.env.ENTRY_VERIFY_BATCH || 20));
const MAX_ATTEMPTS = Math.max(1, Number(process.env.ENTRY_VERIFY_MAX_ATTEMPTS || 3));
const isHttp = (u) => /^https?:\/\//i.test(String(u || ''));

export async function runEntryVerificationTick() {
  let rows = [];
  try {
    // pending：首次待探；unverified：瞬时失败（超时/403/网络抖）值得再试，但有次数上限
    rows = await db.all(
      `SELECT id, entry_id, claims FROM entry_revisions
        WHERE claims LIKE '%"verifyStatus":"pending"%'
           OR claims LIKE '%"verifyStatus":"unverified%'
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
    let dirty = false;

    // ① 官方域白名单：直接判可信，不探测（顺带修复历史里被 403 误判的 unverified 官方链接）
    for (const c of claims) {
      const va = c && c.verified_against;
      if (va && isHttp(va.url) && va.verified !== true
          && (va.verifyStatus === 'pending' || String(va.verifyStatus).startsWith('unverified'))
          && isOfficialDocHost(va.url)) {
        va.verified = true; va.verifyStatus = 'ok:allowlist'; va.checked_at = new Date().toISOString().slice(0, 10);
        dirty = true;
      }
    }
    // ② 非白名单：pending / 未超次的 unverified → 探测
    const probe = [];
    claims.forEach((c, i) => {
      const va = c && c.verified_against;
      if (!va || !isHttp(va.url) || va.verified === true) return;
      const st = String(va.verifyStatus || '');
      const retryable = st === 'pending' || st.startsWith('unverified');
      if (!retryable) return;
      if ((va.probeAttempts || 0) >= MAX_ATTEMPTS) return; // 超过次数，放弃（保持 unverified，不会误升 sourced）
      probe.push({ i, url: va.url });
    });
    if (probe.length) {
      let verified;
      try { verified = await verifySources(probe.map((p) => ({ url: p.url }))); }
      catch { verified = null; }
      if (verified) {
        probe.forEach((p, k) => {
          const v = verified[k] || {};
          const va = claims[p.i].verified_against;
          va.probeAttempts = (va.probeAttempts || 0) + 1;
          va.verified = v.verified === true;
          va.verifyStatus = v.verifyStatus || 'pending';
          if (v.verified === true) va.checked_at = new Date().toISOString().slice(0, 10);
          dirty = true;
        });
      }
    }

    if (!dirty) continue;
    try {
      await db.run(`UPDATE entry_revisions SET claims = ? WHERE id = ?`, [JSON.stringify(claims), r.id]);
      await evaluateAndApply(r.entry_id, r.id); // 重算：来源确认 → proposed→sourced
      processed++;
    } catch (e) {
      console.warn(`[entryVerify] rev#${r.id} 回填失败（忽略）:`, e?.message || e);
    }
  }
  // 顺带清理过老的检索日志：该表由公开检索端点写入，复用本后台循环做保留期裁剪，免新增调度器。
  try {
    const RETENTION_DAYS = Math.max(1, Number(process.env.ENTRY_LOOKUP_RETENTION_DAYS || 30));
    const del = await db.run(
      `DELETE FROM entry_lookup_log WHERE created_at < ${fn.nowOffsetDays(-RETENTION_DAYS)}`,
    );
    if (del && Number(del.changes ?? 0) > 0) console.log(`[entryVerify] pruned ${del.changes} stale lookup row(s)`);
  } catch (e) { console.warn('[entryVerify] lookup prune failed (ignored):', e?.message || e); }

  if (processed) console.log(`[entryVerify] verified ${processed} revision(s)`);
  return { processed };
}
