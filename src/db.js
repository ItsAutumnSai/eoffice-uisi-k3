import mysql from 'mysql2/promise';
import { config } from './config.js';

export const pool = mysql.createPool({
  ...config.db,
  waitForConnections: true,
  connectionLimit: 10,
  timezone: 'Z',
});

// Store and read every DATETIME as UTC.
pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'");
});

const RETRYABLE = new Set([
  1213, // ER_LOCK_DEADLOCK
  1205, // ER_LOCK_WAIT_TIMEOUT
]);

/**
 * Runs fn(conn) inside a transaction. Commits on success, rolls back on any error
 * (so no archive number is consumed by a failed save), and retries on deadlock.
 */
export async function withTransaction(fn, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback().catch(() => {});
      if (RETRYABLE.has(err.errno) && attempt < retries) continue;
      throw err;
    } finally {
      conn.release();
    }
  }
}
