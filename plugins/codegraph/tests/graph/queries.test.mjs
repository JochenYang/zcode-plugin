// Graph queries over the ts-basic fixture (CONTRACTS.md §8): shapes of every
// operation, grouping of callers / callees, impact BFS and its truncation flag.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, close } from '../../src/store/db.mjs';
import { refsInFile, replaceFile, setRefResolution } from '../../src/store/repo.mjs';
import { SEARCH_USAGE_ROWS, search, symbol, callers, callees, impact, outline } from '../../src/graph/queries.mjs';
import { buildProject } from '../resolve/fixture.mjs';

const UTIL = 'src/util.ts';
const APP = 'src/app.ts';
const SHAPES = 'src/shapes.ts';
const DEEP = 'src/nested/deep.ts';
const ENTRY = 'src/nested/entry.ts';

let db;
await buildProject().then((d) => {
  db = d;
});
after(() => {
  try {
    db?.close();
  } catch {
    // already closed
  }
});

const hasRange = (row) => Number.isInteger(row.startLine) && Number.isInteger(row.endLine) && row.startLine >= 1 && row.endLine >= row.startLine;

describe('search', () => {
  test('returns §8 rows with numeric ranges, exact names first', () => {
    const rows = search(db, { query: 'helper' });
    assert.ok(rows.length >= 1);
    assert.deepEqual({ name: rows[0].name, kind: rows[0].kind, path: rows[0].path, qual: rows[0].qual }, { name: 'helper', kind: 'function', path: UTIL, qual: 'helper' });
    assert.ok(rows.every(hasRange), 'every row has startLine/endLine');
    assert.equal(rows[0].startLine, 1);
    assert.equal(rows[0].endLine, 3);
    assert.equal(search(db, { query: 'duplicated' }).length, 2, 'both files');
    assert.deepEqual(search(db, { query: '' }), []);
    assert.deepEqual(search(db, { query: 'zzzz-nothing' }), []);
    assert.deepEqual(search(db, { query: 'helper', kind: 'class' }), []);
    assert.equal(search(db, { query: 'helper', limit: 1 }).length, 1);
  });

  test('reports the words a relaxed search matched and dropped', () => {
    const relaxed = {};
    const rows = search(db, { query: 'helper zzz' }, relaxed);
    assert.equal(rows[0]?.name, 'helper');
    assert.deepEqual(relaxed, { matched: ['helper'], dropped: ['zzz'] });
    const nothing = {};
    assert.deepEqual(search(db, { query: 'zzzz-nothing' }, nothing), []);
    assert.deepEqual(nothing, { matched: [], dropped: [] });
    // Passing the info object does not change the rows.
    assert.ok(search(db, { query: 'helper' }, {}).every((row) => Number.isInteger(row.id) && hasRange(row)));
  });

  test('the leading rows say who uses them from other files; the rest carry nothing', () => {
    const rows = search(db, { query: 'helper', limit: 20 });
    assert.ok(rows.length >= 1);
    const usage = rows[0].usage;
    assert.ok(Number.isInteger(usage?.refs) && usage.refs >= 1, 'helper is used outside its own file');
    assert.ok(Number.isInteger(usage.files) && usage.files >= 1 && usage.files <= usage.refs);
    assert.ok(Number.isInteger(usage.inSource) && usage.inSource >= 0 && usage.inSource <= usage.files);
    assert.deepEqual(Object.keys(usage), ['refs', 'files', 'inSource', 'byName']);
  });

  test('only the first three rows carry usage, however many rows a search returns', () => {
    // "helper" matches one symbol in the fixture, so the assertion above cannot tell "leading
    // rows only" from "every row": here five symbols answer to the same query. The count is
    // written out because it is the contract (CONTRACTS.md §8), not a property of the constant.
    const leading = 3;
    assert.equal(SEARCH_USAGE_ROWS, leading);
    const mem = openDatabase(':memory:');
    try {
      const meta = (path) => ({ path, lang: 'typescript', hash: path, mtimeMs: 1, size: 1, parseOk: true, errorNodes: 0, indexedAt: 1 });
      const def = (name) => ({ kind: 'function', name, qual: name, startLine: 1, endLine: 1, startCol: 0, parent: null });
      const call = (name) => ({ name, kind: 'call', startLine: 3, startCol: 2, endLine: 3 });
      const names = ['helperOne', 'helperTwo', 'helperThree', 'helperFour', 'helperFive'];
      const user = replaceFile(mem, meta('src/user.ts'), { symbols: [], refs: names.map(call) });
      for (const name of names) {
        const file = replaceFile(mem, meta(`src/${name}.ts`), { symbols: [def(name)], refs: [] });
        const ref = refsInFile(mem, user.fileId).find((row) => row.name === name);
        setRefResolution(mem, [{ refId: ref.id, targetId: file.symbolIds[0], resolution: '=' }]);
      }
      const rows = search(mem, { query: 'helper', limit: 20 });
      assert.equal(rows.length, names.length);
      assert.ok(rows.slice(0, leading).every((row) => row.usage?.refs === 1), 'each leading row is used from one other file');
      assert.ok(rows.slice(leading).every((row) => row.usage === undefined), 'only the leading rows pay for it');
    } finally {
      close(mem);
    }
  });
});

