// Applies db/migrations/*.sql in order and records them in schema_migrations.
//   node scripts/migrate.js          apply pending migrations
//   node scripts/migrate.js --fresh  DROP ALL TABLES first (development/testing only)
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { config } from '../src/config.js';

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../db/migrations');

export async function migrate({ fresh = false, log = console.log } = {}) {
  const conn = await mysql.createConnection({ ...config.db, multipleStatements: true });
  try {
    if (fresh) {
      const [tables] = await conn.query(
        `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ?`,
        [config.db.database],
      );
      await conn.query('SET FOREIGN_KEY_CHECKS = 0');
      for (const { name } of tables) await conn.query(`DROP TABLE \`${name}\``);
      await conn.query('SET FOREIGN_KEY_CHECKS = 1');
      log(`Dropped ${tables.length} table(s) from ${config.db.database}`);
    }

    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(255) NOT NULL PRIMARY KEY,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    const [applied] = await conn.query('SELECT name FROM schema_migrations');
    const done = new Set(applied.map((r) => r.name));

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      // MySQL DDL auto-commits, so a failed migration must be fixed by hand.
      await conn.query(await readFile(path.join(MIGRATIONS_DIR, file), 'utf8'));
      await conn.query('INSERT INTO schema_migrations (name) VALUES (?)', [file]);
      log(`Applied ${file}`);
    }
  } finally {
    await conn.end();
  }
}

if (import.meta.main) {
  await migrate({ fresh: process.argv.includes('--fresh') });
}
