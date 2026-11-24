// T17: real repositories, hand-verified symbol positions and caller sites.
// Opt-in: CODEGRAPH_E2E_REPOS="self=D:/path;cg=D:/path;requests=D:/path;gin=D:/path" (name=root pairs).
// CODEGRAPH_E2E_PERF=1 additionally asserts the T18 budgets (machine-dependent, so off by default).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Indexer } from '../../src/index/indexer.mjs';
import { applyDefaults } from '../../src/index/defaults.mjs';
import { symbol, callers, outline } from '../../src/graph/queries.mjs';
import { repoMap } from '../../src/graph/map.mjs';

const repos = Object.fromEntries(
  (process.env.CODEGRAPH_E2E_REPOS ?? '')
    .split(';')
    .map((pair) => pair.split('='))
    .filter((pair) => pair.length === 2)
    .map(([name, root]) => [name.trim(), path.resolve(root.trim())]),
);
const PERF = process.env.CODEGRAPH_E2E_PERF === '1';
const skip = (name) => (repos[name] ? false : `set CODEGRAPH_E2E_REPOS with ${name}=<path> to run this check`);

async function withIndex(root, fn) {
  process.env.ZCODE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-e2e-repo-'));
  const ix = new Indexer({ root, config: applyDefaults({ minFilesToAutoIndex: 1 }) });
  try {
    const t0 = performance.now();
    await ix.buildAll({ force: true });
    const buildMs = performance.now() - t0;
    return await fn(ix, { buildMs });
  } finally {
    await ix.close();
    fs.rmSync(process.env.ZCODE_PLUGIN_DATA, { recursive: true, force: true });
  }
}

const hasCaller = (rows, file, line) => rows.some((r) => r.path === file && r.startLine === line);
const rel = (p) => p.split(path.sep).join('/');

test('this repository: createServer at server.mjs:16, serve calls it at :84', { skip: skip('self') }, async () => {
  const root = repos.self;
  await withIndex(root, async (ix) => {
    const s = symbol(ix.db, { name: 'createServer' });
    assert.ok(s, 'createServer found');
    assert.equal(s.symbol.path, 'plugins/codegraph/src/mcp/server.mjs');
    assert.equal(s.symbol.startLine, 16);
    assert.ok(hasCaller(s.callers, 'plugins/codegraph/src/mcp/server.mjs', 84), 'serve() calls createServer');
    assert.ok(s.callers.some((c) => c.resolution === '='), 'at least one import-resolved caller');
  });
});

test('codegraph clone (1,660 TS/JS files): positions and same-file callers', { skip: skip('cg') }, async () => {
  const root = repos.cg;
  await withIndex(root, async (ix, { buildMs }) => {
    const s = symbol(ix.db, { name: 'normalizeQuerySpelling' });
    assert.ok(s, 'normalizeQuerySpelling found');
    assert.equal(s.symbol.path, 'src/mcp/tools.ts');
    assert.equal(s.symbol.startLine, 214);
    const c = callers(ix.db, { name: 'getExploreBudget' });
    assert.ok(hasCaller(c, 'src/mcp/tools.ts', 2383) && hasCaller(c, 'src/mcp/tools.ts', 7964), 'both call sites of getExploreBudget');
    const map = repoMap(ix.db, { budgetTokens: 1200 });
    assert.ok(map.text.length > 0 && typeof map.truncated === 'boolean');
    console.log(`[perf] codegraph clone first build ${Math.round(buildMs)} ms`);
    if (PERF) assert.ok(buildMs <= 15000, `first build ${Math.round(buildMs)} ms exceeds 15 s`);
  });
});

test('psf/requests (Python): get at api.py:74, Session class at sessions.py:395, api.py:70 constructs it', { skip: skip('requests') }, async () => {
  const root = repos.requests;
  await withIndex(root, async (ix, { buildMs }) => {
    const get = symbol(ix.db, { name: 'get', path: 'src/requests/api.py' });
    assert.ok(get, 'requests.api.get found');
    assert.equal(get.symbol.startLine, 74);
    const session = symbol(ix.db, { name: 'Session' });
    assert.ok(session, 'Session found');
    assert.equal(session.symbol.path, 'src/requests/sessions.py');
    assert.equal(session.symbol.startLine, 395);
    const c = callers(ix.db, { name: 'Session' });
    assert.ok(hasCaller(c, 'src/requests/api.py', 70), 'api.py:70 constructs Session');
    console.log(`[perf] requests first build ${Math.round(buildMs)} ms`);
  });
});

test('gin-gonic/gin (Go): Engine.Run at gin.go:566, Default() calls New() at gin.go:252', { skip: skip('gin') }, async () => {
  const root = repos.gin;
  await withIndex(root, async (ix, { buildMs }) => {
    // gin.go also has a deprecated package-level `Run` (line 141); the method is `Engine.Run`.
    const run = symbol(ix.db, { name: 'Run', qual: 'Engine.Run' });
    assert.ok(run, 'Engine.Run found');
    assert.equal(run.symbol.path, 'gin.go');
    assert.equal(run.symbol.startLine, 566);
    assert.equal(run.symbol.kind, 'method');
    assert.equal(run.symbol.qual, 'Engine.Run');
    // Default() at gin.go:250 calls New() at :252 (same file, unique name -> `~`).
    // (gin.Default() at debug.go:104 is inside a raw string literal and must NOT be a caller.)
    const c = callers(ix.db, { name: 'New', limit: 200 });
    assert.ok(hasCaller(c, 'gin.go', 252), 'gin.go:252 (inside Default) calls New()');
    assert.ok(!hasCaller(c, 'debug.go', 104), 'string literal content is not a call');
    const ol = outline(ix.db, { path: 'gin.go' });
    assert.ok(ol.some((s) => s.name === 'Run' && s.startLine === 566));
    console.log(`[perf] gin first build ${Math.round(buildMs)} ms`);
  });
});

test('relative paths and no absolute leakage in map text', { skip: skip('self') }, async () => {
  await withIndex(repos.self, async (ix) => {
    const map = repoMap(ix.db, { budgetTokens: 800 });
    assert.ok(!/[A-Za-z]:[\\/]/.test(map.text), 'map text must not contain absolute Windows paths');
    assert.ok(!map.text.includes(os.homedir().split(path.sep).join('/')), 'map text must not contain the home directory');
  });
});

// Keep `rel` referenced for Windows path expectations in future cases.
void rel;
