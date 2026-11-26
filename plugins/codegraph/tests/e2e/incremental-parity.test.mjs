// Why: the same rows are written by two different code paths — an incremental
// sync re-resolves each changed file on its own (resolveFile), a full build
// resolves the finished index in one pass (resolveAll). If the two disagree, a
// tool answer depends on the edit history instead of the tree. This test drives
// a random edit sequence over a small mixed-language tree, syncs it in place,
// rebuilds the same tree from scratch in another directory, and compares
// normalized exports of both indexes. Ids, row order and stat columns are left
// out, so a reported difference means the graph content differs.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Indexer } from '../../src/index/indexer.mjs';

// The index lives under the plugin data directory, keyed by project root. Point
// that at a throwaway directory before any Indexer exists (the other indexer-lane
// tests do the same via useScratchData) and keep every project root in its own
// temp directory, so no real project's index is ever touched.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-parity-data-'));
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-parity-'));
process.env.ZCODE_PLUGIN_DATA = DATA;

// minFilesToAutoIndex only gates background builds; buildAll/ensureFresh on an
// index that already holds files do not consult it. Set it to 0 anyway so a
// transient empty index cannot make a step fail for a configuration reason.
const CONFIG = Object.freeze({ minFilesToAutoIndex: 0 });

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
}

after(() => {
  rmrf(SCRATCH);
  rmrf(DATA);
});

// ---------------------------------------------------------------------------
// Fixture: TS, JS and Python in one tree, with cross-file imports and calls so
// that a rename or a deletion changes the parse result of other files too.
// ---------------------------------------------------------------------------

const FIXTURE = {
  'src/util.ts': [
    'export function add(a: number, b: number): number {',
    '  return a + b;',
    '}',
    '',
    'export function format(value: number): string {',
    '  return `value=${value}`;',
    '}',
    '',
  ].join('\n'),

  'src/app.ts': [
    "import { add, format } from './util';",
    '',
    'export function run(): string {',
    '  const total = add(1, 2);',
    '  return format(total);',
    '}',
    '',
  ].join('\n'),

  'src/loop-a.ts': [
    "import { beta } from './loop-b';",
    '',
    'export function alpha(n: number): number {',
    '  return n > 0 ? beta(n - 1) : 0;',
    '}',
    '',
  ].join('\n'),

  'src/loop-b.ts': [
    "import { alpha } from './loop-a';",
    '',
    'export function beta(n: number): number {',
    '  return alpha(n) + 1;',
    '}',
    '',
  ].join('\n'),

  'src/shapes.ts': [
    'export type Shape = { w: number };',
    '',
    'export function area(s: Shape): number {',
    '  return s.w * s.w;',
    '}',
    '',
  ].join('\n'),

  'src/index.ts': [
    "import { area, Shape } from './shapes';",
    '',
    'export function totalArea(items: Shape[]): number {',
    '  return items.reduce((sum, item) => sum + area(item), 0);',
    '}',
    '',
  ].join('\n'),

  'lib/util.py': [
    'def add(a, b):',
    '    return a + b',
    '',
    '',
    'def double(x):',
    '    return add(x, x)',
    '',
  ].join('\n'),

  'lib/app.py': [
    'from util import add',
    '',
    '',
    'def total(values):',
    '    return add(values[0], values[1])',
    '',
  ].join('\n'),

  'lib/shapes.py': [
    'def area(w):',
    '    return w * w',
    '',
    '',
    'def perimeter(w):',
    '    return 4 * w',
    '',
  ].join('\n'),

  'tests/app.test.ts': [
    "import { run } from '../src/app';",
    '',
    'export function testRun(): string {',
    '  return run();',
    '}',
    '',
  ].join('\n'),

  'scripts/build.js': [
    "import { add } from '../src/util';",
    '',
    'export function build(): number {',
    '  return add(2, 3);',
    '}',
    '',
  ].join('\n'),
};

// The consumers of the fixture: deleting them would leave nothing to compare
// against, and they are what a rename elsewhere must keep resolving.
const ENTRY_FILES = new Set(['src/app.ts', 'lib/app.py', 'tests/app.test.ts']);

function writeTree(root, files) {
  for (const [rel, text] of files) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
}

