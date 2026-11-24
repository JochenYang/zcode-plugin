// Lane L4 (JVM/.NET/mobile packs): behaviour beyond the shared contract suite.
// Covers what expected.json cannot express: receiver splitting of member calls, visibility rules,
// grammar quirks worked around inside each pack, and that no pack lists node types absent from its grammar.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initEngine, extractFile, loadSpecs } from '../../src/extract/engine.mjs';

// A pack listing node types absent from its grammar is a defect (the engine only warns on stderr),
// so every write is captured and asserted clean at the end of the file.
const stderrLines = [];
const origWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  stderrLines.push(String(chunk));
  return origWrite(chunk, ...rest);
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '..', 'fixtures', 'langs');
const read = (lang, file) => fs.readFileSync(path.join(FIXTURES, lang, file), 'utf8');

await initEngine();
const specs = await loadSpecs();
const spec = (id) => specs.find((s) => s.id === id);
const run = (id, file, source) => extractFile({ path: file, source, spec: spec(id) });
const runFixture = (id, file) => run(id, file, read(id, file));
const symbol = (out, name) => out.symbols.find((s) => s.name === name);
const kinds = (out) => out.symbols.map((s) => [s.kind, s.name]);
const calls = (out) => out.refs.filter((r) => r.kind === 'call').map((r) => [r.name, r.receiver, r.startLine, out.symbols[r.symbol]?.name ?? null]);
const exportedOf = (out) => Object.fromEntries(out.symbols.map((s) => [s.qual, s.exported]));
const L4 = ['java', 'kotlin', 'scala', 'csharp', 'vbnet', 'dart', 'swift'];

after(() => {
  process.stderr.write = origWrite;
  const warnings = stderrLines.filter((l) => l.includes('codegraph:'));
  assert.deepEqual(warnings, [], `packs must not list node types missing from their grammar:\n${warnings.join('')}`);
});

describe('ownership', () => {
  test('every pack claims exactly its lane extensions and the bundled grammar', () => {
    const expected = {
      java: [['.java'], 'java'],
      kotlin: [['.kt', '.kts'], 'kotlin'],
      scala: [['.scala', '.sc'], 'scala'],
      csharp: [['.cs'], 'c_sharp'],
      vbnet: [['.vb'], 'vbnet'],
      dart: [['.dart'], 'dart'],
      swift: [['.swift'], 'swift'],
    };
    for (const [id, [exts, grammar]] of Object.entries(expected)) {
      const s = spec(id);
      assert.ok(s, `missing pack ${id}`);
      assert.deepEqual(s.extensions, exts, id);
      assert.equal(s.grammar, grammar, id);
      assert.equal(s.support, 'full', id);
    }
  });

  test('the wider real-world fixtures of every language parse without ERROR nodes', async () => {
    for (const id of L4) {
      const file = `extra${spec(id).extensions[0]}`;
      const out = await runFixture(id, file);
      assert.equal(out.parseOk, true, `${file} has ${out.errorNodes} ERROR nodes`);
      assert.ok(out.symbols.length > 5, `${file} should yield symbols`);
    }
  });
});

