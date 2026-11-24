// Dummy reference data for development: divisions, users and the archive-code catalog.
// Every dummy user has the password "password123".
import bcrypt from 'bcryptjs';
import mysql from 'mysql2/promise';
import { config } from '../src/config.js';

export const DUMMY_PASSWORD = 'password123';

const divisions = [
  { code: 'KI', name: 'Kantor Internasional' },
  { code: 'KEU', name: 'Keuangan' },
  { code: 'SDM', name: 'Sumber Daya Manusia' },
];

// FR-05 dummy archive-code catalog. "Memo Internal" is deliberately left without
// a code to exercise the "Kode arsip kategori belum dikonfigurasi" error.
const categories = [
  { name: 'Surat Undangan', archive_code: 'UND' },
  { name: 'Surat Keputusan', archive_code: 'SK' },
  { name: 'Surat Tugas', archive_code: 'ST' },
  { name: 'Nota Dinas', archive_code: 'ND' },
  { name: 'Memo Internal', archive_code: null },
];

export async function seed({ log = console.log } = {}) {
  const conn = await mysql.createConnection(config.db);
  try {
    const hash = await bcrypt.hash(DUMMY_PASSWORD, 10);
    for (const d of divisions) {
      await conn.query(
        `INSERT INTO divisions (code, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)`,
        [d.code, d.name],
      );
      const [[{ id }]] = await conn.query('SELECT id FROM divisions WHERE code = ?', [d.code]);
      const slug = d.code.toLowerCase();
      for (const [role, label] of [['HEAD', 'Kepala'], ['STAFF', 'Staf'], ['STAFF', 'Staf 2']]) {
        const email = `${slug}.${label.toLowerCase().replace(' ', '')}@uisi.test`;
        await conn.query(
          `INSERT INTO users (division_id, name, email, password_hash, role)
           VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE email = email`,
          [id, `${label} ${d.name}`, email, hash, role],
        );
      }
    }
    for (const c of categories) {
      await conn.query(
        `INSERT INTO document_categories (name, archive_code) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE archive_code = VALUES(archive_code)`,
        [c.name, c.archive_code],
      );
    }
    log(`Seeded ${divisions.length} divisions, ${divisions.length * 3} users, ${categories.length} categories`);
  } finally {
    await conn.end();
  }
}

if (import.meta.main) {
  await seed();
}
