// resolveLocals (CONTRACTS.md §6/§8): scope stack over locals.scm captures,
// plus the engine integration (mergeLocals) on real TypeScript.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { initEngine, extractFile, loadSpecs, specForPath } from '../../src/extract/engine.mjs';
import { initTreeSitter, parserFor, queryTextFor } from '../../grammars/loader.mjs';
import { resolveLocals } from '../../src/resolve/locals.mjs';

await initEngine();
const specs = await loadSpecs();
const spec = specs.find((s) => s.id === 'typescript');
const TS = queryTextFor('typescript', 'locals');
const { Query } = await initTreeSitter();

async function extract(source) {
  return extractFile({ path: 'sample.ts', source, spec });
}

async function localsOf(source, symbols) {
  const parser = await parserFor('typescript');
  const tree = parser.parse(source);
  try {
    return resolveLocals(tree, TS, symbols);
  } finally {
    tree.delete();
  }
}

const at = (refs, line, name) => refs.filter((r) => r.startLine === line && r.name === name);
const nonCallNames = (out) => [...new Set(out.refs.filter((r) => r.kind !== 'call').map((r) => r.name))].sort();

describe('resolveLocals query', () => {
  test('typescript and tsx locals queries compile against their grammars', async () => {
    for (const grammar of ['typescript', 'tsx']) {
      const parser = await parserFor(grammar);
      const tree = parser.parse('const a = 1;\nfunction f(b) { return a + b; }\n');
      try {
        assert.doesNotThrow(() => new Query(tree.language, queryTextFor(grammar, 'locals')), grammar);
      } finally {
        tree.delete();
      }
    }
  });
});