describe('java', () => {
  test('member calls carry the receiver; bare calls do not; `new ArrayList<>()` names the raw type', async () => {
    const out = await runFixture('java', 'sample.java');
    const byName = Object.fromEntries(calls(out).map((c) => [`${c[0]}@${c[2]}`, c]));
    assert.deepEqual(byName['round@20'].slice(0, 2), ['round', 'Math']);
    assert.deepEqual(byName['add@29'].slice(0, 2), ['add', 'parts']);
    assert.equal(byName['requireNonNull@15'][1], '');
    assert.deepEqual(byName['ArrayList@28'].slice(0, 2), ['ArrayList', '']);
    assert.equal(byName['round@20'][3], 'of', 'call inside a method body belongs to that method');
  });

  test('imports: single type, wildcard and static forms; package is a namespace symbol', async () => {
    const out = await runFixture('java', 'extra.java');
    const imports = Object.fromEntries(out.imports.map((i) => [i.spec, i.names]));
    assert.deepEqual(imports['java.util'], [{ imported: '*', alias: '*' }]);
    assert.deepEqual(imports['java.lang.Math'], [{ imported: 'max', alias: 'max' }]);
    assert.equal(symbol(out, 'com.example.extra').kind, 'namespace');
    // Path segments of the import statements themselves must not be refs (scoped type usages in code still are).
    const importLines = new Set(out.imports.map((i) => i.startLine));
    assert.ok(!out.refs.some((r) => r.kind !== 'call' && importLines.has(r.startLine)), 'import statements must not produce refs');
  });

  test('visibility: public members exported, package-private not; enum constants inherit the enum', async () => {
    const out = await runFixture('java', 'extra.java');
    const ex = exportedOf(out);
    assert.equal(ex['LineItem'], true);
    assert.equal(ex['LineItem.EMPTY'], true);
    assert.equal(ex['Region'], false);
    assert.equal(ex['Region.US'], false);
    assert.equal(ex['Defaults.SCALE'], false);
    assert.equal(ex['Base.names'], false, 'package-private method');
    assert.equal(ex['LineItem.EMPTY'], true);
  });

  test('records, enums, constants and `this(...)` / `super(...)` constructor invocations', async () => {
    const out = await runFixture('java', 'extra.java');
    assert.deepEqual(kinds(out).filter(([k]) => k === 'record' || k === 'enum' || k === 'constant'), [
      ['record', 'LineItem'], ['enum', 'Region'], ['constant', 'US'], ['constant', 'EU'], ['constant', 'SCALE'],
    ]);
    assert.deepEqual(calls(out).filter((c) => c[0] === 'this' || c[0] === 'super').map((c) => [c[0], c[2]]), [['this', 47], ['super', 51], ['super', 63]]);
    assert.equal(symbol(out, 'Base').endLine, 59);
  });
});

describe('kotlin', () => {
  test('the grammar exports no field names, yet every declaration is named', async () => {
    const { initTreeSitter, loadLanguage } = await import('../../grammars/loader.mjs');
    const { Language } = await initTreeSitter();
    const language = await loadLanguage('kotlin');
    assert.equal(language.fieldCount, 0);
    const out = await runFixture('kotlin', 'sample.kt');
    assert.deepEqual(kinds(out), [
      ['namespace', 'com.example.shop'], ['class', 'Money'], ['method', 'units'], ['method', 'plus'], ['object', 'Pricer'],
      ['constant', 'TAX_RATE'], ['constant', 'cache'], ['method', 'gross'], ['function', 'formatAmounts'],
    ]);
    assert.equal(symbol(out, 'units').signature, '() Double');
  });

  test('interface / enum are class_declaration nodes; companion object and enum entries are named', async () => {
    const out = await runFixture('kotlin', 'extra.kt');
    assert.deepEqual(kinds(out).filter(([k]) => ['interface', 'enum', 'object', 'type'].includes(k)), [
      ['type', 'Price'], ['interface', 'Priced'], ['enum', 'Region'], ['object', 'Companion'],
    ]);
    assert.equal(symbol(out, 'Companion').qual, 'Shape.Companion');
    assert.deepEqual(kinds(out).filter(([k]) => k === 'constant'), [['constant', 'US'], ['constant', 'EU'], ['constant', 'MAX_SIDES']]);
    assert.equal(symbol(out, 'MAX_SIDES').qual, 'Shape.Companion.MAX_SIDES');
  });

  test('call chains split into receiver + last selector; trailing lambdas are not double counted', async () => {
    const out = await runFixture('kotlin', 'sample.kt');
    const list = calls(out);
    assert.deepEqual(list.find((c) => c[0] === 'format'), ['format', 'String', 26, 'formatAmounts']);
    assert.deepEqual(list.find((c) => c[0] === 'roundToInt'), ['roundToInt', '(cents / 100.0)', 10, 'units']);
    // `require(x) { ... }` nests an outer call_expression around the real call; only one `require`.
    assert.equal(list.filter((c) => c[0] === 'require').length, 1);
    assert.equal(list.filter((c) => c[0] === 'joinToString').length, 1);
  });

  test('KDoc right after the imports (swallowed into import_header) is still found; `private` is not exported', async () => {
    const out = await runFixture('kotlin', 'sample.kt');
    assert.equal(symbol(out, 'Money').doc, 'Fixed-precision money in minor units.');
    assert.equal(symbol(out, 'units').doc, 'Whole units, rounded to two decimals.');
    const ex = exportedOf(out);
    assert.equal(ex['Money'], true);
    assert.equal(ex['Pricer.cache'], false);
    assert.equal(ex['Pricer.TAX_RATE'], true);
  });

  test('import aliases and wildcard imports', async () => {
    const out = await runFixture('kotlin', 'extra.kt');
    const imports = Object.fromEntries(out.imports.map((i) => [i.spec, i.names]));
    assert.deepEqual(imports['java.util.Locale'], [{ imported: 'Locale', alias: 'JavaLocale' }]);
    assert.deepEqual(imports['kotlin.collections'], [{ imported: '*', alias: '*' }]);
  });
});

