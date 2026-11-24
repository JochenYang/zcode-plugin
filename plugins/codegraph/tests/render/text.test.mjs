// Snapshot tests for the plain-text renderers (CONTRACTS.md §11). The expected
// strings are the format contract: header, rows, footer, truncation, legend,
// freshness markers. Change them together with src/render/text.mjs.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  INLINE_BODY_MAX_LINES,
  LEGEND,
  freshnessLabel,
  renderCallers,
  renderCallees,
  renderImpact,
  renderMap,
  renderNotice,
  renderOutline,
  renderSearch,
  renderStatus,
  renderSymbol,
} from '../../src/render/text.mjs';
import { estimateTokens, MAX_OUTPUT_BYTES } from '../../src/render/budget.mjs';

const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);
const FRESH = 'indexed 2m ago';
const STALE = 'indexed 2m ago · stale: 3 files changed since index';
const readyStatus = (extra = {}) => ({
  state: 'ready',
  filesTotal: 12,
  filesDone: 12,
  symbols: 340,
  languages: { python: 4, typescript: 8 },
  stale: 0,
  indexedAt: NOW - 125_000,
  error: null,
  ...extra,
});
const bytes = (s) => Buffer.byteLength(s, 'utf8');
const lines = (text) => text.split('\n');

const SEARCH_ROWS = [
  { kind: 'method', name: 'parseConfig', qual: 'Loader.parseConfig', path: 'src/loader.ts', startLine: 8, endLine: 20, signature: 'parseConfig(file: string)' },
  { kind: 'method', name: 'parseConfig', qual: 'Parser.parseConfig', path: 'src/config.ts', startLine: 2, endLine: 10, signature: 'parseConfig(raw: string): Config' },
  { kind: 'interface', name: 'Config', path: 'src/config.ts', startLine: 26, endLine: 29, signature: null },
  { kind: 'function', name: 'parseConfigFile', path: 'src/config.ts', startLine: 50, endLine: 50, signature: 'x'.repeat(100) },
];

const SYMBOL_RESULT = {
  symbol: { kind: 'function', name: 'parseConfig', path: 'src/config/parse.ts', startLine: 42, endLine: 71, signature: 'parseConfig(raw: string): Config', doc: 'Parses the raw config.' },
  callees: [
    { name: 'loadFile', path: 'src/config/parse.ts', startLine: 45, resolution: '=' },
    { name: 'validate', path: 'src/config/parse.ts', startLine: 46, resolution: '~' },
    { name: 'save', path: 'src/config/parse.ts', startLine: 60, resolution: '?', count: 2 },
  ],
  callers: [
    { name: 'main', path: 'src/main.ts', startLine: 12, resolution: '=' },
    { name: 'run', path: 'src/cli.ts', startLine: 9, resolution: '~' },
    { name: 'x', path: 'src/a.ts', startLine: 3, resolution: '?' },
  ],
  imports: ['node:fs', './util', { spec: './util' }],
};

describe('freshnessLabel', () => {
  test('contract fragments for ready / stale / building / empty / error', () => {
    assert.equal(freshnessLabel(readyStatus(), { now: NOW }), FRESH);
    assert.equal(freshnessLabel(readyStatus({ stale: 3 }), { now: NOW }), STALE);
    assert.equal(freshnessLabel(readyStatus({ dirty: 2, stale: undefined }), { now: NOW }), 'indexed 2m ago · stale: 2 files changed since index');
    assert.equal(freshnessLabel({ state: 'building', filesTotal: 16, filesDone: 7 }, { now: NOW }), 'indexing 43% (results partial)');
    assert.equal(freshnessLabel({ state: 'building', filesTotal: 16, filesDone: 7, stale: 3 }, { now: NOW }), 'stale: 3 files changed since index · indexing 43% (results partial)');
    assert.equal(freshnessLabel({ state: 'building', filesTotal: 0, filesDone: 0 }, { now: NOW }), 'indexing (results partial)');
    assert.equal(freshnessLabel({ state: 'empty' }, { now: NOW }), 'not indexed');
    assert.equal(freshnessLabel({ state: 'error' }, { now: NOW }), 'index error');
    assert.equal(freshnessLabel({ state: 'weird' }, { now: NOW }), 'index weird');
    assert.equal(freshnessLabel(null), 'index status unknown');
  });

  test('ages in s / m / h / d, unknown without indexedAt', () => {
    const at = (ms) => freshnessLabel(readyStatus({ indexedAt: NOW - ms }), { now: NOW });
    assert.equal(at(30_000), 'indexed 30s ago');
    assert.equal(at(90_000), 'indexed 1m ago');
    assert.equal(at(3 * 3600_000), 'indexed 3h ago');
    assert.equal(at(60 * 3600_000), 'indexed 2d ago');
    assert.equal(at(-5_000), 'indexed 0s ago');
    assert.equal(freshnessLabel(readyStatus({ indexedAt: undefined }), { now: NOW }), 'indexed unknown time');
  });
});

