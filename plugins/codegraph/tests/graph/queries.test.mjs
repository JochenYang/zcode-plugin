// Graph queries over the ts-basic fixture (CONTRACTS.md §8): shapes of every
// operation, grouping of callers / callees, impact BFS and its truncation flag.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, close } from '../../src/store/db.mjs';
import { refsInFile, replaceFile, setRefResolution } from '../../src/store/repo.mjs';
import { REF_LEAD_MAX, SEARCH_USAGE_ROWS, search, searchIsPartial, symbol, callers, callees, impact, outline } from '../../src/graph/queries.mjs';
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
// Own database for the names that are only used: the fixture's symbols must not be able to
// share a word with them.
const own = openDatabase(':memory:');
after(() => {
  try {
    db?.close();
  } catch {
    // already closed
  }
  try {
    own.close();
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

// A name that is used but not defined: the T20 sessions went to grep for `membershipKind`.
describe('search for a name that is only used', () => {
  const meta = { path: 'src/used.ts', lang: 'typescript', hash: 'used', mtimeMs: 1, size: 1, parseOk: true, errorNodes: 0, indexedAt: 1 };
  // `membershipCache` is the only definition (lines 2-6). Inside it `membershipKind` is read
  // `reads` times and `zzqPlugh` once; the module level reads both once.
  const write = (reads) => replaceFile(own, meta, {
    symbols: [{ kind: 'function', name: 'membershipCache', qual: 'membershipCache', startLine: 2, endLine: 6, startCol: 0, parent: null }],
    refs: [
      ...Array.from({ length: reads }, () => ({ name: 'membershipKind', kind: 'ref', startLine: 3, startCol: 3, endLine: 3, symbol: 0 })),
      { name: 'zzqPlugh', kind: 'ref', startLine: 4, startCol: 3, endLine: 4, symbol: 0 },
      { name: 'membershipKind', kind: 'ref', startLine: 8, startCol: 3, endLine: 8, symbol: null },
      { name: 'zzqPlugh', kind: 'ref', startLine: 9, startCol: 3, endLine: 9, symbol: null },
    ],
  });

  test('no symbol carries the name: the rows are the places that use it', () => {
    write(2);
    const info = {};
    const rows = search(own, { query: 'zzqPlugh' }, info);
    assert.deepEqual(rows, [
      { kind: 'ref', name: 'zzqPlugh', receiver: null, count: 1, path: 'src/used.ts', startLine: 4, owner: 'membershipCache', ownerQual: 'membershipCache', ownerKind: 'function' },
      { kind: 'ref', name: 'zzqPlugh', receiver: null, count: 1, path: 'src/used.ts', startLine: 9, owner: null, ownerQual: null, ownerKind: null },
    ]);
    assert.deepEqual(info, { refs: { uses: 2, files: 1, names: ['zzqPlugh'], capped: false, fromIndex: 2, fromScan: 0, kinds: ['ref'], cut: null, skipped: 'not-asked', symbols: [], symbolCount: 0 } }, 'no scan was passed: that is said, so that "none found in the source" is not');
    assert.equal('start_line' in rows[0], false, 'the §8 shape, no column name');
  });

  test('symbols that share a word, but not all of them: the uses come first and the header learns their names', () => {
    write(2);
    const info = {};
    const rows = search(own, { query: 'membershipKind' }, info);
    assert.deepEqual(rows.map((row) => [row.count, row.startLine, row.owner]), [[2, 3, 'membershipCache'], [1, 8, null]]);
    assert.deepEqual(info, { refs: { uses: 3, files: 1, names: ['membershipKind'], capped: false, fromIndex: 2, fromScan: 0, kinds: ['ref'], cut: null, skipped: 'not-asked', symbols: ['membershipCache'], symbolCount: 1 } });
  });

  test('searchIsPartial is what search decides on: no symbol, or symbols that only share words', () => {
    write(2);
    assert.equal(searchIsPartial(own, { query: 'zzqPlugh' }), true, 'no symbol carries it');
    assert.equal(searchIsPartial(own, { query: 'membershipKind' }), true, 'membershipCache shares a word');
    assert.equal(searchIsPartial(own, { query: 'membershipCache' }), false, 'a symbol carries it');
    assert.equal(searchIsPartial(own, { query: 'membershipCache', kind: 'constant' }), true, 'with a kind only symbols of that kind count');
    assert.equal(searchIsPartial(own, { query: '  ' }), false);
    assert.equal(searchIsPartial(own, { query: 'zzqPlugh', limit: 500 }), searchIsPartial(own, { query: 'zzqPlugh', limit: 1 }));
    assert.throws(() => searchIsPartial(null, { query: 'x' }), /searchIsPartial: "db" must be a DatabaseSync/);
  });

  test('a symbol that carries every word of the name comes first, as before', () => {
    write(2);
    const info = {};
    assert.deepEqual(search(own, { query: 'membershipCache' }, info).map((row) => row.name), ['membershipCache']);
    assert.equal('refs' in info, false);
    assert.deepEqual([info.matched, info.dropped], [['membership', 'cache'], []]);
  });

  test('a name used in more than REF_LEAD_MAX places does not lead: the symbols that share a word stay', () => {
    // The count is written out because it is the contract (CONTRACTS.md §8), not a property of the constant.
    assert.equal(REF_LEAD_MAX, 200);
    write(REF_LEAD_MAX + 1);
    const info = {};
    assert.deepEqual(search(own, { query: 'membershipKind' }, info).map((row) => row.name), ['membershipCache']);
    assert.equal('refs' in info, false);
    assert.deepEqual([info.matched, info.dropped], [['membership'], ['kind']]);
    // Exactly at the limit the uses still lead (the module level adds one to `reads`).
    write(REF_LEAD_MAX - 1);
    assert.ok(search(own, { query: 'membershipKind' }, {}).every((row) => row.name === 'membershipKind'));
  });

  test('with a kind only symbols qualify; the limit keeps the first rows; nothing found gives []', () => {
    write(2);
    const info = {};
    assert.deepEqual(search(own, { query: 'zzqPlugh', kind: 'function' }, info), []);
    assert.equal('refs' in info, false);
    assert.equal(search(own, { query: 'zzqPlugh', limit: 1 }).length, 1);
    const nothing = {};
    assert.deepEqual(search(own, { query: 'zzq-nothing' }, nothing), []);
    assert.deepEqual(nothing, { matched: [], dropped: [] });
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

// The tier of a file (source, tests and scripts, generated) orders every relation list before
// the limit cuts rows, so a cut row is never the source one (CONTRACTS.md §8).
describe('file tiers in the relation lists', () => {
  const meta = (path) => ({ path, lang: 'typescript', hash: path, mtimeMs: 1, size: 1, parseOk: true, errorNodes: 0, indexedAt: 1 });
  const def = (name, line) => ({ kind: 'function', name, qual: name, startLine: line, endLine: line + 2, startCol: 0, parent: null });
  const call = (name, line, symbol) => ({ name, kind: 'call', startLine: line, startCol: 2, endLine: line, symbol });
  const linkTo = (db, fileId, targets) => {
    const rows = refsInFile(db, fileId);
    setRefResolution(db, rows.map((row) => ({ refId: row.id, targetId: targets[row.name], resolution: '=' })));
  };

  test('callers: source, then tests, then generated files, before the limit', () => {
    const db = openDatabase(':memory:');
    try {
      const target = replaceFile(db, meta('src/def.ts'), { symbols: [def('target', 1)], refs: [] });
      const targets = { target: target.symbolIds[0] };
      for (const path of ['a.generated.ts', 'tests/a.test.ts', 'src/user.ts']) {
        const caller = replaceFile(db, meta(path), { symbols: [], refs: [call('target', 1, null)] });
        linkTo(db, caller.fileId, targets);
      }
      // "a.generated.ts" sorts first by path and is listed last; the test file outranks it too.
      assert.deepEqual(callers(db, { name: 'target' }).map((row) => row.path), ['src/user.ts', 'tests/a.test.ts', 'a.generated.ts']);
      assert.deepEqual(symbol(db, { name: 'target' }).callers.map((row) => row.path), ['src/user.ts', 'tests/a.test.ts', 'a.generated.ts']);
      // The cut happens after the tier: one row is the source caller.
      assert.deepEqual(callers(db, { name: 'target', limit: 1 }).map((row) => row.path), ['src/user.ts']);
    } finally {
      db.close();
    }
  });

  test('callees: the tier of the target file, then the existing count and name order', () => {
    const db = openDatabase(':memory:');
    try {
      const targets = {
        genTarget: replaceFile(db, meta('a.gen.ts'), { symbols: [def('genTarget', 1)], refs: [] }).symbolIds[0],
        testTarget: replaceFile(db, meta('tests/t.ts'), { symbols: [def('testTarget', 1)], refs: [] }).symbolIds[0],
        srcTarget: replaceFile(db, meta('src/lib.ts'), { symbols: [def('srcTarget', 1)], refs: [] }).symbolIds[0],
      };
      // Name order would put genTarget first; the tier puts the source target first.
      const caller = replaceFile(db, meta('src/main.ts'), {
        symbols: [def('caller', 1)],
        refs: [call('genTarget', 2, 0), call('testTarget', 3, 0), call('srcTarget', 4, 0)],
      });
      linkTo(db, caller.fileId, targets);
      assert.deepEqual(callees(db, { name: 'caller' }).map((row) => row.path), ['src/lib.ts', 'tests/t.ts', 'a.gen.ts']);
      assert.deepEqual(callees(db, { name: 'caller', limit: 1 }).map((row) => row.name), ['srcTarget']);
      assert.deepEqual(symbol(db, { name: 'caller' }).callees.map((row) => row.name), ['srcTarget', 'testTarget', 'genTarget']);
    } finally {
      db.close();
    }
  });

  test('impact: the tier comes before depth and path; the files list stays alphabetical', () => {
    const db = openDatabase(':memory:');
    try {
      const core = replaceFile(db, meta('src/core.ts'), { symbols: [def('core', 1)], refs: [] });
      const mid = replaceFile(db, meta('src/mid.ts'), { symbols: [def('mid', 1)], refs: [call('core', 2, 0)] });
      const deep = replaceFile(db, meta('src/deep.ts'), { symbols: [def('deep', 1)], refs: [call('mid', 2, 0)] });
      const gen = replaceFile(db, meta('a.gen.ts'), { symbols: [def('genCaller', 1)], refs: [call('core', 2, 0)] });
      linkTo(db, mid.fileId, { core: core.symbolIds[0] });
      linkTo(db, deep.fileId, { mid: mid.symbolIds[0] });
      linkTo(db, gen.fileId, { core: core.symbolIds[0] });
      const result = impact(db, { name: 'core', depth: 2 });
      // The generated dependent is at depth 1; the source one at depth 2 still comes first.
      assert.deepEqual(result.nodes.map((node) => `${node.name}@${node.path}@${node.depth}`), [
        'mid@src/mid.ts@1',
        'deep@src/deep.ts@2',
        'genCaller@a.gen.ts@1',
      ]);
      assert.deepEqual(result.files, ['a.gen.ts', 'src/deep.ts', 'src/mid.ts']);
      assert.equal(result.truncated, false);
    } finally {
      db.close();
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
