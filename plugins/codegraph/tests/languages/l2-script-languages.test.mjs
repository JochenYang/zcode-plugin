// Lane L2 behaviour tests (Python, Ruby, PHP, Lua, Luau, R, Liquid) beyond the shared
// contract suite: each case locks a rule decision that the fixture cannot show alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initEngine, extractFile, loadSpecs, specForPath } from '../../src/extract/engine.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '..', 'fixtures', 'langs');

// The engine warns once per spec when a pack lists node types missing from its grammar.
// Capture stderr from before the first extraction so the final assertion sees them all.
const stderrChunks = [];
const realStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  stderrChunks.push(String(chunk));
  return realStderrWrite(chunk, ...rest);
};

await initEngine();
const specs = await loadSpecs();
const byId = (id) => {
  const spec = specs.find((s) => s.id === id);
  assert.ok(spec, `language pack ${id} must be loaded`);
  return spec;
};
const extract = (id, source, name = `inline.${byId(id).extensions[0]}`) =>
  extractFile({ path: name, source, spec: byId(id) });
const symbol = (out, name) => out.symbols.find((s) => s.name === name);
const calls = (out) => out.refs.filter((r) => r.kind === 'call');
const call = (out, name) => calls(out).find((r) => r.name === name);
const ref = (out, name) => out.refs.filter((r) => r.kind !== 'call' && r.name === name);

test('python: docstrings, relative imports, decorated definitions, exports', async () => {
  const out = await extract(
    'python',
    [
      'import os.path',
      'import os.path as osp',
      'from .shapes import Circle as Disc',
      'from ..util import *',
      'from . import sibling',
      '',
      '"""Module docstring is not a symbol."""',
      'CACHE = {}',
      '',
      '',
      'class Point(Circle):',
      '    """A 2D point."""',
      '',
      '    def __init__(self, x):',
      '        self.x = x',
      '        for _ in range(3):',
      '            pass',
      '',
      '    def _private(self):',
      '        return self.x',
      '',
      '',
      '@functools.lru_cache(maxsize=None)',
      'def load(path: str) -> "list[Point]":',
      '    """Loads points."""',
      '    return osp.basename(path)',
      '',
      '',
      'def late_string():',
      '    x = 1',
      '    return "not a docstring"',
    ].join('\n'),
  );
  assert.equal(out.parseOk, true);
  assert.equal(symbol(out, 'Point').doc, 'A 2D point.');
  assert.equal(symbol(out, 'load').doc, 'Loads points.');
  // A string on the third body line is not a docstring.
  assert.equal(symbol(out, 'late_string').doc, null);
  // Decorated definitions are still plain functions starting at the `def` line.
  assert.equal(symbol(out, 'load').kind, 'function');
  assert.equal(symbol(out, 'load').startLine, 24);
  assert.equal(symbol(out, 'load').exported, true);
  assert.equal(symbol(out, '_private').exported, false);
  assert.equal(symbol(out, '__init__').qual, 'Point.__init__');
  assert.equal(symbol(out, 'CACHE').kind, 'constant');

  const imports = out.imports.map((i) => `${i.spec} ${JSON.stringify(i.names)}`);
  assert.deepEqual(imports, [
    'os.path [{"imported":"os","alias":"os"}]',
    'os.path [{"imported":"*","alias":"osp"}]',
    '.shapes [{"imported":"Circle","alias":"Disc"}]',
    '..util [{"imported":"*","alias":"*"}]',
    '. [{"imported":"sibling","alias":"sibling"}]',
  ]);

  assert.deepEqual(call(out, 'lru_cache'), { name: 'lru_cache', receiver: 'functools', kind: 'call', symbol: null, scope: null, localDef: null, startLine: 23, startCol: 1, endLine: 23 });
  assert.equal(call(out, 'basename').receiver, 'osp');
  assert.equal(out.symbols[call(out, 'range').symbol].name, '__init__');
  // `self` and `_` never become references; attribute access keeps its name.
  assert.equal(ref(out, 'self').length, 0);
  assert.equal(ref(out, '_').length, 0);
  assert.ok(ref(out, 'x').length >= 3);
});