describe('renderStatus', () => {
  test('ready', () => {
    assert.equal(
      renderStatus(readyStatus(), { now: NOW }),
      ['# status · ready · 12 files · 340 symbols · indexed 2m ago', 'languages: typescript 8, python 4'].join('\n'),
    );
    assert.equal(
      renderStatus(readyStatus({ stale: 3 }), { now: NOW }),
      ['# status · ready · 12 files · 340 symbols · indexed 2m ago · stale: 3 files changed since index', 'languages: typescript 8, python 4'].join('\n'),
    );
  });

  test('refresh=true appears in the header args; a failed sync is reported in the freshness segment', () => {
    assert.equal(
      renderStatus(readyStatus(), { now: NOW, refresh: true, syncError: new Error('lock busy') }),
      ['# status refresh=true · ready · 12 files · 340 symbols · indexed 2m ago · sync failed: lock busy', 'languages: typescript 8, python 4'].join('\n'),
    );
  });

  test('empty: no freshness duplication, reason when the indexer gives one, actionable hint', () => {
    assert.equal(
      renderStatus(
        {
          state: 'empty',
          filesTotal: 0,
          filesDone: 0,
          symbols: 0,
          languages: {},
          reason: 'below-min-files',
          reasonDetail: '12 supported file(s), minFilesToAutoIndex is 30',
        },
        { now: NOW },
      ),
      [
        '# status · empty · 0 files · 0 symbols · not indexed',
        'reason: 12 supported file(s), minFilesToAutoIndex is 30 [below-min-files]',
        'hint: use Read/Grep until the project is indexed; auto-index is skipped when autoIndex is off, the root is unsafe (home or drive root) or the supported-file count is outside minFilesToAutoIndex..maxFiles (codegraph.json).',
      ].join('\n'),
    );
    const bare = renderStatus({ state: 'empty' }, { now: NOW });
    assert.equal(lines(bare)[0], '# status · empty · 0 files · 0 symbols · not indexed');
    assert.equal(lines(bare).length, 2);
    assert.match(lines(bare)[1], /^hint: /);
    assert.equal(lines(renderStatus({ state: 'empty', reason: 'auto-index-disabled' }, { now: NOW }))[1], 'reason: auto-index-disabled');
  });

  test('read-only sessions and parse errors are listed as notes', () => {
    const out = lines(renderStatus({ ...readyStatus(), readOnly: true, parseErrors: 2 }, { now: NOW }));
    assert.equal(out[2], 'note: read-only; another session holds the index lock, this one only queries');
    assert.equal(out[3], 'parse errors: 2 file(s) indexed with syntax errors');
  });

  test('building shows progress in the header and keeps the contract marker last', () => {
    assert.equal(
      renderStatus({ state: 'building', filesTotal: 16, filesDone: 7, symbols: 120, languages: { typescript: 7, python: 1 }, stale: 3 }, { now: NOW }),
      [
        '# status · building · 7 of 16 files · 120 symbols · stale: 3 files changed since index · indexing 43% (results partial)',
        'languages: typescript 7, python 1',
      ].join('\n'),
    );
  });

  test('error and unavailable', () => {
    assert.equal(
      renderStatus({ state: 'error', filesTotal: 4, filesDone: 4, symbols: 20, error: 'disk full' }, { now: NOW }),
      ['# status · error · 4 files · 20 symbols · index error', 'error: disk full'].join('\n'),
    );
    assert.equal(
      renderStatus(null),
      ['# status · unavailable', 'index status could not be read; the index directory may be missing or locked'].join('\n'),
    );
  });
});

