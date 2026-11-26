// Tool layer (CONTRACTS.md §10/§11): schemas, validation, freshness flow and
// rendering, driven through the real JSON-RPC handler with a fake context. The
// database holds data produced by the real extraction engine from
// fixtures/graph/sample.ts; graph queries are injected (`ctx.queries`) because
// the real module may still be the phase-0 stub.
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../../src/mcp/server.mjs';
import { BUDGET_RANGE, DEPTH_RANGE, FILES_MAX, LIMIT_RANGE, OPERATIONS, TOOLS, callTool, resolveGraph } from '../../src/mcp/tools.mjs';
import * as graphQueries from '../../src/graph/queries.mjs';
import * as graphMap from '../../src/graph/map.mjs';
import { DEFAULT_CONFIG } from '../../src/config.mjs';
import { planSweep } from '../../src/index/storage.mjs';
import { projectKey } from '../../src/paths.mjs';
import { close, openDatabase } from '../../src/store/db.mjs';
import { findSymbolsByName, importsOfFile, markDirty, refsByName, replaceFile, symbolsInFile, takeDirty } from '../../src/store/repo.mjs';
import { extractFile, initEngine, loadSpecs, specForPath } from '../../src/extract/engine.mjs';
import { INSTRUCTIONS } from '../../src/mcp/instructions.mjs';
import { estimateTokens, MAX_OUTPUT_BYTES } from '../../src/render/budget.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'graph', 'sample.ts');
const SAMPLE = 'src/graph/sample.ts';
const LONG = 'src/graph/long.ts';
// Footer of every non-empty search result (CONTRACTS.md §11).
const SEARCH_NEXT_HINT =
  'next: symbol <name> returns the definition with its callers and imports (body=true reads it in one call); impact <name> shows what a change breaks.';

const CONTRACT_DESCRIPTIONS = {
  codegraph_lookup:
    'Locate symbols and relationships in the code graph. Use this INSTEAD of Grep to find where a function/class/variable is defined, who calls or uses it, what it calls, or what a change impacts. One line per symbol with exact file:line ranges; read only those ranges afterwards. operation=search needs query; symbol/callers/callees/impact need name (add file to disambiguate); outline needs file. cycles lists import cycles; affected lists the test files that depend on given files (files=...). symbol with body=true returns the definition source in the same call. Relations are marked: = import-resolved, ~ unique-name, ? unresolved/dynamic — verify ? with Grep if it matters. Index may lag a few seconds after external edits; codegraph_status reports staleness.',
  codegraph_map:
    'Repository map: directories -> files -> key symbols, ranked by reference count and cut to a token budget. Use this INSTEAD of Glob plus reading file heads when you need to see what a project or directory contains. Symbols only, no source.',
  codegraph_status:
    'Code graph index status: ready/building/empty, file and symbol counts, covered languages, stale files. Call it first when unsure whether the graph is usable; refresh=true forces an incremental sync. storage=true lists every project\'s index on this machine; clean removes indexes (only with confirm=true). When the project is not indexed, fall back to Read/Grep.',
};

let db;
let root;
let indexedAt;

before(async () => {
  await initEngine();
  const specs = await loadSpecs();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-tools-'));
  db = openDatabase(':memory:');
  indexedAt = Date.now();
  const sources = {
    [SAMPLE]: fs.readFileSync(FIXTURE, 'utf8'),
    // 40 lines so the body is above the inline limit and must become a Read line.
    [LONG]: ['export function longBody(n: number): number {', ...Array.from({ length: 38 }, (_, i) => `  const v${i} = n + ${i};`), '}'].join('\n'),
  };
  for (const [rel, source] of Object.entries(sources)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, source);
    const extracted = await extractFile({ path: rel, source, spec: specForPath(rel, specs) });
    assert.equal(extracted.parseOk, true, `${rel} parses`);
    replaceFile(db, { path: rel, lang: extracted.lang, hash: extracted.hash, mtimeMs: indexedAt, size: extracted.size, parseOk: extracted.parseOk, errorNodes: extracted.errorNodes, indexedAt }, extracted);
  }
});

after(() => {
  close(db);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

const READY = () => ({ state: 'ready', filesTotal: 2, filesDone: 2, symbols: 5, languages: { typescript: 2 }, stale: 0, indexedAt: Date.now() - 125_000, error: null });
const FRESH = 'indexed 2m ago';

function fakeCtx(status = READY(), extra = {}) {
  const calls = [];
  return {
    root,
    db,
    config: { ...DEFAULT_CONFIG, defaultBudgetTokens: { ...DEFAULT_CONFIG.defaultBudgetTokens } },
    indexer: {
      ensureFresh: async (opts) => {
        calls.push(['ensureFresh', opts]);
      },
      status: () => {
        calls.push(['status']);
        return typeof status === 'function' ? status() : status;
      },
    },
    calls,
    ...extra,
  };
}

function serverFor(ctx) {
  return createServer({ onCall: (name, args) => callTool(name, args, ctx) });
}

async function rpc(server, method, params) {
  return JSON.parse(await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })));
}

async function call(ctx, name, args) {
  const res = await rpc(serverFor(ctx), 'tools/call', { name, arguments: args });
  assert.equal(res.error, undefined, `protocol error: ${JSON.stringify(res.error)}`);
  return res.result;
}

const text = (result) => result.content[0].text;

// A test implementation of the query layer on top of the real store, shaped
// like CONTRACTS.md §8. Resolution marks are synthesised so every marker and
// the legend are exercised.
function storeQueries(log = []) {
  const row = (r) => ({ kind: r.kind, name: r.name, qual: r.qual, path: r.path, startLine: r.start_line, endLine: r.end_line, signature: r.signature });
  return {
    searchIsPartial(db_, { query, kind, limit }) {
      log.push(['searchIsPartial', { query, kind, limit }]);
      return findSymbolsByName(db_, query, { exact: false }).length === 0;
    },
    search(db_, { query, kind, limit }) {
      log.push(['search', { query, kind, limit }]);
      return findSymbolsByName(db_, query, { exact: false }).slice(0, limit).map(row);
    },
    symbol(db_, { name, path, qual }) {
      log.push(['symbol', { name, path, qual }]);
      const matches = findSymbolsByName(db_, name).filter((r) => !path || r.path === path);
      if (matches.length !== 1) return null;
      const s = matches[0];
      return {
        symbol: s,
        callers: refsByName(db_, name).map((r, i) => ({ name, path: r.path, startLine: r.start_line, resolution: ['=', '~', '?'][i % 3], count: i === 0 ? 2 : 1 })),
        callees: refsByName(db_, 'parseConfig').length ? [{ name: 'parseConfig', path: SAMPLE, startLine: 16, resolution: '~' }] : [],
        imports: importsOfFile(db_, s.path),
      };
    },
    callers(db_, { name, path, limit }) {
      log.push(['callers', { name, path, limit }]);
      return refsByName(db_, name).slice(0, limit).map((r, i) => ({ name, path: r.path, startLine: r.start_line, resolution: ['=', '~', '?'][i % 3], count: i === 0 ? 2 : 1 }));
    },
    callees(db_, { name, path, limit }) {
      log.push(['callees', { name, path, limit }]);
      return [{ name: 'parseConfig', path: SAMPLE, startLine: 16, resolution: '~' }].slice(0, limit);
    },
    impact(db_, { name, path, depth }) {
      log.push(['impact', { name, path, depth }]);
      const nodes = symbolsInFile(db_, SAMPLE).map((r, i) => ({ ...row(r), depth: (i % depth) + 1 }));
      return { nodes, files: [SAMPLE], truncated: depth < 3 };
    },
    outline(db_, { path }) {
      log.push(['outline', { path }]);
      return symbolsInFile(db_, path).map(row);
    },
  };
}