function writeTreeFile(root, files, rel, text) {
  files.set(rel, text);
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

// ---------------------------------------------------------------------------
// Normalized export. One line per row, tab between stable fields, so two
// indexes can be compared byte for byte after sorting.
// ---------------------------------------------------------------------------

const NULL = '\u2205'; // a code point no fixture source contains

function field(value) {
  if (value === null || value === undefined) return NULL;
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

// The stable identity of a symbol: where it is and what it is, never its row id.
function symbolKey(filePath, line, col, kind, name) {
  if (filePath === null || filePath === undefined) return NULL;
  return `${filePath}:${line}:${col}#${kind}@${name}`;
}

const FILES_SQL = 'SELECT path, lang, hash, parse_ok, error_nodes FROM files';

const SYMBOLS_SQL = `
  SELECT f.path AS file_path, s.kind, s.name, s.qual, s.start_line, s.start_col, s.end_line,
         s.signature, s.doc, s.exported, s.block,
         pf.path AS parent_path, p.start_line AS parent_line, p.start_col AS parent_col,
         p.kind AS parent_kind, p.name AS parent_name
  FROM symbols s
  JOIN files f ON f.id = s.file_id
  LEFT JOIN symbols p ON p.id = s.parent_id
  LEFT JOIN files pf ON pf.id = p.file_id`;

const REFS_SQL = `
  SELECT f.path AS file_path, r.name, r.receiver, r.kind, r.start_line, r.start_col, r.end_line,
         r.scope, r.resolution,
         ownf.path AS owner_path, own.start_line AS owner_line, own.start_col AS owner_col,
         own.kind AS owner_kind, own.name AS owner_name,
         tgtf.path AS target_path, tgt.start_line AS target_line, tgt.start_col AS target_col,
         tgt.kind AS target_kind, tgt.name AS target_name
  FROM refs r
  JOIN files f ON f.id = r.file_id
  LEFT JOIN symbols own ON own.id = r.symbol_id
  LEFT JOIN files ownf ON ownf.id = own.file_id
  LEFT JOIN symbols tgt ON tgt.id = r.target_id
  LEFT JOIN files tgtf ON tgtf.id = tgt.file_id`;

const IMPORTS_SQL = `
  SELECT f.path AS file_path, i.spec, i.kind, i.start_line, i.names,
         rf.path AS resolved_path
  FROM imports i
  JOIN files f ON f.id = i.file_id
  LEFT JOIN files rf ON rf.id = i.resolved_file_id`;

// symbols_fts is an external-content table: a plain SELECT reads the content
// table and would happily show rows whose index entries are stale. fts5vocab in
// 'instance' mode reads the inverted index itself, so a missing or leftover
// entry shows up. The schema-qualified 3-argument form is the only one that lets
// the vocab table live in temp (a 2-argument one resolves against temp and fails).
const FTS_VOCAB_DDL = "CREATE VIRTUAL TABLE IF NOT EXISTS temp.codegraph_parity_fts USING fts5vocab(main, symbols_fts, 'instance')";

// term / column / offset are stable; `doc` is a rowid and is only used to name
// the owning symbol, never exported itself.
const FTS_SQL = `
  SELECT v.term, v.col, v.offset,
         f.path AS owner_path, s.start_line AS owner_line, s.start_col AS owner_col,
         s.kind AS owner_kind, s.name AS owner_name
  FROM temp.codegraph_parity_fts v
  LEFT JOIN symbols s ON s.id = v.doc
  LEFT JOIN files f ON f.id = s.file_id`;

/**
 * Export an index as sorted, id-free lines per table.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{ tables: Record<string, string[]>, text: string }}
 */
// Exported so a local proof script can drive the real comparator on two
// hand-built indexes (see .tmp/t39/compare-proof.mjs); nothing else imports it.
export function exportIndex(db) {
  db.exec(FTS_VOCAB_DDL);
  const tables = {
    files: db.prepare(FILES_SQL).all().map((row) => [row.path, row.lang, row.hash, row.parse_ok, row.error_nodes].map(field).join('\t')),

    symbols: db.prepare(SYMBOLS_SQL).all().map((row) => [
      symbolKey(row.file_path, row.start_line, row.start_col, row.kind, row.name),
      row.qual, row.end_line, row.signature, row.doc, row.exported, row.block,
      symbolKey(row.parent_path, row.parent_line, row.parent_col, row.parent_kind, row.parent_name),
    ].map(field).join('\t')),

    refs: db.prepare(REFS_SQL).all().map((row) => [
      row.file_path,
      symbolKey(row.owner_path, row.owner_line, row.owner_col, row.owner_kind, row.owner_name),
      row.name, row.receiver, row.kind, row.start_line, row.start_col, row.end_line,
      row.scope, row.resolution,
      symbolKey(row.target_path, row.target_line, row.target_col, row.target_kind, row.target_name),
    ].map(field).join('\t')),

    imports: db.prepare(IMPORTS_SQL).all().map((row) => [
      row.file_path, row.spec, row.kind, row.start_line, row.names, row.resolved_path,
    ].map(field).join('\t')),

    symbols_fts: db.prepare(FTS_SQL).all().map((row) => [
      row.term, row.col, row.offset,
      symbolKey(row.owner_path, row.owner_line, row.owner_col, row.owner_kind, row.owner_name),
    ].map(field).join('\t')),
  };
  // Sorted in JS, not by SQL: rows whose stable columns are equal must not be
  // ordered by anything the two databases could assign differently (row ids).
  for (const lines of Object.values(tables)) lines.sort();
  const text = Object.entries(tables).map(([name, lines]) => `## ${name} (${lines.length})\n${lines.join('\n')}`).join('\n\n');
  return { tables, text };
}

/**
 * Compare two exports table by table and return a report of the first
 * differences, or null when they are identical.
 */
export function diffExports(incremental, full) {
  const report = [];
  for (const name of Object.keys(incremental.tables)) {
    const a = incremental.tables[name];
    const b = full.tables[name];
    if (a.length === b.length && a.every((line, i) => line === b[i])) continue;
    const inA = new Set(a);
    const inB = new Set(b);
    const onlyIncremental = a.filter((line) => !inB.has(line)).slice(0, 8);
    const onlyFull = b.filter((line) => !inA.has(line)).slice(0, 8);
    report.push([
      `table "${name}": ${a.length} incremental rows vs ${b.length} full rows`,
      ...onlyIncremental.map((line) => `  only in incremental: ${line}`),
      ...onlyFull.map((line) => `  only in full build:  ${line}`),
    ].join('\n'));
  }
  return report.length === 0 ? null : report.join('\n');
}

// The import rows that have a resolved target, as one comparable text: what the
// `resolved_file_id` coverage check is measured on.
function resolvedLines(importLines) {
  return importLines.filter((line) => !line.endsWith(`\t${NULL}`)).join('\n');
}

// ---------------------------------------------------------------------------
// Random edits. xorshift64* with a fixed seed: the same sequence on every
// machine, so a reported failure can be replayed from the seed and step alone.
// ---------------------------------------------------------------------------

const MASK64 = (1n << 64n) - 1n;

function makeRandom(seed) {
  // Scramble the seed once so that neighbouring seeds do not start out alike.
  let state = BigInt.asUintN(64, (BigInt(seed) * 0x9E3779B97F4A7C15n) & MASK64) | 1n;
  return () => {
    state ^= state >> 12n;
    state &= MASK64;
    state ^= (state << 25n) & MASK64;
    state &= MASK64;
    state ^= state >> 27n;
    state &= MASK64;
    const out = (state * 0x2545F4914F6CDD1Dn) & MASK64;
    return Number(out >> 11n) / 2 ** 53;
  };
}

const pick = (rnd, list) => list[Math.floor(rnd() * list.length)];
const int = (rnd, n) => Math.floor(rnd() * n);

function definitionRe() {
  return /(?:function|def)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
}

function definedNames(files) {
  const names = new Set();
  for (const text of files.values()) for (const m of text.matchAll(definitionRe())) names.add(m[1]);
  return [...names].sort();
}

function allIdentifiers(files) {
  const names = new Set();
  for (const text of files.values()) for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) names.add(m[0]);
  return names;
}

// A same-length rename: with an unchanged size only the mtime tells the scan
// that the file changed, which is the case the step driver makes visible.
function variantOf(name) {
  const tail = name.at(-1);
  return `${name.slice(0, -1)}${tail === 'z' ? 'y' : 'z'}`;
}

function moduleSpec(fromRel, toRel) {
  let spec = path.posix.relative(path.posix.dirname(fromRel), toRel).replace(/\.(ts|tsx|js|mjs|cjs)$/, '');
  if (!spec.startsWith('.')) spec = `./${spec}`;
  return spec;
}

function insertComment(rnd, files, root, state, touched) {
  const rel = pick(rnd, [...files.keys()]);
  const marker = rel.endsWith('.py') ? '#' : '//';
  const lines = files.get(rel).split('\n');
  const at = int(rnd, lines.length + 1);
  lines.splice(at, 0, `${marker} parity edit ${(state.edits += 1)}`);
  writeTreeFile(root, files, rel, lines.join('\n'));
  touched.add(rel);
  return `${rel} +${at}`;
}

function appendFunction(rnd, files, root, state, touched) {
  const targets = [...files.keys()].filter((rel) => rel.endsWith('.ts')).sort();
  if (targets.length === 0) return null;
  const names = definedNames(files);
  if (names.length === 0) return null;
  const rel = pick(rnd, targets);
  const callee = pick(rnd, names);
  const name = `generated${(state.functions += 1)}`;
  const prev = files.get(rel);
  writeTreeFile(root, files, rel, `${prev}${prev.endsWith('\n') ? '' : '\n'}export function ${name}(): number {\n  return ${callee}(1);\n}\n`);
  touched.add(rel);
  return `${rel} + ${name} -> ${callee}`;
}

function renameIdentifier(rnd, files, root, state, touched) {
  const uses = new Map(); // name -> set of files it is defined in
  for (const [rel, text] of files) {
    for (const m of text.matchAll(definitionRe())) {
      const entry = uses.get(m[1]) ?? new Set();
      entry.add(rel);
      uses.set(m[1], entry);
    }
  }
  const taken = allIdentifiers(files);
  const acrossFiles = [...uses].filter(([name, rels]) => rels.size >= 2 && !taken.has(variantOf(name))).map(([name]) => name).sort();
  const pool = acrossFiles.length > 0 ? acrossFiles : [...uses.keys()].filter((name) => !taken.has(variantOf(name))).sort();
  if (pool.length === 0) return null;
  const from = pick(rnd, pool);
  const to = variantOf(from);
  const word = new RegExp(`\\b${from}\\b`, 'g');
  let changed = 0;
  for (const [rel, text] of files) {
    const next = text.replace(word, to);
    if (next === text) continue;
    writeTreeFile(root, files, rel, next);
    touched.add(rel);
    changed += 1;
  }
  if (changed === 0) return null;
  state.renames += 1;
  return `${from} -> ${to} (${changed} files)`;
}

function addImport(rnd, files, root, state, touched) {
  const entries = [...files.keys()].sort();
  const rel = pick(rnd, entries);
  const python = rel.endsWith('.py');
  const sameKind = (p) => (python ? p.endsWith('.py') : /\.(ts|tsx|js|mjs|cjs)$/.test(p));
  const dir = path.posix.dirname(rel);
  const siblings = entries.filter((p) => p !== rel && path.posix.dirname(p) === dir && sameKind(p));
  const fallback = python ? 'lib/util.py' : 'src/util.ts';
  const target = siblings.length > 0 ? pick(rnd, siblings) : files.has(fallback) ? fallback : null;
  if (target === null) return null;
  const names = [...files.get(target).matchAll(definitionRe())].map((m) => m[1]);
  if (names.length === 0) return null;
  const imported = pick(rnd, names);
  const line = python
    ? `from ${path.posix.basename(target).replace(/\.py$/, '')} import ${imported}`
    : `import { ${imported} } from '${moduleSpec(rel, target)}';`;
  writeTreeFile(root, files, rel, `${line}\n${files.get(rel)}`);
  touched.add(rel);
  state.imports += 1;
  return `${rel}: ${line}`;
}

function newFile(rnd, files, root, state, touched) {
  state.newFiles += 1;
  const rel = `src/gen-${state.newFiles}.ts`;
  const names = definedNames(files);
  const callee = names.length > 0 ? pick(rnd, names) : 'add';
  writeTreeFile(root, files, rel, `import { ${callee} } from './util';\n\nexport function generated${state.newFiles}(): number {\n  return ${callee}();\n}\n`);
  touched.add(rel);
  return rel;
}

function deleteRandomFile(rnd, files, root) {
  if (files.size < 10) return null;
  const candidates = [...files.keys()].filter((rel) => !ENTRY_FILES.has(rel)).sort();
  if (candidates.length === 0) return null;
  const rel = pick(rnd, candidates);
  files.delete(rel);
  fs.rmSync(path.join(root, rel), { force: true });
  return rel;
}

const EDITORS = {
  'insert-comment': insertComment,
  'append-function': appendFunction,
  'rename-identifier': renameIdentifier,
  'add-import': addImport,
  'new-file': newFile,
};

// The proportions are the test's contract with the reader: comments dominate
// (they only move lines), then new functions, then whole-tree renames (the
// interesting cross-file case), then imports and new files. Deletion is a
// separate 5% roll, as specified. Every edit leaves the file parseable: whole
// line comments are legal anywhere in these fixtures, a word-boundary rename
// swaps one identifier for another, and imports go on line 1.
function applyEdit(rnd, files, root, state) {
  const roll = rnd();
  const kind = roll < 0.5 ? 'insert-comment' : roll < 0.7 ? 'append-function' : roll < 0.85 ? 'rename-identifier' : roll < 0.95 ? 'add-import' : 'new-file';
  const touched = new Set();
  const removed = [];
  const created = [];
  const detail = EDITORS[kind](rnd, files, root, state, touched);
  let label = detail === null ? `${kind} (no-op)` : `${kind} ${detail}`;
  if (kind === 'new-file' && detail !== null) created.push(detail);
  if (files.size >= 10 && rnd() < 0.05) {
    const rel = deleteRandomFile(rnd, files, root);
    if (rel !== null) {
      label += ` + delete-file ${rel}`;
      touched.add(rel);
      removed.push(rel);
      state.deletes += 1;
    }
  }
  return { kind, label, touched: [...touched], removed, created };
}

// Coverage steps for the two edit kinds a ten-step random run can miss: the
// row a deleted file leaves behind and the row a new file adds are exactly what
// the per-step assertions below check, so those assertions need one of each to
// be more than dead code. They run through the same sync-and-compare path.
function forcedDelete(files, root, state) {
  const preferred = ['src/loop-b.ts', 'lib/shapes.py', 'src/shapes.ts', 'scripts/build.js', 'src/loop-a.ts', 'lib/util.py', 'src/util.ts'];
  const rel = preferred.find((candidate) => files.has(candidate))
    ?? [...files.keys()].filter((candidate) => !ENTRY_FILES.has(candidate)).sort()[0];
  if (rel === undefined) return null;
  files.delete(rel);
  fs.rmSync(path.join(root, rel), { force: true });
  state.deletes += 1;
  return { kind: 'delete-file', label: `delete-file ${rel}`, touched: [rel], removed: [rel], created: [] };
}

function forcedNewFile(files, root, state) {
  const n = state.newFiles + 1;
  const rel = `src/coverage-${n}.ts`;
  const callee = definedNames(files)[0] ?? 'add';
  writeTreeFile(root, files, rel, `import { ${callee} } from './util';\n\nexport function coverage${n}(): number {\n  return ${callee}();\n}\n`);
  state.newFiles += 1;
  return { kind: 'new-file', label: `new-file ${rel}`, touched: [rel], removed: [], created: [rel] };
}

// ---------------------------------------------------------------------------
// The two indexes under test
// ---------------------------------------------------------------------------

/** Build `files` from scratch under a fresh root with a fresh Indexer and export it. */
async function buildFreshCopy(files, label) {
  const root = fs.mkdtempSync(path.join(SCRATCH, `full-${label}-`));
  // One worker: the fixture is a dozen files, so spawning more costs more than it saves.
  const ix = new Indexer({ root, config: CONFIG, workers: 1 });
  try {
    writeTree(root, files);
    const res = await ix.buildAll({ force: true });
    assert.equal(res.state, 'ready', `full build of ${label} ended in state ${res.state}`);
    return exportIndex(ix.db);
  } finally {
    await ix.close();
    rmrf(root);
  }
}

function stepsPerSeed() {
  const raw = process.env.CODEGRAPH_PARITY_STEPS;
  if (raw === undefined || raw.trim() === '') return 10;
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(n) || n < 1 || String(n) !== raw.trim()) {
    throw new Error(`CODEGRAPH_PARITY_STEPS must be a positive integer (got "${raw}")`);
  }
  return n;
}

