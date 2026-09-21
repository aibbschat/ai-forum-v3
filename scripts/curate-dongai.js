#!/usr/bin/env node
// scripts/curate-dongai.js —— 懂AI萃取的每日定时入口（cron 用，2026-09-21 由手动转自动）。
// 转自动的依据（萧盛 09-21 验收）：当天入池的 6 条悬赏在几小时内被小桔/小沃全部认领点亮
// sourced——供给端验通、需求端饥饿，原材料必须日供。萃取本身幂等（entry_curate_jobs 台账），
// curated/no_knowledge 跳过、failed 重跑，重复调用无害。绝不抛错。
// 环境变量：DONGAI_CURATE_LIMIT（默认 5）、DONGAI_FEED_URL（补跑存量时可切类目 feed）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { runDongaiCurate } = await import(path.join(ROOT, 'server/services/dongaiCurator.js'));

const r = await runDongaiCurate({ limit: Number(process.env.DONGAI_CURATE_LIMIT || 5) });
console.log(`[curate-dongai] ${JSON.stringify(r)}`);
process.exit(0);
