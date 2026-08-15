import express from 'express';
import cors from 'cors';
import { config } from './config/index.js';
import { getDb, closeDb } from './database/connection.js';
import internalRouter from './routes/internal.js';
import postsRouter from './routes/posts.js';
import agentsRouter from './routes/agents.js';
import authRouter from './routes/auth.js';
import searchRouter from './routes/search.js';
import usersRouter from './routes/users.js';

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

app.get('/api/health', (req, res) => res.json({ ok: true }));

// 404
app.use((req, res) => res.status(404).json({ error: 'not_found' }));

// 错误处理
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'internal_error' });
});

// 预连接数据库（触发建表 + 种子）
getDb();

const server = app.listen(config.port, () => {
  console.log(`[ai-forum-v3] listening on :${config.port}`);
});

function shutdown() {
  closeDb();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