describe('TOOLS', () => {
  test('three tools with the frozen names, descriptions and parameter ranges', () => {
    assert.deepEqual(TOOLS.map((t) => t.name), ['codegraph_status', 'codegraph_lookup', 'codegraph_map']);
    for (const tool of TOOLS) {
      assert.equal(tool.description, CONTRACT_DESCRIPTIONS[tool.name], tool.name);
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(typeof tool.inputSchema.properties, 'object');
    }
    const lookup = TOOLS[1].inputSchema;
    assert.deepEqual(lookup.required, ['operation']);
    assert.deepEqual(lookup.properties.operation.enum, [...OPERATIONS]);
    assert.deepEqual([lookup.properties.depth.minimum, lookup.properties.depth.maximum], [DEPTH_RANGE.min, DEPTH_RANGE.max]);
    assert.deepEqual([lookup.properties.limit.minimum, lookup.properties.limit.maximum], [LIMIT_RANGE.min, LIMIT_RANGE.max]);
    for (const key of ['query', 'name', 'file']) assert.equal(lookup.properties[key].type, 'string', key);
    assert.equal(lookup.properties.body.type, 'boolean');
    const map = TOOLS[2].inputSchema;
    assert.deepEqual([map.properties.budget.minimum, map.properties.budget.maximum], [BUDGET_RANGE.min, BUDGET_RANGE.max]);
    assert.equal(map.properties.path.type, 'string');
    assert.equal(TOOLS[0].inputSchema.properties.refresh.type, 'boolean');
    const status = TOOLS[0].inputSchema;
    assert.deepEqual(Object.keys(status.properties), ['refresh', 'storage', 'clean', 'project', 'confirm']);
    assert.deepEqual(status.properties.clean.enum, ['stale', 'all', 'current', 'project']);
    for (const key of ['storage', 'confirm']) assert.equal(status.properties[key].type, 'boolean', key);
    assert.equal(status.properties.project.type, 'string');
  });

  test('tools/list over JSON-RPC returns them; instructions mention the three tools', async () => {
    const res = await rpc(serverFor(fakeCtx()), 'tools/list', {});
    assert.deepEqual(res.result.tools, TOOLS);
    assert.ok(INSTRUCTIONS.includes('codegraph_status') && INSTRUCTIONS.includes('codegraph_lookup') && INSTRUCTIONS.includes('codegraph_map'));
    assert.ok(INSTRUCTIONS.length <= 800, `${INSTRUCTIONS.length} chars`);
  });
});

describe('argument validation (TypeError -> in-band error)', () => {
  const cases = [
    ['codegraph_lookup', {}, '"operation" is required'],
    ['codegraph_lookup', { operation: 'grep' }, /"operation" must be one of search, symbol, callers, callees, impact, outline, cycles, affected \(got "grep"\)/],
    ['codegraph_lookup', { operation: 'search' }, /operation=search requires "query"/],
    ['codegraph_lookup', { operation: 'symbol' }, /operation=symbol requires "name"/],
    ['codegraph_lookup', { operation: 'outline' }, /operation=outline requires "file"/],
    ['codegraph_lookup', { operation: 'affected' }, /operation=affected requires "files"/],
    ['codegraph_lookup', { operation: 'affected', files: ' , ' }, /"files" must name at least one path \(got " , "\)/],
    ['codegraph_lookup', { operation: 'affected', files: Array.from({ length: FILES_MAX + 1 }, (_, i) => `f${i}.ts`).join(',') }, new RegExp(`"files" must name at most ${FILES_MAX} paths`)],
    ['codegraph_lookup', { operation: 'affected', files: 5 }, /"files" must be a non-empty string \(got 5\)/],
    ['codegraph_lookup', { operation: 'affected', files: 'a.ts', depth: 0 }, /"depth" must be an integer between 1 and 6 \(got 0\)/],
    ['codegraph_lookup', { operation: 'search', query: '  ' }, /"query" must be a non-empty string \(got "  "\)/],
    ['codegraph_lookup', { operation: 'search', query: 'x', depth: 0 }, /"depth" must be an integer between 1 and 6 \(got 0\)/],
    ['codegraph_lookup', { operation: 'impact', name: 'x', depth: 7 }, /"depth" must be an integer between 1 and 6 \(got 7\)/],
    ['codegraph_lookup', { operation: 'impact', name: 'x', depth: '2' }, /"depth" must be an integer between 1 and 6 \(got "2"\)/],
    ['codegraph_lookup', { operation: 'search', query: 'x', limit: 0 }, /"limit" must be an integer between 1 and 200 \(got 0\)/],
    ['codegraph_lookup', { operation: 'search', query: 'x', limit: 201 }, /"limit" must be an integer between 1 and 200 \(got 201\)/],
    ['codegraph_lookup', { operation: 'search', query: 'x', limit: 2.5 }, /"limit" must be an integer between 1 and 200 \(got 2.5\)/],
    ['codegraph_lookup', { operation: 'symbol', name: 'x', body: 'yes' }, /"body" must be a boolean \(got "yes"\)/],
    ['codegraph_map', { budget: 199 }, /"budget" must be an integer between 200 and 4000 \(got 199\)/],
    ['codegraph_map', { budget: 4001 }, /"budget" must be an integer between 200 and 4000 \(got 4001\)/],
    ['codegraph_status', { refresh: 'true' }, /"refresh" must be a boolean \(got "true"\)/],
  ];
  for (const [name, args, expected] of cases) {
    test(`${name} ${JSON.stringify(args)}`, async () => {
      const ctx = fakeCtx();
      const res = await rpc(serverFor(ctx), 'tools/call', { name, arguments: args });
      assert.equal(res.error, undefined, 'not a protocol error');
      assert.equal(res.result.isError, true);
      assert.match(res.result.content[0].text, /^codegraph error: /);
      if (expected instanceof RegExp) assert.match(res.result.content[0].text, expected);
      else assert.ok(res.result.content[0].text.includes(expected), res.result.content[0].text);
      assert.deepEqual(ctx.calls, [], 'invalid arguments never reach the indexer');
    });
  }

  test('non-object arguments and unknown tool names are TypeErrors', async () => {
    await assert.rejects(callTool('codegraph_status', [1]), /"arguments" must be an object \(got array\)/);
    await assert.rejects(callTool('codegraph_status', 'x'), /"arguments" must be an object/);
    await assert.rejects(callTool('nope', {}), /unknown tool "nope"/);
    const res = await call(fakeCtx(), 'codegraph_status', { refresh: true, bogus: 1, limit: 999 });
    assert.equal(res.isError, undefined, 'unknown parameters are ignored');
  });
});

