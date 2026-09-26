// 契约测试用 Express app：挂载全部公开路由（含 comments/engagement）。
// 注意：生产入口 server/index.js 目前未挂载 comments/engagement，测试在此验证其契约，
// 该差异已向维护者报告（见包 G 说明）。
import './env.js';
import express from 'express';
import postsRouter from '../routes/posts.js';
import agentsRouter from '../routes/agents.js';
import joinRouter from '../routes/join.js';
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
// 广场路由（2026-09-15 补）：N2b 访客簿/编年史的**接线**就在这两条路上
// （评论路由要透传 mentionedIds、鼓掌路由要透传 clapperId）—— 不挂上来就测不到真接线。
import plazaRouter from '../routes/plaza.js';
import rolesRouter from '../routes/roles.js';
import trackRouter from '../routes/track.js';
import entriesRouter from '../routes/entries.js';
import { skillCatalogHandler } from '../lib/skillCatalog.js';

const app = express();
app.use(express.json({ limit: '6mb' }));
app.use('/api/internal/dsh', internalRouter);
app.use('/api/posts', postsRouter);
app.use('/api/agents', agentsRouter);
app.use('/api/join', joinRouter);
app.use('/api/auth', authRouter);
app.use('/api/search', searchRouter);
app.use('/api/users', usersRouter);
app.use('/api', commentsRouter);
app.use('/api', engagementRouter);
app.use('/api/messages', messagesRouter);
app.use('/api', socialRouter);
app.use('/api/companions', companionRouter);
app.use('/api/owners', ownersRouter);
app.use('/api/plaza', plazaRouter); // 与 index.js 的挂载前缀一致
app.use('/api/roles', rolesRouter); // M3 角色社会（与 index.js 一致）
app.use('/api', trackRouter); // 站点流量 beacon（与 index.js 的挂载前缀一致）
// 共创知识库（2026-09-26 补）：index.js 一直挂着它（`app.use('/api/entries', ...)`），
// 但本文件漏挂 —— skillCatalog.test 拿「目录里每条路由服务端必须真有」这条断言时暴露出来的。
// 这正是那类"两份 app 手工对齐"的漂移：测试看不到、线上却有，反过来也一样危险。
app.use('/api/entries', entriesRouter);

app.get('/api/health', (req, res) => res.json({ ok: true }));
// 能力目录（2026-09-26 补）：handler 与 index.js 用**同一个引用**，所以测试测到的就是线上那份。
// 为什么要在这里显式挂一行：本文件是手工拼的 app，index.js 的内联路由不会自动进来 ——
// 这就是 skillCatalog 的 handler 必须出库的理由（详见 ../lib/skillCatalog.js 头注）。
app.get('/api/skill/catalog', skillCatalogHandler);

app.use((req, res) => res.status(404).json({ error: 'not_found' }));

// 与 index.js 一致的错误处理器：err.status 决定 HTTP 状态码；err.payload 透传机器可读原因
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  if (err.payload) return res.status(status).json(err.payload);
  res.status(status).json({ error: err.message || 'internal_error' });
});

export default app;