describe('scala', () => {
  test('field_expression callees split into receiver + method; generic functions without parens are calls', async () => {
    const out = await runFixture('scala', 'sample.scala');
    const list = calls(out);
    assert.deepEqual(list.find((c) => c[0] === 'map'), ['map', 'items', 26, 'formatAmounts']);
    assert.deepEqual(list.find((c) => c[0] === 'empty'), ['empty', 'mutable.Map', 20, 'cache']);
    assert.equal(list.find((c) => c[0] === 'require')[1], '');
  });

  test('local vals are not symbols; abstract defs and type aliases are', async () => {
    const out = await runFixture('scala', 'extra.scala');
    const names = out.symbols.map((s) => s.name);
    assert.ok(!names.includes('c'), 'local `val c` must not be a symbol');
    assert.deepEqual(kinds(out).filter(([k]) => ['trait', 'type', 'variable', 'constant'].includes(k)), [
      ['trait', 'Priced'], ['type', 'Discount'], ['variable', 'count'], ['constant', 'items'],
    ]);
    assert.equal(symbol(out, 'price').qual, 'Priced.price');
  });

  test('import selectors, renames and wildcards', async () => {
    const out = await runFixture('scala', 'extra.scala');
    const imports = Object.fromEntries(out.imports.map((i) => [i.spec, i.names]));
    assert.deepEqual(imports['java.util'], [{ imported: 'Locale', alias: 'Locale' }, { imported: 'Random', alias: 'Rnd' }]);
    assert.deepEqual(imports['scala.collection'], [{ imported: '*', alias: '*' }]);
  });
});

describe('csharp', () => {
  test('exported = public | internal | protected; private and modifier-less members are not', async () => {
    const out = await runFixture('csharp', 'extra.cs');
    const ex = exportedOf(out);
    assert.equal(ex['Extra.Point'], true);
    assert.equal(ex['Extra.Point.X'], true);
    assert.equal(ex['Extra.Cart'], true);
    assert.equal(ex['Extra.Cart.Empty'], false, 'private static readonly');
    assert.equal(ex['Extra.Program'], false, 'no modifier');
    assert.equal(ex['Extra.Program.Main'], false);
    assert.equal(ex['Extra.Cart.Seed'], true);
    assert.equal(ex['Extra.Predicate'], true);
    assert.equal(symbol(out, 'Program').exported, false);
  });

  test('const fields are constants, enums inherit visibility, records and delegates are typed', async () => {
    const out = await runFixture('csharp', 'sample.cs');
    assert.deepEqual(kinds(out).filter(([k]) => ['constant', 'record', 'type', 'property', 'enum'].includes(k)), [
      ['constant', 'CentsPerUnit'], ['property', 'Cents'], ['record', 'LineItem'], ['enum', 'Region'], ['constant', 'Us'], ['constant', 'Eu'],
    ]);
    assert.equal(symbol(out, 'Us').exported, true);
    assert.equal(symbol(out, 'Price').exported, false, 'interface method without `public`');
  });

  test('conditional access `Saved?.Invoke()` and constructor initialisers are calls with receivers', async () => {
    const out = await runFixture('csharp', 'extra.cs');
    const list = calls(out);
    assert.deepEqual(list.find((c) => c[0] === 'Invoke'), ['Invoke', 'Saved', 48, 'Clone']);
    assert.deepEqual(list.find((c) => c[0] === 'this'), ['this', '', 30, 'Cart']);
    assert.deepEqual(list.find((c) => c[0] === 'WriteLine'), ['WriteLine', 'System.Console', 66, 'Main']);
    assert.deepEqual(list.find((c) => c[0] === 'ToList'), ['ToList', 'Items', 42, 'Clone']);
  });

  test('using directives: namespace wildcard, `using static`, alias', async () => {
    const out = await runFixture('csharp', 'extra.cs');
    const imports = Object.fromEntries(out.imports.map((i) => [i.spec, i.names]));
    assert.deepEqual(imports['System.Collections.Generic'], [{ imported: '*', alias: '*' }]);
    assert.deepEqual(imports['System.Math'], [{ imported: '*', alias: '*' }]);
    assert.deepEqual(imports['System.IO'], [{ imported: '*', alias: 'IO' }]);
    const usingLines = new Set(out.imports.map((i) => i.startLine));
    assert.ok(!out.refs.some((r) => r.kind !== 'call' && usingLines.has(r.startLine)), 'using directives must not produce refs');
  });

  test('`/// <summary>` docs are cleaned', async () => {
    const out = await runFixture('csharp', 'sample.cs');
    assert.equal(symbol(out, 'Money').doc, 'Fixed-precision money in minor units.');
    assert.equal(symbol(out, 'FromUnits').doc, 'Builds a Money from a whole-unit amount.');
  });
});

