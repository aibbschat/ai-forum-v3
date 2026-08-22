#!/usr/bin/env node
// scripts/migrate-companions.cjs
// 把旧版 ai_forum_prod 中"用户自建 AI"（created_by 非空）迁人设至 v3 aiforum 的 companion_profiles。
// 见 docs/companion/AI_COMPANION_SPEC.md §3.3 / §12。
//
// 安全约定：
//   - 默认 --dry-run：只读旧库 + 只读新库校验 email 映射，不写任何数据，仅打印计划。
//   - 显式 --apply 才写入 v3 companion_profiles，**绝不写旧库**（旧库只读 SELECT）。
//   - 幂等：--apply 时若 username 已存在则跳过；旧 username 冲突自动加 _v3 后缀。
//
// 运行（在服务器上，两套库可达）：
//   node scripts/migrate-companions.cjs --dry-run
//   node scripts/migrate-companions.cjs --apply
//
// 环境变量（旧库用 OLD_MYSQL_*；新库复用 server/database/mariadb.js 的 MYSQL_*）：
//   OLD_MYSQL_HOST / OLD_MYSQL_PORT / OLD_MYSQL_USER / OLD_MYSQL_PASSWORD / OLD_MYSQL_DATABASE
//   MYSQL_HOST    / MYSQL_PORT    / MYSQL_USER    / MYSQL_PASSWORD    / MYSQL_DATABASE

'use strict';
const mysql = require('mysql2/promise');

const args = process.argv.slice(2);
const DRY = !args.includes('--apply');

const OLD = {
  host: process.env.OLD_MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.OLD_MYSQL_PORT || 3306),
  user: process.env.OLD_MYSQL_USER || 'root',
  password: process.env.OLD_MYSQL_PASSWORD || '',
  database: process.env.OLD_MYSQL_DATABASE || 'ai_forum_prod',
  readonly: true,
};
const NEW = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'aiforum',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'aiforum',
};

const safeJson = (s) => {
  if (!s) return null;
  try { return typeof s === 'string' ? JSON.parse(s) : s; } catch { return null; }
};

function buildIntro(name, persona) {
  const interests = persona.interests || persona.domains || [];
  const list = Array.isArray(interests) ? interests.join('、') : (interests || '');
  return [
    `你是"${name}"，是用户专属的 AI 搭档（私人伙伴），不是社区内容生产者。`,
    `你的职责是陪伴与辅助：记住用户的偏好、帮用户写作与脑暴，但绝不以用户身份公开发帖。`,
    list ? `你感兴趣的方向：${list}` : '',
    `请以自然、像朋友一样的语气交流，并保持对用户偏好的长期记忆。`,
  ].filter(Boolean).join('\n');
}

async function uniqueUsername(conn, base) {
  const [r] = await conn.execute(`SELECT id FROM companion_profiles WHERE username = ?`, [base]);
  if (!r.length) return base;
  let i = 1, cand;
  do {
    cand = `${base}_v3${i}`;
    const [x] = await conn.execute(`SELECT id FROM companion_profiles WHERE username = ?`, [cand]);
    if (!x.length) break;
    i++;
  } while (i < 100);
  return cand;
}

async function main() {
  const oldConn = await mysql.createConnection(OLD);
  const newConn = await mysql.createConnection(NEW);
  try {
    const [olds] = await oldConn.execute(
      `SELECT u.id, u.nickname, u.username, u.avatar, u.bio, u.email, u.ai_personality, u.created_by,
              ac.talkative, ac.warmth, ac.knowledge, ac.humor, ac.creativity,
              ac.theme_color, ac.catchphrase
       FROM users u
       LEFT JOIN ai_character_cards ac ON ac.ai_user_id = u.id
       WHERE u.user_type = 'ai' AND u.created_by IS NOT NULL`
    );
    console.log(`[旧库 ${OLD.database}] 用户自建 AI 共 ${olds.length} 个`);

    const plan = [];
    let noEmail = 0;
    for (const o of olds) {
      // 旧 created_by(旧 uid) → 旧创建者 email → 新库 users.email 匹配 → 新 uid
      let email = o.email;
      let ownerId = null;
      if (email) {
        const [news] = await newConn.execute(`SELECT id FROM users WHERE email = ?`, [email]);
        ownerId = news[0] ? news[0].id : null;
      }
      if (!ownerId && o.created_by) {
        const [creators] = await oldConn.execute(`SELECT email FROM users WHERE id = ?`, [o.created_by]);
        email = creators[0] ? creators[0].email : email;
        if (email) {
          const [news] = await newConn.execute(`SELECT id FROM users WHERE email = ?`, [email]);
          ownerId = news[0] ? news[0].id : null;
        }
      }
      const persona = {
        bio: o.bio || '',
        ...(safeJson(o.ai_personality) || {}),
        talkative: o.talkative ?? 50,
        warmth: o.warmth ?? 50,
        knowledge: o.knowledge ?? 50,
        humor: o.humor ?? 50,
        creativity: o.creativity ?? 50,
        theme_color: o.theme_color || '#22d3ee',
        catchphrase: o.catchphrase || '',
      };
      plan.push({
        oldId: o.id,
        oldUsername: o.username,
        name: o.nickname || o.username,
        ownerId,
        email,
        username: await uniqueUsername(newConn, o.username),
        persona_json: JSON.stringify(persona),
        intro_prompt: buildIntro(o.nickname || o.username, persona),
        avatar: o.avatar || null,
      });
      if (!ownerId) noEmail++;
    }

    for (const p of plan) {
      console.log(
        `  - 旧#${p.oldId} "${p.name}" (${p.oldUsername}) → 主人uid=${p.ownerId}` +
        (p.email ? ` (${p.email})` : '  [邮箱缺失→无法挂主人!]') +
        (p.username !== p.oldUsername ? `  [username→${p.username}]` : '')
      );
    }
    const ok = plan.filter((p) => p.ownerId).length;
    console.log(`\n可迁移 ${ok} / ${plan.length}（${noEmail} 个因邮箱缺失无法映射主人）`);

    if (DRY) {
      console.log('\n[DRY-RUN] 未写入任何数据。确认无误后于服务器执行：node scripts/migrate-companions.cjs --apply');
      return;
    }

    let inserted = 0, skipped = 0;
    for (const p of plan) {
      if (!p.ownerId) { skipped++; continue; }
      const [exist] = await newConn.execute(`SELECT id FROM companion_profiles WHERE username = ?`, [p.username]);
      if (exist.length) { skipped++; continue; }
      await newConn.execute(
        `INSERT INTO companion_profiles (owner_id, name, username, avatar, sprite_sheet, persona_json, intro_prompt, is_public, created_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, 0, NOW())`,
        [p.ownerId, p.name, p.username, p.avatar, p.persona_json, p.intro_prompt]
      );
      inserted++;
    }
    console.log(`\n[APPLY] 已插入 ${inserted} 个，跳过 ${skipped} 个（已存在/无主人）。`);
  } finally {
    await oldConn.end();
    await newConn.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
