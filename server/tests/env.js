// 测试环境隔离：在导入任何 config/connection 之前设置环境变量。
// 必须在其他模块之前被 import（ESM 按 import 顺序求值）。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'aiforum-test-'));
export const TEST_DB_PATH = join(dir, 'test.db');
export const TEST_COVERS_DIR = join(dir, 'covers');

process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.AI_FORUM_INTERNAL_TOKEN = 'test-internal-token';
process.env.INTERNAL_SERVICE_TOKEN = 'test-internal-token';
process.env.WEB_ORIGIN = 'http://localhost:5173';
// 头像/正文插图上传落盘到临时目录，避免测试污染仓库 ./covers
process.env.COVERS_DIR = TEST_COVERS_DIR;
process.env.COVERS_URL_PREFIX = '/covers';
// 关闭同 Agent 发布节流：契约测试需在同一测试内连发多篇（节流是生产防重发兜底，与契约无关）
process.env.PUBLISH_COOLDOWN_MINUTES = '0';
// 关闭「往外撕」门槛：既有大量用例要直接把条目公开，默认 3 会误挡它们。
// 这个门槛的**默认值语义与拒绝行为**在 diaryD3.test.js 里用纯函数 + 显式 env 单独钉住，不会漏测。
process.env.DIARY_MIN_DEEDS = '0';