describe('vbnet', () => {
  test('type-like receivers make the grammar prefer array indexing; those are still calls', async () => {
    const out = await runFixture('vbnet', 'sample.vb');
    const list = calls(out);
    assert.deepEqual(list.find((c) => c[0] === 'Round'), ['Round', 'Math', 18, 'FromUnits']);
    assert.deepEqual(list.find((c) => c[0] === 'Join'), ['Join', 'String', 23, 'Describe']);
    assert.deepEqual(list.find((c) => c[0] === 'List'), ['List', '', 22, 'Describe']);
  });

  test('`x = New Foo(1)` misparsed as array bounds is a call; `New Integer() {1, 2}` is not', async () => {
    const out = await runFixture('vbnet', 'extra.vb');
    const list = calls(out);
    assert.deepEqual(list.find((c) => c[0] === 'Cart' && c[2] === 55), ['Cart', '', 55, 'Main']);
    assert.equal(list.filter((c) => c[0] === 'Integer').length, 0);
    assert.deepEqual(list.find((c) => c[0] === 'this'), ['this', '', 22, 'New']);
    assert.deepEqual(list.find((c) => c[0] === 'WriteLine'), ['WriteLine', 'System.Console', 58, 'Main']);
  });

  test('statement line terminators do not inflate endLine; Const fields are constants; enum members inherit', async () => {
    const out = await runFixture('vbnet', 'sample.vb');
    assert.equal(symbol(out, 'Cents').endLine, 9);
    assert.equal(symbol(out, 'Describe').endLine, 23);
    assert.equal(symbol(out, 'CentsPerUnit').kind, 'constant');
    assert.equal(symbol(out, 'Us').exported, true);
    assert.equal(symbol(out, 'New').qual, 'Money.New');
    const inCtor = out.refs.find((r) => r.kind !== 'call' && r.name === 'currency' && r.startLine === 13);
    assert.equal(out.symbols[inCtor.symbol].name, 'New');
  });

  test('doc after `Imports` and `Imports A = B.C` alias', async () => {
    const out = await runFixture('vbnet', 'sample.vb');
    assert.equal(symbol(out, 'Money').doc, 'Fixed-precision money in minor units.');
    assert.equal(symbol(out, 'FromUnits').doc, 'Builds a Money from a whole-unit amount.');
    const extra = await runFixture('vbnet', 'extra.vb');
    assert.deepEqual(extra.imports.find((i) => i.spec === 'System.IO' && i.names[0].alias === 'IO').names, [{ imported: '*', alias: 'IO' }]);
  });
});