describe('freshness flow', () => {
  test('every tool awaits ensureFresh() first, then reads status(); refresh=true is forwarded', async () => {
    const ctx = fakeCtx();
    await call(ctx, 'codegraph_status', {});
    await call(ctx, 'codegraph_lookup', { operation: 'search', query: 'parseConfig' });
    await call(ctx, 'codegraph_map', {});
    assert.deepEqual(ctx.calls, [
      ['ensureFresh', undefined], ['status'],
      ['ensureFresh', undefined], ['status'],
      ['ensureFresh', undefined], ['status'],
    ]);
    const refresh = fakeCtx();
    await call(refresh, 'codegraph_status', { refresh: true });
    assert.deepEqual(refresh.calls, [['ensureFresh', { maxWaitMs: 3000, force: true }], ['status']]);
  });

  test('a failing sync does not abort the query; it is reported in the freshness segment', async () => {
    const ctx = fakeCtx(READY(), {
      indexer: { ensureFresh: async () => { throw new Error('lock timeout'); }, status: () => READY() },
    });
    const out = text(await call(ctx, 'codegraph_status', {}));
    assert.equal(out.split('\n')[0], `# status · ready · 2 files · 5 symbols · ${FRESH} · sync failed: lock timeout`);
    const lookup = fakeCtx(READY(), {
      indexer: { ensureFresh: async () => { throw new Error('lock timeout'); }, status: () => READY() },
      queries: storeQueries(),
    });
    assert.ok(text(await call(lookup, 'codegraph_lookup', { operation: 'outline', file: SAMPLE })).includes(`· ${FRESH} · sync failed: lock timeout`));
  });

  test('indexing off: a call leaves the index alone and says so; only refresh=true syncs', async () => {
    const off = { ...DEFAULT_CONFIG, autoIndex: false };
    const lookup = fakeCtx(READY(), { config: off, queries: storeQueries() });
    const out = text(await call(lookup, 'codegraph_lookup', { operation: 'outline', file: SAMPLE }));
    assert.deepEqual(lookup.calls, [['status']], 'ensureFresh is not called');
    assert.ok(out.includes(`· ${FRESH} · not synced: auto-indexing is off, refresh=true syncs`), out.split('\n')[0]);
    for (const name of ['codegraph_status', 'codegraph_map']) {
      assert.deepEqual(fakeCtx(READY(), { config: off }).calls, [], 'nothing until the tool is called');
      const ctx = fakeCtx(READY(), { config: off });
      await call(ctx, name, {});
      assert.deepEqual(ctx.calls, [['status']], `${name} does not sync either`);
    }
    const refreshed = fakeCtx(READY(), { config: off, queries: storeQueries() });
    const status = text(await call(refreshed, 'codegraph_status', { refresh: true }));
    assert.deepEqual(refreshed.calls, [['ensureFresh', { maxWaitMs: 3000, force: true }], ['status']]);
    assert.equal(status.includes('not synced'), false, 'a refresh did sync');
    assert.ok(status.includes('note: auto-indexing is off (codegraph.json); the index is only refreshed by codegraph_status (refresh=true)'));
    // Indexing on again: every call syncs, and nothing mentions switching it off.
    const on = fakeCtx(READY(), { queries: storeQueries() });
    assert.equal(text(await call(on, 'codegraph_lookup', { operation: 'outline', file: SAMPLE })).includes('auto-indexing is off'), false);
  });
});