describe('renderSearch', () => {
  // Footer of every non-empty search result (CONTRACTS.md §11).
  const NEXT = 'next: symbol <name> returns the definition with its callers and imports (body=true reads it in one call); impact <name> shows what a change breaks.';

  test('rows keep the relevance order they arrive in, kind right-aligned in 9 columns, signature cut at 80, no legend without markers', () => {
    const out = renderSearch(SEARCH_ROWS, { query: 'parseConfig', freshness: FRESH, budget: 1500 });
    assert.equal(
      out,
      [
        '# search parseConfig · 4 matches · indexed 2m ago',
        '   method parseConfig parseConfig(file: string) src/loader.ts:8-20',
        '   method parseConfig parseConfig(raw: string): Config src/config.ts:2-10',
        'interface Config src/config.ts:26-29',
        ` function parseConfigFile ${'x'.repeat(79)}… src/config.ts:50-50`,
        NEXT,
      ].join('\n'),
    );
    assert.equal(out.includes('legend'), false);
  });

  test('the order is the caller\'s, not path order: the best match stays first', () => {
    const [loader, parser, config, file] = SEARCH_ROWS;
    const out = lines(renderSearch([file, loader, config, parser], { query: 'parseConfig', freshness: FRESH }));
    assert.deepEqual(out.slice(1, 5), [
      ` function parseConfigFile ${'x'.repeat(79)}… src/config.ts:50-50`,
      '   method parseConfig parseConfig(file: string) src/loader.ts:8-20',
      'interface Config src/config.ts:26-29',
      '   method parseConfig parseConfig(raw: string): Config src/config.ts:2-10',
    ]);
  });

  test('a relaxed search says that no name has all words and what the best match contains', () => {
    const row = { kind: 'function', name: 'parseCookie', path: 'src/a.ts', startLine: 1, endLine: 2 };
    const relaxed = lines(renderSearch([row], { query: 'sign-in cookie', freshness: FRESH, matched: ['cookie'], dropped: ['in', 'sign'] }));
    assert.equal(relaxed[0], '# search "sign-in cookie" · 1 partial match (no name has all words; best match: cookie) · indexed 2m ago');
    const some = lines(renderSearch([row], { query: 'parse cookie header', freshness: FRESH, matched: ['parse', 'cookie'], dropped: ['header'] }));
    assert.equal(some[0], '# search "parse cookie header" · 1 partial match (no name has all words; best match: parse + cookie) · indexed 2m ago');
    const several = lines(renderSearch([row, row], { query: 'parse cookie header', freshness: FRESH, matched: ['parse', 'cookie'], dropped: ['header'] }));
    assert.equal(several[0], '# search "parse cookie header" · 2 partial matches (no name has all words; best match: parse + cookie) · indexed 2m ago');
    // Nothing dropped, or nothing matched: the header stays plain.
    const plain = renderSearch([row], { query: 'parse cookie', freshness: FRESH, matched: ['parse', 'cookie'], dropped: [] });
    assert.equal(lines(plain)[0], '# search "parse cookie" · 1 match · indexed 2m ago');
    const empty = renderSearch([], { query: 'zzz', freshness: FRESH, matched: [], dropped: ['zz'] });
    assert.equal(lines(empty)[0], '# search zzz · no matches · indexed 2m ago');
  });

  test('kind longer than 9 columns keeps its tail with an ellipsis; multi-word queries are quoted', () => {
    const out = renderSearch(
      [{ kind: 'exported_function', name: 'f', path: 'a.ts', startLine: 1, endLine: 2, signature: 'f()' }],
      { query: 'parse config', freshness: FRESH },
    );
    assert.equal(
      out,
      ['# search "parse config" · 1 match · indexed 2m ago', '…function f f() a.ts:1-2', NEXT].join('\n'),
    );
  });

  test('empty result', () => {
    const out = renderSearch([], { query: 'zzz', freshness: FRESH });
    assert.equal(lines(out)[0], '# search zzz · no matches · indexed 2m ago');
    assert.equal(lines(out).length, 2);
    assert.match(lines(out)[1], /^hint: search matches symbol names only .*; a word of one or two letters must be a whole word\.$/);
  });

  test('legend appears only when a visible row carries ~ or ?', () => {
    const rows = [
      { kind: 'method', name: 'a', path: 'a.ts', startLine: 1, resolution: '=' },
      { kind: 'method', name: 'b', path: 'b.ts', startLine: 1, resolution: '~' },
    ];
    const out = lines(renderSearch(rows, { query: 'q', freshness: FRESH }));
    assert.equal(out.at(-1), NEXT, 'the next-step hint is the last line');
    assert.equal(out.at(-2), LEGEND);
    assert.equal(out.at(-3), '   method b b.ts:1~');
    assert.equal(out.some((l) => l.startsWith('legend:')), true);
    const exact = lines(renderSearch([rows[0]], { query: 'q', freshness: FRESH }));
    assert.equal(exact.some((l) => l.startsWith('legend')), false);
    assert.equal(exact.at(-1), NEXT);
  });

  test('budget cut: "(N of M shown)" is the last line, nothing exceeds the budget, hint yields to tiny budgets', () => {
    const out = renderSearch(SEARCH_ROWS, { query: 'parseConfig', freshness: FRESH, budget: 30 });
    assert.equal(
      out,
      ['# search parseConfig · 4 matches · indexed 2m ago', '(0 of 4 shown)'].join('\n'),
    );
    assert.ok(estimateTokens(out) <= 30);
    const some = renderSearch(SEARCH_ROWS, { query: 'parseConfig', freshness: FRESH, budget: 60 });
    const l = lines(some);
    assert.match(l.at(-1), /^\([1-3] of 4 shown\)$/);
    assert.equal(l.at(-2), 'hint: raise budget (max 4000) or limit (max 200) to see more rows');
    assert.equal(l.includes(NEXT), false, 'rows outrank the next-step hint in a small budget');
    assert.ok(estimateTokens(some) <= 60);
    assert.equal(l.length, parseInt(l.at(-1).slice(1), 10) + 3, 'header + rows + hint + truncation line');
  });

  test('limit cut without a known total is reported as "N of N+1+"', () => {
    const out = lines(renderSearch(SEARCH_ROWS.slice(0, 2), { query: 'parseConfig', freshness: FRESH, more: true }));
    assert.equal(out.at(-1), '(2 of 3+ shown)');
    assert.equal(out.at(-2), 'hint: raise budget (max 4000) or limit (max 200) to see more rows');
    assert.equal(out[0], '# search parseConfig · 2 matches · indexed 2m ago');
  });

  test('rows that carry usage counts end with who uses them; zero and missing counts add nothing', () => {
    const row = { kind: 'function', name: 'f', path: 'src/a.ts', startLine: 1, endLine: 2 };
    const out = lines(renderSearch([
      { ...row, usage: { refs: 12, files: 4, inSource: 3, byName: 0 } },
      { ...row, usage: { refs: 1, files: 1, inSource: 1 } },
      { ...row, usage: { refs: 0, files: 0, inSource: 0 } },
      row,
    ], { query: 'f', freshness: FRESH }));
    assert.equal(out[1], ' function f src/a.ts:1-2 · 12 uses in 4 files (3 in source)');
    assert.equal(out[2], ' function f src/a.ts:1-2 · 1 use in 1 file');
    assert.equal(out[3], ' function f src/a.ts:1-2');
    assert.equal(out[4], ' function f src/a.ts:1-2');
    assert.equal(out.some((l) => l.startsWith('legend:')), false, 'nothing to explain');
  });

  test('usage counts that rest on unique-name links carry ~ and the legend; a hub gets only its count', () => {
    const row = { kind: 'function', name: 'f', path: 'src/a.ts', startLine: 1, endLine: 2 };
    const out = lines(renderSearch([
      { ...row, usage: { refs: 15, files: 2, inSource: 0, byName: 15 } },
      { ...row, usage: { refs: 7, files: 3, inSource: 2, byName: 2 } },
      { ...row, usage: { refs: 15359, capped: true } },
      { ...row, usage: { refs: 1, capped: true } },
      { ...row, usage: { refs: 12, files: 4, inSource: 4, byName: 0 } },
    ], { query: 'f', freshness: FRESH }));
    assert.equal(out[1], ' function f src/a.ts:1-2 · 15 uses in 2 files (0 in source)~');
    assert.equal(out[2], ' function f src/a.ts:1-2 · 7 uses in 3 files (2 in source)~');
    assert.equal(out[3], ' function f src/a.ts:1-2 · 15359 references (not broken down by file)');
    assert.equal(out[4], ' function f src/a.ts:1-2 · 1 reference (not broken down by file)');
    assert.equal(out[5], ' function f src/a.ts:1-2 · 12 uses in 4 files');
    assert.equal(out.filter((l) => l === LEGEND).length, 1, 'the legend explains the ~ once');
  });
});

