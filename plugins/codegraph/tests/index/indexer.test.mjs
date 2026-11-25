import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Indexer, shouldAutoIndex } from '../../src/index/indexer.mjs';
import { statSweep } from '../../src/index/sync.mjs';
import { acquireLock } from '../../src/index/lock.mjs';
import { readStatus, writeStatus } from '../../src/index/status.mjs';
import {
  symbolsInFile, listFiles as listIndexed, countFiles, getFileByPath, markDirty, takeDirty, dirtyCount, deleteFile,
} from '../../src/store/repo.mjs';
import { dbPath, indexDir, lockPath, dirtyLogPath, statusPath } from '../../src/paths.mjs';
import { PLUGIN_VERSION } from '../../src/version.mjs';
import { PLUGIN, scratchDir, rmrf, writeProject, closeAll, touch, sleep, useScratchData, SAMPLE, BROKEN, git } from './_helpers.mjs';

const data = useScratchData('data-indexer');
const indexers = [];
const dirs = [];
afterEach(async () => {
  await closeAll(indexers);
  for (const d of dirs.splice(0)) rmrf(d);
});
after(() => rmrf(data));

function project(name, files) {
  const dir = scratchDir(name);
  dirs.push(dir);
  writeProject(dir, files);
  return dir;
}

function create(root, config = {}, workers = 2) {
  const ix = new Indexer({ root, config, workers });
  indexers.push(ix);
  return ix;
}

const indexedAt = (ix) => Object.fromEntries(listIndexed(ix.db).map((r) => [r.path, r.indexed_at]));
const appendDirty = (root, rel) => fs.appendFileSync(dirtyLogPath(root), `${Date.now()}\t${rel}\n`);

describe('shouldAutoIndex', () => {
  test('gates on the configured minimum, the unsafe flag, autoIndex and maxFiles', () => {
    assert.equal(shouldAutoIndex({ config: {}, unsafe: false, supportedCount: 29, total: 29 }).ok, false);
    assert.equal(shouldAutoIndex({ config: {}, unsafe: false, supportedCount: 30, total: 30 }).ok, true);
    assert.equal(shouldAutoIndex({ config: {}, unsafe: false, supportedCount: 29, total: 29 }).reason, 'below-min-files');
    assert.equal(shouldAutoIndex({ config: { autoIndex: false }, unsafe: false, supportedCount: 100, total: 100 }).reason, 'auto-index-disabled');
    assert.equal(shouldAutoIndex({ config: {}, unsafe: true, supportedCount: 100, total: 100 }).reason, 'unsafe-root');
    assert.equal(shouldAutoIndex({ config: { maxFiles: 50 }, unsafe: false, supportedCount: 40, total: 51 }).reason, 'too-many-files');
    assert.equal(shouldAutoIndex({ config: { maxFiles: 50 }, unsafe: false, supportedCount: 40, total: 50 }).ok, true);
    assert.equal(shouldAutoIndex({ config: { minFilesToAutoIndex: 0 }, unsafe: false, supportedCount: 0, total: 0 }).ok, true);
    assert.match(shouldAutoIndex({ config: {}, unsafe: false, supportedCount: 3, total: 3 }).detail, /minFilesToAutoIndex is 30/);
  });
});

