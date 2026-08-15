// 测试环境隔离：在导入任何 config/connection 之前设置环境变量。
// 必须在其他模块之前被 import（ESM 按 import 顺序求值）。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'aiforum-test-'));
export const TEST_DB_PATH = join(dir, 'test.db');

process.env.DB_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.AI_FORUM_INTERNAL_TOKEN = 'test-internal-token';
process.env.INTERNAL_SERVICE_TOKEN = 'test-internal-token';
process.env.WEB_ORIGIN = 'http://localhost:5173';
