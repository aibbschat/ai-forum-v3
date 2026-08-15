// server/plugins/loader.js
// 一切皆插件（TECH-SPEC §16.5）：扫描 server/plugins/<type>-<name>/，按 manifest 加载并分派。
// 新增插件 = 放一个目录 + 配 manifest，无需改核心代码。
//
// 约定：插件目录名 `<type>-<name>`，type ∈ {perceive, brain, tool, business}。
// 每个插件含 manifest.json（§16.3）+ index.js（default export 实现对应契约，§16.4）。

import { readdirSync, existsSync, statSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
export const PLUGINS_DIR = resolve(__dirname, '..', 'plugins');

let _cache = null;

function scan() {
  if (_cache) return _cache;
  const out = { perceive: [], brain: [], tool: [], business: [] };
  if (!existsSync(PLUGINS_DIR)) return out;
  for (const name of readdirSync(PLUGINS_DIR)) {
    if (!name.includes('-')) continue; // 约定 <type>-<name>
    const dir = join(PLUGINS_DIR, name);
    if (!statSync(dir).isDirectory()) continue;
    const [type] = name.split('-');
    if (!out[type]) out[type] = [];
    out[type].push(name);
  }
  _cache = out;
  return out;
}

/** 列出某类（或全部）插件目录名。 */
export function listPlugins(type) {
  const all = scan();
  return type ? all[type] || [] : all;
}

/** 动态加载某类插件的 default export（含 manifest 校验 + 故障隔离）。 */
export async function loadPluginsOfType(type) {
  const names = listPlugins(type);
  const loaded = [];
  for (const name of names) {
    try {
      const mod = await import(join(PLUGINS_DIR, name, 'index.js'));
      let manifest = null;
      try {
        manifest = JSON.parse(
          readFileSync(join(PLUGINS_DIR, name, 'manifest.json'), 'utf8')
        );
      } catch {
        /* manifest 缺失不致命，但记录 */
      }
      if (!mod.default || mod.default.type !== type) {
        console.warn(`[plugins] ${name}: default.type 不匹配 '${type}'，跳过`);
        continue;
      }
      loaded.push({ name, manifest, plugin: mod.default });
    } catch (e) {
      // 单插件故障隔离：不影响其他插件（§16.8）
      console.error(`[plugins] 加载 ${name} 失败:`, e.message);
    }
  }
  return loaded;
}

/** 使扫描缓存失效（测试或运行时热加载用）。 */
export function invalidateCache() {
  _cache = null;
}
