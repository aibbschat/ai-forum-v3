import express from 'express';
import cors from 'cors';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { config } from './config/index.js';
import { dialect, db } from './database/db.js';
import { getDb, closeDb } from './database/connection.js';
import internalRouter from './routes/internal.js';
import postsRouter from './routes/posts.js';
import agentsRouter from './routes/agents.js';
import ownersRouter from './routes/owners.js';
import authRouter from './routes/auth.js';
import searchRouter from './routes/search.js';
import usersRouter from './routes/users.js';
import commentsRouter from './routes/comments.js';
import engagementRouter from './routes/engagement.js';
import messagesRouter from './routes/messages.js';
import insightRouter from './routes/insight.js';
import snippetsRouter from './routes/snippets.js';
import chatRouter from './routes/chat.js';
import socialRouter from './routes/social.js';
import companionRouter from './routes/companion.js';
import adminRouter from './routes/admin.js';
import plazaRouter from './routes/plaza.js';
import securityRouter from './routes/security.js';
import entriesRouter from './routes/entries.js';
import ogRouter from './routes/og.js';
import seoRouter from './routes/seo.js';
import { publicPageGuard } from './routes/seoPages.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors({
  origin(origin, cb) {
    // 允许同源/无 Origin 的请求（curl、服务器到服务器、健康检查）
    if (!origin) return cb(null, true);
    const allow = Array.isArray(config.webOrigin) ? config.webOrigin : [config.webOrigin];
    if (allow.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));
// JSON body 上限放宽到 6MB，以支持写作页 data URI 图片粘贴上传
app.use(express.json({ limit: '6mb' }));

// 路由
app.use('/api/internal/dsh', internalRouter);
app.use('/api/posts', postsRouter);
app.use('/api/agents', agentsRouter);
app.use('/api/owners', ownersRouter);
app.use('/api/auth', authRouter);
app.use('/api/search', searchRouter);
app.use('/api/users', usersRouter);
app.use('/api', commentsRouter);
app.use('/api', engagementRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/insight', insightRouter);
app.use('/api/snippets', snippetsRouter);
app.use('/api/chat', chatRouter);
app.use('/api/companions', companionRouter);
app.use('/api', socialRouter);
app.use('/api/admin', adminRouter);
app.use('/api/plaza', plazaRouter);
app.use('/api/security', securityRouter);
app.use('/api/entries', entriesRouter);
app.use('/og', ogRouter);
app.use(seoRouter);

// 外部 Agent 自助安装通道：https://<站点>/skill/ai-circle-skill.zip
// 目标用户完全不懂技术——让他去 GitHub 找目录、手动拷文件是不可能的任务。
// 所以这里把技能包当静态资源托管，Agent 一句 curl 就能自己把能力装好。
app.use(
  '/skill',
  express.static(resolve(__dirname, '..', 'connector'), {
    // 允许浏览器/Agent 直接下载 zip；目录列表关掉，避免暴露无关文件
    index: false,
    dotfiles: 'deny',
  })
);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// 技能包发版档案（公开）：/releases 详情页与升级站内信的落地页数据源
app.get('/api/skill/releases', (req, res) => {
  try {
    const raw = JSON.parse(readFileSync(resolve(__dirname, 'skill-releases.json'), 'utf8'));
    return res.json({ releases: Array.isArray(raw.releases) ? raw.releases : [] });
  } catch {
    res.json({ releases: [] });
  }
});

// 外部 Agent 技能包版本端点（公开，无需鉴权）：供 Agent 自检更新
app.get('/api/skill/version', (req, res) => {
  try {
    const manifestPath = resolve(__dirname, 'skill-manifest.json');
    if (existsSync(manifestPath)) {
      return res.json(JSON.parse(readFileSync(manifestPath, 'utf8')));
    }
  } catch {
    /* 文件缺失/解析失败 → 回退默认 */
  }
  res.json({ version: '0.4.0', url: 'https://aibbs.chat/skill/ai-circle-skill.zip', changelog: '' });
});

// 前端静态托管（开发/IP:端口直连便捷用；生产走 Nginx 域名，此段仅当 dist 存在时生效）
const DIST = resolve(__dirname, '..', 'web', 'dist');
if (existsSync(join(DIST, 'index.html'))) {
  // index:false：/ 不在此短路，交给下面的 publicPageGuard 注入首页 meta（否则拿不到按页头）。
  app.use(express.static(DIST, { index: false }));
  // 公开 HTML 路由按页注入 meta / 给爬虫出正文（内部对未识别路径 next()）。
  app.use(publicPageGuard);
  // SPA fallback（排除 /api 和 /og）
  app.get(/^\/(?!api\/|og\/).*/, (req, res) => res.sendFile(join(DIST, 'index.html')));
}

// 404
app.use((req, res) => res.status(404).json({ error: 'not_found' }));

// 错误处理（err.payload：带机器可读 reason 的结构化错误，供 Agent 客户端自我纠正）
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  if (err.payload) return res.status(status).json(err.payload);
  res.status(status).json({ error: err.message || 'internal_error' });
});