describe('dart', () => {
  test('signatures and bodies are siblings, so function symbols are extended over their bodies', async () => {
    const out = await runFixture('dart', 'sample.dart');
    assert.equal(symbol(out, 'fromUnits').endLine, 14);
    assert.equal(symbol(out, 'describeAll').endLine, 35);
    const list = calls(out);
    assert.deepEqual(list.find((c) => c[0] === 'round'), ['round', '(amount * centsPerUnit)', 14, 'fromUnits']);
    assert.deepEqual(list.find((c) => c[0] === 'map'), ['map', 'items', 35, 'describeAll']);
    assert.deepEqual(list.find((c) => c[0] === 'format'), ['format', 'NumberFormat.currency(name: currency)', 22, 'toString']);
  });

  test('receiver chains stop before the variable being initialised', async () => {
    const out = await runFixture('dart', 'extra.dart');
    assert.deepEqual(calls(out).find((c) => c[0] === 'jsonEncode'), ['jsonEncode', 'convert', 42, 'load']);
    assert.deepEqual(calls(out).find((c) => c[0] === 'create'), ['create', 'Base', 41, 'load']);
  });

  test('const/final are constants, var is a variable, mixin and extension are traits, `_private` is not exported', async () => {
    const out = await runFixture('dart', 'extra.dart');
    assert.deepEqual(kinds(out).filter(([k]) => ['trait', 'constant'].includes(k)), [['trait', 'StringExt'], ['trait', 'Loggable']]);
    assert.equal(symbol(out, '_Impl').exported, false);
    assert.equal(out.symbols.find((s) => s.qual === '_Impl.count').exported, true);
    const sample = await runFixture('dart', 'sample.dart');
    assert.equal(symbol(sample, 'taxRate').kind, 'constant');
    assert.equal(symbol(sample, 'zero').kind, 'constant');
    assert.equal(symbol(sample, 'cents').kind, 'field');
    assert.equal(symbol(sample, 'operator +').kind, 'method');
  });

  test('imports: alias, show, hide and export', async () => {
    const out = await runFixture('dart', 'extra.dart');
    const imports = Object.fromEntries(out.imports.map((i) => [i.spec, i.names]));
    assert.deepEqual(imports['dart:async'], [{ imported: '*', alias: '*' }], '`hide` keeps the wildcard');
    assert.deepEqual(imports['dart:convert'], [{ imported: 'jsonEncode', alias: 'jsonEncode' }]);
    assert.equal(out.imports.find((i) => i.spec === 'src/extra.dart').kind, 'reexport');
  });
});

describe('swift', () => {
  test('the sample parses with 0 ERROR nodes and yields every declaration', async () => {
    const out = await runFixture('swift', 'sample.swift');
    assert.equal(out.parseOk, true);
    assert.equal(out.errorNodes, 0);
    assert.deepEqual(kinds(out).map(([k, n]) => `${k}:${n}`), [
      'struct:Money', 'property:centsPerUnit', 'property:cents', 'property:currency', 'property:count', 'method:init', 'method:fromUnits',
      'method:describe', 'method:<', 'enum:Region', 'constant:us', 'constant:taxRate', 'function:formatAll',
    ]);
  });

  test('navigation callees split into receiver + member; optionals lose the `?`', async () => {
    const out = await runFixture('swift', 'extra.swift');
    const list = calls(out);
    assert.deepEqual(list.find((c) => c[0] === 'uppercased'), ['uppercased', 'jobs.first', 54, 'run']);
    assert.deepEqual(list.find((c) => c[0] === 'encode'), ['encode', 'try? JSONEncoder()', 57, 'run']);
    assert.deepEqual(list.find((c) => c[0] === 'total'), ['total', 'anyP', 56, 'run']);
    assert.equal(list.find((c) => c[0] === 'job')[1], '');
  });

  test('subscripts are not calls; `a * Double(x)` parses as `(a * Double)(x)` and names `Double`', async () => {
    const sample = await runFixture('swift', 'sample.swift');
    assert.deepEqual(calls(sample).find((c) => c[0] === 'Double'), ['Double', '', 17, 'fromUnits']);
    const extra = await runFixture('swift', 'extra.swift');
    assert.equal(calls(extra).filter((c) => c[0] === 'jobs').length, 0);
  });

  test('top-level let/var vs properties vs locals; public/open exported; extension/actor/protocol kinds', async () => {
    const extra = await runFixture('swift', 'extra.swift');
    assert.equal(symbol(extra, 'Handler').kind, 'type');
    assert.equal(symbol(extra, 'Int').kind, 'trait');
    assert.equal(symbol(extra, 'Worker').kind, 'class');
    assert.equal(symbol(extra, 'Priced').kind, 'interface');
    assert.equal(symbol(extra, 'jobs').kind, 'property');
    assert.ok(!extra.symbols.some((s) => s.name === 'chained'), 'local `let` must not be a symbol');
    assert.equal(symbol(extra, 'Legacy').exported, true);
    assert.equal(symbol(extra, 'Worker').exported, false);
    assert.equal(symbol(extra, 'subscript').qual, 'Worker.subscript');
    const sample = await runFixture('swift', 'sample.swift');
    assert.equal(symbol(sample, 'taxRate').kind, 'constant');
    assert.equal(symbol(sample, 'taxRate').exported, false);
    assert.equal(symbol(sample, 'init').signature, '(cents: Int, currency: String)');
    assert.equal(symbol(sample, 'fromUnits').doc, 'Builds a Money from a whole-unit amount.');
  });
});