// Two seeds, chosen before the first run so that ten steps already contain a
// cross-file rename, a file deletion and a new file — the edits whose parity
// depends on the resolver rechecking other files. CODEGRAPH_PARITY_STEPS widens
// the same two sequences (nights, manual runs); it does not change the seeds.
const SEEDS = [3, 5];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('normalized export is a baseline: two full builds of the same tree are identical, and a rename is visible', async () => {
  const files = new Map(Object.entries(FIXTURE));

  const first = await buildFreshCopy(files, 'baseline-a');
  const second = await buildFreshCopy(files, 'baseline-b');
  const same = diffExports(first, second);
  assert.equal(same, null, `two full builds of the same tree disagree:\n${same}`);

  // Without this the parity assertions below could pass on an exporter that
  // drops a table or a column entirely.
  for (const name of ['files', 'symbols', 'refs', 'imports', 'symbols_fts']) {
    assert.ok(first.tables[name].length > 0, `export table "${name}" is empty, the exporter would not see it`);
  }
  assert.equal(first.tables.files.length, Object.keys(FIXTURE).length, 'every fixture file is indexed');
  // A term only the inverted index knows: proves symbols_fts is read as an index,
  // not as its external content table.
  assert.ok(first.tables.symbols_fts.some((line) => line.includes('totalarea\tname\t')), 'the FTS index is exported');

  // Rename one function in the copy (same-size, cross-file) and rebuild: the
  // export must show it, in the stable key rather than in an id.
  const renamed = new Map(files);
  for (const rel of ['src/util.ts', 'src/app.ts', 'scripts/build.js', 'lib/util.py', 'lib/app.py']) {
    renamed.set(rel, files.get(rel).replace(/\badd\b/g, 'adz'));
  }
  const third = await buildFreshCopy(renamed, 'baseline-c');
  assert.notEqual(third.text, first.text, 'a cross-file rename must change the export');
  assert.ok(third.tables.symbols.some((line) => line.includes('@adz')), 'the new name appears in the symbol keys');
  assert.ok(!third.tables.symbols.some((line) => line.includes('@add')), 'the old name is gone from the symbol keys');
  assert.ok(third.tables.refs.some((line) => line.includes('#function@adz')), 'refs target the renamed symbol');
  assert.ok(!third.tables.refs.some((line) => line.includes('#function@add')), 'no ref still targets the old name');
});

