// FR-05 / FR-02: centralized archive numbering.
//
// Format: {seq}/{DIVISION_CODE}/{MM}.{YY}            e.g. 5/KI/12.26
// After a revision request and resubmission:          e.g. 5/KI/12.26/REV.1
//
// The sequence is per division per calendar month (so it resets every month).
// A number released by a reject/cancel goes back to the pool and the lowest
// available one is reused first, within the same division and month.
import { config } from '../config.js';

export function numberingPeriod(date = new Date(), timeZone = config.timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric' })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return { year: Number(parts.year), month: Number(parts.month) };
}

export function formatBaseNumber({ seq, divisionCode, year, month }) {
  const mm = String(month).padStart(2, '0');
  const yy = String(year % 100).padStart(2, '0');
  return `${seq}/${divisionCode}/${mm}.${yy}`;
}

export function formatArchiveNumber(baseNumber, revisionNo = 0) {
  return revisionNo > 0 ? `${baseNumber}/REV.${revisionNo}` : baseNumber;
}

/**
 * Reserves a number for a division in the month of `now`. Must run inside a transaction.
 * The FOR UPDATE lock on the division's number_sequences row queues concurrent
 * submissions, so each gets a distinct number.
 */
export async function allocateNumber(conn, { divisionId, divisionCode, now = new Date() }) {
  const { year, month } = numberingPeriod(now);

  await conn.query(
    `INSERT INTO number_sequences (division_id, period_year, period_month, last_seq)
     VALUES (?, ?, ?, 0)
     ON DUPLICATE KEY UPDATE id = id`,
    [divisionId, year, month],
  );
  const [[sequence]] = await conn.query(
    `SELECT id, last_seq FROM number_sequences
     WHERE division_id = ? AND period_year = ? AND period_month = ?
     FOR UPDATE`,
    [divisionId, year, month],
  );

  const [[recycled]] = await conn.query(
    `SELECT id, number FROM letter_numbers
     WHERE division_id = ? AND period_year = ? AND period_month = ? AND status = 'AVAILABLE'
     ORDER BY seq
     LIMIT 1
     FOR UPDATE`,
    [divisionId, year, month],
  );
  if (recycled) {
    await conn.query(`UPDATE letter_numbers SET status = 'RESERVED' WHERE id = ?`, [recycled.id]);
    return { id: recycled.id, number: recycled.number };
  }

  const seq = sequence.last_seq + 1;
  const number = formatBaseNumber({ seq, divisionCode, year, month });
  await conn.query(`UPDATE number_sequences SET last_seq = ? WHERE id = ?`, [seq, sequence.id]);
  const [inserted] = await conn.query(
    `INSERT INTO letter_numbers (division_id, period_year, period_month, seq, number, status)
     VALUES (?, ?, ?, ?, ?, 'RESERVED')`,
    [divisionId, year, month, seq, number],
  );
  return { id: inserted.insertId, number };
}

/** Puts a reserved number back into the pool (reject / cancel before signing). */
export async function releaseNumber(conn, letterNumberId) {
  await conn.query(
    `UPDATE letter_numbers SET status = 'AVAILABLE' WHERE id = ? AND status = 'RESERVED'`,
    [letterNumberId],
  );
}

/** Marks a number as final; it is never recycled after this. */
export async function markNumberUsed(conn, letterNumberId) {
  await conn.query(`UPDATE letter_numbers SET status = 'USED' WHERE id = ?`, [letterNumberId]);
}
