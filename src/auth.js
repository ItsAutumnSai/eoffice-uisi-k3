import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { pool } from './db.js';
import { HttpError } from './errors.js';

const USER_COLUMNS = `u.id, u.name, u.email, u.role, u.division_id, d.code AS division_code, d.name AS division_name`;

export async function login(email, password) {
  const [[user]] = await pool.query(
    `SELECT ${USER_COLUMNS}, u.password_hash
     FROM users u JOIN divisions d ON d.id = u.division_id
     WHERE u.email = ? AND u.is_active = TRUE AND d.is_active = TRUE`,
    [email],
  );
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    throw new HttpError(401, 'Email atau kata sandi salah');
  }
  delete user.password_hash;
  const token = jwt.sign({ sub: String(user.id) }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
  return { token, user };
}

// Loads the user fresh on every request so division moves and deactivation apply immediately.
export async function authenticate(req, _res, next) {
  const header = req.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new HttpError(401, 'Silakan login terlebih dahulu');

  let payload;
  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    throw new HttpError(401, 'Sesi tidak valid atau telah berakhir');
  }

  const [[user]] = await pool.query(
    `SELECT ${USER_COLUMNS}
     FROM users u JOIN divisions d ON d.id = u.division_id
     WHERE u.id = ? AND u.is_active = TRUE AND d.is_active = TRUE`,
    [payload.sub],
  );
  if (!user) throw new HttpError(401, 'Sesi tidak valid atau telah berakhir');
  req.user = user;
  next();
}
