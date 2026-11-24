// Cross-file resolution over the ts-basic fixture (CONTRACTS.md §8/§9): the real
// engine indexes the project into an in-memory database, resolveAll fills
// imports.resolved_file_id and refs.resolution, and every rule (a)–(d) is pinned
// on a concrete ref. Synthetic python / go rows exercise the import resolver
// without their language packs.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initEngine, extractFile, loadSpecs, specForPath } from '../../src/extract/engine.mjs';
import { deleteFile, replaceFile, metaSet } from '../../src/store/repo.mjs';
import { resolveAll, resolveFile } from '../../src/resolve/pipeline.mjs';
import { buildProject, refsOf, refAt, importsOf, fileIdOf, ensureEngine } from './fixture.mjs';

const APP = 'src/app.ts';
const SHAPES = 'src/shapes.ts';
const UTIL = 'src/util.ts';
const DEEP = 'src/nested/deep.ts';

const open = [];
async function project(options) {
  const db = await buildProject(options);
  open.push(db);
  return db;
}
after(() => {
  for (const db of open.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
});

const fileMeta = (p, lang = 'typescript') => ({ path: p, lang, hash: `${p}#1`, mtimeMs: 1, size: 1, parseOk: true, errorNodes: 0, indexedAt: 1 });

async function indexSource(db, rel, source) {
  await ensureEngine();
  const spec = specForPath(rel, await loadSpecs());
  const out = await extractFile({ path: rel, source, spec });
  return replaceFile(db, { ...fileMeta(rel), hash: out.hash, size: out.size, parseOk: out.parseOk, errorNodes: out.errorNodes }, out);
}

describe('resolveAll on ts-basic', () => {
  test('every import resolves to its file, including the dynamic import()', async () => {
    const db = await project();
    const expected = {
      [APP]: ['./util', './util', './shapes', './math', './util'],
      [SHAPES]: ['./util', './util'],
      [DEEP]: ['../util', '../math'],
    };
    for (const [file, specs] of Object.entries(expected)) {
      const rows = importsOf(db, file);
      assert.deepEqual(rows.map((r) => r.spec), specs, file);
      assert.ok(rows.every((r) => r.resolved !== null), `${file}: every import has resolved_file_id`);
    }
    assert.equal(importsOf(db, APP)[4].kind, 'dynamic');
    assert.equal(importsOf(db, APP)[4].resolved, UTIL, 'dynamic import() resolves the file even though it never produces a ref edge');
    assert.equal(importsOf(db, DEEP)[0].resolved, UTIL, '../util from src/nested');
  });

  test('(b) names bound by imports resolve to the exported definition, aliases included', async () => {
    const db = await project();
    const expect = (file, line, name, resolution, target, targetPath, kind = null) => {
      const r = refAt(db, file, line, name, kind);
      assert.equal(r.resolution, resolution, `${file}:${line} ${name} resolution`);
      assert.equal(r.target, target, `${file}:${line} ${name} target`);
      if (targetPath) assert.equal(r.targetPath, targetPath, `${file}:${line} ${name} target path`);
      return r;
    };
    // Import statements bind names; they are not uses and produce no refs.
    assert.deepEqual(refsOf(db, APP).filter((r) => r.line <= 4), []);
    assert.deepEqual(refsOf(db, SHAPES).filter((r) => r.line <= 2), []);
    assert.deepEqual(refsOf(db, DEEP).filter((r) => r.line <= 2), []);
    expect(APP, 7, 'doubled', '=', 'helper', UTIL);
    expect(APP, 9, 'doubled', '=', 'helper', UTIL);
    expect(APP, 10, 'Shape', '=', 'Shape', SHAPES, 'type'); // type annotation
    expect(APP, 12, 'square', '=', 'square', 'src/math.ts');
    expect(APP, 12, 'format', '=', 'format', UTIL);
    expect(APP, 28, 'helper', '=', 'helper', UTIL);
    expect(DEEP, 5, 'helper', '=', 'helper', UTIL);
    expect(DEEP, 5, 'square', '=', 'square', 'src/math.ts');
    expect(SHAPES, 12, 'twice', '=', 'helper', UTIL);
  });

  test('(a) a plain local shadows the import: the call is ? and never falls back to util.helper', async () => {
    const db = await project();
    assert.deepEqual(refsOf(db, APP).filter((r) => r.line === 7 && r.name === 'helper'), [], 'the binding of a plain local is not a reference');
    const call = refAt(db, APP, 8, 'helper');
    assert.equal(call.kind, 'call');
    assert.equal(call.scope, 'local');
    assert.equal(call.resolution, '?', 'shadowed by the local on line 7');
    assert.equal(call.target, null);
    assert.equal(call.targetId, null);
    // The same name through the alias still resolves: the shadow is lexical, not file-wide.
    assert.equal(refAt(db, APP, 9, 'doubled').resolution, '=');
    assert.equal(refAt(db, APP, 28, 'helper').resolution, '=', 'outside run() the import is visible again');
  });

  test('(a) a nested function-valued const is an indexed symbol: locals link its call with =', async () => {
    const db = await project();
    const call = refAt(db, APP, 12, 'plus');
    assert.equal(call.scope, 'local');
    assert.equal(call.resolution, '=');
    assert.equal(call.target, 'plus');
    assert.equal(call.targetPath, APP);
  });

  test('(c) this.m() -> the enclosing class method; Klass.member() through an import or a local class -> =; typed variable -> ~', async () => {
    const db = await project();
    assert.equal(refAt(db, SHAPES, 12, 'this.area').resolution, '=');
    assert.equal(refAt(db, SHAPES, 12, 'this.area').target, 'area');
    assert.equal(refAt(db, SHAPES, 12, 'this.area').targetPath, SHAPES);
    const created = refAt(db, SHAPES, 20, 'Shape.create');
    assert.equal(created.resolution, '=', 'receiver is a class declared in this file');
    assert.equal(created.target, 'create');
    const viaImport = refAt(db, APP, 10, 'Shape.create');
    assert.equal(viaImport.resolution, '=', 'receiver is an imported class');
    assert.equal(viaImport.target, 'create');
    assert.equal(viaImport.targetPath, SHAPES);
    const typed = refAt(db, APP, 12, 'shaped.area');
    assert.equal(typed.resolution, '~', 'receiver is a variable with a type annotation: by name only');
    assert.equal(typed.target, 'area');
    assert.equal(typed.targetPath, SHAPES);
    assert.equal(refAt(db, SHAPES, 20, 'Shape.create().area').resolution, '~', 'chained receiver falls back to the unique member name');
  });

  test('(d) bare names: ambiguous across files -> ?, unknown receiver members -> ?, unresolved types -> ?', async () => {
    const db = await project();
    const dup = refAt(db, APP, 16, 'duplicated');
    assert.equal(dup.resolution, '?', 'duplicated() exists in util.ts and math.ts');
    assert.equal(dup.target, null);
    for (const name of ['cache.has', 'cache.get', 'cache.set']) {
      const r = refAt(db, APP, name === 'cache.set' ? 29 : 27, name);
      assert.equal(r.resolution, '?', name);
      assert.equal(r.target, null, name);
    }
    assert.equal(refAt(db, APP, 19, 'Promise').resolution, '?');
    assert.equal(refAt(db, APP, 24, 'Map').resolution, '?');
    assert.equal(refAt(db, UTIL, 6, 'text.trim').resolution, '?');
  });

  test('(d) bare names without locals: unique in the file or in the index -> ~, ambiguous -> ?', async () => {
    const db = await buildProject({ resolve: false });
    open.push(db);
    const sym = (kind, name, line, end) => ({ kind, name, qual: name, startLine: line, endLine: end, startCol: 0, parent: null });
    const meta = (p) => ({ ...fileMeta(p, 'python'), path: p });
    replaceFile(db, meta('src/unique.py'), {
      symbols: [sym('function', 'once', 1, 2), sym('function', 'caller', 4, 6)],
      refs: [
        { name: 'once', kind: 'call', startLine: 5, startCol: 2, endLine: 5, symbol: 1 },
        { name: 'same', kind: 'call', startLine: 5, startCol: 10, endLine: 5, symbol: 1 },
      ],
      imports: [],
    });
    replaceFile(db, meta('src/other.py'), {
      symbols: [sym('function', 'same', 1, 2), sym('function', 'main', 4, 6)],
      refs: [{ name: 'once', kind: 'call', startLine: 5, startCol: 2, endLine: 5, symbol: 1 }],
      imports: [],
    });
    replaceFile(db, meta('src/third.py'), { symbols: [sym('function', 'same', 1, 2)], refs: [], imports: [] });
    resolveAll(db);
    assert.equal(refAt(db, 'src/unique.py', 5, 'once').resolution, '~', 'unique in its own file');
    assert.equal(refAt(db, 'src/unique.py', 5, 'once').target, 'once');
    assert.equal(refAt(db, 'src/other.py', 5, 'once').resolution, '~', 'unique in the whole index');
    assert.equal(refAt(db, 'src/other.py', 5, 'once').targetPath, 'src/unique.py');
    const ambiguous = refAt(db, 'src/unique.py', 5, 'same');
    assert.equal(ambiguous.resolution, '?', 'defined in two other files and not in this one');
    assert.equal(ambiguous.target, null);
  });

  test('resolveAll returns the totals of this run and is idempotent', async () => {
    const db = await buildProject({ resolve: false });
    open.push(db);
    const first = resolveAll(db);
    const total = db.prepare('SELECT COUNT(*) AS n FROM refs').get().n;
    assert.equal(first.resolved + first.ambiguous + first.unresolved, total, 'every ref is classified exactly once');
    assert.ok(first.resolved >= 10, `resolved ${first.resolved}`);
    assert.ok(first.ambiguous >= 1, `ambiguous ${first.ambiguous}`);
    assert.ok(first.unresolved >= 5, `unresolved ${first.unresolved}`);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM refs WHERE target_id IS NOT NULL').get().n, first.resolved);
    const again = resolveAll(db);
    assert.deepEqual(again, { resolved: 0, ambiguous: 0, unresolved: 0 }, 'nothing is pending after the first pass');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM refs WHERE resolution IS NULL').get().n, 0);
  });
});

describe('incremental resolveFile', () => {
  test('refs in other files whose target was re-indexed are resolved again', async () => {
    const db = await project();
    const utilId = fileIdOf(db, UTIL);
    assert.equal(refAt(db, SHAPES, 12, 'twice').targetId, db.prepare("SELECT id FROM symbols WHERE name = 'helper' AND file_id = ?").get(utilId).id);

    // util.ts loses helper: the store nulls every ref that pointed at it.
    const withoutHelper = fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'projects', 'ts-basic', UTIL), 'utf8')
      .replace('export function helper(value: number): number {\n  return value * 2;\n}\n\n', '');
    await indexSource(db, UTIL, withoutHelper);
    const detached = refAt(db, SHAPES, 12, 'twice');
    assert.equal(detached.targetId, null);
    assert.equal(detached.resolution, null, 'pending again');
    const counts = resolveFile(db, utilId);
    assert.ok(counts.unresolved >= 2, 'shapes.ts twice refs and app.ts helper refs were reprocessed');
    const after = refAt(db, SHAPES, 12, 'twice');
    assert.equal(after.resolution, '?', 'the import no longer exports helper');
    assert.equal(after.target, null);
    assert.equal(refAt(db, DEEP, 5, 'helper').resolution, '?');

    // helper comes back: the importers' ? refs bound to its alias are re-evaluated.
    await indexSource(db, UTIL, fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'projects', 'ts-basic', UTIL), 'utf8'));
    resolveFile(db, fileIdOf(db, UTIL));
    assert.equal(refAt(db, SHAPES, 12, 'twice').resolution, '=');
    assert.equal(refAt(db, SHAPES, 12, 'twice').target, 'helper');
    assert.equal(refAt(db, DEEP, 5, 'helper').resolution, '=');
    assert.equal(refAt(db, APP, 8, 'helper').resolution, '?', 'the lexical shadow is untouched');
  });

  test('a file indexed later satisfies imports and ? refs of files processed earlier', async () => {
    const db = await buildProject({ resolve: false, project: path.join(import.meta.dirname, '..', 'fixtures', 'projects', 'ts-basic', 'src', 'nested') });
    open.push(db);
    await indexSource(db, 'src/early.ts', "import { late } from './late';\nexport function run(): number {\n  return late();\n}\n");
    resolveAll(db);
    assert.equal(importsOf(db, 'src/early.ts')[0].resolved, null, 'late.ts does not exist yet');
    assert.equal(refAt(db, 'src/early.ts', 3, 'late').resolution, '?');

    const late = await indexSource(db, 'src/late.ts', 'export function late(): number {\n  return 1;\n}\n');
    resolveFile(db, late.fileId);
    assert.equal(importsOf(db, 'src/early.ts')[0].resolved, 'src/late.ts', 'importers mentioning the new stem are re-checked');
    assert.equal(refAt(db, 'src/early.ts', 3, 'late').resolution, '=');
    assert.equal(refAt(db, 'src/early.ts', 3, 'late').target, 'late');
  });

  test('resolveFile throws for an unknown file id', async () => {
    const db = await project();
    assert.throws(() => resolveFile(db, 999999), /no file with id 999999/);
  });
});