test('ruby: constant class names, require imports, singleton methods, multi-line docs', async () => {
  const out = await extract(
    'ruby',
    [
      "require 'json'",
      "require File.join('config', 'app')",
      '',
      'module Cart',
      '  MAX_ITEMS = 10',
      '  top_var = 2',
      '',
      '  # Multi-line docs.',
      '  # Second line.',
      '  class Item',
      '    def initialize(code)',
      '      @code = code',
      '    end',
      '',
      '    def name=(value)',
      '      @name = value',
      '    end',
      '  end',
      '',
      '  class Cart::Line; end',
      '',
      '  def self.load(path)',
      '    data = JSON.parse(File.read(path))',
      '    data.map { |row| Item.new(row) }',
      '  end',
      'end',
      '',
      "puts Cart.load('cart.json')",
      'obj&.touch',
      'attr_reader :code',
    ].join('\n'),
  );
  assert.equal(out.parseOk, true);
  assert.equal(symbol(out, 'Item').kind, 'class');
  assert.equal(symbol(out, 'Item').qual, 'Cart.Item');
  assert.equal(symbol(out, 'Item').doc, 'Multi-line docs. Second line.');
  assert.equal(symbol(out, 'Cart::Line').qual, 'Cart.Cart::Line');
  assert.equal(symbol(out, 'load').qual, 'Cart.load');
  assert.equal(symbol(out, 'name').kind, 'method');
  assert.equal(symbol(out, 'MAX_ITEMS').kind, 'constant');
  assert.equal(symbol(out, 'MAX_ITEMS').qual, 'Cart.MAX_ITEMS');
  assert.equal(symbol(out, 'top_var'), undefined);

  // Only string-literal requires are imports; `require File.join(..)` stays a call.
  assert.deepEqual(out.imports.map((i) => i.spec), ['json']);
  assert.equal(call(out, 'join').receiver, 'File');
  assert.equal(call(out, 'load').receiver, 'Cart');
  assert.equal(call(out, 'touch').receiver, 'obj');
  assert.equal(call(out, 'puts').receiver, '');
  assert.equal(call(out, 'parse').receiver, 'JSON');
  assert.equal(call(out, 'map').symbol, out.symbols.indexOf(symbol(out, 'load')));
  assert.equal(call(out, 'attr_reader').symbol, null);
  assert.equal(ref(out, '_').length, 0);
  assert.equal(byId('ruby').scope, 'locals');
});

test('php: namespaced callees, use aliases, constants, qualified references', async () => {
  const out = await extract(
    'php',
    [
      '<?php',
      'namespace App\\Billing;',
      'use App\\Models\\Invoice;',
      'use App\\Support\\Money as Cash;',
      'use App\\{Models\\User, function helper};',
      "require __DIR__ . '/boot.php';",
      '',
      'const A = 1, B = 2;',
      '',
      'final class Calculator extends \\App\\Base',
      '{',
      '    public const TAX_RATE = 0.2;',
      '    private array $lines = [];',
      '',
      '    public function add(Invoice $invoice): float',
      '    {',
      '        $this->lines[] = $invoice;',
      '        return self::round(\\App\\money($invoice));',
      '    }',
      '',
      '    public static function round(float $value): float { return round($value, 2); }',
      '}',
      '',
      '$obj = new \\App\\Foo();',
      '$ok = $obj instanceof \\App\\Foo;',
      '\\App\\Foo::bar();',
      'echo Cash::format((new Calculator())->add($obj));',
    ].join('\n'),
  );
  assert.equal(out.parseOk, true);
  assert.equal(symbol(out, 'App\\Billing').kind, 'namespace');
  assert.equal(symbol(out, 'invoice_total'), undefined);
  assert.equal(symbol(out, 'A').kind, 'constant');
  assert.equal(symbol(out, 'B').kind, 'constant');
  assert.equal(symbol(out, 'TAX_RATE').qual, 'Calculator.TAX_RATE');
  assert.equal(symbol(out, 'lines').kind, 'field');
  assert.equal(symbol(out, 'lines').qual, 'Calculator.lines');
  assert.equal(symbol(out, 'add').signature, '(Invoice $invoice): float');
  assert.equal(symbol(out, 'add').doc, null);

  const imports = out.imports.map((i) => `${i.kind} ${i.spec} ${JSON.stringify(i.names)}`);
  assert.deepEqual(imports, [
    'use App\\Models\\Invoice [{"imported":"Invoice","alias":"Invoice"}]',
    'use App\\Support\\Money [{"imported":"Money","alias":"Cash"}]',
    'use App [{"imported":"User","alias":"User"},{"imported":"helper","alias":"helper"}]',
    "require /boot.php null",
  ]);

  assert.equal(call(out, 'money').receiver, 'App');
  assert.equal(call(out, 'round').receiver, 'self');
  assert.equal(call(out, 'Foo').receiver, 'App');
  assert.equal(call(out, 'bar').receiver, 'App\\Foo');
  assert.equal(call(out, 'add').receiver, '(new Calculator())');
  assert.equal(call(out, 'format').receiver, 'Cash');
  // `\App\Foo` is one reference to `Foo` with a receiver, not three segment refs.
  assert.deepEqual(ref(out, 'Foo').map((r) => r.receiver), ['App', 'App', 'App']);
  assert.equal(ref(out, 'App').length, 0);
  assert.equal(ref(out, 'this').length, 0);
  assert.ok(ref(out, 'lines').length >= 1);
  assert.equal(calls(out).length, 8);
});

