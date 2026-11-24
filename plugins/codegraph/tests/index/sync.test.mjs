import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase, close } from '../../src/store/db.mjs';
import { replaceFile, takeDirty, dirtyCount, deleteFile, listFiles as listIndexed } from '../../src/store/repo.mjs';
import { consumeDirtyLog, statSweep, watch, normalizeDirtyPath } from '../../src/index/sync.mjs';
import { indexDir, dirtyLogPath, dirtyOffsetPath } from '../../src/paths.mjs';
import { loadSpecs } from '../../src/languages/registry.mjs';
import { scratchDir, rmrf, writeProject, sleep, touch, useScratchData, SAMPLE } from './_helpers.mjs';

const data = useScratchData('data-sync');
const dirs = [];
const open = [];
afterEach(() => {
  for (const db of open.splice(0)) close(db);
  for (const d of dirs.splice(0)) rmrf(d);
});
after(() => rmrf(data));

function memDb() {
  const db = openDatabase(':memory:');
  open.push(db);
  return db;
}

const fileRow = (p, extra = {}) => ({ path: p, lang: 'typescript', hash: `${p}#1`, mtimeMs: 1000, size: 10, parseOk: true, errorNodes: 0, indexedAt: 1000, ...extra });

describe('normalizeDirtyPath', () => {
  test('accepts relative paths with either separator, a ./ prefix and absolute paths inside root; rejects outside', () => {
    const root = path.resolve(scratchDir('sync-norm'));
    dirs.push(root);
    assert.equal(normalizeDirtyPath(root, 'src/a.ts'), 'src/a.ts');
    assert.equal(normalizeDirtyPath(root, '.\\src\\a.ts'), 'src/a.ts');
    assert.equal(normalizeDirtyPath(root, path.join(root, 'src', 'a.ts')), 'src/a.ts');
    assert.equal(normalizeDirtyPath(root, path.resolve(root, '..', 'elsewhere.ts')), null);
    assert.equal(normalizeDirtyPath(root, '  '), null);
    assert.equal(normalizeDirtyPath(root, '../escape.ts'), null);
  });

  test('normalizes "." and ".." segments and rejects anything that climbs out of the root, wherever the ".." sits', () => {
    const root = path.resolve(scratchDir('sync-norm-dotdot'));
    dirs.push(root);
    assert.equal(normalizeDirtyPath(root, 'sub/../../outside/secret.ts'), null, 'a leading-".." check alone lets this through');
    assert.equal(normalizeDirtyPath(root, 'a/../../x.ts'), null);
    assert.equal(normalizeDirtyPath(root, 'a/./b/../c.ts'), 'a/c.ts', 'inner ".." that stays inside is fine');
    assert.equal(normalizeDirtyPath(root, '././src//a.ts'), 'src/a.ts');
    assert.equal(normalizeDirtyPath(root, '.'), null);
    assert.equal(normalizeDirtyPath(root, 'src/..'), null);
    assert.equal(normalizeDirtyPath(root, '/etc/passwd'), null);
    assert.equal(normalizeDirtyPath(root, path.resolve(root, 'src', '..', 'src', 'a.ts')), 'src/a.ts', 'absolute inside root after normalization');
    assert.equal(normalizeDirtyPath(root, `${root}${path.sep}..${path.sep}secret.ts`), null, 'absolute that climbs out');
  });
});

