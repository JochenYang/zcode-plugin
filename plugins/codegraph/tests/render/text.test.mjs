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
    assert.equal(lines(out)[1], 'hint: search matches symbol names and names that are used here without a definition (calls, type names, and in JS/TS property reads such as obj.field and object keys such as { field }); text, variables and parameters, and string literals belong to Grep; a word of one or two letters must be a whole word.');
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

// A name that is used but not defined (CONTRACTS.md §11 "search"): the rows are places.
describe('renderSearch: a name that is only used', () => {
  const HEAD = 'hint: no symbol carries this name; the rows are places that use it: calls and type names from the index. ';
  const TAIL = 'Variables and parameters and words in strings are not in the graph: grep for those.';
  // Rows of the index only: what became of the look in the source, by `refs.skipped`.
  const HINT = `${HEAD}JS/TS property reads (obj.field) and object keys ({ field }) were looked for in the source: there were none. ${TAIL}`;
  const HUB_HINT = `${HEAD}It also appears in more JS/TS files than a search lists, read as a property (obj.field) or as the key of an object ({ field }): too common to point anywhere. ${TAIL}`;
  const LIMIT_HINT = `${HEAD}Its JS/TS property reads (obj.field) and object keys ({ field }) are not listed: more of them than a search parses at once, or more source than one scan reads. Grep for them. ${TAIL}`;
  const SKIPPED_HINT = `${HEAD}JS/TS property reads (obj.field) and object keys ({ field }) were not looked for in the source this time: the scanner was not ready or its scan timed out, some files could not be read, or the query is not a single name. ${TAIL}`;
  // Said after any of them when a total carries a +.
  const LOWER = ' Totals with a + are lower bounds: more places exist than were read.';
  const SCAN_HINT =
    'hint: no symbol carries this name; the rows are property reads (obj.name), object keys ({ name }) and members of types, found by scanning the JavaScript ' +
    'and TypeScript source just now; the index had no call or type of that name. ' +
    'Variables and parameters and words in strings are not in the graph: grep for those.';
  const MIXED_HINT =
    'hint: no symbol carries this name; the rows are places that use it: calls and type names from the index, and property reads ' +
    '(obj.name), object keys ({ name }) and members of types found by scanning the JS/TS source just now. ' +
    'Variables and parameters and words in strings are not in the graph: grep for those.';
  const SCAN_ROWS = [
    { kind: 'property', name: 'membershipKind', receiver: 'row', count: 2, path: 'src/sheet.tsx', startLine: 40, owner: 'Cell', ownerQual: 'Cell', ownerKind: 'component' },
    { kind: 'property', name: 'membershipKind', receiver: 'props.account', count: 1, path: 'src/sheet.tsx', startLine: 52, owner: 'Cell', ownerQual: 'Cell', ownerKind: 'component' },
    { kind: 'property', name: 'membershipKind', receiver: 'config', count: 1, path: 'src/start.ts', startLine: 3, owner: null, ownerQual: null, ownerKind: null },
  ];
  // A result of the scan alone, in the name the rows are about.
  const SCANNED = { uses: 4, files: 2, names: ['membershipKind'], capped: false, fromIndex: 0, fromScan: 3, symbols: [], symbolCount: 0 };
  const scanned = (rows, extra = {}) => meta(SCANNED, { query: 'membershipKind', ...extra });
  const cut = (text, max) => `${text.slice(0, max - 1)}…`;
  const ROWS = [
    { kind: 'call', name: 'useEffect', receiver: null, count: 4, path: 'src/ThemeProvider.tsx', startLine: 63, owner: 'ThemeProvider', ownerQual: 'ThemeProvider', ownerKind: 'component' },
    { kind: 'ref', name: 'cfg', receiver: null, count: 1, path: 'src/b.ts', startLine: 3, owner: null, ownerQual: null, ownerKind: null },
    { kind: 'call', name: 'readFileSync', receiver: 'fs', count: 2, path: 'src/c.ts', startLine: 9, owner: 'load', ownerQual: 'load', ownerKind: 'function' },
  ];
  const uses = (extra = {}) => ({ uses: 90, files: 48, names: ['useEffect'], capped: false, fromIndex: 3, fromScan: 0, skipped: null, symbols: [], symbolCount: 0, ...extra });
  const meta = (refs, extra = {}) => ({ query: 'useEffect', freshness: FRESH, refs, ...extra });

  test('rows of the index only: the hint says what became of the look in the source, and "none" only when the scan finished', () => {
    const last = (extra) => lines(renderSearch(ROWS, meta(uses(extra)))).at(-1);
    assert.equal(last({}), HINT);
    assert.equal(last({ skipped: 'hub', capped: true }), HUB_HINT + LOWER);
    assert.equal(last({ skipped: 'limit', capped: true }), LIMIT_HINT + LOWER);
    assert.equal(last({ skipped: 'unreadable' }), SKIPPED_HINT);
    assert.equal(last({ skipped: 'not-asked' }), SKIPPED_HINT, 'no scan was passed: not "none were found"');
    assert.equal(last({ skipped: 'not-ready' }), SKIPPED_HINT);
    assert.equal(last({ skipped: 'not-identifier' }), SKIPPED_HINT);
    // A cut in the index alone: "none were found" still holds, and the + is explained.
    assert.equal(last({ capped: true }), HINT + LOWER);
  });

  test('an empty result whose name is a hub says so, instead of listing what a search matches', () => {
    const last = (extra) => lines(renderSearch([], { query: 'length', freshness: FRESH, ...extra })).at(-1);
    assert.ok(last({}).startsWith('hint: search matches symbol names and names that are used here without a definition'), last({}));
    assert.ok(last({ hub: true }).startsWith('hint: no symbol, call or type has this name, and it is read or used as a key in more JS/TS files than a search lists.'), last({ hub: true }));
    // The other empty hint (a name that matches something) says what a search now covers.
    assert.ok(last({}).includes('in JS/TS property reads such as obj.field and object keys such as { field }'), last({}));
    assert.equal(last({}).includes('object keys in literals'), false);
  });

  test('the header says that no symbol carries the name and how many places use it; the rows are places, not definitions', () => {
    assert.deepEqual(lines(renderSearch(ROWS, meta(uses({ symbols: ['useT', 'useTick'], symbolCount: 20 })))), [
      '# search useEffect · no symbol carries this name; 90 uses in 48 files (useEffect) · also in symbol names: useT, useTick (+18 more found) · indexed 2m ago',
      '     call useEffect ×4 in ThemeProvider src/ThemeProvider.tsx:63',
      '      ref cfg ×1 at src/b.ts:3',
      '     call fs.readFileSync ×2 in load src/c.ts:9',
      HINT,
    ]);
  });

  test('one use in one file, totals past a cut, several names, at most three symbol names', () => {
    const one = lines(renderSearch(ROWS, meta(uses({ uses: 1, files: 1 }))));
    assert.equal(one[0], '# search useEffect · no symbol carries this name; 1 use in 1 file (useEffect) · indexed 2m ago');
    assert.equal(one.at(-1), HINT);
    const capped = lines(renderSearch(ROWS, meta(uses({ uses: 5001, files: 501, names: ['e'], capped: true }), { query: 'e' })));
    assert.equal(capped[0], '# search e · no symbol carries this name; 5001+ uses in 501+ files (e) · indexed 2m ago');
    const several = lines(renderSearch(ROWS, meta(uses({ uses: 141, files: 40, names: ['writeFileSync', 'writeFile', 'writeCacheFile', 'written'] }), { query: 'write file' })));
    assert.equal(several[0], '# search "write file" · no symbol carries this name; 141 uses in 40 files (writeFileSync, writeFile, writeCacheFile … (+1 more)) · indexed 2m ago');
    const three = lines(renderSearch(ROWS, meta(uses({ symbols: ['useT', 'useTick', 'useData'], symbolCount: 3 }))));
    assert.ok(three[0].endsWith('also in symbol names: useT, useTick, useData · indexed 2m ago'), three[0]);
  });

  test('no legend and no next-step hint; relaxed words that arrive with the uses are not shown', () => {
    const out = renderSearch(ROWS, meta(uses({ uses: 2, files: 2 }), { matched: ['use'], dropped: ['effect'] }));
    assert.equal(out.includes('legend'), false);
    assert.equal(out.includes('next:'), false);
    assert.equal(out.includes('partial'), false);
    assert.ok(out.endsWith(HINT));
  });

  test('rows found by a source scan are called property reads and say where they came from', () => {
    const refs = { uses: 4, files: 2, names: ['membershipKind'], capped: false, fromIndex: 0, fromScan: 3, symbols: [], symbolCount: 0 };
    assert.deepEqual(lines(renderSearch(SCAN_ROWS, scanned())), [
      '# search membershipKind · no symbol carries this name; 4 property reads in 2 files (membershipKind) · indexed 2m ago',
      ' property row.membershipKind ×2 in Cell src/sheet.tsx:40',
      ' property props.account.membershipKind ×1 in Cell src/sheet.tsx:52',
      ' property config.membershipKind ×1 at src/start.ts:3',
      SCAN_HINT,
    ]);
    const one = lines(renderSearch(SCAN_ROWS.slice(0, 1), scanned(SCAN_ROWS.slice(0, 1), { refs: { ...refs, uses: 1, files: 1 } })));
    assert.equal(one[0], '# search membershipKind · no symbol carries this name; 1 property read in 1 file (membershipKind) · indexed 2m ago');
    // The kind is cut like any other kind when it is longer than its column.
    assert.equal(lines(renderSearch([{ ...SCAN_ROWS[0], kind: 'propertyValue' }], scanned()))[1], '…rtyValue row.membershipKind ×2 in Cell src/sheet.tsx:40');
  });

  test('a scan that stopped at a limit: what it found is shown, and the totals are marked as lower bounds', () => {
    const out = lines(renderSearch(SCAN_ROWS, scanned(SCAN_ROWS, { refs: { ...SCANNED, uses: 40, files: 12, capped: true } })));
    assert.equal(out[0], '# search membershipKind · no symbol carries this name; 40+ property reads in 12+ files (membershipKind) · indexed 2m ago');
    assert.equal(out.at(-1), SCAN_HINT + LOWER, 'the + in the header is explained once');
  });

  test('rows of both sources are one list and are called uses; the hint names both sources', () => {
    const refs = { uses: 5, files: 3, names: ['membershipKind'], capped: false, fromIndex: 1, fromScan: 3, symbols: [], symbolCount: 0 };
    const fromIndex = { kind: 'ref', name: 'membershipKind', receiver: null, count: 1, path: 'src/model.py', startLine: 12, owner: 'f', ownerQual: 'f', ownerKind: 'function' };
    const out = lines(renderSearch([SCAN_ROWS[0], SCAN_ROWS[2], fromIndex], scanned(SCAN_ROWS, { refs })));
    assert.equal(out[0], '# search membershipKind · no symbol carries this name; 5 uses in 3 files (membershipKind) · indexed 2m ago');
    assert.deepEqual(out.slice(1), [
      ' property row.membershipKind ×2 in Cell src/sheet.tsx:40',
      ' property config.membershipKind ×1 at src/start.ts:3',
      '      ref membershipKind ×1 in f src/model.py:12',
      MIXED_HINT,
    ]);
  });

  test('object keys and members of types are rows of the scan too: by kind, without a receiver', () => {
    const keyRows = [
      { kind: 'key', name: 'membershipKind', receiver: null, count: 3, path: 'src/sweep.ts', startLine: 5, owner: 'f', ownerQual: 'f', ownerKind: 'function' },
      { kind: 'field', name: 'maxIdleDays', receiver: null, count: 1, path: 'src/sweep.ts', startLine: 1, owner: 'Policy', ownerQual: 'Policy', ownerKind: 'interface' },
    ];
    const refs = { uses: 4, files: 1, names: ['membershipKind', 'maxIdleDays'], capped: false, fromIndex: 0, fromScan: 2, kinds: ['key', 'field'], symbols: [], symbolCount: 0 };
    assert.deepEqual(lines(renderSearch(keyRows, meta(refs, { query: 'membershipKind' }))), [
      '# search membershipKind · no symbol carries this name; 4 uses in 1 file (membershipKind, maxIdleDays) · indexed 2m ago',
      '      key membershipKind ×3 in f src/sweep.ts:5',
      '    field maxIdleDays ×1 in Policy src/sweep.ts:1',
      SCAN_HINT,
    ]);
  });

  test('"property reads" counts reads alone; one key among the rows makes the count "uses"', () => {
    const keyRow = { kind: 'key', name: 'membershipKind', receiver: null, count: 1, path: 'src/sweep.ts', startLine: 5, owner: 'f', ownerQual: 'f', ownerKind: 'function' };
    const refs = { ...SCANNED, uses: 4, files: 2, kinds: ['property', 'key'] };
    const header = (rows, kinds) => lines(renderSearch(rows, meta(kinds ? refs : { ...refs, kinds: undefined }, { query: 'membershipKind' })))[0];
    assert.equal(header([SCAN_ROWS[0], keyRow], true), '# search membershipKind · no symbol carries this name; 4 uses in 2 files (membershipKind) · indexed 2m ago');
    // No kinds told (an older or hand-made answer): reads only, as before.
    assert.equal(header([SCAN_ROWS[0]], false), '# search membershipKind · no symbol carries this name; 4 property reads in 2 files (membershipKind) · indexed 2m ago');
  });

  test('a lookup that was cut while the other has rows: the footer names the missing side, and the totals are lower bounds', () => {
    const TAIL = 'Variables and parameters and words in strings are not in the graph: grep for those.';
    const LOWER = ' Totals with a + are lower bounds: more places exist than were read.';
    // The keys were cut: the rows are property reads, and are called that.
    const keysCut = lines(renderSearch(SCAN_ROWS, scanned(SCAN_ROWS, { refs: { ...SCANNED, kinds: ['property'], capped: true, cut: 'keys' } })));
    assert.equal(keysCut[0], '# search membershipKind · no symbol carries this name; 4+ property reads in 2+ files (membershipKind) · indexed 2m ago');
    assert.equal(keysCut.at(-1), 'hint: no symbol carries this name; the rows are property reads (obj.name), found by scanning the JavaScript and TypeScript source just now; the index had no call or type of that name. Its object keys ({ name }) are not listed: the name is on its own in more JS/TS files than a search lists. Grep for them. ' + TAIL + LOWER);
    // The reads were cut: the rows are keys and members of types, so they are uses.
    const keyRow = { kind: 'key', name: 'membershipKind', receiver: null, count: 1, path: 'src/sweep.ts', startLine: 5, owner: 'f', ownerQual: 'f', ownerKind: 'function' };
    const readsCut = lines(renderSearch([keyRow], scanned([keyRow], { refs: { ...SCANNED, uses: 1, files: 1, kinds: ['key'], capped: true, cut: 'reads' } })));
    assert.equal(readsCut[0], '# search membershipKind · no symbol carries this name; 1+ use in 1+ file (membershipKind) · indexed 2m ago');
    assert.equal(readsCut.at(-1), 'hint: no symbol carries this name; the rows are object keys ({ name }) and members of types, found by scanning the JavaScript and TypeScript source just now; the index had no call or type of that name. Its property reads (obj.name) are not listed: it is read as a property in more JS/TS files than a search lists. Grep for them. ' + TAIL + LOWER);
    // Rows of both sources with the keys cut: said in the footer of a mixed list too.
    const fromIndex = { kind: 'ref', name: 'membershipKind', receiver: null, count: 1, path: 'src/model.py', startLine: 12, owner: 'f', ownerQual: 'f', ownerKind: 'function' };
    const mixed = lines(renderSearch([SCAN_ROWS[0], fromIndex], scanned(SCAN_ROWS, { refs: { uses: 2, files: 2, names: ['membershipKind'], capped: true, fromIndex: 1, fromScan: 1, kinds: ['property', 'ref'], cut: 'keys' } })));
    assert.equal(mixed.at(-1), 'hint: no symbol carries this name; the rows are places that use it: calls and type names from the index, and property reads (obj.name) found by scanning the JS/TS source just now. Its object keys ({ name }) are not listed: the name is on its own in more JS/TS files than a search lists. Grep for them. ' + TAIL + LOWER);
    // Only rows of the index: nothing of the scan is listed, so nothing of it is said to be missing.
    assert.equal(lines(renderSearch(ROWS, meta(uses({ cut: 'keys' })))).at(-1), HINT);
    // A word that is not a side is not a cut.
    assert.equal(lines(renderSearch(SCAN_ROWS, scanned(SCAN_ROWS, { refs: { ...SCANNED, cut: 'both' } }))).at(-1), SCAN_HINT);
  });

  test('a long name is cut, and is in quotes when it has spaces', () => {
    const long = 'x'.repeat(100);
    const spaced = `(childProps[name] as ((e: unknown) => void) | undefined) ${'y'.repeat(50)}`;
    const place = (name, receiver, startLine) => ({ kind: 'call', name, receiver, count: 1, path: 'a.ts', startLine, owner: null });
    const [header, first, second] = lines(renderSearch(
      [place(long, 'r'.repeat(40), 1), place(spaced, null, 2)],
      meta(uses({ uses: 2, files: 1, names: [long, spaced] }), { query: 'e' }),
    ));
    assert.equal(header, `# search e · no symbol carries this name; 2 uses in 1 file (${cut(long, 40)}, "${cut(spaced, 40)}") · indexed 2m ago`);
    assert.equal(first, `     call ${cut('r'.repeat(40), 24)}.${cut(long, 60)} ×1 at a.ts:1`);
    assert.equal(second, `     call "${cut(spaced, 60)}" ×1 at a.ts:2`);
  });

  test('budget cut: "(N of M shown)" is the last line, rows outrank the hint, nothing exceeds the budget', () => {
    const cut = renderSearch(ROWS, meta(uses(), { budget: 60 }));
    assert.deepEqual(lines(cut).slice(-2), ['hint: raise budget (max 4000) or limit (max 200) to see more rows', '(0 of 3 shown)']);
    assert.ok(estimateTokens(cut) <= 60);
    const fits = renderSearch(ROWS, meta(uses(), { budget: 70 }));
    assert.deepEqual(lines(fits).slice(1), [
      '     call useEffect ×4 in ThemeProvider src/ThemeProvider.tsx:63',
      '      ref cfg ×1 at src/b.ts:3',
      '     call fs.readFileSync ×2 in load src/c.ts:9',
    ]);
    assert.equal(fits.includes(HINT), false, 'rows outrank the hint in a small budget');
    assert.ok(estimateTokens(fits) <= 70);
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