test('lua: dotted and method functions, require imports, chunk-level locals', async () => {
  const out = await extract(
    'lua',
    [
      'local json = require("json")',
      "local fmt = require 'string.format'",
      'local MAX_ITEMS = 10',
      'local M = {}',
      'local a, b = 1, 2',
      '',
      'local function helper(x)',
      '  local inner = 1',
      '  return x',
      'end',
      '',
      '--- Splits a path.',
      '--- @param path string',
      'function M.split(path)',
      '  return path:match("^(.*)/([^/]*)$")',
      'end',
      '',
      'function M.sub.join(dir, name)',
      '  return fmt("%s/%s", dir, name)',
      'end',
      '',
      'function Counter:increment(by)',
      '  self.count = self.count + (by or 1)',
      '  return self.count',
      'end',
      '',
      'tbl["k"]()',
      '(helper)()',
      'return M',
    ].join('\n'),
  );
  assert.equal(out.parseOk, true);
  assert.deepEqual(out.symbols.map((s) => `${s.kind} ${s.name}`), [
    'variable json',
    'variable fmt',
    'constant MAX_ITEMS',
    'variable M',
    'function helper',
    'function split',
    'function join',
    'method increment',
  ]);
  assert.equal(symbol(out, 'split').doc, 'Splits a path.');
  assert.deepEqual(out.imports.map((i) => `${i.kind} ${i.spec}`), ['require json', 'require string.format']);
  assert.equal(call(out, 'match').receiver, 'path');
  assert.equal(call(out, 'fmt').receiver, '');
  // Dynamic callees produce no call refs at all.
  assert.equal(calls(out).length, 2);
  assert.equal(ref(out, '_').length, 0);
  assert.equal(ref(out, 'self').length, 0);
  assert.ok(ref(out, 'inner').length === 1);
});

test('luau: extends lua, adds type definitions with export state', async () => {
  const spec = byId('luau');
  assert.equal(spec.extends, 'lua');
  assert.equal(spec.grammar, 'luau');
  assert.deepEqual(spec.extensions, ['.luau']);
  assert.equal(spec.definitions.function_declaration, byId('lua').definitions.function_declaration);
  const out = await extract(
    'luau',
    [
      'local Types = require("./types")',
      '',
      'export type Vec2 = { x: number, y: number }',
      'type Kind = "add" | "sub"',
      'type Callback<T> = (T) -> ()',
      '',
      'local Vector = {}',
      'function Vector.new(x: number): Vec2',
      '\treturn { x = x }',
      'end',
      'function Vector:length(): number return 1 end',
      'return Vector',
    ].join('\n'),
  );
  assert.equal(out.parseOk, true);
  assert.deepEqual(out.symbols.map((s) => `${s.kind} ${s.name} ${s.exported}`), [
    'variable Types null',
    'type Vec2 true',
    'type Kind false',
    'type Callback false',
    'variable Vector null',
    'function new null',
    'method length null',
  ]);
  assert.deepEqual(out.imports.map((i) => i.spec), ['./types']);
  assert.equal(ref(out, 'Vec2').length, 1); // the return type annotation only; the alias name is consumed
});

