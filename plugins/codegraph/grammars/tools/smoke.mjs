#!/usr/bin/env node
// Smoke test for the bundled tree-sitter grammars.
//
// For every entry in grammars/manifest.json: load the wasm through the
// bundled web-tree-sitter runtime, parse the matching fixture under
// tests/fixtures/grammars/, and report load time plus ERROR/MISSING node
// counts. Each fixture is parsed twice: right after its grammar is loaded,
// and again after every grammar has been loaded. A different ERROR count on
// the second pass ("DRIFT") means the grammar's output depends on what else
// is loaded in the process — the heap-corruption symptom that old ABI
// grammars show inside a shared web-tree-sitter instance.
//
// Exit code 1 when a grammar fails to load, a parse throws, or a grammar
// drifts. ERROR nodes alone are reported only: they point at grammar or
// fixture drift, not at a broken artifact.
//
// Usage: node plugins/codegraph/grammars/tools/smoke.mjs
// Zero dependencies; runs on Node >= 22.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, basename, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { ensureLiftoffOnly } from '../../src/bootstrap.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
// Optional safety net for runtimes where wasm tier-up crashes (see src/bootstrap.mjs).
if (!(await ensureLiftoffOnly(SCRIPT_PATH))) process.exit(0);

const TOOLS_DIR = dirname(SCRIPT_PATH);
const GRAMMARS_DIR = join(TOOLS_DIR, '..');
const PLUGIN_DIR = join(GRAMMARS_DIR, '..');
const MANIFEST_PATH = join(GRAMMARS_DIR, 'manifest.json');
const FIXTURES_DIR = join(PLUGIN_DIR, 'tests', 'fixtures', 'grammars');
const RUNTIME_PATH = join(GRAMMARS_DIR, 'runtime', 'web-tree-sitter.mjs');

function fail(message) {
  process.stderr.write(`smoke: ${message}\n`);
  process.exit(1);
}

if (!existsSync(MANIFEST_PATH)) fail(`manifest not found: ${MANIFEST_PATH}`);
if (!existsSync(RUNTIME_PATH)) fail(`runtime not found: ${RUNTIME_PATH}`);
if (!existsSync(FIXTURES_DIR)) fail(`fixtures dir not found: ${FIXTURES_DIR}`);

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
if (!Array.isArray(manifest) || manifest.length === 0) {
  fail('manifest.json must be a non-empty array');
}
for (const entry of manifest) {
  if (typeof entry.grammar !== 'string' || typeof entry.file !== 'string') {
    fail(`manifest entry without grammar/file: ${JSON.stringify(entry)}`);
  }
}

const fixtureFiles = readdirSync(FIXTURES_DIR);

function fixtureFor(grammar) {
  const match = fixtureFiles.find((f) => basename(f, extname(f)) === grammar);
  return match ? join(FIXTURES_DIR, match) : null;
}

// Depth-first walk of the whole tree; counts ERROR nodes and missing-token
// placeholders. gotoParent() is never followed by a visit so each node is
// seen exactly once.
function countErrors(root) {
  let errors = 0;
  let missing = 0;
  let nodes = 0;
  const cursor = root.walk();
  const visit = () => {
    nodes += 1;
    if (cursor.nodeType === 'ERROR') errors += 1;
    if (cursor.nodeIsMissing) missing += 1;
  };
  visit();
  for (;;) {
    if (cursor.gotoFirstChild()) {
      visit();
      continue;
    }
    for (;;) {
      if (cursor.gotoNextSibling()) {
        visit();
        break;
      }
      if (!cursor.gotoParent()) return { errors, missing, nodes };
    }
  }
}

function parseFixture(language, source) {
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  const counts = countErrors(tree.rootNode);
  const result = { hasError: tree.rootNode.hasError, root: tree.rootNode.type, ...counts };
  tree.delete();
  parser.delete();
  return result;
}

function pad(value, width, alignRight = false) {
  const s = String(value);
  if (s.length >= width) return s;
  return alignRight ? ' '.repeat(width - s.length) + s : s + ' '.repeat(width - s.length);
}

const tInit = performance.now();
let Parser;
let Language;
let LANGUAGE_VERSION;
let MIN_COMPATIBLE_VERSION;
try {
  // Windows absolute paths are not valid ESM specifiers; go through file://.
  const runtime = await import(pathToFileURL(RUNTIME_PATH).href);
  ({ Parser, Language } = runtime);
  await Parser.init();
  ({ LANGUAGE_VERSION, MIN_COMPATIBLE_VERSION } = runtime);
} catch (error) {
  fail(`runtime init failed: ${error?.message ?? error}`);
}
const initMs = Math.round(performance.now() - tInit);

