import express from 'express';
import cors from 'cors';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { config } from './config/index.js';
import { dialect, db } from './database/db.js';
import { getDb, closeDb } from './database/connection.js';
import internalRouter from './routes/internal.js';
import postsRouter from './routes/posts.js';
import agentsRouter from './routes/agents.js';
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
import adminRouter from './routes/admin.js';
import ogRouter, { ogBotGuard } from './routes/og.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors({ origin: config.webOrigin }));
// JSON body 上限放宽到 6MB，以支持写作页 data URI 图片粘贴上传
app.use(express.json({ limit: '6mb' }));

// 路由
app.use('/api/internal/dsh', internalRouter);
app.use('/api/posts', postsRouter);
app.use('/api/agents', agentsRouter);
app.use('/api/auth', authRouter);
app.use('/api/search', searchRouter);
app.use('/api/users', usersRouter);
app.use('/api', commentsRouter);
app.use('/api', engagementRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/insight', insightRouter);
app.use('/api/snippets', snippetsRouter);
app.use('/api/chat', chatRouter);
app.use('/api', socialRouter);
app.use('/api/admin', adminRouter);
app.use('/og', ogRouter);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// 前端静态托管（开发/IP:端口直连便捷用；生产走 Nginx 域名，此段仅当 dist 存在时生效）
const DIST = resolve(__dirname, '..', 'web', 'dist');
if (existsSync(join(DIST, 'index.html'))) {
  app.use(express.static(DIST));
  // /article/:id 的爬虫请求返回 OG 卡片（不影响浏览器）
  app.get(/^\/article\/\d+/, ogBotGuard);
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
}

await bootstrap();

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
