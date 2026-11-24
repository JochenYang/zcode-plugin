// Performance record for the store lane (not an assertion of the numbers):
// one replaceAllForFile writing 10,000 symbols + 30,000 refs, then 1,000
// searchSymbols calls. Run with `node --test` and read the [perf] lines.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, close } from '../../src/store/db.mjs';
import { USAGE_MAX_REFS, replaceAllForFile, searchSymbols, setRefResolution, symbolsInFile, refsInFile, upsertFile } from '../../src/store/repo.mjs';
import { search as graphSearch } from '../../src/graph/queries.mjs';

const open = [];

afterEach(() => {
  const entries = open.splice(0);
  for (const { db } of entries) if (db) close(db);
  for (const dir of new Set(entries.map(e => e.dir))) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-store-perf-'));
  const entry = { dir, db: null };
  open.push(entry);
  entry.db = openDatabase(path.join(dir, 'graph.db'));
  return entry;
}

const percentile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

test('perf: 10k symbols + 30k refs in one replace, 1k searches', () => {
  const { db } = tmpDb();
  const fileId = upsertFile(db, { path: 'big.ts', lang: 'ts', hash: 'h', mtimeMs: 1, size: 1, parseOk: true, errorNodes: 0, indexedAt: 1 });

  // Every 10th symbol is a class; the nine after it are its methods.
  const SYMBOLS = 10000;
  const REFS = 30000;
  const symbols = new Array(SYMBOLS);
  for (let i = 0; i < SYMBOLS; i++) {
    const isClass = i % 10 === 0;
    symbols[i] = {
      kind: isClass ? 'class' : 'method',
      name: isClass ? `Thing${i}` : `method${i}`,
      qual: isClass ? `Thing${i}` : `Thing${i - (i % 10)}.method${i}`,
      startLine: i + 1,
      endLine: i + 1,
      startCol: 0,
      signature: isClass ? `class Thing${i}` : `method${i}(): void`,
      parent: isClass ? null : i - (i % 10),
    };
  }
  const refs = new Array(REFS);
  for (let i = 0; i < REFS; i++) {
    const target = (i * 7919) % SYMBOLS;
    refs[i] = { name: `method${target}`, kind: 'call', startLine: (i % SYMBOLS) + 1, startCol: 4, endLine: (i % SYMBOLS) + 1, symbol: i % SYMBOLS };
  }

  const t0 = performance.now();
  const { symbolIds } = replaceAllForFile(db, fileId, { symbols, refs, imports: [] });
  const writeMs = performance.now() - t0;
  assert.equal(symbolIds.length, SYMBOLS);
  assert.equal(symbolsInFile(db, 'big.ts').length, SYMBOLS);
  assert.equal(refsInFile(db, fileId).length, REFS);

  // Method names only: every 10th symbol is a class ("Thing<N>"), skip those.
  const queries = Array.from({ length: 100 }, (_, i) => {
    const n = i * 37 + 1;
    return `method${n % 10 === 0 ? n + 1 : n}`;
  });
  const samples = new Array(1000);
  for (let i = 0; i < samples.length; i++) {
    const t = performance.now();
    const rows = searchSymbols(db, queries[i % queries.length]);
    samples[i] = performance.now() - t;
    assert.ok(rows.length >= 1, `query ${queries[i % queries.length]} hits`);
  }
  samples.sort((a, b) => a - b);

  console.log(`[perf] replaceAllForFile: ${SYMBOLS} symbols + ${REFS} refs in ${writeMs.toFixed(0)} ms`);
  console.log(
    `[perf] searchSymbols x${samples.length}: p50 ${percentile(samples, 0.5).toFixed(3)} ms, ` +
    `p95 ${percentile(samples, 0.95).toFixed(3)} ms, max ${samples[samples.length - 1].toFixed(3)} ms`
  );
});

test('perf: search whose leading rows carry usage counts (a hub and two ordinary symbols)', () => {
  const { db } = tmpDb();
  const file = (path) => upsertFile(db, { path, lang: 'ts', hash: path, mtimeMs: 1, size: 1, parseOk: true, errorNodes: 0, indexedAt: 1 });
  // One query ("calc") reaches all three, so they are the leading rows together.
  const loads = [['calcHub', USAGE_MAX_REFS + 500], ['calcMethod', 1500], ['calcHelper', 100]];
  const { symbolIds } = replaceAllForFile(db, file('src/lib.ts'), {
    symbols: loads.map(([name], i) => ({ kind: 'function', name, qual: name, startLine: i + 1, endLine: i + 1, startCol: 0, signature: `${name}(): void`, parent: null })),
    refs: [],
    imports: [],
  });
  const user = file('src/use.ts');
  replaceAllForFile(db, user, {
    symbols: [],
    // The hub is over USAGE_MAX_REFS and so only counted; the other two are broken down by file.
    refs: loads.flatMap(([name, n]) => Array.from({ length: n }, (_, i) => ({ name, kind: 'call', startLine: i + 1, startCol: 2, endLine: i + 1 }))),
    imports: [],
  });
  setRefResolution(db, refsInFile(db, user).map((ref) => ({ refId: ref.id, targetId: symbolIds[loads.findIndex(([name]) => name === ref.name)], resolution: '=' })));

  const samples = new Array(300);
  let rows;
  for (let i = 0; i < samples.length; i++) {
    const t = performance.now();
    rows = graphSearch(db, { query: 'calc' });
    samples[i] = performance.now() - t;
  }
  assert.equal(rows.length, loads.length);
  const usageOf = (name) => rows.find((row) => row.name === name).usage;
  assert.deepEqual(usageOf('calcHub'), { refs: USAGE_MAX_REFS + 500, capped: true });
  assert.deepEqual(usageOf('calcMethod'), { refs: 1500, files: 1, inSource: 1, byName: 0 });
  assert.deepEqual(usageOf('calcHelper'), { refs: 100, files: 1, inSource: 1, byName: 0 });
  samples.sort((a, b) => a - b);

  console.log(
    `[perf] queries.search x${samples.length}, leading rows with ${USAGE_MAX_REFS + 500} (capped) + 1500 + 100 references: ` +
    `p50 ${percentile(samples, 0.5).toFixed(3)} ms, p95 ${percentile(samples, 0.95).toFixed(3)} ms, max ${samples[samples.length - 1].toFixed(3)} ms`
  );
});