describe('consumeDirtyLog', () => {
  test('does nothing and creates nothing when the index directory is missing', () => {
    const root = scratchDir('sync-nodir');
    dirs.push(root);
    const db = memDb();
    assert.deepEqual(consumeDirtyLog(root, db), { lines: 0, paths: 0 });
    assert.equal(fs.existsSync(indexDir(root)), false);
  });

  test('reads whole lines from the recorded offset, marks paths dirty and advances byte-wise', () => {
    const root = scratchDir('sync-log');
    dirs.push(root);
    fs.mkdirSync(indexDir(root), { recursive: true });
    const db = memDb();
    assert.deepEqual(consumeDirtyLog(root, db), { lines: 0, paths: 0 }, 'no log yet');
    assert.equal(fs.existsSync(dirtyOffsetPath(root)), false, 'nothing to consume, nothing written');

    const line1 = `${Date.now()}\tsrc/a.ts\n`;
    const line2 = `${Date.now()}\t.\\src\\deep\\b.ts\n`;
    const partial = `${Date.now()}\tsrc/c.ts`;
    fs.writeFileSync(dirtyLogPath(root), line1 + line2 + partial);
    assert.deepEqual(consumeDirtyLog(root, db), { lines: 2, paths: 2 });
    const expectedOffset = Buffer.byteLength(line1 + line2);
    assert.equal(fs.readFileSync(dirtyOffsetPath(root), 'utf8'), String(expectedOffset));
    assert.deepEqual(takeDirty(db).map((d) => d.path).sort(), ['src/a.ts', 'src/deep/b.ts']);

    // Only new bytes are read; the earlier partial line completes now.
    fs.appendFileSync(dirtyLogPath(root), '\n');
    assert.deepEqual(consumeDirtyLog(root, db), { lines: 1, paths: 1 });
    assert.deepEqual(takeDirty(db).map((d) => d.path), ['src/c.ts']);
    assert.equal(consumeDirtyLog(root, db).lines, 0, 'at EOF');
  });

  test('malformed lines are skipped but still consumed; the offset resets when the log shrinks', () => {
    const root = scratchDir('sync-log-malformed');
    dirs.push(root);
    fs.mkdirSync(indexDir(root), { recursive: true });
    const db = memDb();
    // "no-tab-here" has no field separator, the empty line is nothing, and a line that
    // starts with the tab has an empty mtime: all three are consumed but not marked.
    fs.writeFileSync(dirtyLogPath(root), 'no-tab-here\n\n\tleading-tab.ts\n12345\tgood.ts\n');
    assert.deepEqual(consumeDirtyLog(root, db), { lines: 3, paths: 1 });
    assert.deepEqual(takeDirty(db).map((d) => d.path), ['good.ts']);

    fs.writeFileSync(dirtyLogPath(root), '1\tshort.ts\n');
    assert.deepEqual(consumeDirtyLog(root, db), { lines: 1, paths: 1 });
    assert.deepEqual(takeDirty(db).map((d) => d.path), ['short.ts']);
    assert.equal(dirtyCount(db), 0);
  });

  test('an unreadable offset file means start from zero', () => {
    const root = scratchDir('sync-log-offset');
    dirs.push(root);
    fs.mkdirSync(indexDir(root), { recursive: true });
    fs.writeFileSync(dirtyOffsetPath(root), 'garbage');
    const db = memDb();
    fs.writeFileSync(dirtyLogPath(root), '1\ta.ts\n');
    assert.deepEqual(consumeDirtyLog(root, db), { lines: 1, paths: 1 });
  });
});

describe('statSweep', () => {
  test('marks files whose mtime or size changed, or that vanished; throttles per connection', async () => {
    const root = scratchDir('sync-sweep');
    dirs.push(root);
    writeProject(root, { 'same.ts': SAMPLE, 'touched.ts': SAMPLE, 'grown.ts': SAMPLE, 'gone.ts': SAMPLE, 'sub/renamed.ts': SAMPLE });
    const db = memDb();
    const rows = ['same.ts', 'touched.ts', 'grown.ts', 'gone.ts', 'sub/renamed.ts'].map((p) => {
      const st = fs.statSync(path.join(root, p));
      return fileRow(p, { mtimeMs: Math.trunc(st.mtimeMs), size: st.size });
    });
    for (const r of rows) replaceFile(db, r, {});
    fs.unlinkSync(path.join(root, 'gone.ts'));
    touch(path.join(root, 'touched.ts'));
    fs.appendFileSync(path.join(root, 'grown.ts'), '\n// more\n');
    fs.renameSync(path.join(root, 'sub/renamed.ts'), path.join(root, 'sub/renamed2.ts'));

    const first = await statSweep(db, { root });
    assert.equal(first.skipped, false);
    assert.equal(first.scanned, 5);
    assert.equal(first.changed, 4);
    assert.deepEqual(takeDirty(db).map((d) => d.path).sort(), ['gone.ts', 'grown.ts', 'sub/renamed.ts', 'touched.ts']);

    const throttled = await statSweep(db, { root });
    assert.deepEqual(throttled, { skipped: true, reason: 'throttled' });
    const forced = await statSweep(db, { root, force: true });
    assert.equal(forced.skipped, false);
    assert.equal(forced.changed, 4, 'still different, so still marked');

    // Bring the database back in sync with the disk: nothing should be dirty any more.
    deleteFile(db, 'gone.ts');
    deleteFile(db, 'sub/renamed.ts');
    for (const r of listIndexed(db)) {
      const st = fs.statSync(path.join(root, r.path));
      replaceFile(db, fileRow(r.path, { mtimeMs: Math.trunc(st.mtimeMs), size: st.size }), {});
    }
    takeDirty(db);
    const clean = await statSweep(db, { root, force: true });
    assert.equal(clean.changed, 0);
    assert.equal(dirtyCount(db), 0);
  });

  test('skips above 20k files unless forced', async () => {
    const root = scratchDir('sync-sweep-many');
    dirs.push(root);
    const db = memDb();
    db.exec('BEGIN');
    for (let i = 0; i < 20001; i++) replaceFile(db, fileRow(`f${i}.ts`), {});
    db.exec('COMMIT');
    const skipped = await statSweep(db, { root });
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.reason, 'too-many-files');
    assert.equal(skipped.files, 20001);
    const forced = await statSweep(db, { root, force: true });
    assert.equal(forced.skipped, false);
    assert.equal(forced.changed, 20001, 'none of the files exist on disk');
  });
});

