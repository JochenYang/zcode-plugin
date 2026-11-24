// Lane L1 (Web/TS language packs): behaviour beyond the shared contract suite.
// Covers the things expected.json cannot express: block line/column offsets of embedded
// scripts, `lang` routing, JSX/ArkTS/struct classification and module-edge rules.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { initEngine, extractFile, loadSpecs, specForPath } from '../../src/extract/engine.mjs';

// A pack listing node types absent from its grammar is a defect (the engine only warns
// on stderr), so every write is captured and asserted empty at the end of the file.
const stderrLines = [];
const origWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  stderrLines.push(String(chunk));
  return origWrite(chunk, ...rest);
};

await initEngine();
const specs = await loadSpecs();
const spec = (id) => specs.find((s) => s.id === id);
const run = (id, path, source) => extractFile({ path, source, spec: spec(id) });
const symbol = (out, name) => out.symbols.find((s) => s.name === name);
const kinds = (out) => out.symbols.map((s) => [s.kind, s.name]);
const calls = (out) => out.refs.filter((r) => r.kind === 'call').map((r) => [r.name, r.startLine]);
const blocks = (out) => out.blocks.map((b) => [b.lang, b.startLine, b.endLine]).sort((a, b) => a[1] - b[1]);

describe('javascript', () => {
  test('function-valued declarators are components when PascalCase; host JSX tags are not refs', async () => {
    const out = await run('javascript', 'Tag.jsx', [
      'const PriceTag = ({ cents }) => <span className="p">{fmt(cents)}</span>;',
      'const useTotal = () => <PriceTag cents={1} />;',
      'function helper() { return <div />; }',
    ].join('\n'));
    assert.equal(out.parseOk, true);
    assert.deepEqual(kinds(out), [['component', 'PriceTag'], ['function', 'useTotal'], ['function', 'helper']]);
    const names = out.refs.map((r) => r.name);
    assert.ok(!names.includes('span') && !names.includes('div'), `host tags leaked into refs: ${names.join(',')}`);
    assert.ok(names.includes('PriceTag'), 'a PascalCase JSX tag is a component reference');
  });

  test('static import, require, dynamic import and re-export are module edges, not calls', async () => {
    const out = await run('javascript', 'mod.mjs', [
      "import fs from 'node:fs';",
      "const { join } = require('node:path');",
      "const mod = await import('./mod.js');",
      'export * from "./re.js";',
      'exports.helper = () => join("a");',
    ].join('\n'));
    assert.deepEqual(out.imports.map((i) => [i.kind, i.spec, i.startLine]), [
      ['import', 'node:fs', 1],
      ['require', 'node:path', 2],
      ['dynamic', './mod.js', 3],
      ['reexport', './re.js', 4],
    ]);
    assert.deepEqual(calls(out), [['join', 5]]);
    assert.deepEqual(kinds(out), [['constant', 'mod'], ['constant', 'helper']]);
  });

  test('parameter names and binding positions are definitions, not references', async () => {
    const out = await run('javascript', 'params.cjs', [
      'function f(a, b = 1, [c], { d }) {}',
      'const [x] = [1];',
    ].join('\n'));
    assert.deepEqual(out.refs, []); // neither the pack nor the locals merge may re-add them
    assert.deepEqual(kinds(out), [['function', 'f']]); // locals never enter the index
  });
});

describe('tsx', () => {
  test('TSX parses with 0 ERROR nodes and React components are classified as `component`', async () => {
    const out = await run('tsx', 'List.tsx', [
      "import { useState } from 'react';",
      'interface Props { items: string[] }',
      'export function List<T extends Props>({ items }: Props) {',
      '  const [n, setN] = useState<number>(0);',
      '  return <ul>{items.map((i) => <li key={i}>{i}</li>)}</ul>;',
      '}',
      'const Tag = (p: Props) => <>{p.items.length}</>;',
      'function plain() { return null; }',
      'class Old extends React.Component<Props> { render() { return <div />; } }',
    ].join('\n'));
    assert.equal(out.errorNodes, 0);
    assert.deepEqual(kinds(out), [
      ['interface', 'Props'],
      ['component', 'List'],
      ['component', 'Tag'],
      ['function', 'plain'],
      ['class', 'Old'],
      ['method', 'render'],
    ]);
    const names = out.refs.map((r) => r.name);
    assert.ok(!names.includes('ul') && !names.includes('li') && !names.includes('div'), 'host tags leaked into refs');
    assert.ok(names.includes('React'), 'the React namespace reference survives');
  });
});