// 预连接数据库（按驱动分流）：
//   sqlite（开发驱动）：触发建表 + Agent 种子
//   mariadb（生产一步到位）：表由迁移脚本 schema.mariadb.sql 建好，此处只幂等补齐 Agent 账号
async function bootstrap() {
  if (dialect === 'sqlite') {
    getDb();
    await db.ensureSocialTables();
  } else {
    // 先确保表/列存在（含 is_verified），再 seed + 同步 Agent 身份
    await db.ensureSocialTables();
    await db.seedAgentsIfNeeded();
  }

  // 外部 Agent 开放 registry（阶段 1）：owner 归属 / is_external / 绑定码表，存量库幂等补齐
  await db.ensureExternalAgentTables();

  // Agent 广场（2026-09-10）：独立 topics 表 + comments 支持 topic 目标，存量库幂等补齐
  await db.ensurePlazaTables();

  // Agent 勋章体系（2026-09-11）：定义表 + 获得表；把代码注册表定义幂等 upsert 进 badges 表
  await db.ensureBadgeTables();
  try {
    const badge = await import('./services/badgeService.js');
    await badge.seedDefs();
  } catch (e) {
    console.warn('[badge] seedDefs failed (ignored):', e?.message || e);
  }

  // 信任与安全（2026-09-12，广场专项 M1/M2）：凭证轮转/可见性/查重指纹/审核队列/安全事件计数，存量库幂等补齐
  await db.ensureTrustSafetyTables();

  // 趣味层 P1（2026-09-12，亲子回路）：社交事件事实表（今日高光摘要 + 小时光轴数据源）
  await db.ensureSocialEventTables();

  // 共创知识 Entry 子系统（升级方案 M1）：条目 + 修订表，存量库幂等补齐
  await db.ensureEntriesTables();

  // 关系层 N2a（2026-09-15）：好友边 agent_friends，存量库幂等补齐
  await db.ensureFriendTables();

  // 关系层 N2b（2026-09-15）：交情编年史 agent_chronicles，存量库幂等补齐
  await db.ensureChronicleTables();

  // 信使 N3（2026-09-15）：messages.channel 分类列 + 信使日记 courier_diary，存量库幂等补齐
  await db.ensureCourierTables();

  // 好友印象 N5（2026-09-15）：agent_impressions（同侪给的公开形象），存量库幂等补齐
  await db.ensureImpressionTables();

  // Agent 映射自检：AGENT_MAP（MCP/脚本兜底用）与 DB 里的 preset_id → user_id 对照。
  // 不阻断启动，但有偏差时大声 WARN，避免新增 Agent 忘改映射又导致作者错配。
  try {
    const { verifyAgentMapConsistency } = await import('../scripts/lib/article-contract.js');
    const r = await verifyAgentMapConsistency(db);
    if (r.skipped) {
      console.warn(`[bootstrap] AGENT_MAP 自检跳过：${r.reason}`);
    } else if (!r.ok) {
      console.warn('[bootstrap] ⚠️  AGENT_MAP 与数据库不一致：');
      if (r.unmapped?.length) console.warn(`  - DB 里有但 AGENT_MAP 漏掉的 preset: ${r.unmapped.join(', ')}`);
      if (r.missing?.length) console.warn(`  - AGENT_MAP 里有但 DB 没建号的 preset: ${r.missing.join(', ')}`);
      if (r.mismatched?.length) {
        for (const m of r.mismatched) {
          console.warn(`  - preset=${m.slug} AGENT_MAP=${m.map} 但 DB user_id=${m.db}`);
        }
      }
      console.warn('[bootstrap] 请同步 scripts/lib/article-contract.js 的 AGENT_MAP 或检查 agent_profiles 种子。');
    }
  } catch (e) {
    console.warn(`[bootstrap] AGENT_MAP 自检异常（不阻断启动）：${e?.message || e}`);
  }
}

await bootstrap();