describe('renderSymbol', () => {
  test('a function is "called", a type / constant / class is "used"', () => {
    for (const kind of ['constant', 'interface', 'class', 'field']) {
      const out = lines(renderSymbol({ ...SYMBOL_RESULT, symbol: { ...SYMBOL_RESULT.symbol, kind }, callees: [], callers: [SYMBOL_RESULT.callers[0]] }, { name: 'X', freshness: FRESH }));
      assert.equal(out[0], '# symbol X · src/config/parse.ts:42-71 (30 lines) · uses 1/1 resolved · indexed 2m ago', kind);
      assert.equal(out[4], 'used by(1): main src/main.ts:12=', kind);
    }
    for (const kind of ['function', 'method', 'component']) {
      const out = lines(renderSymbol({ ...SYMBOL_RESULT, symbol: { ...SYMBOL_RESULT.symbol, kind }, callees: [], callers: [SYMBOL_RESULT.callers[0]] }, { name: 'X', freshness: FRESH }));
      assert.match(out[0], / · callers 1\/1 resolved · /, kind);
      assert.equal(out[4], 'called by(1): main src/main.ts:12=', kind);
    }
  });
  test('full layout with Read line for a long body (CONTRACTS.md §11 example)', () => {
    assert.equal(
      renderSymbol(SYMBOL_RESULT, { name: 'parseConfig', freshness: FRESH, body: { lineCount: 30 } }),
      [
        '# symbol parseConfig · src/config/parse.ts:42-71 (30 lines) · callers 2/3 resolved · indexed 2m ago',
        'sig: parseConfig(raw: string): Config',
        'doc: Parses the raw config.',
        'calls(3): loadFile= validate~ save? ×2',
        'called by(3): main src/main.ts:12= · run src/cli.ts:9~ · x src/a.ts:3?',
        'imports: node:fs, ./util',
        LEGEND,
        'body: 30 lines → Read src/config/parse.ts offset 42 limit 30',
      ].join('\n'),
    );
  });

  test('inline body up to 30 lines, Read line above that', () => {
    const meta = { name: 'f', freshness: FRESH };
    const short = renderSymbol({ ...SYMBOL_RESULT, symbol: { ...SYMBOL_RESULT.symbol, startLine: 2, endLine: 4 }, callers: [], callees: [], imports: [] }, { ...meta, body: { lines: ['a', 'b', 'c'] } });
    assert.equal(
      short,
      ['# symbol f · src/config/parse.ts:2-4 (3 lines) · callers 0/0 resolved · indexed 2m ago', 'sig: parseConfig(raw: string): Config', 'doc: Parses the raw config.', 'calls(0): none', 'called by(0): none', 'body (3 lines):', '```', 'a', 'b', 'c', '```'].join('\n'),
    );
    const thirty = Array.from({ length: INLINE_BODY_MAX_LINES }, (_, i) => `  line ${i + 1}`);
    const inline = renderSymbol(SYMBOL_RESULT, { ...meta, body: { lines: thirty } });
    assert.ok(inline.includes(`body (${INLINE_BODY_MAX_LINES} lines):`));
    assert.ok(inline.endsWith('```'));
    const long = renderSymbol(SYMBOL_RESULT, { ...meta, body: { lines: [...thirty, '  one more'] } });
    assert.equal(long.includes('```'), false);
    assert.equal(lines(long).at(-1), 'body: 31 lines → Read src/config/parse.ts offset 42 limit 31');
  });

  test('no body section unless requested; unreadable body explains why', () => {
    const none = renderSymbol(SYMBOL_RESULT, { name: 'parseConfig', freshness: FRESH });
    assert.equal(none.includes('body'), false);
    const failed = renderSymbol(SYMBOL_RESULT, { name: 'parseConfig', freshness: FRESH, body: { error: 'cannot read src/config/parse.ts (ENOENT); the index may be stale' } });
    assert.equal(lines(failed).at(-1), 'body: cannot read src/config/parse.ts (ENOENT); the index may be stale');
  });

  test('body falls back to the Read line when the block would not fit the budget', () => {
    const thirty = Array.from({ length: 30 }, () => '    return value; // a reasonably long body line');
    const out = renderSymbol(SYMBOL_RESULT, { name: 'parseConfig', freshness: FRESH, budget: 100, body: { lines: thirty } });
    assert.equal(out.includes('```'), false);
    assert.ok(out.includes('body: 30 lines → Read src/config/parse.ts offset 42 limit 30'));
    assert.ok(estimateTokens(out) <= 100, `${estimateTokens(out)} tokens`);
    assert.match(lines(out).at(-1), /^\(\d of 5 shown\)$/);
  });

  test('not found and all-resolved (no legend)', () => {
    const missing = lines(renderSymbol(null, { name: 'nope', freshness: FRESH }));
    assert.equal(missing[0], '# symbol nope · not found · indexed 2m ago');
    assert.equal(missing.length, 2);
    assert.match(missing[1], /^hint: no unique symbol/);
    const exact = renderSymbol(
      { ...SYMBOL_RESULT, callees: SYMBOL_RESULT.callees.slice(0, 1), callers: SYMBOL_RESULT.callers.slice(0, 1) },
      { name: 'parseConfig', freshness: FRESH },
    );
    assert.equal(exact.includes('legend'), false);
    assert.equal(lines(exact)[0], '# symbol parseConfig · src/config/parse.ts:42-71 (30 lines) · callers 1/1 resolved · indexed 2m ago');
  });
});