test('r: `<-` function naming, top-level values, imports, roxygen docs', async () => {
  const out = await extract(
    'r',
    [
      'library(stats)',
      'require("jsonlite")',
      'source("utils.R")',
      '',
      "#' Adds two numbers.",
      "#'",
      "#' @param x A numeric vector.",
      "#' @export",
      'add <- function(x, y) {',
      '  x + y',
      '}',
      '',
      'f = function(x) x + 1',
      'g <<- function() 1',
      '`weird name` <- 1',
      'MAX_RETRIES <- 3',
      'opts <- list(a = 1)',
      'retry <- function(times = MAX_RETRIES) times',
      'names(v) <- c("a")',
      'v[1] <- 2',
      'sapply(1:3, function(i) {',
      '  inner <- function() 1',
      '  i * 2',
      '})',
      'tryCatch(f(), error = function(e) e)',
      'utils::read.csv(path)',
      'l$method()',
    ].join('\n'),
  );
  assert.equal(out.parseOk, true);
  assert.deepEqual(out.symbols.map((s) => `${s.kind} ${s.name}@${s.startLine}`), [
    'function add@9',
    'function f@13',
    'function g@14',
    'variable weird name@15',
    'constant MAX_RETRIES@16',
    'variable opts@17',
    'function retry@18',
    'function inner@22',
  ]);
  assert.equal(symbol(out, 'add').doc, 'Adds two numbers.');
  assert.equal(symbol(out, 'add').signature, '(x, y)');
  assert.equal(symbol(out, 'f').doc, null);
  assert.equal(ref(out, 'add').length, 0); // the assigned name is the symbol, not a self-reference
  assert.deepEqual(out.imports.map((i) => `${i.kind} ${i.spec}`), ['require stats', 'require jsonlite', 'require utils.R']);
  assert.equal(call(out, 'read.csv').receiver, 'utils');
  assert.equal(call(out, 'method').receiver, 'l');
  assert.equal(call(out, 'sapply').receiver, '');
  assert.equal(call(out, 'library'), undefined);
  assert.ok(ref(out, 'MAX_RETRIES').length >= 1);
});

test('liquid: file-level support claims the extension without parsing', async () => {
  const spec = byId('liquid');
  assert.equal(spec.support, 'file-level');
  assert.equal(spec.grammar, undefined);
  assert.equal(specForPath('theme/product.liquid'), spec);
  assert.equal(specForPath('theme/product.LIQUID'), spec);
  const out = await extract('liquid', '{% assign broken = %}<h1>{{ product', 'broken.liquid');
  assert.equal(out.parseOk, true);
  assert.equal(out.errorNodes, 0);
  assert.deepEqual([out.symbols, out.imports, out.refs, out.blocks], [[], [], [], []]);
  assert.equal(out.lang, 'liquid');
});

test('fixtures: every sample and broken fixture parses as the contract requires', async () => {
  for (const id of ['python', 'ruby', 'php', 'lua', 'luau', 'r']) {
    const spec = byId(id);
    const ext = spec.extensions[0];
    const dir = path.join(FIXTURES, id);
    const sample = await extractFile({ path: `sample${ext}`, source: fs.readFileSync(path.join(dir, `sample${ext}`), 'utf8'), spec });
    assert.equal(sample.errorNodes, 0, `${id} sample has ERROR nodes`);
    const broken = await extractFile({ path: `broken${ext}`, source: fs.readFileSync(path.join(dir, `broken${ext}`), 'utf8'), spec });
    assert.ok(broken.errorNodes > 0, `${id} broken fixture must produce ERROR nodes`);
    assert.equal(broken.parseOk, false);
    const callsWanted = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8')).calls.length;
    assert.ok(callsWanted >= 3, `${id} fixture must exercise at least 3 call sites`);
  }
});

test('no pack lists node types absent from its grammar', () => {
  const text = stderrChunks.join('');
  const warnings = text.split('\n').filter((line) => /lists node types absent/.test(line));
  assert.deepEqual(warnings, []);
});