// The watcher restarts its debounce on every event, and Windows can report a change to a
// directory more than a second after the write (something else on the machine enumerating it).
// So wait for the flush instead of guessing when it happened.
async function untilDirty(db, atLeast, limitMs = 12_000) {
  const deadline = Date.now() + limitMs;
  while (dirtyCount(db) < atLeast && Date.now() < deadline) await sleep(100);
  return dirtyCount(db);
}

describe('watch', () => {
  test('marks changed paths dirty after a 2 s debounce and stops on close()', async () => {
    const root = scratchDir('sync-watch');
    dirs.push(root);
    writeProject(root, { 'a.ts': SAMPLE, 'sub/b.ts': SAMPLE });
    const db = memDb();
    const w = watch(root, db);
    try {
      fs.appendFileSync(path.join(root, 'a.ts'), '\n// edit\n');
      writeProject(root, { 'sub/c.ts': SAMPLE });
      await sleep(600);
      assert.equal(dirtyCount(db), 0, 'debounce window still open');
      await untilDirty(db, 2);
      assert.deepEqual(takeDirty(db).map((d) => d.path).sort(), ['a.ts', 'sub/c.ts']);

      w.close();
      fs.appendFileSync(path.join(root, 'sub/b.ts'), '\n// late edit\n');
      await sleep(2400);
      assert.equal(dirtyCount(db), 0, 'closed watcher marks nothing');
    } finally {
      w.close();
    }
  });

  test('with specs, build output never reaches the dirty queue (a test run writes thousands of such files)', async () => {
    const root = scratchDir('sync-watch-specs');
    dirs.push(root);
    writeProject(root, { 'a.ts': SAMPLE });
    const db = memDb();
    const w = watch(root, db, { specs: await loadSpecs() });
    try {
      // What a test/build run leaves behind: source maps, build info, snapshots, logs.
      writeProject(root, {
        'dist/a.js.map': '{"version":3}',
        'tsconfig.tsbuildinfo': '{}',
        '__snapshots__/a.test.ts.snap': 'x',
        'out.log': 'x',
        'b.ts': SAMPLE,
      });
      await untilDirty(db, 1);
      assert.deepEqual(takeDirty(db).map((d) => d.path), ['b.ts'], 'only files a language pack claims are marked');
      // Every event has been flushed by now; nothing else may follow.
      await sleep(2400);
      assert.equal(dirtyCount(db), 0, 'build output is never marked, late events included');
    } finally {
      w.close();
    }
  });

  test('ignores events under the index directory when it lives inside the root', async () => {
    const root = scratchDir('sync-watch-self');
    dirs.push(root);
    writeProject(root, { 'a.ts': SAMPLE });
    const nestedData = path.join(root, '.codegraph-data');
    process.env.ZCODE_PLUGIN_DATA = nestedData;
    try {
      const db = memDb();
      const w = watch(root, db);
      fs.mkdirSync(indexDir(root), { recursive: true });
      fs.writeFileSync(path.join(indexDir(root), 'graph.db'), 'x');
      fs.appendFileSync(path.join(root, 'a.ts'), '\n// edit\n');
      await sleep(2400);
      assert.deepEqual(takeDirty(db).map((d) => d.path), ['a.ts']);
      w.close();
    } finally {
      process.env.ZCODE_PLUGIN_DATA = data;
    }
  });
});
