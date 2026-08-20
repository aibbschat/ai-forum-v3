#!/usr/bin/env node
// scripts/render-patch.js — 用本机/部署机的真实路径渲染 cordis.patch.yml
//
// 背景：cordis.patch.yml 含 DSH 加载预设/MCP server 所需的绝对路径，这些路径因机器而异，
// 且会暴露开发者用户名/部署目录。因此仓库里只提交模板 cordis.patch.template.yml（含
// __REPO_ROOT__ / __BAIJIA_DATA_DIR__ 占位符），真实文件由本脚本渲染生成并加入 .gitignore。
//
// 用法：
//   node scripts/render-patch.js                # 自动探测路径并渲染
//   BAIJIA_DATA_DIR=/data/xxx node scripts/render-patch.js
//   node scripts/render-patch.js --check        # 只检查真实文件是否与当前路径一致（CI 用）
//
// 幂等：已存在且内容一致则不重写（不会覆盖 switch-brain.sh 改的 provider）。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, isAbsolute } from 'node:path';

// 加载仓库根 .env，使 BAIJIA_DATA_DIR 等机器相关变量可被读取（dotenv 已在依赖中）。
try {
  const dotenv = await import('dotenv');
  dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env') });
} catch {
  // dotenv 不可用时退回纯 process.env
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = resolve(ROOT, 'dsh/bundles/agent-presets-mount/cordis.patch.template.yml');
const OUT = resolve(ROOT, 'dsh/bundles/agent-presets-mount/cordis.patch.yml');

const repoRoot = ROOT;
// 百家数据目录：显式环境变量优先；否则探测几个常见位置；都没有就用仓库内置空目录占位。
const baijiaCandidates = [
  process.env.BAIJIA_DATA_DIR,
  resolve(ROOT, '../ai-experts-platform/data'),
  resolve(ROOT, 'data/ai-experts'),
].filter(Boolean);
const baijiaDataDir = baijiaCandidates.find((p) => isAbsolute(p) && existsSync(p)) || baijiaCandidates[baijiaCandidates.length - 1];

const check = process.argv.includes('--check');

// 保留已生成文件里 switch-brain.sh 可能改过的 agent-default-model（provider/model），
// 避免每次渲染把大脑选择重置回模板默认值。
function preserveBrainSelection(prev, next) {
  if (!prev) return next;
  const m = prev.match(/- id: agent-default-model\n  config:\n    provider: (\S+)\n    model: (\S+)/);
  if (!m) return next;
  return next.replace(
    /(- id: agent-default-model\n  config:\n    provider: )\S+(\n    model: )\S+/,
    `$1${m[1]}$2${m[2]}`
  );
}

let tpl;
try {
  tpl = readFileSync(TEMPLATE, 'utf8');
} catch {
  console.error(`[render-patch] 找不到模板 ${TEMPLATE}`);
  process.exit(1);
}

let rendered = tpl
  .replaceAll('__REPO_ROOT__', repoRoot)
  .replaceAll('__BAIJIA_DATA_DIR__', baijiaDataDir);

if (existsSync(OUT)) {
  const current = readFileSync(OUT, 'utf8');
  rendered = preserveBrainSelection(current, rendered);
  if (current === rendered) {
    console.log('[render-patch] cordis.patch.yml 已是最新，无需重写');
    process.exit(0);
  }
  if (check) {
    console.error('[render-patch] cordis.patch.yml 与模板渲染结果不一致，请运行 node scripts/render-patch.js');
    process.exit(1);
  }
  console.log('[render-patch] 检测到路径变化，重写 cordis.patch.yml（保留当前大脑选择；旧文件备份为 .bak）');
  writeFileSync(OUT + '.bak', current);
} else if (check) {
  console.error('[render-patch] cordis.patch.yml 不存在，请运行 node scripts/render-patch.js');
  process.exit(1);
} else {
  console.log('[render-patch] 生成 cordis.patch.yml');
}

writeFileSync(OUT, rendered);
console.log(`[render-patch] REPO_ROOT=${repoRoot}`);
console.log(`[render-patch] BAIJIA_DATA_DIR=${baijiaDataDir}`);