const rows = [];
let loadFailures = 0;
let parseFailures = 0;
let drifts = 0;

// Pass 1: load each grammar and parse its fixture immediately.
for (const entry of manifest) {
  const grammar = entry.grammar;
  const wasmPath = join(GRAMMARS_DIR, entry.file);
  const fixturePath = fixtureFor(grammar);
  const row = {
    grammar,
    abi: '',
    bytes: entry.bytes,
    loadMs: '',
    hasError: '',
    errors: '',
    missing: '',
    reparseErrors: '',
    root: '',
    fixture: fixturePath ? basename(fixturePath) : '(none)',
    status: 'ok',
    language: null,
    fixturePath,
  };

  if (!existsSync(wasmPath)) {
    row.status = `LOAD FAIL: missing ${entry.file}`;
    loadFailures += 1;
    rows.push(row);
    continue;
  }

  const t0 = performance.now();
  try {
    row.language = await Language.load(wasmPath);
  } catch (error) {
    row.status = `LOAD FAIL: ${error?.message ?? error}`;
    loadFailures += 1;
    rows.push(row);
    continue;
  }
  row.loadMs = Math.round(performance.now() - t0);
  row.abi = row.language.abiVersion;

  if (!fixturePath) {
    row.status = 'no fixture';
    rows.push(row);
    continue;
  }

  try {
    const first = parseFixture(row.language, readFileSync(fixturePath, 'utf8'));
    row.hasError = first.hasError;
    row.errors = first.errors;
    row.missing = first.missing;
    row.root = first.root;
  } catch (error) {
    row.status = `PARSE FAIL: ${error?.message ?? error}`;
    parseFailures += 1;
  }
  rows.push(row);
}

// Pass 2: every grammar is now resident; parse again and compare.
for (const row of rows) {
  if (!row.language || !row.fixturePath || row.status !== 'ok') continue;
  try {
    const second = parseFixture(row.language, readFileSync(row.fixturePath, 'utf8'));
    row.reparseErrors = second.errors;
    if (second.errors !== row.errors) {
      row.status = `DRIFT: ERROR ${row.errors} -> ${second.errors} after all grammars loaded`;
      drifts += 1;
    }
  } catch (error) {
    row.status = `REPARSE FAIL: ${error?.message ?? error}`;
    parseFailures += 1;
  }
}

const header = {
  grammar: 'grammar',
  abi: 'abi',
  bytes: 'bytes',
  loadMs: 'load ms',
  hasError: 'hasError',
  errors: 'ERROR',
  missing: 'MISSING',
  reparseErrors: 'reparse ERROR',
  root: 'root',
  fixture: 'fixture',
};
const widths = {};
for (const key of Object.keys(header)) {
  widths[key] = Math.max(String(header[key]).length, ...rows.map((r) => String(r[key]).length));
}
const line = (r) =>
  [
    pad(r.grammar, widths.grammar),
    pad(r.abi, widths.abi, true),
    pad(r.bytes, widths.bytes, true),
    pad(r.loadMs, widths.loadMs, true),
    pad(r.hasError, widths.hasError),
    pad(r.errors, widths.errors, true),
    pad(r.missing, widths.missing, true),
    pad(r.reparseErrors, widths.reparseErrors, true),
    pad(r.root, widths.root),
    pad(r.fixture, widths.fixture),
  ].join('  ');

const out = [];
out.push(`node ${process.version} · runtime ${basename(RUNTIME_PATH)} · LANGUAGE_VERSION ${LANGUAGE_VERSION} · MIN_COMPATIBLE_VERSION ${MIN_COMPATIBLE_VERSION} · Parser.init ${initMs} ms`);
out.push('');
out.push(line(header));
out.push('-'.repeat(line(header).length));
for (const row of rows) {
  out.push(line(row) + (row.status === 'ok' ? '' : `  << ${row.status} >>`));
}
const withErrors = rows.filter((r) => r.hasError === true).length;
const noFixture = rows.filter((r) => r.status === 'no fixture').length;
out.push('');
out.push(
  `${rows.length} grammars: ${rows.length - loadFailures} loaded, ` +
    `${withErrors} with ERROR nodes, ${drifts} drifting, ${parseFailures} parse failures, ${loadFailures} load failures, ${noFixture} without fixture`,
);
process.stdout.write(out.join('\n') + '\n');

// Plan T2: every grammar must parse its fixture cleanly and must have a fixture at all.
if (loadFailures > 0 || parseFailures > 0 || drifts > 0 || withErrors > 0 || noFixture > 0) process.exit(1);
