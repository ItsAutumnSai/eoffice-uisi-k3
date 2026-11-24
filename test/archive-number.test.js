import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatArchiveNumber, formatBaseNumber, numberingPeriod } from '../src/services/archiveNumber.js';

test('formats the base number as seq/DIV/MM.YY', () => {
  assert.equal(formatBaseNumber({ seq: 5, divisionCode: 'KI', year: 2026, month: 12 }), '5/KI/12.26');
  assert.equal(formatBaseNumber({ seq: 12, divisionCode: 'KEU', year: 2027, month: 1 }), '12/KEU/01.27');
});

test('appends REV.n only for revisions', () => {
  assert.equal(formatArchiveNumber('5/KI/12.26', 0), '5/KI/12.26');
  assert.equal(formatArchiveNumber('5/KI/12.26', 1), '5/KI/12.26/REV.1');
  assert.equal(formatArchiveNumber('5/KI/12.26', 2), '5/KI/12.26/REV.2');
});

test('the numbering period follows Jakarta time, not UTC', () => {
  // 2026-11-30 18:30 UTC is already 1 December 01:30 in Jakarta.
  assert.deepEqual(numberingPeriod(new Date('2026-11-30T18:30:00Z'), 'Asia/Jakarta'), { year: 2026, month: 12 });
  assert.deepEqual(numberingPeriod(new Date('2026-12-31T17:00:00Z'), 'Asia/Jakarta'), { year: 2027, month: 1 });
});
