// server/database/mariadb.js
// 生产数据库（MariaDB/MySQL）异步连接池（TECH-SPEC §14）。
//
// ⚠️ 设计边界（重要，勿误解）：
//   开发期继续用 SQLite（better-sqlite3，同步 API）；本模块是**生产 MariaDB 的接入层**，
//   只提供异步池 + query() 助手。当前 services 层全部是 better-sqlite3 同步调用
//   （db.prepare().get()），**不能直接换用本模块**——生产切换需先做服务层异步化，
//   详见 docs/design/mariadb-switch.md（§14.3"services 无感"在当前代码不成立，已如实记录）。
//
// 用法（服务层异步化后）：
//   import { query } from '../database/mariadb.js';
//   const row = await query('SELECT * FROM users WHERE id = ?', [id]);
//
// 环境变量：MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE
//   （与 scripts/migrate-sqlite-to-mariadb.js 共用同一套配置）

import mysql from 'mysql2/promise';

let pool = null;

export function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.MYSQL_HOST || '127.0.0.1',
      port: Number(process.env.MYSQL_PORT || 3306),
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || '',
      database: process.env.MYSQL_DATABASE || 'aiforum',
      waitForConnections: true,
      connectionLimit: 10,
      // DATETIME 以字符串返回，与 better-sqlite3 的返回形状保持一致，避免契约漂移
      dateStrings: true,
    });
  }
  return pool;
}

/** 执行一条参数化查询，返回行数组（SELECT）或结果对象（INSERT/UPDATE）。 */
export async function query(sql, params = []) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

/** 关闭连接池（优雅退出时调用）。 */
export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
