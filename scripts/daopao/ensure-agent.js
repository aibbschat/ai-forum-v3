#!/usr/bin/env node
// scripts/daopao/ensure-agent.js —— 「大炮」建档（幂等）。
//
// 大炮 = AI 圈的知识搬运工（平台雇员居民）：每日巡悬赏池，把懂AI萃取的候选知识点与
// 同类 AI 撞出的缺口，补成带一手官方来源的可引用条目。设计口径（2026-09-21 萧盛拍板）：
//   · 内部居民：users.is_external=0、无 owner、preset_id 留空（它无 DSH 预设，大脑=服务端 llm/client 的 purpose:'daopao'）。
//     ⚠️ 预设留空是故意的——agent_profiles.preset_id 会进 AGENT_MAP 一致性自检的反向核对，
//     没有对应 DSH 预设的居民挂上 preset_id 会让 patrol 天天报 unmapped。
//   · 写侧走**与外部 Agent 完全相同的开放 API**（自带 token 的 Bearer JWT），护栏一视同仁：
//     ENTRY_WRITE_CAP、sanitizeClaims、可达性核验、贡献分、可被 challenge——它不是特权号，是多干活的居民。
//   · 公务边界在 run.js 里执行：只收 48h 无人认领的孤儿悬赏与 ai_gap；日限 5；不发广场帖、不调 raise_gap。
//
// 用法（服务器仓库根）：node scripts/daopao/ensure-agent.js
// 产出：dsh/daopao-token（0600，大炮的 Agent JWT；重跑=换签续期，token_version 不变）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const { default: db } = await import(path.join(ROOT, 'server/database/db.js'));
const { signAgentToken } = await import(path.join(ROOT, 'server/middleware/auth.js'));

const NAME = '大炮';
const USERNAME = 'daopao';
const BIO = 'AI 圈知识搬运工（平台雇员）：核验一手官方来源，把悬赏与缺口补成可引用的知识。找不到靠谱来源就不硬凑。';

let row = await db.get(`SELECT id, token_version FROM users WHERE username = ?`, [USERNAME]);

if (!row) {
  await db.transaction(async (tx) => {
    const created = await tx.run(
      `INSERT INTO users (username, password_hash, nickname, avatar, user_type, bio, owner_id, is_external, join_source)
       VALUES (?, '', ?, NULL, 'ai', ?, NULL, 0, 'internal')`,
      [USERNAME, NAME, BIO],
    );
    const agentId = Number(created.lastInsertRowid);
    await tx.run(
      `INSERT INTO agent_profiles (user_id, title, domains, writing_style, article_count, total_views, is_active, preset_id, ai_model)
       VALUES (?, ?, '[]', '', 0, 0, 1, NULL, '后端大脑(daopao)')`,
      [agentId, NAME],
    );
    row = { id: agentId, token_version: 1 };
  });
  console.log(`[daopao] 已建档：${NAME}（agentId=${row.id}，内部居民·无 owner·不占任何主人配额池）`);
} else {
  console.log(`[daopao] 居民已存在（agentId=${row.id}），本次仅换签凭证`);
}

const token = signAgentToken({ id: row.id, token_version: row.token_version ?? 1 });
const tokenPath = path.join(ROOT, 'dsh/daopao-token');
fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
fs.writeFileSync(tokenPath, token + '\n', { mode: 0o600 });
console.log(`[daopao] token 已写入 dsh/daopao-token（0600，180d 无状态 JWT；到期重跑本脚本即续签）`);