describe('resolveLocals', () => {
  test('shadowing counterexample: a plain local makes the call local (localDef null), never the import or a global', async () => {
    const source = [
      "import { helper } from './util';",
      'export function run(n: number): number {',
      '  const helper = Math.max;',
      '  return helper(n, 1);',
      '}',
      '',
    ].join('\n');
    const out = await extract(source);
    const uses = at(out.refs, 4, 'helper');
    assert.equal(uses.length, 1, 'the shadowed call on line 4 is a call ref');
    assert.equal(uses[0].kind, 'call');
    assert.equal(uses[0].scope, 'local');
    assert.equal(uses[0].localDef, null, 'shadowed by a local that is not an indexed symbol');
    assert.deepEqual(nonCallNames(out), ['Math'], 'the plain local binding and its uses carry no graph information and are dropped; only the call survives');
    assert.ok(out.refs.filter((r) => r.name === 'helper').every((r) => r.scope === 'local'), 'no helper ref is left for import / global resolution');
    assert.equal(at(out.refs, 1, 'helper').length, 0, 'the import binding is consumed with the statement');
    // resolveLocals itself still reports the binding and the use so the caller can decide.
    const items = await localsOf(source, out.symbols);
    assert.deepEqual(items.filter((i) => i.name === 'helper').map((i) => [i.startLine, i.localDef]), [[3, null], [4, null]]);
  });

  test('a use resolves to the indexed symbol it denotes (top-level const / function) with localDef = symbol index', async () => {
    const symbols = [
      { kind: 'constant', name: 'TOP', startLine: 1, endLine: 1, startCol: 6, endCol: 9 },
      { kind: 'function', name: 'f', startLine: 2, endLine: 4, startCol: 0, endCol: 1 },
    ];
    const items = await localsOf('const TOP = 1;\nfunction f(n) {\n  return TOP + n;\n}\n', symbols);
    const top = items.find((i) => i.name === 'TOP' && i.startLine === 3);
    assert.deepEqual({ localDef: top.localDef, symbol: top.symbol, startCol: top.startCol, endLine: top.endLine }, { localDef: 0, symbol: 1, startCol: 9, endLine: 3 });
    const n = items.find((i) => i.name === 'n' && i.startLine === 3);
    assert.equal(n.localDef, null, 'parameter is a plain local');
    assert.equal(n.symbol, 1, 'enclosing symbol index');
    assert.ok(!items.some((i) => i.name === 'TOP' && i.startLine === 1), 'a definition is never reported as a reference');
    assert.ok(!items.some((i) => i.name === 'f' && i.startLine === 2), 'the function name is a definition, not a use');
  });

  test('hoisted function declaration: a use above the declaration in the same scope still sees the local', async () => {
    const symbols = [
      { kind: 'function', name: 'outer', startLine: 1, endLine: 5, startCol: 0, endCol: 1 },
      { kind: 'function', name: 'inner', startLine: 3, endLine: 3, startCol: 2, endCol: 22, parent: 0 },
    ];
    const items = await localsOf('function outer() {\n  const x = inner();\n  function inner() { return 1; }\n  return x;\n}\n', symbols);
    const call = items.find((i) => i.name === 'inner' && i.startLine === 2);
    assert.equal(call.localDef, 1, 'resolves to the hoisted inner declaration (an indexed symbol)');
    const x = items.find((i) => i.name === 'x' && i.startLine === 4);
    assert.equal(x.localDef, null, 'plain local');
  });

  test('a local that merely shares its name with the enclosing function is not that symbol', async () => {
    const symbols = [{ kind: 'function', name: 'process', startLine: 1, endLine: 4, startCol: 0, endCol: 1 }];
    const items = await localsOf('function process() {\n  const process = [1];\n  return process;\n}\n', symbols);
    const use = items.find((i) => i.name === 'process' && i.startLine === 3);
    assert.equal(use.localDef, null);
    assert.equal(use.symbol, 0);
  });

  test('destructuring, catch, for-of and type parameters bind; refs outside their scope do not see them', async () => {
    const source = [
      'const { a, b: renamed, ...rest } = obj;',
      'function f({ text, opts = null }: Bag, ...others) {',
      '  const total = a + renamed + rest.length + text + opts + others.length;',
      '}',
      'try { f(); } catch (err) { console.log(err); }',
      'for (const item of list) { use(item); }',
      'use(item);',
      'function g<T extends object>(v: T): T { return v; }',
      '',
    ].join('\n');
    const items = await localsOf(source, [{ kind: 'function', name: 'f', startLine: 2, endLine: 4, startCol: 0, endCol: 1 }]);
    // Plain locals only (localDef null): the symbol `f` resolves to itself and is not the point here.
    const names = (line) => items.filter((i) => i.startLine === line && i.localDef === null).map((i) => `${i.name}@${i.startCol}`).sort();
    assert.deepEqual(names(1), ['renamed@14', 'rest@26'], 'binding occurrences of destructured names (shorthand patterns are never refs)');
    assert.deepEqual(names(3).map((n) => n.split('@')[0]), ['a', 'opts', 'others', 'renamed', 'rest', 'text', 'total'], 'uses inside f plus the `total` binding');
    assert.deepEqual(names(5).map((n) => n.split('@')[0]), ['err', 'err'], 'catch parameter: binding and use');
    assert.deepEqual(names(6).map((n) => n.split('@')[0]), ['item', 'item'], 'for-of binding and use');
    assert.deepEqual(names(7), [], 'item is not visible after the loop');
    assert.deepEqual(names(8).map((n) => n.split('@')[0]).sort(), ['T', 'T', 'T', 'g', 'v', 'v'], 'type parameter binds inside g; g is not an indexed symbol here, so its binding is a plain local');
    assert.ok(items.filter((i) => i.localDef !== null).every((i) => i.name === 'f'), 'only the indexed function resolves to a symbol');
  });

  test('same-file declarations resolve uses from other scopes (name binds in the enclosing scope)', async () => {
    const symbols = [
      { kind: 'class', name: 'Point', startLine: 1, endLine: 3, startCol: 0, endCol: 1 },
      { kind: 'function', name: 'make', startLine: 4, endLine: 4, startCol: 0, endCol: 50 },
    ];
    const items = await localsOf('class Point {\n  static origin = new Point();\n}\nfunction make(): Point { return Point.origin; }\n', symbols);
    const uses = items.filter((i) => i.name === 'Point');
    assert.deepEqual(uses.map((i) => [i.startLine, i.localDef]), [[2, 0], [4, 0], [4, 0]]);
  });
});