describe('renderCallers / renderCallees', () => {
  const ROWS = [
    { name: 'main', path: 'src/main.ts', startLine: 12, resolution: '=', count: 3 },
    { name: 'run', path: 'src/cli.ts', startLine: 9, resolution: '?' },
  ];

  test('callers: same row format, marker glued to the location, count as ×N, summary with resolved share', () => {
    assert.equal(
      renderCallers(ROWS, { name: 'loadConfig', freshness: FRESH }),
      [
        '# callers loadConfig · 2 call sites (1/2 resolved) · indexed 2m ago',
        '     call run src/cli.ts:9?',
        '     call main src/main.ts:12= ×3',
        LEGEND,
      ].join('\n'),
    );
  });

  test('callees share the format and the file arg is shown', () => {
    assert.equal(
      renderCallees(ROWS.map((r) => ({ ...r, resolution: '~' })), { name: 'loadConfig', file: 'src/main.ts', freshness: FRESH }),
      [
        '# callees loadConfig src/main.ts · 2 callees (2/2 resolved) · indexed 2m ago',
        '     call run src/cli.ts:9~',
        '     call main src/main.ts:12~ ×3',
        LEGEND,
      ].join('\n'),
    );
  });

  test('empty relations, limit cut', () => {
    const empty = lines(renderCallers([], { name: 'x', freshness: FRESH }));
    assert.equal(empty[0], '# callers x · no callers · indexed 2m ago');
    assert.equal(empty.length, 2);
    assert.match(empty[1], /^hint: confirm the name/);
    const more = lines(renderCallees(ROWS, { name: 'x', freshness: FRESH, more: true }));
    assert.equal(more.at(-1), '(2 of 3+ shown)');
  });

  test('relation rows without a path (unresolved callee target) show the line alone', () => {
    const out = lines(renderCallees([{ name: 'validate', path: null, startLine: 10, resolution: '?', count: 1 }], { name: 'parseConfig', freshness: FRESH }));
    assert.equal(out[0], '# callees parseConfig · 1 callee (0/1 resolved) · indexed 2m ago');
    assert.equal(out[1], '     call validate line 10?');
    assert.equal(out[2], LEGEND);
    const sym = renderSymbol({ ...SYMBOL_RESULT, callees: [{ name: 'validate', path: null, startLine: 10, resolution: '?' }], callers: [] }, { name: 'parseConfig', freshness: FRESH });
    assert.ok(sym.includes('calls(1): validate?'));
  });
});

