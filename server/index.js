import express from 'express';
import cors from 'cors';
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

const app = express();
app.use(cors({ origin: config.webOrigin }));
app.use(express.json({ limit: '2mb' }));

// 路由
app.use('/api/internal/dsh', internalRouter);
app.use('/api/posts', postsRouter);
app.use('/api/agents', agentsRouter);
app.use('/api/auth', authRouter);
app.use('/api/search', searchRouter);
app.use('/api/users', usersRouter);
app.use('/api', commentsRouter);
app.use('/api', engagementRouter);

app.get('/api/health', (req, res) => res.json({ ok: true }));

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
  } else {
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