describe('Indexer', () => {
  test('first build indexes every supported file with symbols, keeps broken files as parse errors and writes status.json', async () => {
    const dir = project('ix-build', {
      'src/a.ts': SAMPLE,
      'src/b.ts': SAMPLE.replace('parseConfig', 'parseConfigB'),
      'broken.ts': BROKEN,
      'notes.txt': 'not code',
    });
    const ix = create(dir);
    const events = [];
    ix.onProgress((e) => events.push(e));

    const res = await ix.buildAll();
    assert.equal(res.state, 'ready');
    assert.equal(countFiles(ix.db), 3);
    assert.deepEqual(listIndexed(ix.db).map((r) => r.path), ['broken.ts', 'src/a.ts', 'src/b.ts']);

    const names = symbolsInFile(ix.db, 'src/a.ts').map((s) => s.name);
    assert.ok(names.includes('parseConfig') && names.includes('Loader') && names.includes('loadAll'), `symbols: ${names}`);
    assert.ok(names.includes('load'), 'methods are symbols too');
    assert.ok(symbolsInFile(ix.db, 'src/b.ts').some((s) => s.name === 'parseConfigB'));
    assert.ok(ix.db.prepare('SELECT COUNT(*) AS c FROM refs').get().c > 0, 'refs stored');
    assert.ok(ix.db.prepare('SELECT COUNT(*) AS c FROM refs WHERE resolution IS NOT NULL').get().c > 0, 'refs were handed to the resolver');
    assert.ok(ix.db.prepare('SELECT COUNT(*) AS c FROM imports').get().c > 0, 'imports stored');

    const broken = getFileByPath(ix.db, 'broken.ts');
    assert.equal(broken.parse_ok, 0);
    assert.ok(broken.error_nodes > 0);
    const b = getFileByPath(ix.db, 'src/b.ts');
    assert.equal(b.mtime_ms, Math.trunc(fs.statSync(path.join(dir, 'src/b.ts')).mtimeMs), 'mtimeMs is truncated');
    assert.equal(b.size, Buffer.byteLength(SAMPLE.replace('parseConfig', 'parseConfigB')));
    assert.equal(b.lang, 'typescript');

    const json = readStatus(dir);
    assert.equal(json.state, 'ready');
    assert.equal(json.filesTotal, 3);
    assert.equal(json.filesDone, 3);
    assert.equal(json.symbols, ix.db.prepare('SELECT COUNT(*) AS c FROM symbols').get().c);
    assert.deepEqual(json.languages, { typescript: 3 });
    assert.equal(json.pluginVersion, PLUGIN_VERSION);
    assert.equal(json.root, dir.split(path.sep).join('/'));
    assert.equal(json.reason, null);
    assert.equal(json.stale, 0);
    assert.ok(Number.isInteger(json.indexedAt) && json.indexedAt > 0);

    assert.equal(events[0].state, 'building');
    assert.equal(events[0].filesDone, 0);
    assert.equal(events.at(-1).state, 'ready');
    assert.equal(events.at(-1).filesTotal, 3);
    assert.equal(events.at(-1).filesDone, 3);
    for (let i = 1; i < events.length; i++) assert.ok(events[i].filesDone >= events[i - 1].filesDone, 'progress never goes backwards');
    // The lock is held only while writing: after the build an idle instance must not
    // keep other sessions on the project read-only.
    assert.equal(fs.existsSync(lockPath(dir)), false, 'lock released once the build is over');
  });

  test('ensureFresh builds in the background when the index is empty and auto-indexing allows it', async () => {
    const dir = project('ix-auto', { 'a.ts': SAMPLE, 'b.ts': SAMPLE });
    const ix = create(dir, { minFilesToAutoIndex: 2 });
    assert.equal(countFiles(ix.db), 0);
    const res = await ix.ensureFresh({ maxWaitMs: 20000 });
    assert.equal(res.state, 'ready');
    assert.equal(res.partial, false);
    assert.equal(res.readOnly, false);
    assert.equal(countFiles(ix.db), 2);
    assert.equal(readStatus(dir).state, 'ready');
    // A second call is a cheap no-op.
    const again = await ix.ensureFresh();
    assert.equal(again.state, 'ready');
    assert.equal(countFiles(ix.db), 2);
  });

  test('below minFilesToAutoIndex the index stays empty with a machine-readable reason', async () => {
    const dir = project('ix-few', { 'a.ts': SAMPLE, 'b.ts': SAMPLE });
    const ix = create(dir);
    const res = await ix.ensureFresh({ maxWaitMs: 500 });
    assert.equal(res.state, 'empty');
    assert.equal(res.partial, false);
    assert.equal(res.reason, 'below-min-files');
    assert.equal(countFiles(ix.db), 0);
    const st = ix.status();
    assert.equal(st.state, 'empty');
    assert.equal(st.reason, 'below-min-files');
    assert.match(st.reasonDetail, /2 supported file\(s\), minFilesToAutoIndex is 30/);
    assert.equal(st.parseErrors, 0);
    const json = readStatus(dir);
    assert.equal(json.state, 'empty');
    assert.equal(json.reason, 'below-min-files');
    assert.equal(json.filesTotal, 0);
    assert.equal(json.error, null);
    assert.equal(fs.existsSync(dirtyLogPath(dir)), false, 'nothing was indexed, so nothing consumed');
  });

  test('autoIndex: false refuses with its own reason and never walks', async () => {
    const dir = project('ix-disabled', { 'a.ts': SAMPLE });
    const ix = create(dir, { autoIndex: false, minFilesToAutoIndex: 0 });
    const res = await ix.ensureFresh();
    assert.equal(res.state, 'empty');
    assert.equal(res.reason, 'auto-index-disabled');
    assert.equal(readStatus(dir).reason, 'auto-index-disabled');
    assert.equal(countFiles(ix.db), 0);
  });

  test('incremental sync driven by dirty.log re-parses only the changed file', async () => {
    const dir = project('ix-incremental', { 'a.ts': SAMPLE, 'b.ts': SAMPLE, 'c.ts': SAMPLE });
    const ix = create(dir, { minFilesToAutoIndex: 1 });
    await ix.buildAll();
    const before = indexedAt(ix);
    // Arm the sweep throttle so that only dirty.log can report the change.
    await statSweep(ix.db, { root: dir });
    await sleep(5);

    fs.appendFileSync(path.join(dir, 'b.ts'), '\nexport function addedLater() { return 1; }\n');
    touch(path.join(dir, 'b.ts'));
    appendDirty(dir, 'b.ts');
    const res = await ix.ensureFresh();
    assert.equal(res.state, 'ready');
    assert.equal(res.dirty, 0);
    const after = indexedAt(ix);
    assert.equal(after['a.ts'], before['a.ts'], 'untouched files keep indexed_at');
    assert.equal(after['c.ts'], before['c.ts']);
    assert.ok(after['b.ts'] >= before['b.ts']);
    assert.ok(symbolsInFile(ix.db, 'b.ts').some((s) => s.name === 'addedLater'));
    assert.equal(symbolsInFile(ix.db, 'a.ts').length, symbolsInFile(ix.db, 'c.ts').length);
  });

  test('incremental sync driven by the mtime scan works without any hook', async () => {
    const dir = project('ix-sweep', { 'a.ts': SAMPLE, 'b.ts': SAMPLE });
    const ix = create(dir, { minFilesToAutoIndex: 1 });
    await ix.buildAll();
    const before = indexedAt(ix);
    await sleep(5);
    fs.appendFileSync(path.join(dir, 'a.ts'), '\nexport function fromScan() { return 2; }\n');
    touch(path.join(dir, 'a.ts'));
    const sweep = await statSweep(ix.db, { root: dir, force: true });
    assert.equal(sweep.changed, 1);
    assert.equal(ix.status().dirty, 1);
    await ix.ensureFresh();
    assert.ok(symbolsInFile(ix.db, 'a.ts').some((s) => s.name === 'fromScan'));
    assert.equal(indexedAt(ix)['b.ts'], before['b.ts']);
    assert.equal(ix.status().dirty, 0);
  });

  test('deleting a file removes its row, symbols and refs', async () => {
    const dir = project('ix-delete', { 'a.ts': SAMPLE, 'b.ts': SAMPLE });
    const ix = create(dir, { minFilesToAutoIndex: 1 });
    await ix.buildAll();
    assert.ok(symbolsInFile(ix.db, 'b.ts').length > 0);
    await statSweep(ix.db, { root: dir });
    fs.unlinkSync(path.join(dir, 'b.ts'));
    appendDirty(dir, 'b.ts');
    await ix.ensureFresh();
    assert.equal(getFileByPath(ix.db, 'b.ts'), null);
    assert.equal(symbolsInFile(ix.db, 'b.ts').length, 0);
    assert.equal(countFiles(ix.db), 1);
    assert.equal(ix.db.prepare('SELECT COUNT(*) AS c FROM refs WHERE file_id NOT IN (SELECT id FROM files)').get().c, 0);
    const st = readStatus(dir);
    assert.equal(st.filesTotal, 1);
    assert.equal(st.symbols, ix.db.prepare('SELECT COUNT(*) AS c FROM symbols').get().c);
  });

  test('a file that .gitignore ignores never enters the index through a dirty entry, and one it took up since leaves at its next sync', async () => {
    // The listing keeps ignored files out of a build. Between two listings a file arrives as a
    // dirty entry (a hook, the watcher), and that road applies the same rule (CONTRACTS.md §9).
    const dir = project('ix-gitignore', { 'src/a.ts': SAMPLE, '.gitignore': 'scratch/\nignored.ts\n' });
    git(dir, 'init', '-q');
    git(dir, 'add', 'src/a.ts'); // tracked: stays whatever .gitignore says later, as in the listing
    const ix = create(dir, { minFilesToAutoIndex: 1 });
    await ix.buildAll();
    assert.deepEqual(listIndexed(ix.db).map((r) => r.path), ['src/a.ts']);
    const variant = (name) => SAMPLE.replace('parseConfig', name);
    writeProject(dir, { 'scratch/new.ts': variant('parseConfigScratch'), 'ignored.ts': variant('parseConfigIgnored'), 'src/new.ts': variant('parseConfigNew') });
    markDirty(ix.db, ['scratch/new.ts', 'ignored.ts', 'src/new.ts']);
    await ix.ensureFresh();
    assert.deepEqual(listIndexed(ix.db).map((r) => r.path).sort(), ['src/a.ts', 'src/new.ts']);
    assert.equal(ix.status().dirty, 0, 'the ignored ones are dropped, not left to be retried');
    assert.equal(symbolsInFile(ix.db, 'src/new.ts').some((s) => s.name === 'parseConfigNew'), true);
    assert.equal(symbolsInFile(ix.db, 'ignored.ts').length, 0);

    // .gitignore takes up a file the index holds: its next sync drops it, without waiting for
    // the next listing; the tracked one is not reported by git and stays.
    writeProject(dir, { '.gitignore': 'scratch/\nignored.ts\nsrc/new.ts\nsrc/a.ts\n' });
    markDirty(ix.db, ['src/new.ts', 'src/a.ts']);
    await ix.ensureFresh();
    assert.deepEqual(listIndexed(ix.db).map((r) => r.path), ['src/a.ts']);
    assert.equal(symbolsInFile(ix.db, 'src/new.ts').length, 0, 'its symbols went with its row');

    // Without git there is no .gitignore to ask: the plain walk admits the file, and so does this road.
    const plain = project('ix-gitignore-nogit', { 'src/a.ts': SAMPLE, '.gitignore': 'ignored.ts\n' });
    const plainIx = create(plain, { minFilesToAutoIndex: 1 });
    await plainIx.buildAll();
    writeProject(plain, { 'ignored.ts': variant('parseConfigIgnored') });
    markDirty(plainIx.db, ['ignored.ts']);
    await plainIx.ensureFresh();
    assert.deepEqual(listIndexed(plainIx.db).map((r) => r.path).sort(), ['ignored.ts', 'src/a.ts']);
  });

  test('a file behind a directory link never enters the index, neither in a build nor through a dirty entry', async () => {
    // git walks into a junction on Windows and lists what is behind it as the project's own; a
    // hook or the watcher reports a file edited through one. A link can leave the project or
    // loop, so neither road admits it (CONTRACTS.md §9).
    const elsewhere = project('ix-link-elsewhere', { 'hidden.ts': SAMPLE.replace('parseConfig', 'parseConfigHidden'), 'deep/nested.ts': SAMPLE.replace('parseConfig', 'parseConfigNested') });
    const dir = project('ix-link', { 'src/a.ts': SAMPLE });
    git(dir, 'init', '-q');
    fs.symlinkSync(elsewhere, path.join(dir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const ix = create(dir, { minFilesToAutoIndex: 1 });
    await ix.buildAll();
    assert.deepEqual(listIndexed(ix.db).map((r) => r.path), ['src/a.ts'], 'the build leaves both out, the one right behind the link and the one below it');
    markDirty(ix.db, ['linked/hidden.ts', 'linked/deep/nested.ts']);
    await ix.ensureFresh();
    assert.deepEqual(listIndexed(ix.db).map((r) => r.path), ['src/a.ts']);
    assert.equal(ix.status().dirty, 0, 'dropped, not left to be retried');
  });

  test('same content with a new mtime only refreshes the fingerprint', async () => {
    const dir = project('ix-touch', { 'a.ts': SAMPLE });
    const ix = create(dir, { minFilesToAutoIndex: 1 });
    await ix.buildAll();
    const before = getFileByPath(ix.db, 'a.ts');
    touch(path.join(dir, 'a.ts'));
    await statSweep(ix.db, { root: dir, force: true });
    assert.equal(ix.status().dirty, 1);
    await ix.ensureFresh();
    const after = getFileByPath(ix.db, 'a.ts');
    assert.equal(after.hash, before.hash);
    assert.equal(after.indexed_at, before.indexed_at, 'no re-parse happened');
    assert.notEqual(after.mtime_ms, before.mtime_ms, 'but the fingerprint was refreshed so the scan stops flagging it');
    assert.equal(symbolsInFile(ix.db, 'a.ts').length, 7);
    await statSweep(ix.db, { root: dir, force: true });
    assert.equal(ix.status().dirty, 0);
  });

  test('unsupported, oversized, ignored-directory and unknown paths in dirty.log are dropped without errors', async () => {
    const dir = project('ix-dirty-misc', {
      'a.ts': SAMPLE,
      'notes.txt': 'x',
      'big.ts': `${SAMPLE}//${'z'.repeat(4_300_000)}`,
      'node_modules/dep/index.ts': SAMPLE,
      'generated/g.ts': SAMPLE,
    });
    const ix = create(dir, { minFilesToAutoIndex: 1, exclude: ['generated'] });
    await ix.buildAll();
    assert.deepEqual(listIndexed(ix.db).map((r) => r.path), ['a.ts']);
    await statSweep(ix.db, { root: dir });
    for (const rel of ['notes.txt', 'big.ts', 'missing.ts', '../outside.ts', 'node_modules/dep/index.ts', 'generated/g.ts']) appendDirty(dir, rel);
    const res = await ix.ensureFresh();
    assert.equal(res.state, 'ready');
    assert.equal(res.dirty, 0);
    assert.deepEqual(listIndexed(ix.db).map((r) => r.path), ['a.ts'], 'a hook-written dirty line cannot admit files the walker would skip');
  });

  test('a symlink reported through dirty.log is dropped like the walker would (lstat, not stat)', async () => {
    const dir = project('ix-symlink', { 'a.ts': SAMPLE });
    const outside = scratchDir('ix-symlink-outside');
    dirs.push(outside);
    fs.writeFileSync(path.join(outside, 'secret.ts'), 'export function outsideSecret(): number { return 42; }\n');
    try {
      fs.symlinkSync(path.join(outside, 'secret.ts'), path.join(dir, 'link.ts'), 'file');
    } catch (err) {
      if (!['EPERM', 'EACCES', 'ENOENT'].includes(err.code)) throw err;
      console.log('[symlink] this machine cannot create file symlinks: case skipped');
      return;
    }
    const ix = create(dir, { minFilesToAutoIndex: 0 });
    await ix.buildAll();
    assert.deepEqual(listIndexed(ix.db).map((r) => r.path), ['a.ts'], 'the walker never lists links');
    await statSweep(ix.db, { root: dir });
    appendDirty(dir, 'link.ts');
    const res = await ix.ensureFresh({ maxWaitMs: 20000 });
    assert.equal(res.state, 'ready');
    assert.equal(res.dirty, 0);
    assert.equal(getFileByPath(ix.db, 'link.ts'), null, 'a dirty line cannot index through a symlink');
    assert.equal(ix.db.prepare("SELECT COUNT(*) AS c FROM symbols WHERE name = 'outsideSecret'").get().c, 0);
  });

  test('a file that grows beyond maxFileBytes is dropped from the index', async () => {
    const dir = project('ix-grow', { 'a.ts': SAMPLE });
    const ix = create(dir, { minFilesToAutoIndex: 0, maxFileBytes: 1000 });
    await ix.buildAll();
    assert.equal(countFiles(ix.db), 1);
    fs.appendFileSync(path.join(dir, 'a.ts'), `\n// ${'x'.repeat(2000)}\n`);
    await statSweep(ix.db, { root: dir, force: true });
    await ix.ensureFresh({ maxWaitMs: 20000 });
    assert.equal(countFiles(ix.db), 0);
    assert.equal(readStatus(dir).state, 'empty');
    assert.equal(readStatus(dir).reason, 'no-supported-files');
    assert.equal(readStatus(dir).filesTotal, 0);
  });

  test('read-only while another pid holds the lock, recovers once it is released', async () => {
    const dir = project('ix-readonly', { 'a.ts': SAMPLE });
    const foreign = await acquireLock(lockPath(dir));
    assert.equal(foreign.acquired, true);
    const ix = create(dir, { minFilesToAutoIndex: 1 });
    // The constructor takes no lock; read-only is decided per write attempt.
    assert.equal(ix.readOnly, false);
    const r1 = await ix.ensureFresh();
    assert.equal(r1.readOnly, true);
    assert.equal(r1.state, 'empty');
    assert.equal(r1.reason, 'lock-held-read-only');
    assert.equal(countFiles(ix.db), 0);
    assert.equal(ix.status().readOnly, true);
    await assert.rejects(ix.buildAll(), /locked by another process/);
    assert.equal(fs.readFileSync(lockPath(dir), 'utf8').trim(), String(process.pid), 'the foreign lock is untouched');

    foreign.release();
    const r2 = await ix.ensureFresh({ maxWaitMs: 20000 });
    assert.equal(r2.readOnly, false);
    assert.equal(r2.state, 'ready');
    assert.equal(countFiles(ix.db), 1);
    assert.equal(ix.readOnly, false);
    // Held only while writing: the finished build gave the lock back.
    assert.equal(fs.existsSync(lockPath(dir)), false);
  });

  test('close() releases the lock, the watcher and the database so Windows can delete everything at once', async () => {
    const dir = project('ix-close', { 'a.ts': SAMPLE, 'sub/b.ts': SAMPLE });
    const ix = create(dir, { minFilesToAutoIndex: 1 });
    await ix.ensureFresh({ maxWaitMs: 20000 });
    assert.equal(countFiles(ix.db), 2);
    await ix.close();
    await ix.close();
    assert.equal(ix.closed, true);
    assert.equal(fs.existsSync(lockPath(dir)), false);
    assert.throws(() => ix.status(), /closed/);
    await assert.rejects(ix.ensureFresh(), /closed/);
    await assert.rejects(ix.buildAll(), /closed/);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(indexDir(dir), { recursive: true, force: true });
    assert.equal(fs.existsSync(dir), false);
    assert.equal(fs.existsSync(dbPath(dir)), false);
    dirs.splice(dirs.indexOf(dir), 1);
  });

  test('buildAll without force skips unchanged files; with force it re-indexes everything', async () => {
    const dir = project('ix-force', { 'a.ts': SAMPLE, 'b.ts': SAMPLE });
    const ix = create(dir);
    await ix.buildAll();
    const first = indexedAt(ix);
    await sleep(5);
    const second = await ix.buildAll();
    assert.equal(second.state, 'ready');
    assert.deepEqual(indexedAt(ix), first, 'unchanged files keep their indexed_at');
    await sleep(5);
    const third = await ix.buildAll({ force: true });
    assert.equal(third.state, 'ready');
    const after = indexedAt(ix);
    assert.ok(after['a.ts'] > first['a.ts'] && after['b.ts'] > first['b.ts']);
  });

  test('a first build and a force build load in bulk and leave the index complete', async () => {
    const dir = project('ix-bulk', {
      'a.ts': 'export function alpha(): number {\n  return 1;\n}\n',
      'b.ts': "import { alpha } from './a';\nexport function beta(): number {\n  return alpha();\n}\n",
    });
    const ix = create(dir);
    const db = ix.db;
    const schema = fs.readFileSync(path.join(PLUGIN, 'src', 'store', 'schema.sql'), 'utf8');
    const declared = [...schema.matchAll(/CREATE INDEX IF NOT EXISTS (\w+)\s+ON/g)].map((m) => m[1]).sort();
    const complete = () => {
      const present = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name").all().map((r) => r.name);
      assert.deepEqual(present, declared, 'every index of the schema exists');
      assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
      assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'sqlite_stat1'").get(), 'ANALYZE ran');
    };
    for (const force of [false, true, true]) {
      const r = await ix.buildAll({ force });
      assert.equal(r.state, 'ready');
      complete();
      assert.equal(countFiles(db), 2);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM refs WHERE resolution IS NULL').get().n, 0, 'resolved');
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM refs WHERE resolution = '=' AND name = 'alpha'").get().n, 1, 'b.ts -> a.alpha');
    }
  });

  test('buildAll prunes rows that fell out of the walked set when maxFiles shrinks', async () => {
    const dir = project('ix-max', { 'a.ts': SAMPLE, 'b.ts': SAMPLE, 'c.ts': SAMPLE });
    const ix = create(dir, { maxFiles: 2 });
    await ix.buildAll();
    assert.deepEqual(listIndexed(ix.db).map((r) => r.path), ['a.ts', 'b.ts']);
    await ix.close();
    const ix2 = create(dir, { maxFiles: 1 });
    await ix2.buildAll();
    assert.deepEqual(listIndexed(ix2.db).map((r) => r.path), ['a.ts']);
    assert.equal(ix2.db.prepare('SELECT COUNT(*) AS c FROM symbols WHERE file_id NOT IN (SELECT id FROM files)').get().c, 0);
  });

  test('languages restricts which packs are indexed; a narrowed list is applied by the next ensureFresh', async () => {
    const dir = project('ix-langs', { 'a.ts': SAMPLE });
    const ix = create(dir, { languages: ['typescript'], minFilesToAutoIndex: 1 });
    await ix.ensureFresh({ maxWaitMs: 20000 });
    assert.equal(countFiles(ix.db), 1);
    await ix.close();
    // The tree reconciliation walks with the new pack list: a.ts is no longer a
    // candidate, so its row is dropped instead of lingering until an explicit build.
    const ix2 = create(dir, { languages: ['python'], minFilesToAutoIndex: 0 });
    const kept = await ix2.ensureFresh({ maxWaitMs: 20000 });
    assert.equal(kept.state, 'empty');
    assert.equal(kept.reason, 'no-supported-files');
    assert.equal(countFiles(ix2.db), 0);
    assert.equal(ix2.db.prepare('SELECT COUNT(*) AS c FROM symbols').get().c, 0);
    const rebuilt = await ix2.buildAll();
    assert.equal(rebuilt.state, 'empty');
    assert.equal(readStatus(dir).reason, 'no-supported-files');
  });

  test('files added or removed without a hook are found by the tree reconciliation; the walk is throttled unless forced', async () => {
    const dir = project('ix-walk', { 'a.ts': SAMPLE, 'b.ts': SAMPLE, 'gen/x.ts': SAMPLE });
    const ix = create(dir, { minFilesToAutoIndex: 0 });
    await ix.buildAll();
    assert.deepEqual(listIndexed(ix.db).map((r) => r.path), ['a.ts', 'b.ts', 'gen/x.ts']);
    await ix.close();

    writeProject(dir, { 'c.ts': SAMPLE, 'sub/d.ts': SAMPLE });
    // `gen` becomes excluded: the file is unchanged on disk, so only a fresh listing can drop it.
    const ix2 = create(dir, { minFilesToAutoIndex: 0, exclude: ['gen'] });
    const first = await ix2.ensureFresh({ maxWaitMs: 20000 });
    assert.equal(first.state, 'ready');
    assert.deepEqual(listIndexed(ix2.db).map((r) => r.path), ['a.ts', 'b.ts', 'c.ts', 'sub/d.ts']);
    assert.ok(symbolsInFile(ix2.db, 'sub/d.ts').length > 0, 'the new file was indexed, not just marked dirty');
    assert.equal(readStatus(dir).filesTotal, 4);
    assert.equal(ix2.db.prepare("SELECT value FROM meta WHERE key = 'lastWalkAt'").get().value.trim().length > 10, true);

    // Within the 60 s window a second call trusts dirty.log and the mtime scan only.
    writeProject(dir, { 'late.ts': SAMPLE });
    const throttled = await ix2.ensureFresh({ maxWaitMs: 20000 });
    assert.equal(throttled.state, 'ready');
    assert.equal(getFileByPath(ix2.db, 'late.ts'), null, 'not walked again within the interval');
    // force bypasses both the mtime-scan throttle and the walk interval.
    const forced = await ix2.ensureFresh({ maxWaitMs: 20000, force: true });
    assert.equal(forced.state, 'ready');
    assert.ok(getFileByPath(ix2.db, 'late.ts'), 'forced walk finds the new file');
    assert.equal(countFiles(ix2.db), 5);
  });

  test('status.json left at building by a killed build is resumed: missing files indexed, pending refs resolved', async () => {
    const files = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${String(i).padStart(2, '0')}.ts`, `${SAMPLE}\n// ${i}\n`]));
    const dir = project('ix-killed', files);
    const ix = create(dir, { minFilesToAutoIndex: 0 });
    await ix.buildAll();
    // Shape left by a process killed mid-build: half the rows missing, status
    // 'building', and every committed file's refs still pending.
    for (const row of listIndexed(ix.db).slice(6)) deleteFile(ix.db, row.path);
    ix.db.exec('UPDATE refs SET target_id = NULL, resolution = NULL');
    writeStatus(dir, { state: 'building', filesTotal: 12, filesDone: 6, reason: null, error: null });
    await ix.close();

    const ix2 = create(dir, { minFilesToAutoIndex: 0 });
    const res = await ix2.ensureFresh({ maxWaitMs: 20000 });
    assert.equal(res.state, 'ready');
    assert.equal(res.partial, false);
    assert.equal(countFiles(ix2.db), 12);
    assert.equal(ix2.db.prepare('SELECT COUNT(*) AS c FROM refs WHERE resolution IS NULL').get().c, 0);
    assert.ok(ix2.db.prepare("SELECT COUNT(*) AS c FROM refs WHERE resolution IN ('=', '~')").get().c > 0);
    assert.equal(readStatus(dir).state, 'ready');
    assert.equal(readStatus(dir).filesDone, 12);
  });

  test('a lost status.json does not hide an index that holds content: status() reads the database, the next refresh writes the file back', async () => {
    const dir = project('ix-status-lost', { 'a.ts': SAMPLE, 'b.ts': SAMPLE, 'notes.txt': 'not code' });
    const ix = create(dir, { minFilesToAutoIndex: 0 });
    await ix.buildAll();
    fs.rmSync(statusPath(dir));
    assert.equal(readStatus(dir), null);
    // Before this the default state ('empty') was reported, and every tool answered "not indexed".
    const seen = ix.status();
    assert.equal(seen.state, 'ready');
    assert.equal(seen.filesTotal, 2);
    assert.ok(seen.symbols > 0);
    assert.deepEqual(seen.languages, { typescript: 2 });
    assert.ok(seen.indexedAt > 0 && seen.indexedAt <= Date.now(), "the age is the database file's");

    // A read-only session (another process holds the lock) answers the same way but writes nothing.
    const foreign = await acquireLock(lockPath(dir));
    const other = create(dir, { minFilesToAutoIndex: 0 });
    assert.equal((await other.ensureFresh()).readOnly, true);
    assert.equal(other.status().state, 'ready');
    assert.equal(readStatus(dir), null, 'a read-only session must not write status.json');
    foreign.release();

    await ix.ensureFresh({ maxWaitMs: 20000 });
    const stored = readStatus(dir);
    assert.equal(stored.state, 'ready', 'the lock holder writes the file back for the hooks');
    assert.equal(stored.filesTotal, 2);
    assert.ok(stored.indexedAt > 0 && stored.indexedAt <= Date.now());
  });

  test('a project file that switches indexing off is the reason an empty index reports', async () => {
    const dir = project('ix-project-off', { 'a.ts': SAMPLE });
    const ix = create(dir, { autoIndex: false, autoIndexOffBy: 'project', minFilesToAutoIndex: 0 });
    const res = await ix.ensureFresh({ maxWaitMs: 20000 });
    assert.equal(res.state, 'empty');
    assert.equal(res.reason, 'auto-index-disabled');
    assert.match(ix.status().reasonDetail, /\.zcode\/codegraph\.json/, 'the message names the project file');
    assert.equal(countFiles(ix.db), 0, 'nothing is indexed');
  });

  test('a build that died after committing every file but before resolving is completed without re-parsing', async () => {
    const dir = project('ix-killed-late', { 'a.ts': SAMPLE, 'b.ts': SAMPLE });
    const ix = create(dir, { minFilesToAutoIndex: 0 });
    await ix.buildAll();
    const before = Object.fromEntries(listIndexed(ix.db).map((r) => [r.path, r.indexed_at]));
    ix.db.exec('UPDATE refs SET target_id = NULL, resolution = NULL');
    writeStatus(dir, { state: 'building', filesTotal: 2, filesDone: 2, reason: null, error: null });
    await ix.close();

    const ix2 = create(dir, { minFilesToAutoIndex: 0 });
    const res = await ix2.ensureFresh({ maxWaitMs: 20000 });
    assert.equal(res.state, 'ready');
    assert.equal(res.partial, false);
    assert.equal(ix2.db.prepare('SELECT COUNT(*) AS c FROM refs WHERE resolution IS NULL').get().c, 0, 'resolveAll ran although nothing was committed');
    for (const [p, at] of Object.entries(before)) assert.equal(getFileByPath(ix2.db, p).indexed_at, at, `${p} was skipped by mtime/size`);
  });

  test('a batch of dirty files above the foreground limit runs as a background build and the call returns partial', { timeout: 60000 }, async () => {
    const files = Object.fromEntries(Array.from({ length: 210 }, (_, i) => [`f${String(i).padStart(3, '0')}.ts`, `${SAMPLE}\n// ${i}\n`]));
    const dir = project('ix-batch', files);
    const ix = create(dir, { minFilesToAutoIndex: 0, workers: 4 });
    await ix.buildAll();
    await ix.close();
    for (let i = 0; i < 210; i++) fs.appendFileSync(path.join(dir, `f${String(i).padStart(3, '0')}.ts`), '\nexport function batchEdited(): number { return 1; }\n');

    const ix2 = create(dir, { minFilesToAutoIndex: 0, workers: 4 });
    const immediate = await ix2.ensureFresh({ maxWaitMs: 0 });
    assert.equal(immediate.partial, true, 'the batch was not awaited');
    assert.equal(immediate.state, 'building');
    assert.equal(readStatus(dir).state, 'building');
    assert.equal(ix2.db.prepare("SELECT COUNT(*) AS c FROM files WHERE path = 'f000.ts'").get().c, 1, 'rows stay queryable meanwhile');
    const done = await ix2.ensureFresh({ maxWaitMs: 20000 });
    assert.equal(done.state, 'ready');
    assert.equal(done.partial, false);
    assert.equal(done.dirty, 0);
    assert.equal(ix2.db.prepare("SELECT COUNT(DISTINCT file_id) AS c FROM symbols WHERE name = 'batchEdited'").get().c, 210);
    assert.equal(ix2.db.prepare('SELECT COUNT(*) AS c FROM refs WHERE resolution IS NULL').get().c, 0);
  });

  test('a file deleted through a dirty entry has the refs of its former users re-resolved', async () => {
    const dir = project('ix-delete-refs', {
      'lib.ts': 'export function gone(): number { return 1; }\n',
      'use.ts': "import { gone } from './lib';\nexport function run(): number {\n  return gone();\n}\n",
    });
    const ix = create(dir, { minFilesToAutoIndex: 0 });
    await ix.buildAll();
    assert.equal(ix.db.prepare("SELECT resolution FROM refs WHERE name = 'gone'").get().resolution, '=');
    await statSweep(ix.db, { root: dir }); // arm the throttle so the dirty line drives the sync
    fs.unlinkSync(path.join(dir, 'lib.ts'));
    appendDirty(dir, 'lib.ts');
    await ix.ensureFresh({ maxWaitMs: 20000 });
    assert.equal(getFileByPath(ix.db, 'lib.ts'), null);
    assert.equal(ix.db.prepare('SELECT COUNT(*) AS c FROM refs WHERE resolution IS NULL').get().c, 0, 'nothing stays pending after a delete-only sync');
    assert.equal(ix.db.prepare("SELECT resolution FROM refs WHERE name = 'gone'").get().resolution, '?');
    assert.equal(readStatus(dir).filesTotal, 1);
  });

  test('concurrent ensureFresh calls are serialized into a single build', async () => {
    const files = Object.fromEntries(Array.from({ length: 35 }, (_, i) => [`f${String(i).padStart(2, '0')}.ts`, `${SAMPLE}\n// ${i}\n`]));
    const dir = project('ix-concurrent', files);
    const ix = create(dir);
    const [r1, r2] = await Promise.all([ix.ensureFresh({ maxWaitMs: 20000 }), ix.ensureFresh({ maxWaitMs: 20000 })]);
    assert.equal(r1.state, 'ready');
    assert.equal(r2.state, 'ready');
    assert.equal(countFiles(ix.db), 35);
    assert.equal(ix.db.prepare('SELECT COUNT(DISTINCT path) AS c FROM files').get().c, 35);
  });

  test('status() reports the live dirty count and onProgress can be unsubscribed', async () => {
    const dir = project('ix-status', { 'a.ts': SAMPLE });
    const ix = create(dir, { minFilesToAutoIndex: 1 });
    let calls = 0;
    const off = ix.onProgress(() => { calls++; });
    off();
    await ix.buildAll();
    assert.equal(calls, 0);
    markDirty(ix.db, ['a.ts']);
    assert.equal(ix.status().dirty, 1);
    assert.equal(readStatus(dir).stale, 0, 'stale in status.json is only refreshed by the indexer');
    takeDirty(ix.db);
    assert.equal(dirtyCount(ix.db), 0);
    assert.throws(() => ix.onProgress(null), TypeError);
  });

  test('constructor validates its arguments', () => {
    assert.throws(() => new Indexer({ config: {} }), /"root" must be a non-empty string/);
    assert.throws(() => new Indexer({ root: 'x', config: { maxFiles: 'many' } }), /"maxFiles" must be an integer/);
  });

  test('a lock path that cannot be used makes writes fail with the raw error and never wedges the instance', async () => {
    const dir = project('ix-lock-fail', { 'a.ts': SAMPLE });
    // A lock path that cannot be read as a file: readFileSync fails with EISDIR.
    fs.mkdirSync(lockPath(dir), { recursive: true });
    const ix = new Indexer({ root: dir });
    await assert.rejects(ix.ensureFresh(), (err) => ['EISDIR', 'EPERM', 'EACCES'].includes(err.code));
    await assert.rejects(ix.buildAll(), (err) => ['EISDIR', 'EPERM', 'EACCES'].includes(err.code));
    assert.equal(ix.status().state, 'empty', 'queries keep working');
    await ix.close();
    // Windows refuses to delete a file that still has an open handle: this only succeeds if the connection was closed.
    fs.rmSync(indexDir(dir), { recursive: true, force: true });
    assert.equal(fs.existsSync(dbPath(dir)), false);
    // The same path works once the obstacle is gone.
    fs.rmSync(dir, { recursive: true, force: true });
    dirs.splice(dirs.indexOf(dir), 1);
  });

  test('a build that fails rejects buildAll, reports progress state error and leaves the indexer usable', async () => {
    const dir = project('ix-build-error', { 'a.ts': SAMPLE });
    const ix = create(dir, { minFilesToAutoIndex: 1 });
    const events = [];
    ix.onProgress((e) => events.push(e.state));
    // A directory where status.json belongs makes every status write fail.
    fs.mkdirSync(path.dirname(dbPath(dir)), { recursive: true });
    fs.mkdirSync(statusPath(dir));
    await assert.rejects(ix.buildAll(), { code: 'EISDIR' });
    assert.equal(events.at(-1), 'error');
    assert.equal(countFiles(ix.db), 0, 'nothing was committed before the failure');
    fs.rmdirSync(statusPath(dir));
    const res = await ix.buildAll();
    assert.equal(res.state, 'ready');
    assert.equal(countFiles(ix.db), 1);
  });
});
