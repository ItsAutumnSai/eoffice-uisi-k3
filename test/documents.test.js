// Integration tests against MySQL. They WIPE the configured database, so they only run
// when DB_NAME ends in "_test" or ALLOW_DB_RESET=1 is set.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { config } from '../src/config.js';

const canReset = config.db.database.endsWith('_test') || process.env.ALLOW_DB_RESET === '1';

describe('documents API (FR-05, FR-10)', { skip: !canReset && 'set DB_NAME=*_test or ALLOW_DB_RESET=1' }, () => {
  let server;
  let base;
  let pool;
  let documents;
  const tokens = {};
  const categories = {};

  async function api(who, method, path, body) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(who && { authorization: `Bearer ${tokens[who]}` }) },
      body: body && JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  async function draft(who, title = 'Surat', category = 'Surat Undangan') {
    const res = await api(who, 'POST', '/api/documents', { title, content: '<p>isi</p>', category_id: categories[category] });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data;
  }

  const submit = (who, id) => api(who, 'POST', `/api/documents/${id}/submit`);

  async function currentPeriodSuffix(code) {
    const { numberingPeriod, formatBaseNumber } = await import('../src/services/archiveNumber.js');
    const { year, month } = numberingPeriod();
    return formatBaseNumber({ seq: 0, divisionCode: code, year, month }).slice(1); // "/KI/MM.YY"
  }

  before(async () => {
    const { migrate } = await import('../scripts/migrate.js');
    const { seed, DUMMY_PASSWORD } = await import('../scripts/seed.js');
    await migrate({ fresh: true, log: () => {} });
    await seed({ log: () => {} });

    ({ pool } = await import('../src/db.js'));
    documents = await import('../src/services/documents.js');
    const { createApp } = await import('../src/app.js');
    server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;

    const users = {
      kiHead: 'ki.kepala@uisi.test', kiStaff: 'ki.staf@uisi.test', kiStaff2: 'ki.staf2@uisi.test',
      keuHead: 'keu.kepala@uisi.test', keuStaff: 'keu.staf@uisi.test',
    };
    for (const [key, email] of Object.entries(users)) {
      const res = await api(null, 'POST', '/api/auth/login', { email, password: DUMMY_PASSWORD });
      assert.equal(res.status, 200);
      tokens[key] = res.body.token;
      users[key] = res.body.user;
    }
    tokens.users = users;
    const [rows] = await pool.query('SELECT id, name FROM document_categories');
    for (const r of rows) categories[r.name] = r.id;
  });

  after(async () => {
    server?.close();
    await pool?.end();
  });

  test('requests without a token are rejected', async () => {
    assert.equal((await api(null, 'GET', '/api/documents')).status, 401);
  });

  describe('FR-10 workspace isolation', () => {
    test('a draft has no number and belongs to the author division, whatever the body says', async () => {
      const res = await api('kiStaff', 'POST', '/api/documents', {
        title: 'Coba', category_id: categories['Surat Tugas'], division_id: 999,
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.data.division_code, 'KI');
      assert.equal(res.body.data.status, 'DRAFT');
      assert.equal(res.body.data.archive_number, null);
    });

    test('lists only show documents of the user division', async () => {
      const ki = await draft('kiStaff', 'Milik KI');
      await submit('kiStaff', ki.id);
      const keu = await draft('keuStaff', 'Milik KEU');
      await submit('keuStaff', keu.id);

      const kiList = (await api('kiHead', 'GET', '/api/documents')).body.data;
      assert.ok(kiList.length > 0);
      assert.ok(kiList.every((d) => d.division_code === 'KI'));
      assert.ok(!kiList.some((d) => d.id === keu.id));
    });

    test('opening another division document by ID returns 404', async () => {
      const keu = await draft('keuStaff', 'Rahasia KEU');
      await submit('keuStaff', keu.id);
      assert.equal((await api('kiStaff', 'GET', `/api/documents/${keu.id}`)).status, 404);
      assert.equal((await api('kiHead', 'POST', `/api/documents/${keu.id}/approve`)).status, 404);
      assert.equal((await api('kiStaff', 'GET', '/api/documents/99999999')).status, 404);
    });

    test('a KORIN grant (document_recipients) lets another division open it', async () => {
      const keu = await draft('keuStaff', 'Untuk KI');
      await submit('keuStaff', keu.id);
      await pool.query('INSERT INTO document_recipients (document_id, division_id) VALUES (?, ?)', [
        keu.id, tokens.users.kiStaff.division_id,
      ]);
      assert.equal((await api('kiStaff', 'GET', `/api/documents/${keu.id}`)).status, 200);
      const kiList = (await api('kiStaff', 'GET', '/api/documents')).body.data;
      assert.ok(!kiList.some((d) => d.id === keu.id), 'shared docs are not part of the workspace list');
    });

    test('drafts are private to their author inside the division', async () => {
      const d = await draft('kiStaff', 'Draf pribadi');
      assert.equal((await api('kiStaff2', 'GET', `/api/documents/${d.id}`)).status, 404);
      assert.equal((await api('kiHead', 'GET', `/api/documents/${d.id}`)).status, 404);
    });
  });

  describe('FR-05 archive numbers', () => {
    test('a number is generated on submit, sequential per division', async () => {
      const suffix = await currentPeriodSuffix('KI');
      const [[{ n }]] = await pool.query(
        `SELECT COUNT(*) AS n FROM letter_numbers l JOIN divisions d ON d.id = l.division_id WHERE d.code = 'KI'`,
      );
      const a = (await submit('kiStaff', (await draft('kiStaff')).id)).body.data;
      const b = (await submit('kiStaff2', (await draft('kiStaff2')).id)).body.data;
      assert.equal(a.archive_number, `${n + 1}${suffix}`);
      assert.equal(b.archive_number, `${n + 2}${suffix}`);
      assert.equal(a.status, 'SUBMITTED');
    });

    test('a head of division gets the number when submitting their own document', async () => {
      const d = (await submit('kiHead', (await draft('kiHead', 'Dari kepala')).id)).body.data;
      assert.match(d.archive_number, /^\d+\/KI\/\d{2}\.\d{2}$/);
    });

    test('a category without an archive code blocks submission', async () => {
      const d = await draft('kiStaff', 'Memo', 'Memo Internal');
      const res = await submit('kiStaff', d.id);
      assert.equal(res.status, 422);
      assert.equal(res.body.error, 'Kode arsip kategori belum dikonfigurasi');
      const after = (await api('kiStaff', 'GET', `/api/documents/${d.id}`)).body.data;
      assert.equal(after.status, 'DRAFT');
      assert.equal(after.archive_number, null);
    });

    test('revision keeps the number and adds REV.n', async () => {
      const d = await draft('kiStaff', 'Perlu revisi');
      const first = (await submit('kiStaff', d.id)).body.data.archive_number;

      let res = await api('kiHead', 'POST', `/api/documents/${d.id}/request-revision`, { note: 'Perbaiki tanggal' });
      assert.equal(res.body.data.status, 'REVISION_REQUESTED');
      assert.equal(res.body.data.archive_number, first);

      await api('kiStaff', 'PATCH', `/api/documents/${d.id}`, { content: '<p>sudah diperbaiki</p>' });
      res = await submit('kiStaff', d.id);
      assert.equal(res.body.data.archive_number, `${first}/REV.1`);

      await api('kiHead', 'POST', `/api/documents/${d.id}/request-revision`, { note: 'Sekali lagi' });
      res = await submit('kiStaff', d.id);
      assert.equal(res.body.data.archive_number, `${first}/REV.2`);
    });

    test('a rejected number goes back to the pool and the lowest one is reused', async () => {
      const a = (await submit('kiStaff', (await draft('kiStaff', 'A')).id)).body.data;
      const b = (await submit('kiStaff', (await draft('kiStaff', 'B')).id)).body.data;

      await api('kiHead', 'POST', `/api/documents/${b.id}/reject`, { note: 'Tidak sesuai' });
      const rejected = await api('kiHead', 'POST', `/api/documents/${a.id}/reject`, { note: 'Tidak sesuai' });
      assert.equal(rejected.body.data.status, 'REJECTED');
      assert.equal(rejected.body.data.archive_number, null);

      const c = (await submit('kiStaff2', (await draft('kiStaff2', 'C')).id)).body.data;
      assert.equal(c.archive_number, a.archive_number, 'lowest released number first');
      const d = (await submit('kiStaff2', (await draft('kiStaff2', 'D')).id)).body.data;
      assert.equal(d.archive_number, b.archive_number);

      // The rejected document can be fixed and resubmitted; it gets a fresh number.
      const again = (await submit('kiStaff', a.id)).body.data;
      assert.equal(again.status, 'SUBMITTED');
      assert.notEqual(again.archive_number, a.archive_number);
    });

    test('a cancelled document releases its number too', async () => {
      const a = (await submit('kiStaff', (await draft('kiStaff')).id)).body.data;
      await api('kiStaff', 'POST', `/api/documents/${a.id}/cancel`);
      const b = (await submit('kiStaff', (await draft('kiStaff')).id)).body.data;
      assert.equal(b.archive_number, a.archive_number);
    });

    test('an approved number is final and never recycled', async () => {
      const a = (await submit('kiStaff', (await draft('kiStaff')).id)).body.data;
      const approved = await api('kiHead', 'POST', `/api/documents/${a.id}/approve`);
      assert.equal(approved.body.data.status, 'APPROVED');
      assert.equal((await api('kiStaff', 'POST', `/api/documents/${a.id}/cancel`)).status, 409);
      const [[row]] = await pool.query(
        `SELECT l.status FROM letter_numbers l JOIN documents d ON d.letter_number_id = l.id WHERE d.id = ?`, [a.id],
      );
      assert.equal(row.status, 'USED');
    });

    test('staff cannot review documents', async () => {
      const a = (await submit('kiStaff', (await draft('kiStaff')).id)).body.data;
      const res = await api('kiStaff2', 'POST', `/api/documents/${a.id}/reject`, { note: 'x' });
      assert.equal(res.status, 403);
    });

    test('numbering resets every month and is separate per division', async () => {
      const ki = tokens.users.kiStaff;
      const keu = tokens.users.keuStaff;
      const jan = new Date('2031-01-15T03:00:00Z');
      const feb = new Date('2031-02-01T00:00:00Z'); // 07:00 in Jakarta
      const sub = async (u, now) =>
        (await documents.submitDocument(u, (await draft(u === ki ? 'kiStaff' : 'keuStaff')).id, { now })).archive_number;

      assert.equal(await sub(ki, jan), '1/KI/01.31');
      assert.equal(await sub(ki, jan), '2/KI/01.31');
      assert.equal(await sub(keu, jan), '1/KEU/01.31');
      assert.equal(await sub(ki, feb), '1/KI/02.31');
    });

    test('concurrent submissions never get the same number', async () => {
      const users = ['kiStaff', 'kiStaff2'];
      const drafts = await Promise.all(Array.from({ length: 20 }, (_, i) => draft(users[i % 2], `Paralel ${i}`)));
      const results = await Promise.all(drafts.map((d, i) => submit(users[i % 2], d.id)));
      assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.find((r) => r.status !== 200)));

      const numbers = results.map((r) => r.body.data.archive_number);
      assert.equal(new Set(numbers).size, numbers.length);
      const seqs = numbers.map((n) => Number(n.split('/')[0])).sort((x, y) => x - y);
      for (let i = 1; i < seqs.length; i++) assert.equal(seqs[i], seqs[i - 1] + 1, 'no gaps');
    });

    test('a failed save rolls back and does not consume a number', async () => {
      const { withTransaction } = await import('../src/db.js');
      const { allocateNumber } = await import('../src/services/archiveNumber.js');
      const [[kiDiv]] = await pool.query(`SELECT id FROM divisions WHERE code = 'KI'`);
      const now = new Date('2032-03-10T03:00:00Z');

      await assert.rejects(
        withTransaction(async (conn) => {
          await allocateNumber(conn, { divisionId: kiDiv.id, divisionCode: 'KI', now });
          throw new Error('simulated failure');
        }),
        /simulated failure/,
      );
      const doc = await documents.submitDocument(tokens.users.kiStaff, (await draft('kiStaff')).id, { now });
      assert.equal(doc.archive_number, '1/KI/03.32');
    });
  });
});
