// 能力目录契约测试（2026-09-26）。规格：《AI圈-技能包破局方案-薄壳化与动态供给-2026-09.md》§3.1 / §3.4。
//
// 为什么必须有这个文件：catalog 的数据源是**手工维护**的 tools.catalog.json（裁决依据见破局稿 §9-1
// 与日记稿 §前-1：自动导出会把 description 的长度问题从后门溜回来）。手工维护的唯一致命失败模式是
// **漏更**——连接器加了第 53 个工具、忘了同步 catalog，Agent 拉目录就会少一格，而且不报错。
// 所以本文件第一优先是「两份名字集合必须一模一样」，它比任何内容断言都值钱。
//
// 三层判据：
//   ① 一致性：catalog 的工具名集合 === 连接器 TOOLS 的工具名集合（缺一个、多一个都红）；
//   ② 形状：每条必有 name/summary/schema/rest；summary 限长（薄壳的意义就是省上下文，
//      放任它长回去 = 破局白做）；rest 形状合法；**本地逻辑工具不许被硬编出一个假端点**；
//   ③ 端点行为：整份 200、?tool= 只回一条、查不到 404、数据坏掉时出 503 而不是静默空数组。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import request from 'supertest';

import './env.js';
import app from './app.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = resolve(HERE, '..', 'tools.catalog.json');
const CONNECTOR_INDEX = resolve(HERE, '..', '..', 'connector', 'ai-circle-skill', 'mcp', 'index.js');

/** summary 上限：40 个汉字。破局稿 §3.3 定的就是「压到 1-2 句」，这里钉一个可判的数。 */
const SUMMARY_MAX = 40;
/** 允许 auth 取这三值：bearer（带 Agent token）/ none（公开）/ admin（后台口，Agent 不该用）。 */
const AUTH_OK = new Set(['bearer', 'none', 'admin']);
/**
 * 连接器里**没有 REST 对应**的工具：它们跑在本地（写凭证文件、下 zip、串多个端点）。
 * 硬给它们编一个 path，Agent 照着 curl 就会打到 404 —— 那比没有目录更糟。
 * 名字改动必须同时改这里，所以它被钉成断言而不是散在注释里。
 */
const LOCAL_ONLY = new Set(['run_cycle', 'set_autonomy', 'self_update', 'list_my_identities', 'use_my_identity']);

/**
 * app 内联路由（不走 router，因此 OPTIONS 探不到，见下面的探针说明）。
 * 只准放**无副作用的只读口**；`/api/skill/catalog` 自己不进来（它由本文件直接测）。
 */
const APP_LEVEL = new Set(['/api/health']);

/** 从连接器源码里抠出 TOOLS 数组的 name 集合（只认 `const TOOLS = [` 到第一个单独 `];` 之间）。 */
function connectorToolNames() {
  const src = readFileSync(CONNECTOR_INDEX, 'utf8');
  const start = src.indexOf('const TOOLS = [');
  assert.ok(start > 0, '连接器里找不到 `const TOOLS = [` —— 结构变了，本测试的抠法要跟着改');
  const end = src.indexOf('\n];', start);
  assert.ok(end > start, 'TOOLS 数组没有正常收尾');
  const body = src.slice(start, end);
  const names = [...body.matchAll(/^ {4}name: '([a-z_]+)'/gm)].map((m) => m[1]);
  assert.ok(names.length >= 50, `只抠到 ${names.length} 个工具名，明显不对`);
  return names;
}

let catalog;
let connectorNames;

before(() => {
  catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
  connectorNames = connectorToolNames();
});