describe('codegraph_status', () => {
  test('switched off by the project: the hint names the project file, not the user\'s configuration', async () => {
    const config = { ...DEFAULT_CONFIG, autoIndex: false, autoIndexOffBy: 'project' };
    const ctx = fakeCtx({ state: 'empty', filesTotal: 0, filesDone: 0, symbols: 0, reason: 'auto-index-disabled', reasonDetail: 'autoIndex is false in .zcode/codegraph.json of the project' }, { config });
    const out = text(await call(ctx, 'codegraph_status', {}));
    assert.match(out, /reason: autoIndex is false in \.zcode\/codegraph\.json of the project \[auto-index-disabled\]/);
    assert.match(out, /hint: auto-indexing is off in \.zcode\/codegraph\.json of this project; delete "autoIndex": false there to index it\./);
    assert.doesNotMatch(out, /Set autoIndex true/);
    const kept = text(await call(fakeCtx(READY(), { config }), 'codegraph_status', {}));
    assert.ok(kept.includes('note: auto-indexing is off for this project (.zcode/codegraph.json); the index is only refreshed by codegraph_status (refresh=true)'));
  });

  // The store as a fake: three indexes, one of them the project of the session. The real module
  // is covered in tests/index/storage.test.mjs; here it is about what the tool makes of it.
  function fakeStore() {
    const now = Date.now();
    const entries = [
      { key: '1111111111111111', dir: path.join('store', '1111111111111111'), root: 'D:/gone/old', state: 'ready', files: 40, symbols: 90, bytes: 220 * 1024 * 1024, lastUsedAt: now - 200 * 86400000, inUse: false, orphan: true },
      { key: '2222222222222222', dir: path.join('store', '2222222222222222'), root: 'D:/codes/other', state: 'ready', files: 9, symbols: 30, bytes: 300 * 1024, lastUsedAt: now - 2 * 3600000, inUse: true, orphan: false },
      { key: projectKey(root), dir: path.join('store', 'current'), root: root.split(path.sep).join('/'), state: 'ready', files: 2, symbols: 5, bytes: 8 * 1024 * 1024, lastUsedAt: now - 125_000, inUse: false, orphan: false },
    ];
    const log = [];
    const storage = {
      indexesDir: () => path.join('store-data', 'indexes'),
      listIndexes: () => entries,
      planSweep: (list, options) => planSweep(list, options),
      removeListed: (entry) => { log.push(['removeListed', entry.key]); return true; },
      removeIndex: (dir) => { log.push(['removeIndex', path.basename(dir)]); return true; },
    };
    return { storage, log };
  }

  test('storage=true lists every index with size and last use, and the policy in force', async () => {
    const { storage } = fakeStore();
    const out = text(await call(fakeCtx(READY(), { storage, config: { ...DEFAULT_CONFIG, maxTotalMB: 2048 } }), 'codegraph_status', { storage: true }));
    const lines = out.split('\n');
    assert.equal(lines[0], `# status · ready · 2 files · 5 symbols · ${FRESH}`);
    assert.deepEqual(lines.slice(1), [
      'languages: typescript 2',
      `indexes: 3 projects · 228 MB in all`,
      'under store-data/indexes',
      ` D:/gone/old · project folder missing · 220 MB · used 200d ago`,
      ` D:/codes/other · 9 files · 300 KB · used 2h ago · in use`,
      ` ${root.split(path.sep).join('/')} · 2 files · 8.0 MB · used 2m ago`,
      'policy: indexes unused for more than 90 days are removed when a session opens; the least recently used go above 2048 MB in total; an index whose project folder is gone goes by the same age rule',
    ]);
    const plain = text(await call(fakeCtx(READY(), { storage }), 'codegraph_status', {}));
    assert.equal(plain.includes('indexes:'), false, 'the store is listed only on request');
  });

  test('clean without confirm=true removes nothing and lists what would go', async () => {
    const { storage, log } = fakeStore();
    const out = text(await call(fakeCtx(READY(), { storage }), 'codegraph_status', { clean: 'stale' }));
    assert.deepEqual(log, [], 'nothing was removed');
    assert.equal(out.split('\n')[0], '# status clean=stale · 1 of 3 indexes would be removed · 220 MB');
    assert.match(out, / D:\/gone\/old · project folder missing · 220 MB · used 200d ago · orphan/);
    assert.match(out, /hint: nothing was removed\. Call again with confirm=true, and only when the user asked for it\./);
  });

  test('clean=stale with confirm=true removes what the policy allows and reports it', async () => {
    const { storage, log } = fakeStore();
    const out = text(await call(fakeCtx(READY(), { storage }), 'codegraph_status', { clean: 'stale', confirm: true }));
    assert.deepEqual(log, [['removeListed', '1111111111111111']]);
    assert.equal(out.split('\n')[0], '# status clean=stale · removed 1 of 3 indexes · 220 MB freed');
    assert.match(out, / D:\/gone\/old .* · orphan/);
    assert.match(out, /hint: an index that was removed is rebuilt the next time a session opens its project/);
  });

  test('clean=all keeps the project of the session and any index in use', async () => {
    const { storage, log } = fakeStore();
    const out = text(await call(fakeCtx(READY(), { storage }), 'codegraph_status', { clean: 'all', confirm: true }));
    assert.deepEqual(log, [['removeListed', '1111111111111111']], 'the index in use is not touched');
    assert.equal(out.split('\n')[0], '# status clean=all · removed 1 of 3 indexes · 220 MB freed');
    assert.match(out, / D:\/codes\/other · 9 files · 300 KB · used 2h ago · in use · kept: in use/);
  });

  test('clean=project removes the named one, by path or key, but never the project of this session', async () => {
    const { storage, log } = fakeStore();
    const ctx = fakeCtx(READY(), { storage });
    const out = text(await call(ctx, 'codegraph_status', { clean: 'project', project: 'D:\\codes\\other\\', confirm: true }));
    assert.deepEqual(log, [['removeListed', '2222222222222222']]);
    assert.equal(out.split('\n')[0], '# status clean=project · removed 1 of 3 indexes · 300 KB freed');
    assert.match(text(await call(ctx, 'codegraph_status', { clean: 'project', project: root.split(path.sep).join('/'), confirm: true })), /is the project of this session: use clean="current"/);
    assert.match(text(await call(ctx, 'codegraph_status', { clean: 'project', project: 'D:/nowhere', confirm: true })), /no index of "D:\/nowhere" in this store; codegraph_status \(storage=true\) lists them/);
  });

  // The rebuild of the process context after clean=current is covered end to end in
  // tests/e2e/warm-start.test.mjs; an injected context is never reset.
  test('clean=current closes this session\'s index before the files go', async () => {
    const { storage, log } = fakeStore();
    const closed = [];
    const ctx = fakeCtx(READY(), { storage });
    ctx.indexer = {
      ensureFresh: async (opts) => ctx.calls.push(['ensureFresh', opts]),
      status: () => { ctx.calls.push(['status']); return READY(); },
      close: async () => { closed.push('closed'); },
    };
    const out = text(await call(ctx, 'codegraph_status', { clean: 'current', confirm: true }));
    assert.deepEqual(closed, ['closed'], 'the handle is closed before the files go');
    assert.deepEqual(log, [['removeListed', projectKey(root)]]);
    assert.equal(out.split('\n')[0], '# status clean=current · removed 1 of 3 indexes · 8.0 MB freed');
    // A clean request neither syncs nor refreshes: it asks the indexer once whether this
    // session is building, then acts on the store.
    assert.deepEqual(ctx.calls, [['status']]);
    // A value outside the enum is an argument error (in-band for the model, a TypeError here).
    await assert.rejects(callTool('codegraph_status', { clean: 'everything' }, fakeCtx(READY(), { storage })), /"clean" must be one of stale, all, current, project/);
  });

  test('clean=current refuses while this session is building: closing would wait for the whole build', async () => {
    const { storage, log } = fakeStore();
    const ctx = fakeCtx({ ...READY(), building: true, filesTotal: 700, filesDone: 300 }, { storage });
    const out = text(await call(ctx, 'codegraph_status', { clean: 'current', confirm: true }));
    assert.equal(out, '# status clean=current\nthe index of this project is being built in this session (300 of 700 files); call again once codegraph_status says ready');
    assert.deepEqual(log, [], 'nothing was removed');
    assert.deepEqual(ctx.calls, [['status']], 'the indexer was asked, not closed');
    // A build another process left behind on disk is not a build of this session: it may go.
    const stale = fakeCtx({ ...READY(), state: 'building', filesTotal: 700, filesDone: 300, building: false }, { storage });
    stale.indexer.close = async () => {};
    assert.match(text(await call(stale, 'codegraph_status', { clean: 'current', confirm: true })), /removed 1 of 3 indexes/);
  });
  test('ready, empty and building render as text (no isError)', async () => {
    const ready = await call(fakeCtx(), 'codegraph_status', {});
    assert.equal(ready.isError, undefined);
    assert.deepEqual(ready.content, [{ type: 'text', text: `# status · ready · 2 files · 5 symbols · ${FRESH}\nlanguages: typescript 2` }]);
    const empty = text(await call(fakeCtx({ state: 'empty', filesTotal: 0, filesDone: 0, symbols: 0, reason: 'below-min-files', reasonDetail: '4 supported file(s)' }), 'codegraph_status', {}));
    assert.equal(empty.split('\n')[0], '# status · empty · 0 files · 0 symbols · not indexed');
    assert.equal(empty.split('\n')[1], 'reason: 4 supported file(s) [below-min-files]');
    const building = text(await call(fakeCtx({ state: 'building', filesTotal: 2, filesDone: 1, symbols: 3 }), 'codegraph_status', { refresh: true }));
    assert.equal(building.split('\n')[0], '# status refresh=true · building · 1 of 2 files · 3 symbols · indexing 50% (results partial)');
  });

  test('a status() that throws yields the unavailable text instead of an error', async () => {
    const ctx = fakeCtx(READY(), { indexer: { ensureFresh: async () => {}, status: () => { throw new Error('status.json unreadable'); } } });
    const out = text(await call(ctx, 'codegraph_status', {}));
    assert.equal(out.split('\n')[0], '# status · unavailable');
    assert.ok(out.includes('status.json unreadable'));
  });
});

