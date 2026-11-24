import express from 'express';
import { authenticate, login } from './auth.js';
import { HttpError } from './errors.js';
import { documentsRouter } from './routes/documents.js';

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== 'string' || typeof password !== 'string') {
      throw new HttpError(400, 'email dan password wajib diisi');
    }
    res.json(await login(email, password));
  });

  app.use('/api', authenticate);
  app.get('/api/auth/me', (req, res) => res.json({ user: req.user }));
  app.use('/api/documents', documentsRouter);

  app.use((_req, _res, next) => next(new HttpError(404, 'Endpoint tidak ditemukan')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Body JSON tidak valid' });
    console.error(err);
    res.status(500).json({ error: 'Terjadi kesalahan pada server' });
  });

  return app;
}
