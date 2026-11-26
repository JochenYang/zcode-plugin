// The two dependency queries (CONTRACTS.md §8): import cycles over the resolved import graph,
// and the bounded reverse walk from given files to the test files that depend on them.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, close } from '../../src/store/db.mjs';
import { beginWriteGroup, replaceFile, setRefResolution, refsInFile } from '../../src/store/repo.mjs';
import { affectedTests, importCycles, MAX_AFFECTED_FILES, MAX_WALK_FILES } from '../../src/graph/dependencies.mjs';

const open = [];
function memory() {
  const db = openDatabase(':memory:');
  open.push(db);
  return db;
}
afterEach(() => {
  for (const db of open.splice(0)) close(db);
});

const meta = (path) => ({ path, lang: 'typescript', hash: path, mtimeMs: 1, size: 1, parseOk: true, errorNodes: 0, indexedAt: 1 });
const def = (name, line = 1) => ({ kind: 'function', name, qual: name, startLine: line, endLine: line + 1, startCol: 0, parent: null });
const idOf = (db, path) => Number(db.prepare('SELECT id FROM files WHERE path = ?').get(path).id);

// A file with one import per `specs` entry, still unresolved; `link` fills the target once every
// file exists.
function addFile(db, path, { specs = [], symbols = [], refs = [] } = {}) {
  return replaceFile(db, meta(path), {
    symbols,
    refs,
    imports: specs.map((spec, i) => ({ spec, names: null, kind: 'import', startLine: i + 1 })),
  });
}

function link(db, from, spec, to) {
  db.prepare('UPDATE imports SET resolved_file_id = ? WHERE file_id = ? AND spec = ?').run(idOf(db, to), idOf(db, from), spec);
}