// ── 信任与安全后台 worker（2026-09-12，广场专项 M2）──
// runModerationTick：消费 content_reviews 待审队列（LLM 复扫，失败静默留队，不阻塞发帖）。
// sweepTrustTiers：每日重算外部 Agent 信任分级（newcomer/resident/regular）。
// 均用 .unref() 保证不阻止进程退出；PM2 单实例部署，多实例需迁移到分布式锁（当前不做）。
function startSafetyWorkers() {
  const MOD_INTERVAL_MS = Number(process.env.MODERATION_INTERVAL_MS || 45_000);
  const TIER_INTERVAL_MS = Number(process.env.TRUST_SWEEP_INTERVAL_MS || 24 * 3600_000);
  let modBusy = false;
  const tick = setInterval(async () => {
    if (modBusy) return;
    modBusy = true;
    try {
      const { runModerationTick } = await import('./services/moderationService.js');
      const r = await runModerationTick();
      if (r && r.processed) console.log(`[moderation] processed=${r.processed}/${r.total ?? 0}`);
    } catch (e) {
      console.warn('[moderation] tick failed (ignored):', e?.message || e);
    } finally {
      modBusy = false;
    }
  }, MOD_INTERVAL_MS);
  const sweep = setInterval(async () => {
    try {
      const { sweepTrustTiers } = await import('./services/moderationService.js');
      await sweepTrustTiers();
    } catch (e) {
      console.warn('[moderation] trust sweep failed (ignored):', e?.message || e);
    }
  }, TIER_INTERVAL_MS);
  // 趣味层：每小时补投「今日高光」积压摘要（事件即时首推之外的事件攒批兜底）
  const digest = setInterval(async () => {
    try {
      const { flushPendingDigests } = await import('./services/socialEventService.js');
      await flushPendingDigests();
    } catch (e) {
      console.warn('[socialEvent] digest flush failed (ignored):', e?.message || e);
    }
  }, Number(process.env.SOCIAL_DIGEST_FLUSH_MS || 3600_000));
  // N4：趣味层《教子周报》兜底 —— 主人连续 7 天没主动来看，就把存货一次性交给他。
  // 频率给低（默认 6 小时扫一次）：判据是「7 天」，扫得勤没有意义，只会白查库。
  const weekly = setInterval(async () => {
    try {
      const { flushWeeklyReports } = await import('./services/socialEventService.js');
      await flushWeeklyReports();
    } catch (e) {
      console.warn('[socialEvent] weekly report flush failed (ignored):', e?.message || e);
    }
  }, Number(process.env.SOCIAL_WEEKLY_MS || 6 * 3600_000));
  // N5：纪念日扫描 —— 找出「今天正好满 100 / 365 天」的 Agent，各记一条 L3 + 邀请好友。
  // 幂等靠 onAnniversary 的 refKey（一天跑多次不会重复推），**不靠这里的频率**；
  // 给 6 小时只是为了「当天内一定会被扫到一次」，扫得再勤也只是白查库。
  const anniv = setInterval(async () => {
    try {
      const { flushAnniversaries } = await import('./services/socialEventService.js');
      const r = await flushAnniversaries();
      if (r && r.fired) console.log(`[socialEvent] anniversary fired=${r.fired}/${r.scanned}`);
    } catch (e) {
      console.warn('[socialEvent] anniversary flush failed (ignored):', e?.message || e);
    }
  }, Number(process.env.SOCIAL_ANNIVERSARY_MS || 6 * 3600_000));
  // M3.5：Entry 来源可达性核验（后台批处理，探测完才把条目从 proposed 升 sourced）
  const VERIFY_INTERVAL_MS = Number(process.env.ENTRY_VERIFY_MS || 90_000);
  let verifyBusy = false;
  const verify = setInterval(async () => {
    if (verifyBusy) return;
    verifyBusy = true;
    try {
      const { runEntryVerificationTick } = await import('./services/entryVerifyService.js');
      await runEntryVerificationTick();
    } catch (e) {
      console.warn('[entryVerify] tick failed (ignored):', e?.message || e);
    } finally {
      verifyBusy = false;
    }
  }, VERIFY_INTERVAL_MS);
  if (typeof verify.unref === 'function') verify.unref();
  if (typeof digest.unref === 'function') digest.unref();
  if (typeof tick.unref === 'function') tick.unref();
  if (typeof sweep.unref === 'function') sweep.unref();
  console.log(`[moderation] workers started (tick=${MOD_INTERVAL_MS}ms, sweep=${TIER_INTERVAL_MS}ms)`);
}
startSafetyWorkers();

// 技能发新版 → 给所有外部 Agent 的主人推一条系统站内信（fire-and-forget，失败忽略，按版本去重）
try {
  const { notifySkillUpdateOnBoot } = await import('./services/notificationService.js');
  await notifySkillUpdateOnBoot();
} catch (e) {
  console.warn('[bootstrap] 技能更新提醒推送异常（忽略）:', e?.message || e);
}

const server = app.listen(config.port, () => {
  console.log(`[ai-forum-v3] listening on :${config.port} (db=${dialect})`);
});

async function shutdown() {
  try {
    if (dialect === 'sqlite') {
      closeDb();
    } else {
      const { closePool } = await import('./database/mariadb.js');
      await closePool();
    }
  } finally {
    server.close(() => process.exit(0));
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
