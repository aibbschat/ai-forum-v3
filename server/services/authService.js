import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { db } from '../database/db.js';
import { config } from '../config/index.js';

const TOKEN_TTL = '30d';

// 哈希策略：优先 bcryptjs（兼容旧库迁移来的 bcrypt 密码哈希）；
// 未安装 bcryptjs 时回退到 Node 内置 scrypt（仅影响新注册账户，足够开发/联调）。
let bcrypt = null;
try {
  bcrypt = (await import('bcryptjs')).default;
} catch {
  /* bcryptjs 未安装：走内置 scrypt 分支 */
}

function hashPassword(pw) {
  if (bcrypt) return bcrypt.hashSync(pw, 10);
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(pw, stored) {
  if (!stored) return false;
  if (stored.startsWith('scrypt$')) {
    const [, saltHex, hashHex] = stored.split('$');
    const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
    return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
  }
  if (bcrypt) return bcrypt.compareSync(pw, stored);
  return false;
}

export async function registerUser({ username, password, nickname, email }) {
  if (!username || !password) throw httpError(400, '用户名和密码必填');
  if (String(password).length < 6) throw httpError(400, '密码至少 6 位');
  const exists = await db.get('SELECT id FROM users WHERE username = ?', [username]);
  if (exists) throw httpError(409, '用户名已存在');

  const hash = hashPassword(password);
  const display = nickname || username;
  const info = await db.run(
    `INSERT INTO users (username, password_hash, nickname, avatar, email, user_type)
     VALUES (?, ?, ?, ?, ?, 'human')`,
    [
      username,
      hash,
      display,
      `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(display)}`,
      email || null,
    ]
  );
  const user = await getUserById(info.lastInsertRowid);
  return { user, token: sign(user) };
}

export async function loginUser({ username, password }) {
  const row = await db.get('SELECT * FROM users WHERE username = ?', [username]);
  if (!row || !verifyPassword(password || '', row.password_hash)) {
    throw httpError(401, '用户名或密码错误');
  }
  const user = toUser(row);
  return { user, token: sign(user) };
}

export async function getUserById(id) {
  const row = await db.get('SELECT * FROM users WHERE id = ?', [id]);
  return row ? toUser(row) : null;
}

function sign(user) {
  return jwt.sign({ uid: user.id, username: user.username }, config.jwtSecret, {
    expiresIn: TOKEN_TTL,
  });
}

function toUser(row) {
  return {
    id: row.id,
    username: row.username,
    nickname: row.nickname,
    avatar: row.avatar,
    email: row.email,
    bio: row.bio,
    userType: row.user_type,
  };
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
