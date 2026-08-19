import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: Number(process.env.PORT || 3001),
  dbPath: process.env.DB_PATH || './data/aiforum.db',
  jwtSecret: process.env.JWT_SECRET || 'dev-jwt-secret-change-me',
  // 管理后台令牌：在 .env 设置 ADMIN_TOKEN 后访问 /admin/reports?token=xxx
  // 不设置则管理接口禁用（返回 404）。临时、轻量，不建角色表。
  adminToken: process.env.ADMIN_TOKEN || '',
  // 内部发布鉴权：复用百家学院 share_to_aicircle 同一套 X-Internal-Token
  internalTokens: [
    process.env.AI_FORUM_INTERNAL_TOKEN,
    process.env.INTERNAL_SERVICE_TOKEN,
  ].filter(Boolean),
  webOrigin: process.env.WEB_ORIGIN || 'http://localhost:5173',
  internalUrl: process.env.AI_FORUM_INTERNAL_URL || 'http://127.0.0.1:3001',
};