describe('symbol', () => {
  test('returns the symbol with camelCase ranges, callers grouped by owning symbol, callees grouped by target, and file imports', () => {
    const result = symbol(db, { name: 'helper' });
    assert.ok(result, 'unique name resolves');
    const { symbol: s, callers: who, callees: what, imports } = result;
    assert.equal(s.path, UTIL);
    assert.equal(s.kind, 'function');
    assert.equal(s.signature, '(value: number): number');
    assert.ok(hasRange(s));
    assert.equal(s.startLine, 1);
    assert.equal(s.endLine, 3);

    const names = who.map((c) => `${c.name}@${c.path}:${c.startLine}:${c.resolution}`);
    assert.deepEqual(names, ['run@src/app.ts:7:=', 'memo@src/app.ts:28:=', 'deep@src/nested/deep.ts:5:=', 'scaled@src/shapes.ts:12:='], 'callers sorted by path then line (first ref of the group: line 7 binds helper through the alias), each with the strongest marker');
    assert.ok(who.every((c) => c.count >= 1 && c.resolution === '=' && typeof c.kind === 'string' && typeof c.qual === 'string'));
    assert.equal(who.find((c) => c.name === 'run').count, 2, 'run references helper twice through the alias (binding value and call)');
    assert.equal(who.find((c) => c.name === 'run').kind, 'function');

    const callees = what.map((c) => `${c.name}${c.resolution}`);
    assert.deepEqual(callees, [], 'helper calls nothing');

    assert.deepEqual(symbol(db, { name: 'run' }).callees.map((c) => `${c.name}${c.resolution}`).sort(), ['area~', 'create=', 'format=', 'helper=', 'helper?', 'plus=', 'square='], 'run: resolved targets by name, the shadowed call grouped by its own name');
    const shapes = symbol(db, { name: 'scaled' });
    assert.deepEqual(shapes.imports.map((i) => [i.spec, i.resolvedPath]), [['./util', UTIL], ['./util', UTIL]]);
    assert.equal(shapes.symbol.qual, 'Shape.scaled');
    assert.equal(shapes.symbol.parentId !== null, true);
  });

  test('ambiguous names are null unless narrowed by path or qual; unknown names are null', () => {
    assert.equal(symbol(db, { name: 'duplicated' }), null);
    const narrowed = symbol(db, { name: 'duplicated', path: 'src/math.ts' });
    assert.equal(narrowed.symbol.path, 'src/math.ts');
    assert.equal(symbol(db, { name: 'duplicated', path: 'src/math.ts', qual: 'duplicated' }).symbol.path, 'src/math.ts');
    assert.equal(symbol(db, { name: 'nope' }), null);
    assert.equal(symbol(db, {}), null);
    const byQual = symbol(db, { name: 'scaled', qual: 'Shape.scaled' });
    assert.equal(byQual.symbol.name, 'scaled');
  });
});

describe('callers / callees', () => {
  test('standalone operations share the symbol lookup and honour limit', () => {
    const all = callers(db, { name: 'helper' });
    assert.equal(all.length, 4);
    assert.deepEqual(callers(db, { name: 'helper', limit: 2 }).map((c) => c.name), ['run', 'memo']);
    assert.deepEqual(callers(db, { name: 'duplicated' }), []);
    assert.deepEqual(callers(db, { name: 'create' }).map((c) => `${c.name}@${c.path}:${c.startLine}`), ['run@src/app.ts:10', 'defaultScale@src/shapes.ts:20']);
    const calleesOfRun = callees(db, { name: 'run', limit: 3 });
    assert.equal(calleesOfRun.length, 3);
    assert.ok(calleesOfRun.every((c) => Number.isInteger(c.count) && c.count >= 1 && typeof c.resolution === 'string' && Number.isInteger(c.startLine)));
    assert.ok(symbol(db, { name: 'helper' }).callers.every((c) => Number.isInteger(c.startLine)), 'caller rows carry numeric lines');
    assert.deepEqual(callees(db, { name: 'helper' }), []);
    assert.deepEqual(callees(db, { name: 'nope' }), []);
  });
});