describe('renderImpact', () => {
  const RESULT = {
    nodes: [
      { kind: 'function', name: 'main', path: 'src/main.ts', startLine: 1, endLine: 5, depth: 1 },
      { kind: 'function', name: 'run', path: 'src/cli.ts', startLine: 3, endLine: 9, depth: 1 },
      { kind: 'function', name: 'boot', path: 'src/cli.ts', startLine: 20, endLine: 30, depth: 2 },
    ],
    files: ['src/main.ts', 'src/cli.ts'],
    truncated: false,
  };

  test('nodes sorted by path/line with depth, files listed, header carries depth=N', () => {
    assert.equal(
      renderImpact(RESULT, { name: 'loadConfig', depth: 2, freshness: FRESH }),
      [
        '# impact loadConfig depth=2 · 3 nodes in 2 files · indexed 2m ago',
        ' function run src/cli.ts:3-9 depth 1',
        ' function boot src/cli.ts:20-30 depth 2',
        ' function main src/main.ts:1-5 depth 1',
        'files(2): src/main.ts, src/cli.ts',
      ].join('\n'),
    );
  });

  test('query-side truncation is a hint, our own row limit is the regular truncation line', () => {
    const cut = renderImpact({ ...RESULT, truncated: true }, { name: 'loadConfig', depth: 2, freshness: FRESH });
    assert.equal(lines(cut).at(-1), 'hint: impact was cut; raise depth (max 6) or limit (max 200) to see more.');
    assert.equal(lines(cut).some((l) => /shown\)$/.test(l)), false);
    const limited = lines(renderImpact(RESULT, { name: 'loadConfig', depth: 1, freshness: FRESH, more: true }));
    assert.equal(limited[0], '# impact loadConfig depth=1 · 3 nodes in 2 files · indexed 2m ago');
    assert.equal(limited.at(-1), '(3 of 4+ shown)');
  });
});

