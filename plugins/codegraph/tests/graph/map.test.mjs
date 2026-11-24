// Repository map (CONTRACTS.md §8/§11): directory grouping, six symbols per
// file ranked by reference count, token budget with truncation.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../src/store/db.mjs';
import { replaceFile } from '../../src/store/repo.mjs';
import { repoMap } from '../../src/graph/map.mjs';
import { buildProject } from '../resolve/fixture.mjs';

const tokens = (text) => Math.ceil(Buffer.byteLength(text, 'utf8') / 4);

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

describe('repoMap', () => {
  test('groups files by directory, ranks symbols by references, cuts to six per file', () => {
    const map = repoMap(db);
    const lines = map.text.split('\n');
    assert.equal(lines[0], 'src/', 'root-level directory first');
    assert.ok(lines.includes('src/nested/'), 'subdirectories follow');
    assert.ok(lines.some((l) => l.startsWith('  app.ts  ')), 'file lines are indented under their directory');
    const util = lines.find((l) => l.startsWith('  util.ts  '));
    assert.equal(util, '  util.ts  function helper:1  function format:5  function duplicated:11  constant VERSION:9', 'resolved refs by target, unresolved by name, none last');
    const many = lines.find((l) => l.startsWith('  many.ts  '));
    assert.equal(many.split('  ').length - 2, 6, 'at most six symbols per file');
    assert.ok(!many.includes('theta'));
    assert.deepEqual(lines.slice(lines.indexOf('src/nested/') + 1).filter((l) => l.startsWith('  ')).map((l) => l.trim().split('  ')[0]).sort(), ['deep.ts', 'entry.ts']);
    assert.equal(map.truncated, false);
    assert.equal(map.shown, map.total, 'the default budget shows the whole map');
    assert.equal(map.files, map.filesTotal);
    assert.ok(map.total >= 20);
    assert.ok(tokens(map.text) <= 1200);
  });

  test('budget 100 tokens stops early and is marked truncated', () => {
    const map = repoMap(db, { budgetTokens: 100 });
    assert.equal(map.truncated, true);
    assert.ok(map.shown < map.total, `${map.shown} of ${map.total} symbols`);
    assert.ok(map.files < map.filesTotal);
    assert.ok(tokens(map.text) <= 100, `${tokens(map.text)} tokens`);
    assert.ok(map.text.length > 0, 'at least the first lines fit');
    const full = repoMap(db, { budgetTokens: 4000 });
    assert.equal(full.truncated, false);
    assert.ok(full.text.startsWith(map.text), 'truncation only drops whole lines from the end');
  });

  test('path narrows the scope to a directory or a single file', () => {
    const nested = repoMap(db, { path: 'src/nested' });
    const lines = nested.text.split('\n');
    assert.equal(lines.length, 3);
    assert.equal(lines[0], 'src/nested/');
    assert.ok(lines[1].startsWith('  deep.ts  ') && lines[2].startsWith('  entry.ts  '));
    assert.equal(nested.filesTotal, 2);
    assert.equal(nested.truncated, false);
    assert.ok(nested.text.includes('  deep.ts  ') && nested.text.includes('  entry.ts  '));
    assert.ok(!nested.text.includes('app.ts'));
    const one = repoMap(db, { path: './src/util.ts' });
    assert.equal(one.filesTotal, 1);
    assert.equal(one.shown, 4);
    assert.ok(one.text.startsWith('src/\n  util.ts  '));
    assert.deepEqual(repoMap(db, { path: 'src/nothing' }), { text: '', shown: 0, total: 0, truncated: false, files: 0, filesTotal: 0 });
  });

  test('rejects invalid arguments', () => {
    assert.throws(() => repoMap(null), /must be a DatabaseSync/);
    assert.throws(() => repoMap(db, { budgetTokens: 0 }), /positive integer/);
    assert.throws(() => repoMap(db, { budgetTokens: 12.5 }), /positive integer/);
    assert.throws(() => repoMap(db, { path: 5 }), /must be a string/);
  });

  test('when the budget cuts the map, total / filesTotal still describe the whole scope (first six symbols per file)', () => {
    const sym = (kind, name, line, end) => ({ kind, name, qual: name, startLine: line, endLine: end, startCol: 0, parent: null });
    const meta = (p) => ({ path: p, lang: 'typescript', hash: p, mtimeMs: 1, size: 1, parseOk: true, errorNodes: 0, indexedAt: 1 });
    const big = openDatabase(':memory:');
    try {
      big.exec('SAVEPOINT bulk');
      for (let d = 0; d < 3; d++) {
        for (let i = 0; i < 10; i++) {
          const p = `pkg${d}/mod${String(i).padStart(2, '0')}.ts`;
          const n = i === 0 ? 3 : 8; // one small file per package, the rest have more than six symbols
          replaceFile(big, meta(p), { symbols: Array.from({ length: n }, (_, k) => sym('function', `fn${d}_${i}_${k}`, 1 + k, 1 + k)), refs: [], imports: [] });
        }
      }
        replaceFile(big, meta('pkg0/empty.ts'), { symbols: [], refs: [], imports: [] });
        big.exec('RELEASE bulk');
      const cut = repoMap(big, { budgetTokens: 100 });
      assert.equal(cut.truncated, true);
      assert.ok(cut.shown < cut.total, `${cut.shown} of ${cut.total}`);
      assert.equal(cut.total, 3 * 9 * 6 + 3 * 3, 'every file with symbols contributes min(6, its count)');
      assert.equal(cut.filesTotal, 30, 'files without symbols are not counted');
      assert.ok(cut.files < cut.filesTotal);
      assert.equal(cut.text.split('\n')[0], 'pkg0/', 'output order is unchanged: directories sorted, files in path order');
      // Same scope narrowed: the counts follow the scope, and an uncut map needs no aggregate at all.
      const scoped = repoMap(big, { path: 'pkg1', budgetTokens: 100 });
      assert.equal(scoped.filesTotal, 10);
      assert.equal(scoped.total, 9 * 6 + 3);
      const whole = repoMap(big, { path: 'pkg1', budgetTokens: 4000 });
      assert.equal(whole.truncated, false);
      assert.equal(whole.shown, whole.total);
      assert.equal(whole.files, whole.filesTotal);
    } finally {
      big.close();
    }
  });
});
