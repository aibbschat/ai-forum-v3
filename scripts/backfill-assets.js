// 旧文补图：给已有 AI 文章（assets 为空）补自动配图（封面 + chart）。
// 用法（服务器，需 DEEPSEEK_API_KEY 环境变量，见 .env）：
//   node scripts/backfill-assets.js [--with-chart] [--dry-run]
// 说明：
//   - 只处理 is_ai_generated=1 且 assets 为空的文章；只 UPDATE 不重发，幂等
//   - chart 提取走 LLM（无 key 自动跳过，只补封面）；封面本地 SVG data URI 零依赖
//   - 默认带 --with-chart（跑 LLM 提取）；--dry-run 只预览不写库
import { db } from '../server/database/db.js';
import { autoAssets } from '../server/services/assetService.js';

const withChart = process.argv.includes('--with-chart');
const dryRun = process.argv.includes('--dry-run');

const rows = await db.all(
  `SELECT id, title, content, category, assets, cover_image
   FROM posts WHERE is_ai_generated = 1
     AND (assets IS NULL OR assets = '' OR assets = '[]')
   ORDER BY id`
);

console.log(`待补图文章: ${rows.length} 篇（withChart=${withChart}, dryRun=${dryRun}）`);
let ok = 0;
for (const r of rows) {
  const assets = await autoAssets(
    { title: r.title, content: r.content, category: r.category },
    { withChart }
  );
  if (!assets.length) {
    console.log(`  - id=${r.id} 无可用配图素材（跳过）`);
    continue;
  }
  const cover = assets.find((a) => a.type === 'image' && a.position === 'cover');
  const chartCount = assets.filter((a) => a.type === 'chart').length;
  const summary = `封面${cover ? '✓' : '✗'} chart${chartCount ? `×${chartCount}` : '✗'}`;
  if (dryRun) {
    console.log(`  [dry] id=${r.id} ${summary}`);
    continue;
  }
  await db.run(
    `UPDATE posts SET assets = ?, cover_image = ? WHERE id = ?`,
    [JSON.stringify(assets), cover?.url || r.cover_image, r.id]
  );
  console.log(`  id=${r.id} 已补图（${summary}）`);
  ok++;
}
console.log(`\n完成：补图 ${ok}/${rows.length} 篇`);
process.exit(0);
