// server/lib/skillCatalog.js
// 能力目录 handler —— 技能包破局方案「阶段 1」里**只增不改**的那一半。
//   规格：《AI圈-技能包破局方案-薄壳化与动态供给-2026-09.md》§3.1；
//   与日记这条线的先后关系：《AI圈-Agent日记与主人房间设计-2026-09.md》§前-1。
//
// 为什么单独成 lib 而不像旁边的 /api/skill/version 那样内联在 index.js：
//   `tests/app.js` 是**手工拼**的测试用 app，只挂 router、不复制 index.js 的内联路由。
//   内联在这里写的口，测试就永远测不到（本文件初版正是踩了这个坑）。所以 handler 出库，
//   index.js 与 tests/app.js 挂**同一个引用** —— 两份 app 的漂移就此可被测试抓住。
//
// 三条设计取舍（都写在测试里钉住，别靠注释自觉）：
//   ① 数据每次热读文件，不打进代码、不加常驻缓存：catalog 的全部价值就是
//      **改数据即生效、不重启不发版**。热读同时保住了这条。
//   ② `?tool=<name>` 只回一条：直连宿主的 Agent 为了查一个参数不该把 52 条全吞进上下文。
//   ③ 数据坏掉时**诚实 503**，绝不静默回空数组：空数组会让 Agent 判定「这些工具都不存在」，
//      那比一次报错坏得多；503 才会让它退回 SKILL.md 的兜底端点表。
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CATALOG_FILE = resolve(HERE, '..', 'tools.catalog.json');

/** 当前生效的目录文件。留一个 env 覆盖口有两个用处：
 *  ① 测试可以造一份坏数据/候选数据来验降级，**不必去改仓库里那份真文件**；
 *  ② 运维可以先 `SKILL_CATALOG_FILE=... jsonlint` 一份新目录，确认无误再替换。
 *  读文件仍每次一次（见文件头"热读"那条），所以覆盖是即时生效的。 */
const activeCatalogFile = () => process.env.SKILL_CATALOG_FILE || CATALOG_FILE;

/** 只回这些键 —— 防止将来有人在 JSON 里塞运维字段（如内部路径、密钥）被原样公开。 */
const TOP_KEYS = ['catalogVersion', 'generatedAt', 'baseUrl', 'auth', 'tools'];
const pick = (o) => Object.fromEntries(TOP_KEYS.filter((k) => k in o).map((k) => [k, o[k]]));

export function skillCatalogHandler(req, res) {
  let catalog;
  const file = activeCatalogFile();
  try {
    catalog = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn('[skill/catalog] 数据不可读，返回 503：', e?.message || e);
    return res.status(503).json({
      error: 'catalog_unavailable',
      fallback: '按 SKILL.md 的「端点清单」一节直连，稍后重试本接口',
    });
  }
  const want = String(req.query?.tool || '').trim();
  if (!want) return res.json(pick(catalog));
  const one = (catalog.tools || []).find((t) => t.name === want);
  if (!one) {
    return res.status(404).json({ error: 'unknown_tool', tool: want, catalogVersion: catalog.catalogVersion });
  }
  return res.json({
    catalogVersion: catalog.catalogVersion,
    generatedAt: catalog.generatedAt,
    baseUrl: catalog.baseUrl,
    auth: catalog.auth,
    tool: one,
  });
}

export default skillCatalogHandler;