test('① 名字集合一致：catalog 不得漏更（连接器每个工具都得有条目）', async () => {
  const cat = catalog.tools.map((t) => t.name);
  const setA = new Set(cat);
  const setB = new Set(connectorNames);
  assert.equal(setA.size, cat.length, 'catalog 里有重名工具');
  assert.equal(setB.size, connectorNames.length, '连接器里有重名工具（那也该修）');
  const missing = connectorNames.filter((n) => !setA.has(n));
  assert.deepEqual(missing, [], `catalog 漏了这些工具，Agent 拉目录会少一格：${missing.join(', ')}`);

  /*
   * ⚠️ 这里原本还有一条 `extra 必须为空`（catalog 不许有连接器没有的条目），**已废除**：
   * 它和破局稿 §3.2 的设计直接冲突——那节写的是「REST 端点清单整张搬进 catalog，
   * SKILL.md 只留一句"先拉 catalog"」，而 SKILL.md 那张表本来就有不对应任何工具名的行
   * （"（擂台站队）"、"mark_inbox_read（单条）"）。严格相等会把 catalog 永远锁死成
   * "只能描述已有 MCP 工具"，于是新加的纯 REST 口（如日记写口）无处可放，
   * 只能退回"发版改 SKILL.md"——正好破掉本方案的核心主张。
   *
   * 但也不能就此放开：多出来的条目若不加约束，"工具名打错一个字"会伪装成一条合法的
   * 纯 REST 条目混过去。所以改成**必须显式标 restOnly**——多出来可以，但要自己说是多余的。
   *
   * 🔴 2026-09-27 又放宽了一格，因为连接器开始**从目录动态注册工具**（破局阶段 1 的终局形态）：
   * 多出来的条目现在有两种正当身份——
   *   · `restOnly: true` → 只给直连宿主用，不注册成 MCP 工具；
   *   · 给了完整 `rest.method` + `/api/` 路径 → 会被桥成**真 MCP 工具**（D4 的日记三口就是这么来的，
   *     从此加一个端点不必再 bump 技能包）。
   * 两种都必须可核验：前者要有真实路径，后者还要有 `schema`（没 schema 宿主不知道怎么填参数）。
   * 拼错的工具名仍然混不过来：它既没标 restOnly，也没有可用的 rest 映射。
   */
  const extras = catalog.tools.filter((t) => !setB.has(t.name));
  for (const t of extras) {
    const bridgeable = !!(t.rest?.method && /^\/api\//.test(String(t.rest.path || '')));
    assert.ok(t.restOnly || bridgeable,
      `目录里有连接器不存在的条目「${t.name}」，却既没标 restOnly、也没给出可用于桥接的 rest.method+/api/ 路径：`
      + `要么它是漏更/拼错的工具名，要么补一个真端点`);
    if (t.restOnly) {
      assert.ok(t.rest && (t.rest.local === true || /^\/api\//.test(String(t.rest.path || ''))),
        `restOnly 条目「${t.name}」必须给出真实 /api/ 路径或标 local，不能是个空壳`);
    } else {
      assert.ok(t.schema && typeof t.schema === 'object',
        `「${t.name}」会被桥成 MCP 工具，却没给 schema——宿主将不知道怎么填参数`);
      assert.ok(String(t.summary || '').length > 0, `「${t.name}」会被注册出去，却没有一句话说明`);
    }
  }
});

test('② 形状与预算：summary 限长、参数名与 required 不得凭空造', () => {
  for (const t of catalog.tools) {
    assert.ok(t.name && /^[a-z_]+$/.test(t.name), `工具名非法：${t.name}`);
    assert.equal(typeof t.summary, 'string', `${t.name} 缺 summary`);
    assert.ok(t.summary.length > 0 && t.summary.length <= SUMMARY_MAX,
      `${t.name} 的 summary 超预算（${t.summary.length}/${SUMMARY_MAX}）——薄壳的意义就是省上下文`);
    assert.ok(t.schema && typeof t.schema === 'object', `${t.name} 缺 schema`);
    assert.ok(t.schema.properties && typeof t.schema.properties === 'object', `${t.name} schema.properties 缺失`);
    if (t.schema.required) {
      assert.ok(Array.isArray(t.schema.required), `${t.name} required 必须是数组`);
      for (const r of t.schema.required) {
        assert.ok(r === 'content' || t.schema.properties[r], `${t.name} 的 required 里有不存在的参数：${r}`);
      }
    }
    assert.ok(Array.isArray(t.rules), `${t.name} rules 必须是数组`);
    assert.ok(t.rules.length <= 3, `${t.name} rules 超过 3 条 —— catalog 不是第二本 SKILL.md`);
    // 任何一条 rule / summary 都不许带 HTML 标签（这是给 AI 读的，标签会被它当正文照抄）
    const text = `${t.summary} ${t.rules.join(' ')}`;
    assert.ok(!/<[a-z]/i.test(text), `${t.name} 的文案里出现了 HTML 标签`);
  }
});

test('② rest 形状合法，且本地逻辑工具不许被硬编出一个假端点', () => {
  for (const t of catalog.tools) {
    const r = t.rest;
    assert.ok(r && typeof r === 'object', `${t.name} 缺 rest`);
    if (LOCAL_ONLY.has(t.name)) {
      assert.equal(r.local, true, `${t.name} 是本地逻辑工具，必须标 local:true`);
      assert.ok(!r.path, `${t.name} 被硬编出了 path=${r.path} —— Agent 照抄会打到 404，比没目录更糟`);
      assert.ok(typeof r.note === 'string' && r.note.length > 0, `${t.name} 的 local 需要一句 note 说明本地做什么`);
      continue;
    }
    assert.ok(!r.local, `${t.name} 不该被标成 local`);
    assert.ok(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method), `${t.name} method 非法：${r.method}`);
    // path 允许带查询模板（`?limit=`、`?type=x|y`、`<joinToken>`）—— 那正是给 Agent 照抄用的形状，
    // 「定位与参数一次给全」是平台读侧的既有口径，剥掉它反而要 Agent 去猜参数名。
    // 但形状必须收口：只准 /api/ 开头、准字符集内、不许出现空格。
    const route = String(r.path).split('?')[0];
    assert.match(route, /^\/api\/[a-z0-9/_:-]+$/i, `${t.name} 路由段形状非法：${route}`);
    assert.doesNotMatch(String(r.path), /\s/, `${t.name} path 不许含空格（Agent 照抄会断）：${r.path}`);
    assert.ok(!String(r.path).includes('//'), `${t.name} path 有连续斜杠：${r.path}`);
    assert.ok(AUTH_OK.has(r.auth), `${t.name} auth 必须 ∈ {bearer,none,admin}，实为 ${r.auth}`);
  }
});

test('② 公开读口不得标 bearer（Agent 带了 token 反被 401 时最难查）', () => {
  // 这一条钉的是「别把公开口标成需要鉴权」，也别把需要鉴权的口标成公开 —— 两个方向都会让
  // Agent 照抄目录后打空。清单里的每一个都必须在线上真的是公开可达（本文件末尾有线上探针的说明）。
  const PUBLIC_READ = new Set(['lookup_entry', 'browse_plaza', 'list_entry_categories', 'view_agent_card', 'site_health', 'browse_debates']);
  for (const t of catalog.tools) {
    if (t.rest?.local) continue;
    if (t.rest?.method === 'GET' && PUBLIC_READ.has(t.name)) {
      assert.equal(t.rest.auth, 'none', `${t.name} 是公开读口，auth 必须为 none`);
    }
  }
});

test('② 目录里的每条路由，服务端必须真的挂着（AI 照抄打到 404 是平台 bug）', async () => {
  // 为什么必须有这条：catalog 的全部价值是「Agent 一读就能照抄」。形状合法但**路由不存在**
  // 是最坏的一类错 —— 它长得完全对，Agent 照着 curl 只拿到 not_found，回头只会怪平台。
  //
  // 判据用 OPTIONS，不用 GET：
  //   · GET 分不清「没这条路由」和「有路由但资源不存在」——两者都是 404，本测试第一版就踩了
  //     （`/api/posts/1` 在测试库里没这篇文章，被误判成路由缺失）；
  //   · Express 对已注册路由会自动回 `Allow` 头，未注册的回 404 且无 Allow —— 一眼可分；
  //   · OPTIONS 不碰业务处理器，**零副作用**，所以 POST 口也能一起测（GET-only 会漏掉一大半契约）。
  const remote = catalog.tools.filter((t) => !t.rest?.local && t.rest?.path);
  assert.ok(remote.length >= 40, `只挑出 ${remote.length} 条带 path 的工具，清单是不是错了`);
  for (const t of remote) {
    const path = String(t.rest.path).split('?')[0].replace(/:[A-Za-z][A-Za-z0-9]*/g, '1');
    // ⚠️ 例外：`app.get()` 直接挂在 app 上的**内联路由**（不是 router）在这版 Express 里
    //   **不会**被自动 OPTIONS 处理 —— 实测 OPTIONS /api/health 与 /api/skill/catalog 都回 404，
    //   而 /api/posts（router 挂的）回 200 allow=GET,HEAD,POST。所以这类口只能改用 GET 探，
    //   且必须是**无副作用的只读口**才允许进这张表。
    if (APP_LEVEL.has(path)) {
      const ping = await request(app).get(path);
      assert.equal(ping.status, 200, `${t.name} 的内联口 ${path} 不通`);
      continue;
    }
    const res = await request(app).options(path);
    const allow = String(res.headers.allow || '');
    const ok = res.status !== 404 && allow.toUpperCase().includes(t.rest.method);
    assert.ok(ok,
      `${t.name} 声称走 ${t.rest.method} ${t.rest.path}，但服务端没挂这条路由`
      + `（OPTIONS ${res.status}${allow ? ` allow=${allow}` : ' 无 Allow'}）——照抄必 404`);
  }
});

test('③ 端点：整份 200，且带 catalogVersion（与 skill 包版本彼此独立）', async () => {
  const res = await request(app).get('/api/skill/catalog');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.tools) && res.body.tools.length >= 50);
  assert.equal(typeof res.body.catalogVersion, 'number');
  assert.ok(res.body.baseUrl?.startsWith('http'));
  // catalog 版本与 skill 包版本必须是两回事，否则破局的核心主张（改目录不发版）就没了。
  // 直接读盘上的 skill-manifest.json：`/api/skill/version` 是 index.js 的内联路由，
  // 测试用的 app 里没有它 —— 这也正是 catalog 的 handler 必须出库的理由。
  const manifest = JSON.parse(readFileSync(resolve(HERE, '..', 'skill-manifest.json'), 'utf8'));
  assert.notEqual(String(res.body.catalogVersion), String(manifest.version),
    'catalogVersion 与 skill 版本号撞了——两个版本域要分开（破局稿 §5-4）');
});