describe('arkts', () => {
  test('`@Component struct` is a component, its members are methods/fields, ArkUI builders are calls', async () => {
    const out = await run('arkts', 'Home.ets', [
      '/** Home page. */',
      '@Entry',
      '@Component',
      'struct Home {',
      '  @State count: number = 0;',
      '  build() {',
      '    Column() { Text(this.label()).fontSize(14) }',
      '  }',
      '  label(): string { return `c=${this.count}`; }',
      '}',
    ].join('\n'));
    assert.equal(out.errorNodes, 0);
    const home = symbol(out, 'Home');
    assert.equal(home.kind, 'component');
    assert.equal(home.doc, 'Home page.'); // decorators sit between the comment and the struct
    assert.deepEqual(out.symbols.filter((s) => s.parent !== null).map((s) => [s.kind, s.qual]), [
      ['field', 'Home.count'],
      ['method', 'Home.build'],
      ['method', 'Home.label'],
    ]);
    assert.deepEqual(calls(out), [['Column', 7], ['Text', 7], ['label', 7]]);
  });
});

describe('embedded script blocks (svelte / vue / astro)', () => {
  test('svelte: absolute line/column offsets and `lang="ts"` routing', async () => {
    const out = await run('svelte', 'Cart.svelte', [
      '<script context="module">',
      '  export const limit = 1;',
      '</script>',
      '<!-- a comment that pushes the instance script down -->',
      '<script lang="ts">',
      '  interface Props { items: string[] }',
      '  const props = $props();',
      '  function total(): number {',
      '    return props.items.length;',
      '  }',
      '</script>',
      '<div on:click={() => total()} />',
    ].join('\n'));
    assert.equal(out.parseOk, true, 'the TS block must be parsed by the TypeScript grammar');
    assert.deepEqual(blocks(out), [
      ['javascript', 1, 2],
      ['typescript', 5, 10],
    ]);
    const limit = symbol(out, 'limit');
    assert.deepEqual([limit.startLine, limit.endLine, limit.exported, out.blocks[limit.block].lang], [2, 2, true, 'javascript']);
    const props = symbol(out, 'props');
    assert.deepEqual([props.startLine, props.startCol, out.blocks[props.block].lang], [7, 8, 'typescript']);
    const total = symbol(out, 'total');
    assert.deepEqual([total.startLine, total.endLine, total.qual], [8, 10, 'total']);
    assert.equal(symbol(out, 'Props').kind, 'interface');
    assert.deepEqual(calls(out), [['$props', 7]]); // template markup is not indexed
  });

  test('vue: a template error reaches parseOk while `<script setup lang="ts">` is still indexed', async () => {
    const out = await run('vue', 'Broken.vue', [
      '<template>',
      '  <div :class="x"',
      '    <span>{{ a</span>',
      '  </div>',
      '</template>',
      '<script setup lang="ts">',
      "import { ref } from 'vue';",
      'const n = ref(0);',
      '</script>',
    ].join('\n'));
    assert.equal(out.parseOk, false, 'the vue grammar must report the broken template');
    assert.ok(out.errorNodes > 0);
    assert.deepEqual(blocks(out), [['typescript', 6, 8]]);
    const n = symbol(out, 'n');
    assert.deepEqual([n.kind, n.startLine, n.qual], ['constant', 8, 'n']);
    assert.deepEqual(out.imports.map((i) => [i.spec, i.startLine]), [['vue', 7]]);
  });

  test('astro: frontmatter is TypeScript, a plain `<script>` is JavaScript', async () => {
    const out = await run('astro', 'Layout.astro', [
      '---',
      'export interface Front { id: string }',
      'const id = "a";',
      '---',
      '<div>{id}</div>',
      '<script>',
      '  function track() { return id; }',
      '</script>',
    ].join('\n'));
    assert.equal(out.errorNodes, 0);
    assert.deepEqual(blocks(out), [
      ['typescript', 2, 3],
      ['javascript', 6, 7],
    ]);
    assert.deepEqual(out.symbols.map((s) => [s.kind, s.name, s.startLine, out.blocks[s.block].lang]), [
      ['interface', 'Front', 2, 'typescript'],
      ['constant', 'id', 3, 'typescript'],
      ['function', 'track', 7, 'javascript'],
    ]);
  });

  test('script tags with src= or lang=tsx are routed correctly', async () => {
    const out = await run('svelte', 'X.svelte', [
      '<script src="/external.js"></script>',
      '<script lang="tsx">',
      '  export const View = () => <b>bold</b>;',
      '</script>',
    ].join('\n'));
    assert.deepEqual(blocks(out), [['tsx', 2, 3]]);
    assert.equal(symbol(out, 'View').kind, 'component');
    assert.ok(!out.refs.some((r) => r.name === 'b'));
  });
});

