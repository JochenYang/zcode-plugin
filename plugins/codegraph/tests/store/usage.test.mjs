// usageCounts (src/store/repo.mjs): who uses a symbol from other files, for the leading rows of
// a search. In-memory database; refs are linked the way the resolver does it.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, close } from '../../src/store/db.mjs';
import { USAGE_MAX_REFS, refsInFile, replaceFile, setRefResolution, symbolsInFile, usageCounts } from '../../src/store/repo.mjs';

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
const symbol = (kind, name, line) => ({ kind, name, qual: name, startLine: line, endLine: line, startCol: 0, parent: null });
const call = (name, line) => ({ name, kind: 'call', startLine: line, startCol: 2, endLine: line });
const idOf = (db, path, name) => symbolsInFile(db, path).find((row) => row.name === name).id;

// Links every ref in `fileId` to `targetId`. A test that needs a mix passes a function instead of a resolution.
function link(db, fileId, targetId, resolution = '=') {
  setRefResolution(db, refsInFile(db, fileId).map((ref, i) => ({ refId: ref.id, targetId, resolution: typeof resolution === 'function' ? resolution(i) : resolution })));
}

function project() {
  const db = memory();
  const a = replaceFile(db, meta('src/a.ts'), {
    symbols: [symbol('function', 'alpha', 1), symbol('function', 'lonely', 5)],
    // alpha calls itself, and that reference is linked like any other: a same-file reference
    // is still not a use from the outside.
    refs: [call('alpha', 2)],
  });
  const b = replaceFile(db, meta('src/b.ts'), { symbols: [symbol('function', 'beta', 1)], refs: [call('alpha', 3), call('alpha', 4)] });
  const t = replaceFile(db, meta('tests/a.test.ts'), { symbols: [], refs: [call('alpha', 2)] });
  const alpha = idOf(db, 'src/a.ts', 'alpha');
  link(db, a.fileId, alpha);
  link(db, b.fileId, alpha);
  link(db, t.fileId, alpha);
  return { db, alpha, lonely: idOf(db, 'src/a.ts', 'lonely'), other: b };
}

test('counts references from other files, the files they sit in, and how many of those are source', () => {
  const { db, alpha } = project();
  const counts = usageCounts(db, [alpha]);
  assert.deepEqual(counts.get(alpha), { refs: 3, files: 2, inSource: 1, byName: 0 });
  assert.equal(counts.size, 1);
});

test('a reference linked by a unique name is counted, and the count says so', () => {
  const { db, alpha, other } = project();
  link(db, other.fileId, alpha, (i) => (i === 1 ? '~' : '='));
  assert.deepEqual(usageCounts(db, [alpha]).get(alpha), { refs: 3, files: 2, inSource: 1, byName: 1 });
});

test('a symbol nothing outside refers to gets no entry; unknown ids and empty input give an empty map', () => {
  const { db, alpha, lonely } = project();
  assert.equal(usageCounts(db, [lonely]).has(lonely), false);
  assert.deepEqual([...usageCounts(db, [alpha, lonely, 999999]).keys()], [alpha]);
  assert.equal(usageCounts(db, []).size, 0);
  assert.throws(() => usageCounts(db, [0]), /usageCounts: "ids" must be an integer >= 1/);
  assert.throws(() => usageCounts(null, [1]), /usageCounts: "db" must be a DatabaseSync/);
});

test('a symbol with more references than USAGE_MAX_REFS reports the count alone; the boundary is still broken down', () => {
  const db = memory();
  const hub = replaceFile(db, meta('src/hub.ts'), {
    symbols: [symbol('function', 'hub', 1), symbol('function', 'edge', 3)],
    refs: [call('hub', 2)],
  });
  // hub: USAGE_MAX_REFS from another file plus its own call, one over the limit. edge: exactly
  // the limit, all from another file.
  const many = replaceFile(db, meta('src/many.ts'), {
    symbols: [],
    refs: [
      ...Array.from({ length: USAGE_MAX_REFS }, (_, i) => call('hub', i + 1)),
      ...Array.from({ length: USAGE_MAX_REFS }, (_, i) => call('edge', i + 1)),
    ],
  });
  const hubId = idOf(db, 'src/hub.ts', 'hub');
  link(db, hub.fileId, hubId);
  const names = { hub: hubId, edge: idOf(db, 'src/hub.ts', 'edge') };
  setRefResolution(db, refsInFile(db, many.fileId).map((ref) => ({ refId: ref.id, targetId: names[ref.name], resolution: '=' })));
  const counts = usageCounts(db, [hubId, names.edge, 999999]);
  assert.deepEqual(counts.get(hubId), { refs: USAGE_MAX_REFS + 1, capped: true });
  assert.deepEqual(counts.get(names.edge), { refs: USAGE_MAX_REFS, files: 1, inSource: 1, byName: 0 });
  assert.deepEqual([...counts.keys()].sort(), [hubId, names.edge].sort());
});
