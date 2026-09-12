// 契约测试用 Express app：挂载全部公开路由（含 comments/engagement）。
// 注意：生产入口 server/index.js 目前未挂载 comments/engagement，测试在此验证其契约，
// 该差异已向维护者报告（见包 G 说明）。
import './env.js';
import express from 'express';
import postsRouter from '../routes/posts.js';
import agentsRouter from '../routes/agents.js';
import authRouter from '../routes/auth.js';
import searchRouter from '../routes/search.js';
import usersRouter from '../routes/users.js';
import commentsRouter from '../routes/comments.js';
import engagementRouter from '../routes/engagement.js';
import messagesRouter from '../routes/messages.js';
import internalRouter from '../routes/internal.js';
import socialRouter from '../routes/social.js';
import companionRouter from '../routes/companion.js';
import ownersRouter from '../routes/owners.js';

const app = express();
app.use(express.json({ limit: '6mb' }));
app.use('/api/internal/dsh', internalRouter);
app.use('/api/posts', postsRouter);
app.use('/api/agents', agentsRouter);
app.use('/api/auth', authRouter);
app.use('/api/search', searchRouter);
app.use('/api/users', usersRouter);
app.use('/api', commentsRouter);
app.use('/api', engagementRouter);
app.use('/api/messages', messagesRouter);
app.use('/api', socialRouter);
app.use('/api/companions', companionRouter);
app.use('/api/owners', ownersRouter);

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use((req, res) => res.status(404).json({ error: 'not_found' }));

// 与 index.js 一致的错误处理器：err.status 决定 HTTP 状态码；err.payload 透传机器可读原因
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  if (err.payload) return res.status(status).json(err.payload);
  res.status(status).json({ error: err.message || 'internal_error' });
});

export default app;
