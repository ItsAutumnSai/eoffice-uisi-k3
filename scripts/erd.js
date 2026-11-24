// Generates docs/erd.svg and docs/erd.png from the live database schema.
//   npm run erd
// Needs google-chrome (or CHROME_BIN) for the PNG.
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { instance } from '@viz-js/viz';
import mysql from 'mysql2/promise';
import { config } from '../src/config.js';

const OUT_DIR = path.resolve(import.meta.dirname, '../docs');
const HIDDEN_TABLES = new Set(['schema_migrations']);

// Header colour per functional group.
const GROUPS = {
  divisions: '#2f6f4f', users: '#2f6f4f',
  documents: '#1f4e79', document_categories: '#1f4e79', document_recipients: '#1f4e79', document_logs: '#1f4e79',
  number_sequences: '#8a4b0f', letter_numbers: '#8a4b0f',
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function readSchema() {
  const conn = await mysql.createConnection(config.db);
  try {
    const db = config.db.database;
    const [columns] = await conn.query(
      `SELECT table_name AS t, column_name AS c, column_type AS type, is_nullable AS nullable, column_key AS k
       FROM information_schema.columns WHERE table_schema = ? ORDER BY table_name, ordinal_position`, [db]);
    const [fks] = await conn.query(
      `SELECT table_name AS t, column_name AS c, referenced_table_name AS rt, referenced_column_name AS rc
       FROM information_schema.key_column_usage
       WHERE table_schema = ? AND referenced_table_name IS NOT NULL`, [db]);
    const [uniques] = await conn.query(
      `SELECT table_name AS t, MIN(column_name) AS c
       FROM information_schema.statistics
       WHERE table_schema = ? AND non_unique = 0 AND index_name <> 'PRIMARY'
       GROUP BY table_name, index_name HAVING COUNT(*) = 1`, [db]);
    return { columns, fks, uniques };
  } finally {
    await conn.end();
  }
}

function toDot({ columns, fks, uniques }) {
  const fkSet = new Set(fks.map((f) => `${f.t}.${f.c}`));
  const uqSet = new Set(uniques.map((u) => `${u.t}.${u.c}`));
  const tables = new Map();
  for (const col of columns) {
    if (HIDDEN_TABLES.has(col.t)) continue;
    if (!tables.has(col.t)) tables.set(col.t, []);
    tables.get(col.t).push(col);
  }

  const nodes = [...tables].map(([table, cols]) => {
    const rows = cols.map((col) => {
      const key = `${table}.${col.c}`;
      const badges = [col.k === 'PRI' && 'PK', fkSet.has(key) && 'FK', uqSet.has(key) && 'UQ'].filter(Boolean).join(' ');
      const type = col.type.replace(/^enum\((.*)\)$/, (_, v) => `enum(${v.split(',').length})`).replace(' unsigned', '');
      const name = col.k === 'PRI' ? `<B>${esc(col.c)}</B>` : esc(col.c);
      return `<TR>
        <TD ALIGN="LEFT" WIDTH="40" PORT="${col.c}_w">${badges ? `<FONT POINT-SIZE="9" COLOR="#8a5a00"><B>${badges}</B></FONT>` : ' '}</TD>
        <TD ALIGN="LEFT">${name}${col.nullable === 'YES' ? '<FONT COLOR="#999999"> ?</FONT>' : ''}</TD>
        <TD ALIGN="LEFT" PORT="${col.c}_e"><FONT COLOR="#666666" POINT-SIZE="10">${esc(type)}</FONT></TD></TR>`;
    }).join('');
    return `"${table}" [label=<<TABLE BORDER="1" COLOR="#555555" CELLBORDER="0" CELLSPACING="0" CELLPADDING="4" BGCOLOR="white">
      <TR><TD COLSPAN="3" BGCOLOR="${GROUPS[table] ?? '#444444'}" CELLPADDING="7"><FONT COLOR="white" POINT-SIZE="13"><B>${table}</B></FONT></TD></TR>
      ${rows}</TABLE>>];`;
  });

  const nullable = new Set(columns.filter((c) => c.nullable === 'YES').map((c) => `${c.t}.${c.c}`));
  const edges = fks.filter((f) => !HIDDEN_TABLES.has(f.t)).map((f) => {
    const key = `${f.t}.${f.c}`;
    // Child end: many (crow) or at most one if the FK is unique. Parent end: exactly one or zero/one.
    const tail = uqSet.has(key) ? 'teeodot' : (nullable.has(key) ? 'crowodot' : 'crowtee');
    const head = nullable.has(key) ? 'teeodot' : 'teetee';
    return `"${f.t}":"${f.c}_w":w -> "${f.rt}":"${f.rc}_e":e [dir=both, arrowtail=${tail}, arrowhead=${head}];`;
  });

  return `digraph erd {
    graph [rankdir=RL, splines=spline, nodesep=0.5, ranksep=1.1, pad=0.4, bgcolor="white",
           fontname="Helvetica", fontsize=20, labelloc=t,
           label=<<B>E-Office UISI K3 - ERD (FR-05 Archive Numbering &amp; FR-10 Division Workspace)</B><BR/><FONT POINT-SIZE="11" COLOR="#666666">PK primary key | FK foreign key | UQ unique | ? nullable | crow's foot = many, bar = one, circle = optional</FONT>>];
    node [shape=plain, fontname="Helvetica", fontsize=11];
    edge [color="#555555", penwidth=1.2, arrowsize=0.9];
    ${nodes.join('\n')}
    ${edges.join('\n')}
  }`;
}

const schema = await readSchema();
const viz = await instance();
const result = viz.render(toDot(schema), { format: 'svg' });
if (result.status !== 'success' || result.errors.length) console.error(result.errors);
const svg = result.output;
await mkdir(OUT_DIR, { recursive: true });
const svgPath = path.join(OUT_DIR, 'erd.svg');
await writeFile(svgPath, svg);
console.log(`Wrote ${svgPath}`);

const [, w, h] = svg.match(/<svg width="(\d+)pt" height="(\d+)pt"/);
const width = Math.ceil((Number(w) * 4) / 3);
const height = Math.ceil((Number(h) * 4) / 3);
const htmlPath = path.join(OUT_DIR, '.erd-render.html');
await writeFile(htmlPath, `<html><body style="margin:0;background:white">${svg.replace(/^[\s\S]*?(<svg)/, '$1')}</body></html>`);
const pngPath = path.join(OUT_DIR, 'erd.png');
try {
  execFileSync(process.env.CHROME_BIN ?? 'google-chrome', [
    '--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
    `--window-size=${width},${height}`, `--screenshot=${pngPath}`, `file://${htmlPath}`,
  ], { stdio: 'ignore' });
  console.log(`Wrote ${pngPath}`);
} finally {
  await rm(htmlPath, { force: true });
}