describe('renderOutline', () => {
  test('source order per file and the empty hint', () => {
    assert.equal(
      renderOutline(
        [
          { kind: 'function', name: 'loadConfig', startLine: 14, endLine: 20, signature: 'loadConfig(): void' },
          { kind: 'class', name: 'Parser', startLine: 1, endLine: 20, signature: null },
          { kind: 'method', name: 'parseConfig', startLine: 2, endLine: 10, signature: 'parseConfig(raw: string)' },
        ],
        { file: 'src/config.ts', freshness: FRESH },
      ),
      [
        '# outline src/config.ts · 3 symbols · indexed 2m ago',
        '    class Parser src/config.ts:1-20',
        '   method parseConfig parseConfig(raw: string) src/config.ts:2-10',
        ' function loadConfig loadConfig(): void src/config.ts:14-20',
      ].join('\n'),
    );
    const empty = lines(renderOutline([], { file: 'nope.ts', freshness: FRESH }));
    assert.equal(empty[0], '# outline nope.ts · no symbols · indexed 2m ago');
    assert.equal(empty.length, 2);
    assert.match(empty[1], /^hint: file is not in the index/);
  });
});

describe('renderMap', () => {
  const MAP = { text: 'src/\n  a.ts  function f:1 method g:3\nlib/\n  b.ts  class B:1', shown: 5, total: 5, truncated: false };

  test('wraps repoMap text with the header', () => {
    assert.equal(renderMap(MAP, { path: 'src/', freshness: FRESH }), ['# map src/ · 5 symbols · indexed 2m ago', ...MAP.text.split('\n')].join('\n'));
    assert.equal(lines(renderMap(MAP, { freshness: FRESH }))[0], '# map · 5 symbols · indexed 2m ago');
  });

  test('truncated map reports shown of total and the hint', () => {
    const out = lines(renderMap({ ...MAP, shown: 5, total: 340, truncated: true }, { path: 'src/', freshness: FRESH }));
    assert.equal(out[0], '# map src/ · 5 of 340 symbols · indexed 2m ago');
    assert.equal(out.at(-1), 'hint: raise budget (max 4000) or pass a narrower path to see more.');
    const byCount = lines(renderMap({ ...MAP, shown: 5, total: 340 }, { freshness: FRESH }));
    assert.equal(byCount[0], '# map · 5 of 340 symbols · indexed 2m ago');
  });

  test('empty and null maps', () => {
    assert.equal(renderMap({ text: '', shown: 0, total: 0, truncated: false }, { freshness: FRESH }), ['# map · 0 symbols · indexed 2m ago', 'hint: no symbols in scope; pass a path or check codegraph_status.'].join('\n'));
    assert.equal(lines(renderMap(null, { freshness: FRESH }))[0], '# map · 0 symbols · indexed 2m ago');
  });
});