describe('razor', () => {
  test('@functions, @code and @{} blocks become C# with absolute lines; `<script>` stays JavaScript', async () => {
    const out = await run('razor', 'Page.cshtml', [
      '@* @functions { ignored } *@',
      '<p>@@functions</p>',
      '@functions {',
      '  public static string A(int x) { return $"{x}"; }',
      '  private void B() { if (x) { A(1); } }',
      '}',
      '@{ var t = A(2); }',
      '<script>function s() { return 1; }</script>',
    ].join('\n'));
    assert.equal(out.errorNodes, 0);
    assert.deepEqual(blocks(out), [
      ['csharp', 3, 5],
      ['csharp', 7, 7],
      ['javascript', 8, 8],
    ]);
    // The synthetic wrapper class is removed by hooks.postProcess, so members are top-level.
    assert.deepEqual(out.symbols.map((s) => [s.kind, s.name, s.startLine, s.qual]), [
      ['method', 'A', 4, 'A'],
      ['method', 'B', 5, 'B'],
      ['function', 's', 8, 's'],
    ]);
    assert.deepEqual(out.refs.filter((r) => r.kind === 'call').map((r) => [r.name, r.startLine, r.symbol]), [
      ['A', 5, 1],
      ['A', 7, null],
    ]);
  });

  test('.razor @code blocks are class members too', async () => {
    const out = await run('razor', 'Counter.razor', '@code {\n  private int count = 0;\n  void Inc() { count++; }\n}\n');
    assert.equal(out.errorNodes, 0);
    assert.deepEqual(out.symbols.map((s) => [s.kind, s.name, s.startLine]), [
      ['field', 'count', 2],
      ['method', 'Inc', 3],
    ]);
  });
});

describe('extension ownership', () => {
  const owners = {
    javascript: ['.js', '.jsx', '.mjs', '.cjs'],
    tsx: ['.tsx'],
    arkts: ['.ets'],
    svelte: ['.svelte'],
    vue: ['.vue'],
    astro: ['.astro'],
    razor: ['.cshtml', '.razor'],
  };

  test('each pack claims exactly its extensions and `extends` did not leak TypeScript ones', () => {
    for (const [id, exts] of Object.entries(owners)) {
      const s = spec(id);
      assert.ok(s, `pack ${id} missing`);
      assert.deepEqual(s.extensions, exts, id);
      for (const ext of exts) assert.equal(specForPath(`dir/file${ext.toUpperCase()}`)?.id, id, `${id} must own ${ext}`);
    }
    assert.equal(specForPath('x.ts')?.id, 'typescript');
    assert.equal(specForPath('x.tsx')?.id, 'tsx');
  });

  test('grammars: javascript/tsx/arkts/vue parse their own syntax, svelte/astro/razor are script-only', () => {
    assert.deepEqual(
      Object.fromEntries(['javascript', 'tsx', 'arkts', 'vue', 'svelte', 'astro', 'razor'].map((id) => [id, [spec(id).grammar ?? null, spec(id).support]])),
      {
        javascript: ['javascript', 'full'],
        tsx: ['tsx', 'full'],
        arkts: ['arkts', 'full'],
        vue: ['vue', 'full'],
        svelte: [null, 'script'],
        astro: [null, 'script'],
        razor: [null, 'script'],
      },
    );
    assert.equal(spec('javascript').scope, 'locals');
    assert.equal(spec('tsx').scope, 'locals');
  });
});

test('no L1 pack lists node types absent from its grammar', () => {
  const warnings = stderrLines.filter((l) => l.includes('absent from grammar'));
  process.stderr.write = origWrite;
  assert.deepEqual(warnings, []);
});
