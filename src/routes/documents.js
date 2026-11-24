import { Router } from 'express';
import { HttpError, notFound } from '../errors.js';
import * as documents from '../services/documents.js';

const STATUSES = ['DRAFT', 'SUBMITTED', 'REVISION_REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED'];

function badRequest(message) {
  return new HttpError(400, message);
}

function documentId(req) {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw notFound();
  return id;
}

function optionalString(body, key, { required = false, max } = {}) {
  const value = body?.[key];
  if (value === undefined || value === null) {
    if (required) throw badRequest(`${key} wajib diisi`);
    return undefined;
  }
  if (typeof value !== 'string' || (required && value.trim() === '')) throw badRequest(`${key} tidak valid`);
  if (max && value.length > max) throw badRequest(`${key} maksimal ${max} karakter`);
  return value;
}

function optionalId(body, key, { required = false } = {}) {
  const value = body?.[key];
  if (value === undefined || value === null) {
    if (required) throw badRequest(`${key} wajib diisi`);
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value <= 0) throw badRequest(`${key} tidak valid`);
  return value;
}

export const documentsRouter = Router();

documentsRouter.get('/', async (req, res) => {
  const { status } = req.query;
  if (status !== undefined && !STATUSES.includes(status)) throw badRequest('status tidak valid');
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  res.json({ data: await documents.listDocuments(req.user, { status, limit, offset }) });
});

documentsRouter.post('/', async (req, res) => {
  const doc = await documents.createDocument(req.user, {
    title: optionalString(req.body, 'title', { required: true, max: 255 }),
    content: optionalString(req.body, 'content'),
    categoryId: optionalId(req.body, 'category_id', { required: true }),
  });
  res.status(201).json({ data: doc });
});

documentsRouter.get('/:id', async (req, res) => {
  res.json({ data: await documents.getDocument(req.user, documentId(req)) });
});

documentsRouter.patch('/:id', async (req, res) => {
  const doc = await documents.updateDocument(req.user, documentId(req), {
    title: optionalString(req.body, 'title', { max: 255 }),
    content: optionalString(req.body, 'content'),
    categoryId: optionalId(req.body, 'category_id'),
  });
  res.json({ data: doc });
});

documentsRouter.post('/:id/submit', async (req, res) => {
  res.json({ data: await documents.submitDocument(req.user, documentId(req)) });
});

documentsRouter.post('/:id/request-revision', async (req, res) => {
  const note = optionalString(req.body, 'note', { required: true });
  res.json({ data: await documents.requestRevision(req.user, documentId(req), { note }) });
});

documentsRouter.post('/:id/reject', async (req, res) => {
  const note = optionalString(req.body, 'note', { required: true });
  res.json({ data: await documents.rejectDocument(req.user, documentId(req), { note }) });
});

documentsRouter.post('/:id/cancel', async (req, res) => {
  const note = optionalString(req.body, 'note');
  res.json({ data: await documents.cancelDocument(req.user, documentId(req), { note }) });
});

documentsRouter.post('/:id/approve', async (req, res) => {
  res.json({ data: await documents.approveDocument(req.user, documentId(req)) });
});