for (const seed of SEEDS) {
  test(`incremental sync matches a full rebuild (seed ${seed})`, async () => {
    const steps = stepsPerSeed();
    const root = fs.mkdtempSync(path.join(SCRATCH, `live-${seed}-`));
    const files = new Map(Object.entries(FIXTURE));
    writeTree(root, files);
    const live = new Indexer({ root, config: CONFIG, workers: 2 });
    const failures = [];
    const rnd = makeRandom(seed); // one stream per seed: replay by seed + step
    const state = { edits: 0, functions: 0, renames: 0, imports: 0, newFiles: 0, deletes: 0 };
    // A run-wide clock: every write moves the edited files' mtime forward by a
    // second, so the mtime+size prefilter never misses a change that kept the size.
    const clock = { value: Date.now() + 60_000 };
    const hasFile = (exported, rel) => exported.tables.files.some((line) => line.startsWith(`${rel}\t`));
    let previousImports = null;
    let previousResolved = null;
    let importsChanged = 0;
    let resolvedChanged = 0;
    let stepIndex = 0;

    const runStep = async (edit) => {
      stepIndex += 1;
      const label = `seed ${seed} step ${stepIndex}: ${edit.label}`;
      clock.value += 1000;
      const stamp = new Date(clock.value);
      for (const rel of edit.touched) {
        const abs = path.join(root, rel);
        if (fs.existsSync(abs)) fs.utimesSync(abs, stamp, stamp);
      }

      const synced = await live.ensureFresh({ force: true });
      // The sync must have finished before the export: a pending entry means the
      // index still predates the edit and the comparison would be meaningless.
      assert.equal(synced.readOnly, false, `${label}: another process held the lock`);
      assert.equal(synced.state, 'ready', `${label}: sync ended in state ${synced.state}`);
      assert.equal(synced.dirty, 0, `${label}: ${synced.dirty} dirty entr(ies) left after ensureFresh`);

      const incremental = exportIndex(live.db);
      const full = await buildFreshCopy(files, `${seed}-${stepIndex}`);
      for (const rel of edit.removed) {
        assert.ok(!hasFile(incremental, rel), `${label}: deleted ${rel} is still in the incremental index`);
        assert.ok(!hasFile(full, rel), `${label}: deleted ${rel} is still in the full index`);
      }
      for (const rel of edit.created) {
        assert.ok(hasFile(incremental, rel), `${label}: new ${rel} is missing from the incremental index`);
        assert.ok(hasFile(full, rel), `${label}: new ${rel} is missing from the full index`);
      }

      // Count steps that really moved the import table, so the comparison below
      // is known to have compared something that changed — specs on one side,
      // the resolved target (resolved_file_id) on the other. A row without a
      // target has nothing to cover, so only rows with one count for the second.
      const importsNow = incremental.tables.imports;
      if (previousImports !== null && importsNow.join('\n') !== previousImports.join('\n')) importsChanged += 1;
      const resolvedNow = resolvedLines(importsNow);
      if (previousResolved !== null && resolvedNow !== previousResolved) resolvedChanged += 1;
      previousImports = importsNow;
      previousResolved = resolvedNow;

      // live.status() is diagnostics only: the watcher re-marks edited files
      // after its own debounce, and a later sync would hash-skip them.
      const pending = live.status().dirty;
      const diff = diffExports(incremental, full);
      if (diff !== null) {
        failures.push(`${label}\n  live dirty: ${pending}, live files: ${incremental.tables.files.length}, full files: ${full.tables.files.length}\n${diff}`);
      }
    };

    try {
      const built = await live.buildAll({ force: true });
      assert.equal(built.state, 'ready', 'the initial build of the live tree must be ready');
      const initial = exportIndex(live.db);
      assert.equal(initial.tables.files.length, Object.keys(FIXTURE).length, 'initial index holds every fixture file');
      previousImports = initial.tables.imports;
      previousResolved = resolvedLines(previousImports);

      for (let i = 1; i <= steps; i += 1) await runStep(applyEdit(rnd, files, root, state));

      // The random sequence skips these two kinds often enough at ten steps that
      // the row assertions above would otherwise never run.
      if (state.deletes === 0) {
        const forced = forcedDelete(files, root, state);
        assert.ok(forced !== null, 'the fixture ran out of files to delete');
        await runStep(forced);
      }
      if (state.newFiles === 0) await runStep(forcedNewFile(files, root, state));

      // A sequence of no-ops would make every parity claim vacuous.
      assert.ok(state.renames >= 1, `the sequence must contain a cross-file rename (renames: ${state.renames})`);
      assert.ok(state.deletes >= 1, `the run must delete at least one file (deletes: ${state.deletes})`);
      assert.ok(state.newFiles >= 1, `the run must create at least one file (new files: ${state.newFiles})`);
      assert.ok(importsChanged >= 1, `no step changed the imports export, so the import comparison never ran (import edits: ${state.imports})`);
      assert.ok(resolvedChanged >= 1, 'no step changed an import target, so resolved_file_id was never covered');
      assert.equal(
        failures.length,
        0,
        `${failures.length} of ${stepIndex} steps disagree (renames: ${state.renames}, deletes: ${state.deletes}, new files: ${state.newFiles}, imports: ${state.imports}):\n\n${failures.join('\n\n')}`,
      );

      const final = exportIndex(live.db);
      assert.notEqual(final.text, initial.text, 'the edit sequence must have changed the index');
    } finally {
      await live.close();
      rmrf(root);
    }
  });
}