describe('codegraph_lookup', () => {
  test('not indexed: readable text, the query layer is never called', async () => {
    const log = [];
    const ctx = fakeCtx({ state: 'empty', filesTotal: 0, symbols: 0 }, { queries: storeQueries(log) });
    const out = await call(ctx, 'codegraph_lookup', { operation: 'search', query: 'parseConfig' });
    assert.equal(out.isError, undefined);
    assert.equal(text(out), '# search parseConfig · not indexed\nhint: project is not indexed; use Read/Grep for now. codegraph_status explains why.');
    assert.deepEqual(log, []);
    const map = text(await call(fakeCtx({ state: 'empty' }, { map: { repoMap: () => { throw new Error('must not run'); } } }), 'codegraph_map', {}));
    assert.equal(map.split('\n')[0], '# map · not indexed');
  });

  test('query errors become readable text with the message, never isError', async () => {
    const ctx = fakeCtx(READY(), { queries: { ...graphQueries, search: () => { throw new Error('database disk image is malformed'); } } });
    const out = await call(ctx, 'codegraph_lookup', { operation: 'search', query: 'x' });
    assert.equal(out.isError, undefined);
    assert.equal(
      text(out),
      `# search x · query failed · ${FRESH}\nhint: the index could not be queried (database disk image is malformed); codegraph_status reports the index state.`,
    );
    const mapCtx = fakeCtx(READY(), { map: { repoMap: () => { throw new Error('boom'); } } });
    assert.equal(text(await call(mapCtx, 'codegraph_map', {})), `# map · query failed · ${FRESH}\nhint: the index could not be queried (boom); codegraph_status reports the index state.`);
  });

  test('default path: the real graph modules are used when the context overrides nothing', async (t) => {
    assert.equal(resolveGraph({}).queries, graphQueries);
    assert.equal(resolveGraph({}).map, graphMap);
    const fake = storeQueries();
    assert.equal(resolveGraph({ queries: fake }).queries, fake);
    assert.equal(resolveGraph({ map: fake }).map, fake);
    // Whatever the real module returns today, the tool must render exactly that
    // in the row format: the expectation is derived from the module's own rows,
    // kept in the module's (relevance) order.
    const rows = graphQueries.search(db, { query: 'parseConfig', kind: null, limit: 21 });
    const out = text(await call(fakeCtx(), 'codegraph_lookup', { operation: 'search', query: 'parseConfig' }));
    const expected = [
      rows.length === 0 ? `# search parseConfig · no matches · ${FRESH}` : `# search parseConfig · ${rows.length} ${rows.length === 1 ? 'match' : 'matches'} · ${FRESH}`,
      ...rows.map((r) => `${r.kind.padStart(9)} ${r.name}${r.signature ? ` ${r.signature}` : ''} ${r.path}:${r.startLine}-${r.endLine}`),
      ...(rows.length === 0 ? [] : [SEARCH_NEXT_HINT]),
    ];
    if (rows.every((r) => Number.isInteger(r.startLine) && Number.isInteger(r.endLine))) {
      assert.equal(out, expected.join('\n'));
    } else {
      // Lane B's rows must carry line numbers (CONTRACTS.md §8); until they do,
      // only the header is asserted and the gap is reported.
      t.diagnostic(`graph queries return rows without startLine/endLine: ${JSON.stringify(rows[0])}`);
      assert.equal(out.split('\n')[0], expected[0]);
      assert.ok(out.includes('parseConfig'));
    }
    const outline = text(await call(fakeCtx(), 'codegraph_lookup', { operation: 'outline', file: SAMPLE }));
    assert.equal(outline.split('\n')[0], `# outline ${SAMPLE} · ${graphQueries.outline(db, { path: SAMPLE }).length} symbols · ${FRESH}`);
    assert.ok(outline.includes('function parseConfig'), 'real outline rows are rendered');
    const symbol = text(await call(fakeCtx(), 'codegraph_lookup', { operation: 'symbol', name: 'parseConfig', body: true }));
    assert.ok(symbol.startsWith(`# symbol parseConfig · ${SAMPLE}:`));
    const sym = graphQueries.symbol(db, { name: 'parseConfig' });
    if (Number.isInteger(sym?.symbol?.startLine) && Number.isInteger(sym?.symbol?.endLine)) {
      assert.ok(symbol.includes('```'), 'real symbol result inlines the body');
    } else {
      t.diagnostic(`graph symbol() returns no line range: ${JSON.stringify(sym?.symbol)}`);
      assert.ok(symbol.includes('body: symbol has no line range in the index'));
    }
  });

  test('wiring with an injected query layer: search rows, limit probing, kind alignment', async () => {
    const log = [];
    const ctx = fakeCtx(READY(), { queries: storeQueries(log) });
    const out = text(await call(ctx, 'codegraph_lookup', { operation: 'search', query: 'parse' }));
    // One ask for the decision (does a symbol carry the name?), then one search for limit + 1 rows
    // to detect truncation. A name no symbol carries does not make a second search: the property
    // reads are looked for between the two.
    assert.deepEqual(log, [['searchIsPartial', { query: 'parse', kind: null, limit: 21 }], ['search', { query: 'parse', kind: null, limit: 21 }]]);
    log.length = 0;
    text(await call(ctx, 'codegraph_lookup', { operation: 'search', query: 'validate' }));
    assert.deepEqual(log.map(([name]) => name), ['searchIsPartial', 'search'], 'one search, with both sources');
    assert.equal(
      out,
      [`# search parse · 1 match · ${FRESH}`, ' function parseConfig (src: string, opts?: Options): Config src/graph/sample.ts:8-11', SEARCH_NEXT_HINT].join('\n'),
    );
    assert.equal(out.includes('legend'), false, 'a "?" inside a signature is not a marker');
    const load = text(await call(fakeCtx(READY(), { queries: storeQueries() }), 'codegraph_lookup', { operation: 'search', query: 'load' }));
    assert.equal(
      load,
      [
        `# search load · 3 matches · ${FRESH}`,
        '    class Loader src/graph/sample.ts:13-18',
        '   method load (file: string): Config src/graph/sample.ts:15-17',
        ' function loadAll (dir: string): Config[] src/graph/sample.ts:20-22',
        SEARCH_NEXT_HINT,
      ].join('\n'),
    );
    const limited = text(await call(fakeCtx(READY(), { queries: storeQueries() }), 'codegraph_lookup', { operation: 'search', query: 'load', limit: 2 }));
    assert.equal(limited.split('\n').at(-1), '(2 of 3+ shown)');
    assert.equal(limited.split('\n').at(-2), 'hint: raise budget (max 4000) or limit (max 200) to see more rows');
  });

  test('search for a name that is only used (real modules): the tool prints the places that use it', async () => {
    // parseConfig calls validate(text, opts); nothing in the fixture defines validate.
    const out = text(await call(fakeCtx(), 'codegraph_lookup', { operation: 'search', query: 'validate' }));
    assert.equal(
      out,
      [
        `# search validate · no symbol carries this name; 1 use in 1 file (validate) · ${FRESH}`,
        '     call validate ×1 in parseConfig src/graph/sample.ts:10',
        'hint: no symbol carries this name; the rows are places that use it: calls and type names from the index. ' +
          'JS/TS property reads (obj.field) and object keys ({ field }) were looked for in the source: there were none. ' +
          'Variables and parameters and words in strings are not in the graph: grep for those.',
      ].join('\n'),
    );
    const limited = text(await call(fakeCtx(), 'codegraph_lookup', { operation: 'search', query: 'validate', limit: 1 }));
    assert.ok(limited.startsWith(`# search validate · no symbol carries this name; 1 use in 1 file (validate) · ${FRESH}`));
    // The model decides whether to call search from the schema: a name nothing defines must be
    // listed as something search answers, with everything the scan finds (CONTRACTS.md §10).
    const { operation, query } = TOOLS[1].inputSchema.properties;
    assert.ok(operation.description.startsWith('search: symbols by name, or the places that use a name no symbol carries;'));
    assert.ok(query.description.includes('When no symbol carries the name, search lists where it is used: calls and type names from the index, and for JS/TS the '));
    assert.ok(query.description.includes('property reads (obj.field), the object keys ({ field }, also when destructuring), the attribute names of JSX elements and the members of types of that name, found by scanning the source.'));
    assert.ok(query.description.includes('Variables and parameters and words in strings are not in the graph.'));
  });

  test('a name that is only read as a property or used as a key: the tool, the real search and the source scan together', async () => {
    // The tool builds the scan with the session's root and the project's database; the real
    // search asks it when the index has nothing; the rows come back as property reads and keys.
    const { warmPropertyReads } = await import('../../src/graph/propertyReads.mjs');
    await warmPropertyReads();
    const scanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-tools-scan-'));
    const scanDb = openDatabase(':memory:');
    try {
      const specs = await loadSpecs();
      const index = async (rel, source) => {
        const abs = path.join(scanRoot, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, source);
        const extracted = await extractFile({ path: rel, source, spec: specForPath(rel, specs) });
        assert.equal(extracted.parseOk, true, rel);
        replaceFile(scanDb, { path: rel, lang: extracted.lang, hash: extracted.hash, mtimeMs: indexedAt, size: extracted.size, parseOk: extracted.parseOk, errorNodes: extracted.errorNodes, indexedAt }, extracted);
      };
      await index('src/graph/sheet.tsx', ['export function Cell({ row }: Props) {', '  return row.zzqPlugh + this.fallback.zzqPlugh;', '}', ''].join('\n'));
      await index('src/graph/sweep.ts', [
        'export function sweep(policy: Policy) {',
        '  const written = { zzqPlugh: 1 };',
        '  const { zzqPlugh } = policy;',
        '  return written;',
        '}',
        'interface Policy {',
        '  zzqPlugh: number;',
        '}',
        '',
      ].join('\n'));
      const ctx = fakeCtx(READY(), { root: scanRoot, db: scanDb, queries: graphQueries });
      const out = text(await call(ctx, 'codegraph_lookup', { operation: 'search', query: 'zzqPlugh' }));
      assert.deepEqual(out.split('\n'), [
        `# search zzqPlugh · no symbol carries this name; 5 uses in 2 files (zzqPlugh) · ${FRESH}`,
        ' property row.zzqPlugh ×1 in Cell src/graph/sheet.tsx:2',
        ' property this.fallback.zzqPlugh ×1 in Cell src/graph/sheet.tsx:2',
        '      key zzqPlugh ×2 in sweep src/graph/sweep.ts:2',
        '    field zzqPlugh ×1 in Policy src/graph/sweep.ts:7',
        'hint: no symbol carries this name; the rows are property reads (obj.name), object keys ({ name }) and members of types, found by scanning the JavaScript and TypeScript ' +
          'source just now; the index had no call or type of that name. ' +
          'Variables and parameters and words in strings are not in the graph: grep for those.',
      ]);
    } finally {
      close(scanDb);
      fs.rmSync(scanRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    }
  });

  test('symbol: header, relations with markers and legend, inline body from disk, Read line for long bodies', async () => {
    const log = [];
    const ctx = fakeCtx(READY(), { queries: storeQueries(log) });
    const out = text(await call(ctx, 'codegraph_lookup', { operation: 'symbol', name: 'parseConfig', body: true }));
    assert.deepEqual(log, [['symbol', { name: 'parseConfig', path: undefined, qual: undefined }]]);
    const expected = [
      `# symbol parseConfig · ${SAMPLE}:8-11 (4 lines) · callers 1/1 resolved · ${FRESH}`,
      'sig: (src: string, opts?: Options): Config',
      'doc: Parses a config string.',
      'calls(1): parseConfig~',
      `called by(1): parseConfig ${SAMPLE}:16= ×2`,
      'imports: node:fs, ./options',
      'legend: = import-resolved · ~ unique-name · ? unresolved/dynamic',
      'body (4 lines):',
      '```',
      'export function parseConfig(src: string, opts?: Options): Config {',
      "  const text = readFile(src, 'utf8');",
      '  return validate(text, opts);',
      '}',
      '```',
    ];
    // The body is the exact source range of the symbol (fixture lines 8-11).
    assert.equal(out, expected.join('\n'));

    const long = text(await call(fakeCtx(READY(), { queries: storeQueries() }), 'codegraph_lookup', { operation: 'symbol', name: 'longBody', body: true }));
    assert.ok(long.includes(`# symbol longBody · ${LONG}:1-40 (40 lines)`));
    assert.equal(long.split('\n').at(-1), `body: 40 lines → Read ${LONG} offset 1 limit 40`);
    assert.equal(long.includes('```'), false);

    const noBody = text(await call(fakeCtx(READY(), { queries: storeQueries() }), 'codegraph_lookup', { operation: 'symbol', name: 'longBody' }));
    assert.equal(noBody.includes('body'), false);
  });

  test('symbol body: missing file and symbol without result', async () => {
    const missing = fakeCtx(READY(), {
      queries: { ...storeQueries(), symbol: () => ({ symbol: { name: 'x', path: 'src/gone.ts', startLine: 1, endLine: 2 }, callers: [], callees: [], imports: [] }) },
    });
    const out = text(await call(missing, 'codegraph_lookup', { operation: 'symbol', name: 'x', body: true }));
    assert.equal(out.split('\n').at(-1), 'body: cannot read src/gone.ts (ENOENT); the index may be stale');
    const none = text(await call(fakeCtx(READY(), { queries: storeQueries() }), 'codegraph_lookup', { operation: 'symbol', name: 'nope' }));
    assert.equal(none.split('\n')[0], `# symbol nope · not found · ${FRESH}`);
    assert.match(none.split('\n')[1], /^hint: no unique symbol/);
  });

  test('callers / callees / impact / outline through the injected layer', async () => {
    const log = [];
    const ctx = fakeCtx(READY(), { queries: storeQueries(log) });
    const callers = text(await call(ctx, 'codegraph_lookup', { operation: 'callers', name: 'parseConfig' }));
    assert.deepEqual(log.at(-1), ['callers', { name: 'parseConfig', path: undefined, limit: 21 }]);
    assert.equal(callers, [`# callers parseConfig · 1 call site (1/1 resolved) · ${FRESH}`, `     call parseConfig ${SAMPLE}:16= ×2`].join('\n'));
    assert.equal(callers.includes('legend'), false, 'only "=" markers: no legend');
    const callees = text(await call(ctx, 'codegraph_lookup', { operation: 'callees', name: 'load', file: SAMPLE }));
    assert.deepEqual(log.at(-1), ['callees', { name: 'load', path: SAMPLE, limit: 21 }]);
    assert.equal(callees.split('\n')[0], `# callees load ${SAMPLE} · 1 callee (1/1 resolved) · ${FRESH}`);
    assert.equal(callees.split('\n')[1], `     call parseConfig ${SAMPLE}:16~`);
    const impact = text(await call(ctx, 'codegraph_lookup', { operation: 'impact', name: 'parseConfig', depth: 1 }));
    assert.deepEqual(log.at(-1), ['impact', { name: 'parseConfig', path: undefined, depth: 1 }]);
    assert.equal(impact.split('\n')[0], `# impact parseConfig depth=1 · 4 nodes in 1 file · ${FRESH}`);
    assert.equal(impact.split('\n').at(-2), `files(1): ${SAMPLE}`);
    assert.equal(impact.split('\n').at(-1), 'hint: impact was cut; raise depth (max 6) or limit (max 200) to see more.');
    const impact2 = text(await call(fakeCtx(READY(), { queries: storeQueries() }), 'codegraph_lookup', { operation: 'impact', name: 'parseConfig', depth: 2, limit: 2 }));
    assert.equal(impact2.split('\n').at(-1), '(2 of 3+ shown)');
    const outline = text(await call(ctx, 'codegraph_lookup', { operation: 'outline', file: SAMPLE }));
    assert.deepEqual(log.at(-1), ['outline', { path: SAMPLE }]);
    assert.equal(
      outline,
      [
        `# outline ${SAMPLE} · 4 symbols · ${FRESH}`,
        ' function parseConfig (src: string, opts?: Options): Config src/graph/sample.ts:8-11',
        '    class Loader src/graph/sample.ts:13-18',
        '   method load (file: string): Config src/graph/sample.ts:15-17',
        ' function loadAll (dir: string): Config[] src/graph/sample.ts:20-22',
      ].join('\n'),
    );
  });

  test('cycles and affected: argument mapping, defaults and rendering', async () => {
    const log = [];
    const queries = {
      ...storeQueries(log),
      importCycles: (_db, options) => {
        log.push(['importCycles', options]);
        return { cycles: [{ paths: ['src/a.ts', 'src/b.ts', 'src/a.ts'], walked: true }], total: 1, truncated: false };
      },
      affectedTests: (_db, options) => {
        log.push(['affectedTests', options]);
        return { tests: ['tests/a.test.ts'], otherFiles: 1, scanned: 3, truncated: false, unknown: [] };
      },
    };
    const ctx = fakeCtx(READY(), { queries });
    assert.equal(text(await call(ctx, 'codegraph_lookup', { operation: 'cycles', limit: 5 })), [
      `# cycles · 1 import cycle in 2 files · ${FRESH}`,
      'cycle 1 (2 files): src/a.ts → src/b.ts → src/a.ts',
      'hint: cycles follow resolved imports only; dynamic imports and unresolved specifiers are not in the graph.',
    ].join('\n'));
    assert.deepEqual(log.at(-1), ['importCycles', { limit: 5 }]);
    // The path list is normalised; the query asks for one more row than the caller wants.
    const affected = text(await call(ctx, 'codegraph_lookup', { operation: 'affected', files: './src/a.ts, src\\b.ts', depth: 2, limit: 10 }));
    assert.deepEqual(log.at(-1), ['affectedTests', { files: ['src/a.ts', 'src/b.ts'], depth: 2, limit: 11 }]);
    assert.equal(affected.split('\n')[0], `# affected src/a.ts, src/b.ts · 1 test file reaches them (3 files scanned) · ${FRESH}`);
    // A path named twice (here in two spellings of the same file) is asked about once.
    const twice = text(await call(ctx, 'codegraph_lookup', { operation: 'affected', files: 'src/a.ts, ./src/a.ts' }));
    assert.deepEqual(log.at(-1), ['affectedTests', { files: ['src/a.ts'], depth: 3, limit: 21 }]);
    assert.ok(twice.startsWith('# affected src/a.ts · '), twice.split('\n')[0]);
    await call(ctx, 'codegraph_lookup', { operation: 'affected', files: 'src/a.ts' });
    assert.deepEqual(log.at(-1), ['affectedTests', { files: ['src/a.ts'], depth: 3, limit: 21 }], 'depth defaults to 3');
    // Too many paths is an argument error (see the validation table), not a slower call.
    const many = Array.from({ length: FILES_MAX }, (_, i) => `src/f${i}.ts`);
    await call(ctx, 'codegraph_lookup', { operation: 'affected', files: many.join(',') });
    assert.deepEqual(log.at(-1), ['affectedTests', { files: many, depth: 3, limit: 21 }], 'the cap itself is accepted');
    // The real module is what an unmodified context gets: both operations exist and answer.
    const real = fakeCtx();
    assert.match(text(await call(real, 'codegraph_lookup', { operation: 'cycles' })), new RegExp(`^# cycles · no import cycles · ${FRESH}`));
    const realAffected = text(await call(real, 'codegraph_lookup', { operation: 'affected', files: 'src/nowhere.ts' }));
    assert.ok(realAffected.startsWith(`# affected src/nowhere.ts · no test files reach them (0 files scanned)`), realAffected.split('\n')[0]);
    assert.ok(realAffected.includes('not in the index: src/nowhere.ts'), realAffected);
  });

  test('paths are normalised to the index form (native separators, absolute inside root, leading "./")', async () => {
    const log = [];
    const ctx = fakeCtx(READY(), { queries: storeQueries(log) });
    const native = process.platform === 'win32' ? SAMPLE.split('/').join('\\') : SAMPLE;
    await call(ctx, 'codegraph_lookup', { operation: 'outline', file: `./${native}` });
    assert.deepEqual(log.at(-1), ['outline', { path: SAMPLE }]);
    await call(ctx, 'codegraph_lookup', { operation: 'outline', file: path.join(root, SAMPLE) });
    assert.deepEqual(log.at(-1), ['outline', { path: SAMPLE }]);
    const mapLog = [];
    await call(fakeCtx(READY(), { map: { repoMap: (_db, opts) => { mapLog.push(opts); return { text: 'x', shown: 1, total: 1, truncated: false }; } } }), 'codegraph_map', { path: path.join(root, 'src') });
    assert.deepEqual(mapLog, [{ path: 'src', budgetTokens: DEFAULT_CONFIG.defaultBudgetTokens.map }]);
  });

  test('budget: explicit value wins, config default applies, out-of-range config values are clamped', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ kind: 'function', name: `symbol${i}`, path: `src/f${i}.ts`, startLine: i + 1, endLine: i + 2 }));
    const queries = { ...graphQueries, search: (_db, { limit }) => many.slice(0, limit) };
    // limit 200 lifts the row limit so the budget is the only cut.
    const out = text(await call(fakeCtx(READY(), { queries }), 'codegraph_lookup', { operation: 'search', query: 'x', limit: 200, budget: 300 }));
    assert.ok(estimateTokens(out) <= 300, `${estimateTokens(out)} tokens`);
    assert.match(out.split('\n').at(-1), /^\(\d+ of 60 shown\)$/);
    const fromConfig = fakeCtx(READY(), { queries, config: { defaultBudgetTokens: { lookup: 250, map: 1200 } } });
    const cfgOut = text(await call(fromConfig, 'codegraph_lookup', { operation: 'search', query: 'x', limit: 200 }));
    assert.ok(estimateTokens(cfgOut) <= 250);
    const clamped = fakeCtx(READY(), { queries, config: { defaultBudgetTokens: { lookup: 5, map: 1200 } } });
    const clampOut = text(await call(clamped, 'codegraph_lookup', { operation: 'search', query: 'x', limit: 200 }));
    assert.ok(estimateTokens(clampOut) <= 200, `clamped to the 200 minimum: ${estimateTokens(clampOut)}`);
    for (const budget of [200, 2000, 4000]) {
      const big = text(await call(fakeCtx(READY(), { queries }), 'codegraph_lookup', { operation: 'search', query: 'x', limit: 200, budget }));
      assert.ok(estimateTokens(big) <= budget);
      assert.ok(Buffer.byteLength(big) <= MAX_OUTPUT_BYTES);
    }
  });
});

