#!/usr/bin/env node
// scripts/test-companion-flow.cjs — 伴侣全链路冒烟验证
// 用法: node scripts/test-companion-flow.cjs
// 依赖: 在服务器 V3 目录下执行（需要 .env 和数据库可达）
const jwt = require('jsonwebtoken');
const fs = require('fs');

const env = Object.fromEntries(
  fs.readFileSync('.env', 'utf8')
    .split('\n')
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => l.split('=', 2))
);
const JWT = jwt.sign({ userId: 28, username: 'admin' }, env.JWT_SECRET, { expiresIn: '1h' });
const BASE = 'http://127.0.0.1:3002';
const HDR = { Authorization: `Bearer ${JWT}` };

async function test() {
  let ok = 0, fail = 0;
  const check = (name, cond) => {
    if (cond) { console.log(`  ✅ ${name}`); ok++; }
    else      { console.log(`  ❌ ${name}`); fail++; }
  };

  // 1. 伴侣列表
  console.log('\n=== 1. 伴侣列表（萧盛账号 id=28）===');
  const list = await fetch(`${BASE}/api/companions`, { headers: HDR }).then(r => r.json());
  check('返回 companions 数组', Array.isArray(list.companions));
  check('有 2 个伴侣（逍遥游×2）', list.companions?.length === 2);
  const anya = list.companions?.find(c => c.username === '逍遥游_0i8c');
  check('逍遥游_0i8c 存在', !!anya);
  check('is_public=0（默认私域）', anya?.is_public === 0);
  check('badge=我的搭档', anya?.badge === '我的搭档');
  console.log(`  列表: ${list.companions?.map(c => c.name).join(', ')}`);

  // 2. 按 username 获取
  console.log('\n=== 2. 按 username 获取 ===');
  const byUser = await fetch(`${BASE}/api/companions/u/逍遥游_0i8c`, { headers: HDR }).then(r => r.json());
  check('按 username 查到伴侣', !!byUser.companion);
  check('persona_json 有内容', !!byUser.companion?.persona_json);

  // 3. 伴侣聊天
  console.log('\n=== 3. 伴侣聊天 ===');
  const chat = await fetch(`${BASE}/api/companions/1/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...HDR },
    body: JSON.stringify({ message: '你好，逍遥游！我是萧盛，你的主人。' }),
  }).then(r => r.json());
  check('返回 sessionId', !!chat.sessionId);
  check('返回 reply.content', !!chat.reply?.content);
  console.log(`  回复: ${(chat.reply?.content || '').slice(0, 120)}...`);
  console.log(`  model: ${chat.reply?.model_used || '?'}`);

  // 4. 记忆写入
  console.log('\n=== 4. 记忆验证 ===');
  const mem = await fetch(`${BASE}/api/companions/1/memories`, { headers: HDR }).then(r => r.json());
  check('返回 memories 数组', Array.isArray(mem.memories));
  console.log(`  记忆条数: ${mem.memories?.length || 0}`);
  if (mem.memories?.length > 0) {
    for (const m of mem.memories.slice(0, 3)) {
      console.log(`    ${m.source}: ${(m.content || '').slice(0, 80)}`);
    }
  }

  // 5. 辅助写作
  console.log('\n=== 5. 辅助写作 ===');
  const draft = await fetch(`${BASE}/api/companions/1/writing/polish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...HDR },
    body: JSON.stringify({ content: '我想写一篇关于AI未来发展的文章，帮我润色一下开头。' }),
  }).then(r => r.json());
  check('返回草稿', !!draft.draft);
  console.log(`  草稿: ${(draft.draft?.draft_content || '').slice(0, 120)}...`);

  // 6. 新建伴侣（验证 CRUD）
  console.log('\n=== 6. 创建新伴侣 ===');
  const created = await fetch(`${BASE}/api/companions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...HDR },
    body: JSON.stringify({ name: '测试伴侣', bio: '用于验证的测试搭档' }),
  }).then(r => r.json());
  check('创建成功', !!created.companion);
  console.log(`  新伴侣: #${created.companion?.id} ${created.companion?.name}`);

  // 7. 删除伴侣（清理测试数据）
  if (created.companion?.id) {
    await fetch(`${BASE}/api/companions/${created.companion.id}`, {
      method: 'DELETE', headers: HDR,
    });
    check('删除测试伴侣成功', true);
  }

  // 8. 1-per-user 约束
  console.log('\n=== 7. 1-per-user 约束 ===');
  const dupe = await fetch(`${BASE}/api/companions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...HDR },
    body: JSON.stringify({ name: '再建一个', bio: '应该被拒绝' }),
  }).then(r => r.json());
  check('超过上限被拒绝', dupe.error || dupe.message);

  // 汇总
  console.log(`\n══════════════════════════════════`);
  console.log(`  结果: ${ok} 通过, ${fail} 失败`);
  console.log(`══════════════════════════════════`);
  process.exit(fail > 0 ? 1 : 0);
}

test().catch(e => {
  console.error('测试异常:', e);
  process.exit(1);
});