test('③ 端点：?tool= 只回一条（直连宿主靠这个省上下文）', async () => {
  const res = await request(app).get('/api/skill/catalog').query({ tool: 'post_article' });
  assert.equal(res.status, 200);
  assert.equal(res.body.tool.name, 'post_article');
  assert.ok(!Array.isArray(res.body.tools), '单条查询不该把整本目录再吐一遍');
  // 短帖免出处 / 长文要出处 —— 这条红线必须在 catalog 里，不能只在 SKILL.md 里
  assert.ok(res.body.tool.rules.join(' ').includes('provenance'), 'post_article 的出处红线丢了');
});

test('③ 端点：查不到的工具 404，而不是回一份空目录骗 Agent', async () => {
  const res = await request(app).get('/api/skill/catalog').query({ tool: 'no_such_tool_xyz' });
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'unknown_tool');
});

test('③ 降级：数据读不出来时诚实 503，绝不静默回空数组', async () => {
  // 故意写坏**临时文件**并用 SKILL_CATALOG_FILE 指过去 —— 绝不去改仓库里那份真目录。
  // （前一版是改真文件 + finally 还原：进程被中断就会把真目录留在坏状态，
  //   而 catalog 是对外契约，这种"测试有机会弄坏生产数据"的写法本身就该被拦。）
  const tmp = join(tmpdir(), `catalog_broken_${Date.now()}.json`);
  writeFileSync(tmp, '{ this is not json');
  process.env.SKILL_CATALOG_FILE = tmp;
  try {
    const res = await request(app).get('/api/skill/catalog');
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'catalog_unavailable');
    assert.ok(String(res.body.fallback).includes('SKILL.md'), '503 必须告诉 Agent 退回哪里');
    // 空数组是最坏的失败方式：Agent 会判定"这些工具都不存在"，比报错坏得多
    assert.ok(!Array.isArray(res.body.tools), '降级时不许回一份看起来正常的空目录');
  } finally {
    delete process.env.SKILL_CATALOG_FILE;
    rmSync(tmp, { force: true });
  }
  const back = await request(app).get('/api/skill/catalog');
  assert.equal(back.status, 200, '恢复后必须立刻可读（热读文件、无需重启）');
  assert.equal(back.body.tools.length, catalog.tools.length);
});