// Per-file staleness (CONTRACTS.md §11): the header says how many files changed, the line after
// it names the ones this result rests on, so the model can Read them.
describe('per-file staleness line', () => {
  const STALE_STATUS = () => ({ ...READY(), dirty: 1, stale: 1 });
  const HEAD = 'stale: 1 files changed since index';
  const banner = (path, more = 0) => `stale: ${path}${more > 0 ? ` (+${more} more)` : ''} changed since index — Read them for the current content`;
  afterEach(() => {
    takeDirty(db, 10_000);
  });

  test('a result that names a dirty file gets one line after the header; the header keeps its count', async () => {
    markDirty(db, [SAMPLE]);
    const expected = {
      search: `# search parse · 1 match · ${FRESH} · ${HEAD}`,
      symbol: `# symbol parseConfig · ${SAMPLE}:8-11 (4 lines) · callers 1/1 resolved · ${FRESH} · ${HEAD}`,
      impact: `# impact parseConfig depth=1 · 4 nodes in 1 file · ${FRESH} · ${HEAD}`,
      outline: `# outline ${SAMPLE} · 4 symbols · ${FRESH} · ${HEAD}`,
    };
    const args = {
      search: { query: 'parse' },
      symbol: { name: 'parseConfig' },
      impact: { name: 'parseConfig', depth: 1 },
      outline: { file: SAMPLE },
    };
    for (const [operation, head] of Object.entries(expected)) {
      const lines = text(await call(fakeCtx(STALE_STATUS(), { queries: storeQueries() }), 'codegraph_lookup', { operation, ...args[operation] })).split('\n');
      assert.equal(lines[0], head, operation);
      assert.equal(lines[1], banner(SAMPLE), operation);
    }
  });

  test('nothing in common: no line, and the header still counts the dirty files', async () => {
    markDirty(db, ['src/elsewhere.ts']);
    const lines = text(await call(fakeCtx(STALE_STATUS(), { queries: storeQueries() }), 'codegraph_lookup', { operation: 'outline', file: SAMPLE })).split('\n');
    assert.equal(lines[0], `# outline ${SAMPLE} · 4 symbols · ${FRESH} · ${HEAD}`);
    assert.equal(lines.some((line) => line.startsWith('stale: ')), false);
  });

  test('more than three paths: three are named and the rest are a count', async () => {
    const paths = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.gen.ts'];
    const nodes = paths.map((path, i) => ({ kind: 'function', name: `n${i}`, path, startLine: 1, endLine: 2, depth: 1 }));
    markDirty(db, paths);
    const queries = { ...storeQueries(), impact: () => ({ nodes, files: [], truncated: false }) };
    const out = text(await call(fakeCtx(STALE_STATUS(), { queries }), 'codegraph_lookup', { operation: 'impact', name: 'x' }));
    // The generated file sorts last, so the first three rows (source) are the ones named.
    assert.equal(out.split('\n')[1], 'stale: a.ts, b.ts, c.ts (+2 more) changed since index — Read them for the current content');
  });

  test('a path longer than 100 characters is cut in the line', async () => {
    const long = `src/${'x'.repeat(150)}.ts`;
    const nodes = [{ kind: 'function', name: 'n', path: long, startLine: 1, endLine: 2, depth: 1 }];
    markDirty(db, [long]);
    const queries = { ...storeQueries(), impact: () => ({ nodes, files: [], truncated: false }) };
    const out = text(await call(fakeCtx(STALE_STATUS(), { queries }), 'codegraph_lookup', { operation: 'impact', name: 'x' }));
    assert.equal(out.split('\n')[1], `stale: ${long.slice(0, 99)}… changed since index — Read them for the current content`);
  });

  test('with files dirty, only the paths this result names are looked up', async () => {
    markDirty(db, ['src/elsewhere.ts']);
    // A database that refuses to list the dirty table: the lookup must name the paths it asks about.
    const guarded = new Proxy(db, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql) => {
            if (/from\s+dirty\b/i.test(sql) && !/where\s+path\s+in\s*\(/i.test(sql)) throw new Error('the dirty table was listed, not asked about paths');
            return target.prepare(sql);
          };
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const out = text(await call(fakeCtx(STALE_STATUS(), { queries: storeQueries(), db: guarded }), 'codegraph_lookup', { operation: 'outline', file: SAMPLE }));
    assert.equal(out.split('\n')[0], `# outline ${SAMPLE} · 4 symbols · ${FRESH} · ${HEAD}`);
    assert.equal(out.split('\n').some((line) => line.startsWith('stale: ')), false);
  });

  test('a clean index reads no dirty rows at all', async () => {
    // A database that refuses the query: with nothing dirty the line must not even look.
    const guarded = new Proxy(db, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql) => {
            if (/from\s+dirty\b/i.test(sql)) throw new Error('the dirty table was read while nothing is dirty');
            return target.prepare(sql);
          };
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const ctx = fakeCtx(READY(), { db: guarded, queries: storeQueries() });
    assert.equal(text(await call(ctx, 'codegraph_lookup', { operation: 'outline', file: SAMPLE })), [
      `# outline ${SAMPLE} · 4 symbols · ${FRESH}`,
      ` function parseConfig (src: string, opts?: Options): Config ${SAMPLE}:8-11`,
      `    class Loader ${SAMPLE}:13-18`,
      `   method load (file: string): Config ${SAMPLE}:15-17`,
      ` function loadAll (dir: string): Config[] ${SAMPLE}:20-22`,
    ].join('\n'));
  });
});

describe('codegraph_map', () => {
  test('repoMap receives path and budget; the text is wrapped with header and truncation hint', async () => {
    const log = [];
    const ctx = fakeCtx(READY(), {
      map: {
        repoMap: (_db, opts) => {
          log.push(opts);
          return { text: 'src/\n  a.ts  function f:1', shown: 3, total: 40, truncated: true };
        },
      },
    });
    const out = text(await call(ctx, 'codegraph_map', { path: 'src', budget: 3000 }));
    assert.deepEqual(log, [{ path: 'src', budgetTokens: 3000 }]);
    assert.equal(out, `# map src · 3 of 40 symbols · ${FRESH}\nsrc/\n  a.ts  function f:1\nhint: raise budget (max 4000) or pass a narrower path to see more.`);
    const all = text(await call(fakeCtx(READY(), { map: { repoMap: () => ({ text: 'a.ts  function f:1', shown: 1, total: 1, truncated: false }) } }), 'codegraph_map', {}));
    assert.equal(all, `# map · 1 symbol · ${FRESH}\na.ts  function f:1`);
  });
});