describe('receivers resolved to a class, and imports whose module is not indexed', () => {
  // Small projects indexed with the real engine on top of an empty ts-basic copy.
  async function scratch(files) {
    const db = await buildProject({ resolve: false, project: path.join(import.meta.dirname, '..', 'fixtures', 'projects', 'ts-basic', 'src', 'nested') });
    open.push(db);
    for (const [rel, src] of Object.entries(files)) await indexSource(db, rel, src);
    resolveAll(db);
    return db;
  }
  const SHAPES_SRC = 'export class Shape {\n  area(): number { return 1; }\n  static create(): Shape { return new Shape(); }\n}\nexport function nope(): number { return 0; }\n';

  test('(c) Klass.member() with Klass imported or declared here and no such member -> ? (never the globally unique name)', async () => {
    const db = await scratch({
      'src/shapes.ts': SHAPES_SRC,
      'src/use.ts': "import { Shape } from './shapes';\nclass Local extends Shape {\n  run(): number { return 1; }\n}\nexport function g(): number {\n  return Shape.nope() + Local.nope() + Shape.create().area();\n}\n",
    });
    const use = refsOf(db, 'src/use.ts');
    const at = (line, receiver, name) => use.find((r) => r.line === line && r.receiver === receiver && r.name === name);
    assert.equal(at(6, 'Shape', 'nope').resolution, '?', 'imported class without the member: no edge');
    assert.equal(at(6, 'Shape', 'nope').targetId, null);
    assert.equal(at(6, 'Local', 'nope').resolution, '?', 'class declared in this file without the member: no edge');
    assert.equal(at(6, 'Shape', 'create').resolution, '=', 'an existing static member still resolves');
    assert.equal(at(6, 'Shape.create()', 'area').resolution, '~', 'unknown receiver keeps the unique-name rule');
    // The global `nope` is not reached through a class, only as a bare name.
    const bare = await scratch({ 'src/shapes.ts': SHAPES_SRC, 'src/use.ts': "import { Shape } from './shapes';\nexport function g(): number {\n  return nope();\n}\n" });
    assert.equal(refsOf(bare, 'src/use.ts').find((r) => r.name === 'nope').resolution, '~');
  });

  test('this.m() not declared on the enclosing class keeps the unique-name fallback (it may be inherited)', async () => {
    const db = await scratch({
      'src/shapes.ts': SHAPES_SRC,
      'src/use.ts': "import { Shape } from './shapes';\nclass Sub extends Shape {\n  total(): number {\n    return this.area() + this.missing();\n  }\n}\n",
    });
    const use = refsOf(db, 'src/use.ts');
    assert.equal(use.find((r) => r.name === 'area' && r.receiver === 'this').resolution, '~', 'inherited member found by name');
    assert.equal(use.find((r) => r.name === 'missing' && r.receiver === 'this').resolution, '?');
  });

  test('(b) an import binding whose module is not in the index stays ?, even when the name is globally unique', async () => {
    const db = await scratch({
      'lib.ts': 'export function foo(): number { return 1; }\n',
      'src/app.ts': "import { foo } from './missing';\nimport { chunk } from 'lodash';\nexport function g(value: number): number {\n  return foo() + chunk(value);\n}\n",
    });
    const app = refsOf(db, 'src/app.ts');
    assert.equal(importsOf(db, 'src/app.ts')[0].resolved, null);
    assert.equal(importsOf(db, 'src/app.ts')[1].resolved, null, 'a package specifier is never a project file');
    assert.equal(app.find((r) => r.name === 'foo').resolution, '?', 'the import pins foo to ./missing; lib.ts foo is a different symbol');
    assert.equal(app.find((r) => r.name === 'foo').targetId, null);
    assert.equal(app.find((r) => r.name === 'chunk').resolution, '?', 'a package import does not fall back to a same-named project symbol either');
    // Once the module exists the same ref resolves through the import.
    await indexSource(db, 'src/missing.ts', 'export function foo(): number { return 2; }\n');
    resolveFile(db, fileIdOf(db, 'src/missing.ts'));
    const after = refsOf(db, 'src/app.ts').find((r) => r.name === 'foo');
    assert.equal(after.resolution, '=');
    assert.equal(after.targetPath, 'src/missing.ts');
  });
});