describe('renderNotice', () => {
  test('header plus optional hint', () => {
    assert.equal(renderNotice({ operation: 'search', args: 'x', summary: 'not indexed', hint: 'use Read/Grep' }), '# search x · not indexed\nhint: use Read/Grep');
    assert.equal(renderNotice({ operation: 'map', args: '', summary: 'query failed', freshness: FRESH }), '# map · query failed · indexed 2m ago');
  });
});

describe('output limits', () => {
  test('every renderer stays within its token budget', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ kind: 'method', name: `symbol${i}`, path: `src/dir${i % 3}/file${i}.ts`, startLine: i + 1, endLine: i + 30, signature: `symbol${i}(a: string, b: number): Promise<void>` }));
    for (const budget of [200, 400, 1500, 4000]) {
      for (const out of [
        renderSearch(rows, { query: 'symbol', freshness: STALE, budget }),
        renderCallers(rows.map((r) => ({ name: r.name, path: r.path, startLine: r.startLine, resolution: '?' })), { name: 'x', freshness: STALE, budget }),
        renderSymbol({ ...SYMBOL_RESULT, callees: rows.map((r) => ({ name: r.name, path: r.path, startLine: 1, resolution: '~' })) }, { name: 'x', freshness: STALE, budget }),
      ]) {
        assert.ok(estimateTokens(out) <= budget, `budget ${budget}: ${estimateTokens(out)} tokens`);
      }
    }
  });

  test('hard cap: 45 KB even with an unbounded budget, marker last, whole lines only', () => {
    const rows = Array.from({ length: 3000 }, (_, i) => ({ kind: 'function', name: `f${i}`, path: `src/file${i}.ts`, startLine: 1, endLine: 9, signature: 'x'.repeat(100) }));
    const out = renderSearch(rows, { query: 'f', freshness: FRESH, budget: 10_000_000 });
    assert.ok(bytes(out) <= MAX_OUTPUT_BYTES, `${bytes(out)} bytes`);
    const l = lines(out);
    assert.match(l.at(-1), /^\(output truncated at 45 KB: \d+ of 3002 lines shown\)$/);
    assert.equal(l[0], '# search f · 3000 matches · indexed 2m ago');
    assert.equal(l[1], ` function f0 ${'x'.repeat(79)}… src/file0.ts:1-9`);
    assert.ok(l.length > 100);
    const status = renderStatus(readyStatus({ languages: Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [`lang${i}`, 1])) }));
    // The languages line is clamped before the byte cap, so the model still sees the languages instead of a dropped row.
    assert.ok(bytes(status) <= MAX_OUTPUT_BYTES);
    const langLine = lines(status).find((l) => l.startsWith('languages: '));
    assert.match(langLine, /… \(\+9960 more\)$/);
    assert.equal(lines(status).at(-1).startsWith('(output truncated'), false);
  });
});
