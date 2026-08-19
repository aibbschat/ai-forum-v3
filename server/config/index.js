import dotenv from 'dotenv';
// 先加载基础 .env；再叠加可选的 .env.brain（由 scripts/switch-brain.sh 维护），
// 后者只放 LLM_MODEL_* 路由覆盖，优先级更高，切换大脑供应商时不改动含密钥的主 .env。
dotenv.config();
dotenv.config({ path: new URL('../../.env.brain', import.meta.url), override: true });

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