describe('synthetic python and go imports', () => {
  const sym = (kind, name, line, end) => ({ kind, name, qual: name, startLine: line, endLine: end, startCol: 0, parent: null });
  const insert = (db, p, lang, data) => replaceFile(db, fileMeta(p, lang), data);

  test('python: absolute and relative (one / two dots) imports resolve to module.py or package __init__.py', async () => {
    const db = await buildProject({ resolve: false });
    open.push(db);
    insert(db, 'pkg/helper.py', 'python', { symbols: [sym('function', 'helper', 1, 2)], refs: [], imports: [] });
    insert(db, 'pkg/__init__.py', 'python', { symbols: [], refs: [], imports: [] });
    insert(db, 'pkg/mod.py', 'python', {
      symbols: [sym('function', 'load', 2, 4)],
      refs: [{ name: 'helper', kind: 'call', startLine: 3, startCol: 2, endLine: 3, symbol: 0 }],
      imports: [{ spec: '.helper', names: [{ imported: 'helper', alias: 'helper' }], kind: 'from', startLine: 1 }],
    });
    insert(db, 'pkg/sub/deep.py', 'python', {
      symbols: [sym('function', 'deep', 2, 4)],
      refs: [{ name: 'helper', kind: 'call', startLine: 3, startCol: 2, endLine: 3, symbol: 0 }],
      imports: [{ spec: '..helper', names: [{ imported: 'helper', alias: 'helper' }], kind: 'from', startLine: 1 }],
    });
    insert(db, 'pkg/abs.py', 'python', {
      symbols: [],
      refs: [],
      imports: [{ spec: 'pkg.helper', kind: 'from', startLine: 1 }, { spec: 'pkg', kind: 'import', startLine: 2 }, { spec: 'os.path', kind: 'import', startLine: 3 }],
    });
    const counts = resolveAll(db);
    assert.equal(importsOf(db, 'pkg/mod.py')[0].resolved, 'pkg/helper.py');
    assert.equal(importsOf(db, 'pkg/sub/deep.py')[0].resolved, 'pkg/helper.py');
    assert.deepEqual(importsOf(db, 'pkg/abs.py').map((r) => r.resolved), ['pkg/helper.py', 'pkg/__init__.py', null]);
    for (const file of ['pkg/mod.py', 'pkg/sub/deep.py']) {
      const r = refAt(db, file, 3, 'helper');
      assert.equal(r.resolution, '=', file);
      assert.equal(r.targetPath, 'pkg/helper.py', file);
    }
    assert.ok(counts.resolved >= 2);
  });

  test('go: in-module package paths resolve to a directory (first indexed file) via go.mod or the tail heuristic; stdlib stays null', async () => {
    const db = await buildProject({ resolve: false });
    open.push(db);
    insert(db, 'internal/util/util.go', 'go', { symbols: [sym('function', 'DoThing', 1, 2)], refs: [], imports: [] });
    insert(db, 'internal/util/helper.go', 'go', { symbols: [], refs: [], imports: [] });
    insert(db, 'cmd/server/main.go', 'go', {
      symbols: [sym('function', 'main', 5, 7)],
      refs: [{ name: 'DoThing', kind: 'call', startLine: 6, startCol: 2, endLine: 6, symbol: 0 }],
      imports: [{ spec: 'example.com/x/internal/util', kind: 'import', startLine: 3 }, { spec: 'fmt', kind: 'import', startLine: 4 }],
    });
    resolveAll(db);
    assert.equal(importsOf(db, 'cmd/server/main.go')[0].resolved, 'internal/util/helper.go');
    assert.equal(importsOf(db, 'cmd/server/main.go')[1].resolved, null);
    const call = refAt(db, 'cmd/server/main.go', 6, 'DoThing');
    assert.equal(call.resolution, '~', 'no alias: the bare name is globally unique');
    assert.equal(call.targetPath, 'internal/util/util.go');

    // With go.mod reachable through meta root, the module path strips the prefix explicitly.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-gomod-'));
    try {
      fs.writeFileSync(path.join(dir, 'go.mod'), 'module example.com/x\n\ngo 1.22\n');
      metaSet(db, 'root', dir);
      db.prepare('UPDATE imports SET resolved_file_id = NULL').run();
      resolveAll(db);
      assert.equal(importsOf(db, 'cmd/server/main.go')[0].resolved, 'internal/util/helper.go');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('recheck after a re-index (what a second version of a file may change elsewhere)', () => {
  // A bare project on top of an empty ts-basic copy; every file indexed with
  // the real engine, resolved once, then one file edited and resolveFile'd,
  // which is exactly what the indexer does for an incremental sync.
  async function scratch(files) {
    const db = await buildProject({ resolve: false, project: path.join(import.meta.dirname, '..', 'fixtures', 'projects', 'ts-basic', 'src', 'nested') });
    open.push(db);
    for (const [rel, src] of Object.entries(files)) await indexSource(db, rel, src);
    resolveAll(db);
    return db;
  }
  const USE = 'src/use.ts';

  test('a definition the file gains re-evaluates the ? refs named after it elsewhere; the others keep their mark', async () => {
    const db = await scratch({
      'src/lib.ts': 'export function a(): number { return 1; }\n',
      [USE]: "import { a } from './lib';\nexport function g(): number {\n  return a() + b() + c();\n}\n",
    });
    assert.equal(refAt(db, USE, 3, 'a').resolution, '=');
    assert.equal(refAt(db, USE, 3, 'b').resolution, '?');
    assert.equal(refAt(db, USE, 3, 'c').resolution, '?');

    await indexSource(db, 'src/lib.ts', 'export function a(): number { return 1; }\nexport function b(): number { return 2; }\n');
    resolveFile(db, fileIdOf(db, 'src/lib.ts'));
    assert.equal(refAt(db, USE, 3, 'b').resolution, '~', 'b is now the only definition: unique by name');
    assert.equal(refAt(db, USE, 3, 'b').targetPath, 'src/lib.ts');
    assert.equal(refAt(db, USE, 3, 'c').resolution, '?', 'still undefined');
    assert.equal(refAt(db, USE, 3, 'a').resolution, '=', 're-pointed to the new id of a');
    assert.equal(refAt(db, USE, 3, 'a').target, 'a');
  });

  test('a renamed definition: refs of the old name lose their target, refs of the new name gain one', async () => {
    const db = await scratch({
      'src/lib.ts': 'export function foo(): number { return 1; }\n',
      [USE]: "import { foo, bar } from './lib';\nexport function g(): number {\n  return foo() + bar();\n}\n",
    });
    assert.equal(refAt(db, USE, 3, 'foo').resolution, '=');
    assert.equal(refAt(db, USE, 3, 'bar').resolution, '?', 'imported from lib, which does not export it');

    await indexSource(db, 'src/lib.ts', 'export function bar(): number { return 2; }\n');
    resolveFile(db, fileIdOf(db, 'src/lib.ts'));
    assert.equal(refAt(db, USE, 3, 'foo').resolution, '?', 'the import pins foo to lib, which no longer has it');
    assert.equal(refAt(db, USE, 3, 'foo').targetId, null);
    assert.equal(refAt(db, USE, 3, 'bar').resolution, '=', 'the export was added back');
    assert.equal(refAt(db, USE, 3, 'bar').target, 'bar');
  });

  test('a definition whose kind changes is a changed name: kind-sensitive refs are re-evaluated', async () => {
    const db = await scratch({
      'src/x1.ts': 'export function x(): number { return 1; }\n',
      'src/lib.ts': 'export function x(): number { return 2; }\n',
      [USE]: "export function g(): x {\n  return null as unknown as x;\n}\n",
    });
    // Two functions named x: a type ref narrows to type kinds, finds none and
    // falls back to both candidates, which is ambiguous.
    assert.equal(refAt(db, USE, 1, 'x', 'type').resolution, '?');
    assert.equal(refAt(db, USE, 1, 'x', 'type').targetId, null);
    await indexSource(db, 'src/lib.ts', 'export class x {}\n');
    resolveFile(db, fileIdOf(db, 'src/lib.ts'));
    assert.equal(refAt(db, USE, 1, 'x', 'type').resolution, '~', 'the class is now the only type-kind candidate');
    assert.equal(refAt(db, USE, 1, 'x', 'type').targetPath, 'src/lib.ts');
  });

  test('a file removed in the same sync: ? refs named after its definitions become resolvable', async () => {
    const db = await scratch({
      'src/x1.ts': 'export function x(): number { return 1; }\n',
      'src/x2.ts': 'export function x(): number { return 2; }\n',
      [USE]: "export function g(): number {\n  return x();\n}\n",
      'src/other.ts': 'export function other(): number { return 3; }\n',
    });
    assert.equal(refAt(db, USE, 2, 'x').resolution, '?', 'two definitions: ambiguous');
    assert.equal(deleteFile(db, 'src/x2.ts'), true);
    assert.equal(refAt(db, USE, 2, 'x').resolution, '?', 'a deletion alone does not touch ? refs');

    // The indexer re-indexes another file of the same sync: its resolveFile
    // sees what the deletion removed and re-evaluates the name.
    await indexSource(db, 'src/other.ts', 'export function other(): number { return 4; }\n');
    resolveFile(db, fileIdOf(db, 'src/other.ts'));
    assert.equal(refAt(db, USE, 2, 'x').resolution, '~', 'x is unique now');
    assert.equal(refAt(db, USE, 2, 'x').targetPath, 'src/x1.ts');
  });

  test('an edit that leaves every definition unchanged re-evaluates nothing else by name', async () => {
    const db = await scratch({
      'src/lib.ts': 'export function a(): number {\n  return 1;\n}\n',
      [USE]: "export function g(): number {\n  return a() + b();\n}\n",
    });
    const before = refsOf(db, USE);
    assert.deepEqual(before.map(r => [r.name, r.resolution]), [['a', '~'], ['b', '?']]);
    // Same definitions, a longer body: the shapes of lib.ts's names are identical,
    // so nothing elsewhere is re-evaluated; and since the definition keeps its
    // id (repo), use.ts's a is not even pending again.
    await indexSource(db, 'src/lib.ts', 'export function a(): number {\n  const one = 1;\n  return one;\n}\n');
    const counts = resolveFile(db, fileIdOf(db, 'src/lib.ts'));
    assert.deepEqual(counts, { resolved: 0, ambiguous: 0, unresolved: 0 }, 'lib.ts itself has no refs left; use.ts was not looked at');
    const after = refsOf(db, USE);
    assert.deepEqual(after.map(r => [r.name, r.resolution, r.targetPath]), [['a', '~', 'src/lib.ts'], ['b', '?', null]]);
    assert.equal(after[0].targetId, before[0].targetId, 'the definition kept its id');
  });

  test('editing a file keeps the ids of its definitions: refs elsewhere stay resolved and are not looked at again', async () => {
    const db = await scratch({
      'src/lib.ts': 'export function a(): number {\n  return 1;\n}\nexport function b(): number {\n  return a() + 1;\n}\n',
      [USE]: "import { a, b } from './lib';\nexport function g(): number {\n  return a() + b();\n}\n",
    });
    const before = refsOf(db, USE);
    assert.deepEqual(before.map(r => [r.name, r.resolution, r.target]), [['a', '=', 'a'], ['b', '=', 'b']]);

    // Only line numbers move: both definitions survive with their ids.
    await indexSource(db, 'src/lib.ts', '// a comment line\n// another one\nexport function a(): number {\n  return 1;\n}\nexport function b(): number {\n  return a() + 1;\n}\n');
    const counts = resolveFile(db, fileIdOf(db, 'src/lib.ts'));
    const after = refsOf(db, USE);
    assert.deepEqual(after.map(r => [r.name, r.resolution, r.target]), [['a', '=', 'a'], ['b', '=', 'b']]);
    assert.deepEqual(after.map(r => r.targetId), before.map(r => r.targetId), 'same target ids');
    assert.deepEqual(counts, { resolved: 1, ambiguous: 0, unresolved: 0 }, "only lib.ts's own a() call was pending");
    assert.equal(refsOf(db, 'src/lib.ts').find(r => r.name === 'a').resolution !== null, true, 'and it is classified again');
    assert.equal(db.prepare('SELECT start_line FROM symbols WHERE id = ?').get(after[0].targetId).start_line, 3, 'the kept row moved in place');
  });

  test('a definition that keeps its id but loses its export: the importer\'s = ref is looked at again', async () => {
    const db = await scratch({
      'src/lib.ts': 'export function a(): number {\n  return 1;\n}\nexport function b(): number {\n  return 2;\n}\n',
      [USE]: "import { a, b } from './lib';\nexport function g(): number {\n  return a() + b();\n}\n",
    });
    const before = refsOf(db, USE);
    assert.deepEqual(before.map(r => [r.name, r.resolution]), [['a', '='], ['b', '=']]);
    // b is still defined (same id) but no longer exported: its shape changed, so
    // the importer's ref is re-evaluated (whatever its mark). The index does not
    // track exports precisely, so the outcome is the same and nothing is written.
    await indexSource(db, 'src/lib.ts', 'export function a(): number {\n  return 1;\n}\nfunction b(): number {\n  return 2;\n}\n');
    const counts = resolveFile(db, fileIdOf(db, 'src/lib.ts'));
    assert.deepEqual(counts, { resolved: 1, ambiguous: 0, unresolved: 0 }, "use.ts's b was looked at again (lib.ts has no refs of its own)");
    assert.deepEqual(refsOf(db, USE).map(r => [r.name, r.resolution, r.targetId]), [['a', '=', before[0].targetId], ['b', '=', before[1].targetId]]);
  });

  test('a deleted file that pointed at its own symbols does not break the next resolveFile', async () => {
    const db = await scratch({
      'src/recursive.ts': 'export function down(n: number): number {\n  return n === 0 ? 0 : down(n - 1);\n}\n',
      [USE]: "import { down } from './recursive';\nexport function g(): number {\n  return down(3);\n}\n",
    });
    const own = refsOf(db, 'src/recursive.ts').find(r => r.name === 'down' && r.kind === 'call');
    assert.ok(['=', '~'].includes(own.resolution) && own.targetPath === 'src/recursive.ts', 'the recursive call points at its own definition');
    deleteFile(db, 'src/recursive.ts');
    // The next sync re-indexes another file: its resolveFile must skip the
    // deleted file that the store recorded as pending (its own refs).
    await indexSource(db, 'src/other.ts', 'export function other(): number {\n  return 4;\n}\n');
    const counts = resolveFile(db, fileIdOf(db, 'src/other.ts'));
    assert.deepEqual(counts, { resolved: 0, ambiguous: 0, unresolved: 1 }, "use.ts's down was looked at (its module is gone)");
    assert.equal(refsOf(db, USE).find(r => r.name === 'down').resolution, '?');
  });
});
