import { pool, withTransaction } from '../db.js';
import { conflict, forbidden, notFound, unprocessable } from '../errors.js';
import {
  allocateNumber,
  formatArchiveNumber,
  markNumberUsed,
  releaseNumber,
} from './archiveNumber.js';

const EDITABLE = ['DRAFT', 'REVISION_REQUESTED', 'REJECTED'];
const CANCELLABLE = ['DRAFT', 'SUBMITTED', 'REVISION_REQUESTED', 'REJECTED'];

const DOCUMENT_COLUMNS = `
  d.id, d.division_id, dv.code AS division_code, dv.name AS division_name,
  d.category_id, c.name AS category_name, d.created_by, u.name AS created_by_name,
  d.title, d.status, d.revision_no, d.archive_number, d.archive_code,
  d.submitted_at, d.created_at, d.updated_at`;

const DOCUMENT_FROM = `
  FROM documents d
  JOIN divisions dv ON dv.id = d.division_id
  JOIN document_categories c ON c.id = d.category_id
  JOIN users u ON u.id = d.created_by`;

// Drafts are private to their author; everything else is visible to the whole division.
const OWN_WORKSPACE = `(d.division_id = ? AND (d.status <> 'DRAFT' OR d.created_by = ?))`;

// FR-10: the workspace list only ever shows the logged-in user's division.
export async function listDocuments(user, { status, limit = 50, offset = 0 } = {}) {
  const params = [user.division_id, user.id];
  let where = OWN_WORKSPACE;
  if (status) {
    where += ' AND d.status = ?';
    params.push(status);
  }
  const [rows] = await pool.query(
    `SELECT ${DOCUMENT_COLUMNS} ${DOCUMENT_FROM}
     WHERE ${where}
     ORDER BY d.updated_at DESC, d.id DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return rows;
}

// FR-10: a document of another division is only reachable with a KORIN grant
// (document_recipients). Otherwise it is reported as not found (404), so IDs
// of other divisions' documents cannot be probed.
export async function getDocument(user, id, conn = pool) {
  const [[doc]] = await conn.query(
    `SELECT ${DOCUMENT_COLUMNS}, d.content ${DOCUMENT_FROM}
     WHERE d.id = ?
       AND (${OWN_WORKSPACE}
            OR (d.status <> 'DRAFT' AND EXISTS (
                  SELECT 1 FROM document_recipients r
                  WHERE r.document_id = d.id AND (r.user_id = ? OR r.division_id = ?))))`,
    [id, user.division_id, user.id, user.id, user.division_id],
  );
  if (!doc) throw notFound();
  return doc;
}

// Locks a document of the user's own division for a state change.
async function lockOwnDocument(conn, user, id) {
  const [[doc]] = await conn.query(
    `SELECT d.*, dv.code AS division_code
     FROM documents d JOIN divisions dv ON dv.id = d.division_id
     WHERE d.id = ? AND d.division_id = ?
     FOR UPDATE`,
    [id, user.division_id],
  );
  if (!doc || (doc.status === 'DRAFT' && doc.created_by !== user.id)) throw notFound();
  return doc;
}

async function log(conn, { documentId, userId, action, from, to, archiveNumber = null, note = null }) {
  await conn.query(
    `INSERT INTO document_logs
       (document_id, user_id, action_type, status_from, status_to, archive_number, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [documentId, userId, action, from, to, archiveNumber, note],
  );
}

async function findActiveCategory(conn, categoryId) {
  const [[category]] = await conn.query(
    `SELECT id, archive_code FROM document_categories WHERE id = ? AND is_active = TRUE`,
    [categoryId],
  );
  if (!category) throw unprocessable('Kategori surat tidak valid');
  return category;
}

function requireAuthor(user, doc) {
  if (doc.created_by !== user.id) {
    throw forbidden('Akses ditolak: hanya pembuat dokumen yang dapat melakukan aksi ini');
  }
}

function requireHead(user) {
  if (user.role !== 'HEAD') {
    throw forbidden('Akses ditolak: Anda tidak memiliki wewenang persetujuan');
  }
}

function requireStatus(doc, allowed) {
  if (!allowed.includes(doc.status)) {
    throw conflict(`Aksi tidak dapat dilakukan pada dokumen berstatus ${doc.status}`);
  }
}

export async function createDocument(user, { title, content = null, categoryId }) {
  return withTransaction(async (conn) => {
    await findActiveCategory(conn, categoryId);
    // division_id always comes from the session, never from the request body.
    const [result] = await conn.query(
      `INSERT INTO documents (division_id, category_id, created_by, title, content)
       VALUES (?, ?, ?, ?, ?)`,
      [user.division_id, categoryId, user.id, title, content],
    );
    await log(conn, { documentId: result.insertId, userId: user.id, action: 'CREATE', from: null, to: 'DRAFT' });
    return getDocument(user, result.insertId, conn);
  });
}

export async function updateDocument(user, id, { title, content, categoryId }) {
  return withTransaction(async (conn) => {
    const doc = await lockOwnDocument(conn, user, id);
    requireAuthor(user, doc);
    requireStatus(doc, EDITABLE);
    if (categoryId !== undefined) await findActiveCategory(conn, categoryId);
    await conn.query(
      `UPDATE documents
       SET title = COALESCE(?, title), content = COALESCE(?, content), category_id = COALESCE(?, category_id)
       WHERE id = ?`,
      [title ?? null, content ?? null, categoryId ?? null, id],
    );
    await log(conn, { documentId: id, userId: user.id, action: 'UPDATE', from: doc.status, to: doc.status });
    return getDocument(user, id, conn);
  });
}

/**
 * Submits a document for approval/signing. This is the only point where an archive
 * number is generated, whether the author is a staff member or the head of division.
 * Resubmitting after a revision request keeps the number and adds /REV.n.
 */
export async function submitDocument(user, id, { now = new Date() } = {}) {
  return withTransaction(async (conn) => {
    const doc = await lockOwnDocument(conn, user, id);
    requireAuthor(user, doc);
    requireStatus(doc, EDITABLE);

    const category = await findActiveCategory(conn, doc.category_id);
    if (!category.archive_code) throw unprocessable('Kode arsip kategori belum dikonfigurasi');

    let letterNumberId;
    let revisionNo;
    let archiveNumber;
    let action;
    if (doc.status === 'REVISION_REQUESTED' && doc.letter_number_id) {
      const [[number]] = await conn.query(`SELECT number FROM letter_numbers WHERE id = ?`, [doc.letter_number_id]);
      letterNumberId = doc.letter_number_id;
      revisionNo = doc.revision_no + 1;
      archiveNumber = formatArchiveNumber(number.number, revisionNo);
      action = 'RESUBMIT';
    } else {
      const number = await allocateNumber(conn, { divisionId: doc.division_id, divisionCode: doc.division_code, now });
      letterNumberId = number.id;
      revisionNo = 0;
      archiveNumber = number.number;
      action = 'SUBMIT';
    }

    await conn.query(
      `UPDATE documents
       SET status = 'SUBMITTED', letter_number_id = ?, revision_no = ?, archive_number = ?,
           archive_code = ?, submitted_at = UTC_TIMESTAMP()
       WHERE id = ?`,
      [letterNumberId, revisionNo, archiveNumber, category.archive_code, id],
    );
    await log(conn, { documentId: id, userId: user.id, action, from: doc.status, to: 'SUBMITTED', archiveNumber });
    return getDocument(user, id, conn);
  });
}

export async function requestRevision(user, id, { note }) {
  return withTransaction(async (conn) => {
    requireHead(user);
    const doc = await lockOwnDocument(conn, user, id);
    requireStatus(doc, ['SUBMITTED']);
    await conn.query(`UPDATE documents SET status = 'REVISION_REQUESTED' WHERE id = ?`, [id]);
    await log(conn, {
      documentId: id, userId: user.id, action: 'REQUEST_REVISION',
      from: doc.status, to: 'REVISION_REQUESTED', archiveNumber: doc.archive_number, note,
    });
    return getDocument(user, id, conn);
  });
}

// Reject and cancel both return the number to the pool and clear it from the document.
async function closeAndRelease(conn, user, doc, { status, action, note = null }) {
  if (doc.letter_number_id) await releaseNumber(conn, doc.letter_number_id);
  await conn.query(
    `UPDATE documents
     SET status = ?, letter_number_id = NULL, archive_number = NULL, revision_no = 0
     WHERE id = ?`,
    [status, doc.id],
  );
  await log(conn, {
    documentId: doc.id, userId: user.id, action,
    from: doc.status, to: status, archiveNumber: doc.archive_number, note,
  });
}

export async function rejectDocument(user, id, { note }) {
  return withTransaction(async (conn) => {
    requireHead(user);
    const doc = await lockOwnDocument(conn, user, id);
    requireStatus(doc, ['SUBMITTED']);
    await closeAndRelease(conn, user, doc, { status: 'REJECTED', action: 'REJECT', note });
    return getDocument(user, id, conn);
  });
}

export async function cancelDocument(user, id, { note = null } = {}) {
  return withTransaction(async (conn) => {
    const doc = await lockOwnDocument(conn, user, id);
    requireAuthor(user, doc);
    requireStatus(doc, CANCELLABLE);
    await closeAndRelease(conn, user, doc, { status: 'CANCELLED', action: 'CANCEL', note });
    return getDocument(user, id, conn);
  });
}

// Placeholder for the signing flow (FR-11/FR-12): once approved the number is final.
export async function approveDocument(user, id) {
  return withTransaction(async (conn) => {
    requireHead(user);
    const doc = await lockOwnDocument(conn, user, id);
    requireStatus(doc, ['SUBMITTED']);
    await markNumberUsed(conn, doc.letter_number_id);
    await conn.query(`UPDATE documents SET status = 'APPROVED' WHERE id = ?`, [id]);
    await log(conn, {
      documentId: id, userId: user.id, action: 'APPROVE',
      from: doc.status, to: 'APPROVED', archiveNumber: doc.archive_number,
    });
    return getDocument(user, id, conn);
  });
}