describe('importCycles', () => {
  test('one component is one cycle, starting at the smallest path and closing on it; other edges do not join', () => {
    const db = memory();
    addFile(db, 'src/a.ts', { specs: ['b', 'd'] });
    addFile(db, 'src/b.ts', { specs: ['c'] });
    addFile(db, 'src/c.ts', { specs: ['a'] });
    addFile(db, 'src/d.ts');
    link(db, 'src/a.ts', 'b', 'src/b.ts');
    link(db, 'src/a.ts', 'd', 'src/d.ts');
    link(db, 'src/b.ts', 'c', 'src/c.ts');
    link(db, 'src/c.ts', 'a', 'src/a.ts');
    assert.deepEqual(importCycles(db), {
      cycles: [{ paths: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/a.ts'], walked: true }],
      total: 1,
      truncated: false,
    });
  });

  test('no cycle, a self-import and an unresolved specifier are not cycles', () => {
    const db = memory();
    addFile(db, 'src/a.ts', { specs: ['b', 'b', 'missing', 'a'] });
    addFile(db, 'src/b.ts');
    addFile(db, 'src/c.ts', { specs: ['nowhere'] });
    link(db, 'src/a.ts', 'b', 'src/b.ts');
    link(db, 'src/a.ts', 'a', 'src/a.ts');
    assert.deepEqual(importCycles(db), { cycles: [], total: 0, truncated: false });
  });

  test('cycles sort by files then first path; limit cuts the list but total still counts', () => {
    const db = memory();
    // Two files, first path src/a.ts.
    addFile(db, 'src/a.ts', { specs: ['b'] });
    addFile(db, 'src/b.ts', { specs: ['a'] });
    link(db, 'src/a.ts', 'b', 'src/b.ts');
    link(db, 'src/b.ts', 'a', 'src/a.ts');
    // Three files, first path z/a.ts: more files, so it leads despite the later path.
    addFile(db, 'z/a.ts', { specs: ['b'] });
    addFile(db, 'z/b.ts', { specs: ['c'] });
    addFile(db, 'z/c.ts', { specs: ['a'] });
    link(db, 'z/a.ts', 'b', 'z/b.ts');
    link(db, 'z/b.ts', 'c', 'z/c.ts');
    link(db, 'z/c.ts', 'a', 'z/a.ts');
    const all = importCycles(db, { limit: 10 });
    assert.deepEqual(all.cycles.map((cycle) => [new Set(cycle.paths).size, cycle.paths[0], cycle.walked]), [[3, 'z/a.ts', true], [2, 'src/a.ts', true]]);
    assert.equal(all.total, 2);
    assert.equal(all.truncated, false);
    const one = importCycles(db, { limit: 1 });
    assert.deepEqual(one.cycles, [{ paths: ['z/a.ts', 'z/b.ts', 'z/c.ts', 'z/a.ts'], walked: true }]);
    assert.equal(one.total, 2);
    assert.equal(one.truncated, true, 'more cycles exist than the limit kept');
  });

  test('a component that is not one simple cycle is a closed walk that repeats a file', () => {
    const db = memory();
    // a <-> b, b <-> c: every file reaches every other, but no simple cycle holds all three.
    addFile(db, 'src/a.ts', { specs: ['b'] });
    addFile(db, 'src/b.ts', { specs: ['a', 'c'] });
    addFile(db, 'src/c.ts', { specs: ['b'] });
    link(db, 'src/a.ts', 'b', 'src/b.ts');
    link(db, 'src/b.ts', 'a', 'src/a.ts');
    link(db, 'src/b.ts', 'c', 'src/c.ts');
    link(db, 'src/c.ts', 'b', 'src/b.ts');
    const [cycle] = importCycles(db).cycles;
    assert.equal(cycle.walked, true);
    assert.equal(cycle.paths[0], 'src/a.ts');
    assert.equal(cycle.paths.at(-1), 'src/a.ts', 'the walk is closed');
    assert.deepEqual(new Set(cycle.paths), new Set(['src/a.ts', 'src/b.ts', 'src/c.ts']), 'every file of the component is listed');
  });

  test('a component past MAX_WALK_FILES is listed by path instead of walked', () => {
    // One ring: every file imports the next, the last imports the first. One component of `n` files.
    const ring = (n) => {
      const db = memory();
      const end = beginWriteGroup(db);
      try {
        for (let i = 0; i < n; i += 1) addFile(db, `src/ring${i}.ts`, { specs: ['next'] });
      } finally {
        end();
      }
      for (let i = 0; i < n; i += 1) link(db, `src/ring${i}.ts`, 'next', `src/ring${(i + 1) % n}.ts`);
      return db;
    };
    const paths = (n) => Array.from({ length: n }, (_, i) => `src/ring${i}.ts`);

    const atLimit = importCycles(ring(MAX_WALK_FILES)).cycles[0];
    assert.equal(atLimit.walked, true, `${MAX_WALK_FILES} files is still walked`);
    assert.equal(new Set(atLimit.paths).size, MAX_WALK_FILES, 'the walk passes through every file');
    assert.equal(atLimit.paths[0], 'src/ring0.ts');
    assert.equal(atLimit.paths.at(-1), 'src/ring0.ts', 'and closes');

    const past = importCycles(ring(MAX_WALK_FILES + 1)).cycles[0];
    assert.equal(past.walked, false, `${MAX_WALK_FILES + 1} files is past the walk`);
    assert.deepEqual(past.paths, paths(MAX_WALK_FILES + 1).sort(), 'the files of the component, sorted');
  });

  test('bad arguments', () => {
    const db = memory();
    assert.deepEqual(importCycles(db), { cycles: [], total: 0, truncated: false });
    assert.throws(() => importCycles(null), /importCycles: "db" must be a DatabaseSync/);
    assert.throws(() => importCycles(db, { limit: 0 }), /importCycles: "limit" must be a positive integer/);
    assert.throws(() => importCycles(db, { limit: 2.5 }), /importCycles: "limit" must be a positive integer/);
    assert.throws(() => importCycles(db, null), /importCycles: "options" must be an object/);
  });
});

describe('affectedTests', () => {
  // core <- util (import) <- mid (import); core <- app (a resolved reference);
  // core <- tests/core.test.ts; mid <- tests/deep.test.ts. Three hops deep at most.
  function project() {
    const db = memory();
    addFile(db, 'src/core.ts', { symbols: [def('core')] });
    addFile(db, 'src/util.ts', { specs: ['core'] });
    addFile(db, 'src/mid.ts', { specs: ['util'] });
    addFile(db, 'src/app.ts', { symbols: [def('run')], refs: [{ name: 'core', kind: 'call', startLine: 2, startCol: 2, endLine: 2, symbol: 0 }] });
    addFile(db, 'tests/core.test.ts', { specs: ['core'] });
    addFile(db, 'tests/deep.test.ts', { specs: ['mid'] });
    link(db, 'src/util.ts', 'core', 'src/core.ts');
    link(db, 'src/mid.ts', 'util', 'src/util.ts');
    link(db, 'tests/core.test.ts', 'core', 'src/core.ts');
    link(db, 'tests/deep.test.ts', 'mid', 'src/mid.ts');
    const coreSymbol = Number(db.prepare("SELECT s.id FROM symbols s WHERE s.name = 'core'").get().id);
    const appId = idOf(db, 'src/app.ts');
    setRefResolution(db, refsInFile(db, appId).map((ref) => ({ refId: ref.id, targetId: coreSymbol, resolution: '=' })));
    return db;
  }

  test('reverse closure over imports and resolved references, one level at a time', () => {
    const db = project();
    const one = affectedTests(db, { files: ['src/core.ts'], depth: 1 });
    assert.deepEqual(one.tests, ['tests/core.test.ts']);
    assert.equal(one.otherFiles, 2, 'src/util.ts (import) and src/app.ts (reference)');
    assert.equal(one.scanned, 4, 'the input plus three dependents');
    assert.equal(one.truncated, true, 'mid and the test behind it are beyond depth 1');
    assert.deepEqual(one.unknown, []);

    // Depth 2 reaches mid (one more import hop) but not the test that imports mid.
    const two = affectedTests(db, { files: ['src/core.ts'], depth: 2 });
    assert.deepEqual(two.tests, ['tests/core.test.ts']);
    assert.equal(two.otherFiles, 3);
    assert.equal(two.scanned, 5);
    assert.equal(two.truncated, true);

    const three = affectedTests(db, { files: ['src/core.ts'], depth: 3 });
    assert.deepEqual(three.tests, ['tests/core.test.ts', 'tests/deep.test.ts']);
    assert.equal(three.otherFiles, 3);
    assert.equal(three.scanned, 6);
    assert.equal(three.truncated, false, 'nothing depends on tests/deep.test.ts');
    assert.deepEqual(affectedTests(db, { files: ['src/core.ts'] }), three, 'depth defaults to 3');
  });

  test('a name-only match (~) is not a dependency', () => {
    const db = project();
    // Calls something called `core` without importing it: the resolver matched the unique name.
    addFile(db, 'tests/byname.test.ts', { symbols: [def('probe')], refs: [{ name: 'core', kind: 'call', startLine: 2, startCol: 2, endLine: 2, symbol: 0 }] });
    const coreSymbol = Number(db.prepare("SELECT s.id FROM symbols s WHERE s.name = 'core'").get().id);
    setRefResolution(db, refsInFile(db, idOf(db, 'tests/byname.test.ts')).map((ref) => ({ refId: ref.id, targetId: coreSymbol, resolution: '~' })));
    const result = affectedTests(db, { files: ['src/core.ts'], depth: 1 });
    assert.deepEqual(result.tests, ['tests/core.test.ts'], 'the test that imports core is listed; the one that merely calls a name is not');
    assert.equal(result.otherFiles, 2);
  });

  test('only tests are listed; the input files are never listed, even when they are tests', () => {
    const db = project();
    const both = affectedTests(db, { files: ['src/core.ts', 'tests/deep.test.ts'], depth: 2 });
    assert.deepEqual(both.tests, ['tests/core.test.ts']);
    assert.deepEqual(both.unknown, []);
    // An input test file is counted as scanned, not as a candidate.
    assert.equal(both.scanned, 6);
  });

  test('a path the index does not know is reported, not walked', () => {
    const db = project();
    const out = affectedTests(db, { files: ['src/nope.ts', 'src/core.ts'], depth: 1 });
    assert.deepEqual(out.unknown, ['src/nope.ts']);
    assert.deepEqual(out.tests, ['tests/core.test.ts']);
    assert.deepEqual(affectedTests(db, { files: ['src/nope.ts'] }), { tests: [], otherFiles: 0, scanned: 0, truncated: false, unknown: ['src/nope.ts'] });
  });

  test('the limit cuts the test list; the walk itself is not called truncated for it', () => {
    const db = memory();
    addFile(db, 'src/core.ts');
    for (let i = 0; i < 5; i += 1) addFile(db, `tests/t${i}.test.ts`, { specs: ['core'] });
    for (let i = 0; i < 5; i += 1) link(db, `tests/t${i}.test.ts`, 'core', 'src/core.ts');
    const out = affectedTests(db, { files: ['src/core.ts'], limit: 2 });
    assert.deepEqual(out.tests, ['tests/t0.test.ts', 'tests/t1.test.ts']);
    assert.equal(out.truncated, false);
  });

  test('the file cap stops the walk and says so', () => {
    const db = memory();
    addFile(db, 'src/core.ts');
    // More dependents than the walk may visit: the cap, not the depth, ends it.
    const width = MAX_AFFECTED_FILES + 10;
    const end = beginWriteGroup(db);
    try {
      for (let i = 0; i < width; i += 1) addFile(db, `src/user${i}.ts`, { specs: ['core'] });
    } finally {
      end();
    }
    db.prepare('UPDATE imports SET resolved_file_id = ? WHERE resolved_file_id IS NULL').run(idOf(db, 'src/core.ts'));
    const out = affectedTests(db, { files: ['src/core.ts'], depth: 1, limit: 1 });
    assert.equal(out.truncated, true);
    assert.equal(out.scanned, MAX_AFFECTED_FILES, 'the cap counts the input file too');
    assert.equal(out.otherFiles, MAX_AFFECTED_FILES - 1);
  });

  test('bad arguments', () => {
    const db = memory();
    assert.deepEqual(affectedTests(db), { tests: [], otherFiles: 0, scanned: 0, truncated: false, unknown: [] });
    assert.throws(() => affectedTests(null), /affectedTests: "db" must be a DatabaseSync/);
    assert.throws(() => affectedTests(db, { files: 'src/a.ts' }), /"files" must be an array/);
    assert.throws(() => affectedTests(db, { files: [''] }), /"files\[0\]" must be a non-empty string/);
    assert.throws(() => affectedTests(db, { files: ['src/a.ts'], depth: 0 }), /"depth" must be an integer >= 1/);
    assert.throws(() => affectedTests(db, { files: ['src/a.ts'], limit: 0 }), /"limit" must be a positive integer/);
    assert.throws(() => affectedTests(db, null), /"options" must be an object/);
  });
});