describe('impact', () => {
  test('reverse BFS over refs.target_id up to depth, with nodes / files / truncated', () => {
    const one = impact(db, { name: 'create', depth: 1 });
    assert.deepEqual(one.nodes.map((n) => `${n.name}@${n.path}:${n.startLine}`), ['run@src/app.ts:6', 'defaultScale@src/shapes.ts:19'], 'nodes are the dependent symbols at their own definition');
    assert.ok(one.nodes.every((n) => hasRange(n) && n.depth === 1 && n.kind && n.signature !== undefined));
    assert.deepEqual(one.files, [APP, SHAPES]);
    assert.equal(one.truncated, true, 'entry() calls defaultScale: dependents exist beyond depth 1');
    assert.equal(one.total, 2);

    const two = impact(db, { name: 'create', depth: 2 });
    assert.deepEqual(two.nodes.map((n) => `${n.name}@${n.depth}`), ['run@1', 'defaultScale@1', 'entry@2']);
    assert.deepEqual(two.files, [APP, ENTRY, SHAPES]);
    assert.equal(two.truncated, false, 'nothing calls entry(): the walk is complete');

    const deepEnd = impact(db, { name: 'helper' });
    assert.deepEqual(deepEnd.files, [DEEP, APP, SHAPES].sort(), 'default depth 2 still only reaches the direct callers');
    assert.equal(deepEnd.truncated, false);
    assert.deepEqual(impact(db, { name: 'nope' }), { nodes: [], files: [], truncated: false, total: 0 });
    assert.deepEqual(impact(db, { name: 'duplicated' }).nodes, [], 'ambiguous name -> nothing');
  });

  test('a cycle back into already-visited owners is not "beyond the depth": truncated stays false', () => {
    const sym = (kind, name, line, end) => ({ kind, name, qual: name, startLine: line, endLine: end, startCol: 0, parent: null });
    const ref = (name, line, symbol) => ({ name, receiver: '', kind: 'call', startLine: line, startCol: 2, endLine: line, symbol });
    const meta = (p) => ({ path: p, lang: 'typescript', hash: p, mtimeMs: 1, size: 1, parseOk: true, errorNodes: 0, indexedAt: 1 });
    const cyc = openDatabase(':memory:');
    try {
      // f calls g, g calls f; rec calls itself; a -> b -> c -> a with a side exit d.
      replaceFile(cyc, meta('m.ts'), { symbols: [sym('function', 'f', 1, 3), sym('function', 'g', 5, 7)], refs: [ref('g', 2, 0), ref('f', 6, 1)], imports: [] });
      replaceFile(cyc, meta('s.ts'), { symbols: [sym('function', 'rec', 1, 3)], refs: [ref('rec', 2, 0)], imports: [] });
      replaceFile(cyc, meta('ring.ts'), {
        symbols: [sym('function', 'a', 1, 3), sym('function', 'b', 5, 7), sym('function', 'c', 9, 11), sym('function', 'd', 13, 15)],
        refs: [ref('b', 2, 0), ref('c', 6, 1), ref('a', 10, 2), ref('d', 11, 2)],
        imports: [],
      });
      const resolve = (file) => {
        const fileId = cyc.prepare('SELECT id FROM files WHERE path = ?').get(file).id;
        for (const r of cyc.prepare('SELECT id, name FROM refs WHERE file_id = ?').all(fileId)) {
          const t = cyc.prepare('SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ? AND s.name = ?').get(file, r.name);
          cyc.prepare('UPDATE refs SET target_id = ?, resolution = ? WHERE id = ?').run(t.id, '~', r.id);
        }
      };
      for (const p of ['m.ts', 's.ts', 'ring.ts']) resolve(p);

      const one = impact(cyc, { name: 'f', depth: 1 });
      assert.deepEqual(one.nodes.map((n) => `${n.name}@${n.depth}`), ['g@1']);
      assert.equal(one.truncated, false, 'the only owner beyond g is f itself: the closure is complete');
      for (const depth of [2, 6]) assert.equal(impact(cyc, { name: 'f', depth }).truncated, false);
      assert.equal(impact(cyc, { name: 'rec', depth: 1 }).truncated, false);
      // Reverse edges: a <- c <- b <- a, and d <- c. Walking up from a runs around the ring and stops.
      const ring = impact(cyc, { name: 'a', depth: 2 });
      assert.deepEqual(ring.nodes.map((n) => `${n.name}@${n.depth}`), ['c@1', 'b@2']);
      assert.equal(ring.truncated, false, 'the only owner of b is a itself: the back-edge is visited, not "beyond"');
      // From d the ring is still beyond the first hop, so depth 1 is genuinely cut...
      const exit1 = impact(cyc, { name: 'd', depth: 1 });
      assert.deepEqual(exit1.nodes.map((n) => `${n.name}@${n.depth}`), ['c@1']);
      assert.equal(exit1.truncated, true, 'c is also called by b, which is beyond depth 1 and not yet visited');
      // ...and once the walk reaches a again the remaining back-edge no longer counts.
      const exit3 = impact(cyc, { name: 'd', depth: 3 });
      assert.deepEqual(exit3.nodes.map((n) => `${n.name}@${n.depth}`), ['c@1', 'b@2', 'a@3']);
      assert.equal(exit3.truncated, false);
    } finally {
      cyc.close();
    }
  });
});

describe('outline', () => {
  test('symbols of one file in source order with numeric ranges', () => {
    const rows = outline(db, { path: UTIL });
    assert.deepEqual(rows.map((r) => [r.kind, r.name, r.startLine, r.endLine]), [
      ['function', 'helper', 1, 3],
      ['function', 'format', 5, 7],
      ['constant', 'VERSION', 9, 9],
      ['function', 'duplicated', 11, 13],
    ]);
    assert.ok(rows.every(hasRange));
    assert.deepEqual(outline(db, { path: 'src/missing.ts' }), []);
    assert.throws(() => outline(db, { path: '' }), /non-empty string/);
    assert.throws(() => outline(db, {}), /non-empty string/);
  });
});
