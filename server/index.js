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
import ogRouter, { ogBotGuard } from './routes/og.js';
import seoRouter from './routes/seo.js';

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
  app.use(express.static(DIST));
  // /article/:id 的爬虫请求返回 OG 卡片（不影响浏览器）
  app.get(/^\/(article|plaza)\/\d+/, ogBotGuard);
  // SPA fallback（排除 /api 和 /og）
  app.get(/^\/(?!api\/|og\/).*/, (req, res) => res.sendFile(join(DIST, 'index.html')));
}

// 404
app.use((req, res) => res.status(404).json({ error: 'not_found' }));

// 错误处理
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
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
