// Performance record for the indexer lane (numbers are printed, not asserted):
// first full build of 200 real TypeScript files from the research clone, then a
// single-file incremental sync through dirty.log and an mtime sweep of the lot.
// Run with `node --test` and read the [perf] lines.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Indexer } from '../../src/index/indexer.mjs';
import { statSweep } from '../../src/index/sync.mjs';
import { countFiles } from '../../src/store/repo.mjs';
import { dirtyLogPath } from '../../src/paths.mjs';
import { REPO, scratchDir, rmrf, closeAll, touch, sleep, useScratchData } from './_helpers.mjs';

const SOURCE = path.join(REPO, '.tmp', 'codegraph-research', 'codegraph', 'src');
const FILES = 200;

const data = useScratchData('data-perf');
const dirs = [];
const indexers = [];
after(async () => {
  await closeAll(indexers);
  for (const d of dirs.splice(0)) rmrf(d);
  rmrf(data);
});

function copySources(dest) {
  const list = [];
  const stack = [SOURCE];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile() && entry.name.endsWith('.ts')) list.push(abs);
    }
  }
  list.sort();
  const chosen = list.slice(0, FILES);
  for (const abs of chosen) {
    const rel = path.relative(SOURCE, abs);
    const target = path.join(dest, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(abs, target);
  }
  return chosen.map((abs) => path.relative(SOURCE, abs).split(path.sep).join('/'));
}

test('perf: 200-file first build, single-file incremental, mtime sweep', { timeout: 180_000 }, async () => {
  if (!fs.existsSync(SOURCE)) {
    console.log(`[perf] skipped: ${SOURCE} not present`);
    return;
  }
  const dir = scratchDir('perf');
  dirs.push(dir);
  const rels = copySources(dir);
  assert.equal(rels.length, FILES);

  const workers = Number(process.env.CODEGRAPH_PERF_WORKERS) || 4;
  const ix = new Indexer({ root: dir, config: { minFilesToAutoIndex: 0 }, workers });
  indexers.push(ix);
  const progress = [];
  ix.onProgress((e) => progress.push(e));

  const t0 = performance.now();
  const res = await ix.ensureFresh({ maxWaitMs: 120_000 });
  const buildMs = performance.now() - t0;
  assert.equal(res.state, 'ready');
  assert.equal(countFiles(ix.db), FILES);
  const symbols = ix.db.prepare('SELECT COUNT(*) AS c FROM symbols').get().c;
  const refs = ix.db.prepare('SELECT COUNT(*) AS c FROM refs').get().c;

  // Single-file incremental: one edit reported through dirty.log (hook path).
  const target = rels[Math.floor(rels.length / 2)];
  await statSweep(ix.db, { root: dir }); // arm the throttle so only dirty.log drives this sync
  fs.appendFileSync(path.join(dir, target), '\nexport function __perfProbe__() { return 1; }\n');
  touch(path.join(dir, target));
  fs.appendFileSync(dirtyLogPath(dir), `${Date.now()}\t${target}\n`);
  const t1 = performance.now();
  const inc = await ix.ensureFresh();
  const incMs = performance.now() - t1;
  assert.equal(inc.state, 'ready');
  assert.equal(inc.dirty, 0);

  // Touch one file without changing content: a full scan plus a hash-only re-check.
  touch(path.join(dir, rels[0]));
  const t2 = performance.now();
  const sweep = await statSweep(ix.db, { root: dir, force: true });
  const sweepMs = performance.now() - t2;
  assert.equal(sweep.changed, 1);
  const t3 = performance.now();
  await ix.ensureFresh();
  const unchangedMs = performance.now() - t3;

  // Non-force rebuild: everything skipped by mtime/size.
  const t4 = performance.now();
  await ix.buildAll();
  const rebuildMs = performance.now() - t4;

  const first = progress[0];
  const last = progress.at(-1);
  console.log(`[perf] first build: ${FILES} files, ${symbols} symbols, ${refs} refs, ${workers} workers -> ${Math.round(buildMs)} ms (${(buildMs / FILES).toFixed(1)} ms/file); progress events ${progress.length} (${first?.filesDone}..${last?.filesDone}/${last?.filesTotal}, ${last?.state})`);
  console.log(`[perf] single-file incremental via dirty.log (incl. stat scan of ${FILES} files): ${incMs.toFixed(1)} ms`);
  console.log(`[perf] mtime sweep of ${sweep.scanned} files: ${sweepMs.toFixed(1)} ms; unchanged-content sync: ${unchangedMs.toFixed(1)} ms`);
  console.log(`[perf] non-force rebuild (walk + stat + all skipped): ${rebuildMs.toFixed(1)} ms`);
  await sleep(10);
});
