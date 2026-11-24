// A new project is indexed when the session opens, and an indexed one refreshed, without the
// model calling a tool: the handshake alone starts the work (src/mcp/server.mjs silentIndexStart).
// Real grammars, real server process, throw-away project and data directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectKey } from '../../src/paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '..', '..', 'bin', 'server.mjs');

// The server under test gets its own data directory through the environment; the test process
// does not, so paths are built from that directory instead of from paths.mjs's dataDir().
const indexFiles = (root, data) => path.join(data, 'indexes', projectKey(root));
const statusFile = (root, data) => path.join(indexFiles(root, data), 'status.json');

function write(root, rel, text) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

function start(root, data) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: root,
    env: { ...process.env, ZCODE_PLUGIN_DATA: data, ZCODE_PROJECT_DIR: root },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  let stderr = '';
  const queue = [];
  const waiters = [];
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      (waiters.shift() ?? ((value) => queue.push(value)))(JSON.parse(line));
    }
  });
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const next = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => waiters.push(resolve)));
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  const stop = async () => {
    child.kill();
    await new Promise((resolve) => child.once('close', resolve));
    return stderr;
  };
  return { next, notify, stop, request: (id, method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`) };
}

const readStatus = (root, data) => {
  try {
    return JSON.parse(fs.readFileSync(statusFile(root, data), 'utf8'));
  } catch {
    return null;
  }
};

// Poll until `accept` holds for the value of `read` (or the timeout passes; the last value is returned).
async function waitFor(read, accept, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let value = null;
  while (Date.now() < deadline) {
    value = read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return value;
}

// status.json is rewritten during a build; "ready with every file" is the settled state.
async function waitUntilReady(root, data, files, timeoutMs = 120_000) {
  return waitFor(() => readStatus(root, data), (status) => status?.state === 'ready' && status.filesTotal >= files && status.symbols > 0, timeoutMs);
}

test('a never-indexed project is indexed by the handshake alone, and the index answers', { timeout: 180_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-warm-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-warm-data-'));
  // The fixture is tiny: lower the auto-index floor the way a user would, in codegraph.json.
  fs.writeFileSync(path.join(data, 'codegraph.json'), JSON.stringify({ autoIndex: true, minFilesToAutoIndex: 1 }));
  write(root, 'a.ts', 'export function alpha(): number {\n  return 1;\n}\n');
  write(root, 'b.ts', "import { alpha } from './a';\nexport const beta = (): number => alpha();\n");
  const session = start(root, data);
  try {
    session.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    const init = await session.next();
    assert.equal(init.result.serverInfo.name, 'codegraph');
    // No tool call from here on: the index has to appear by itself.
    const status = await waitUntilReady(root, data, 2);
    assert.equal(status?.state, 'ready', `index was not built by the handshake (status ${JSON.stringify(status)})`);
    assert.ok(status.filesTotal >= 2 && status.symbols >= 2, JSON.stringify(status));
    session.notify('notifications/initialized', {});
    session.request(2, 'tools/call', { name: 'codegraph_lookup', arguments: { operation: 'symbol', name: 'beta' } });
    const res = await session.next();
    const text = res.result.content[0].text;
    assert.match(text, /# symbol beta · b\.ts:2-2/);
    assert.match(text, /called by\(0\): none|calls\(1\): alpha/, text);
  } finally {
    const stderr = await session.stop();
    assert.doesNotMatch(stderr, /codegraph: /, 'the silent start must not report a failure');
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

// An index of another project, written the way an old one looks: status, a usage stamp and file
// times `ageMs` back. Its database is never opened, since no session of these tests works there.
function seedIndex(data, project, ageMs = 0) {
  const dir = path.join(data, 'indexes', projectKey(project));
  fs.mkdirSync(dir, { recursive: true });
  const stamp = Date.now() - ageMs;
  const when = new Date(stamp);
  const files = {
    'status.json': JSON.stringify({ root: project.split(path.sep).join('/'), state: 'ready', filesTotal: 1, filesDone: 1, symbols: 1, indexedAt: stamp }),
    'graph.db': 'not a database',
    'used.at': String(stamp),
  };
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
    fs.utimesSync(path.join(dir, name), when, when);
  }
  return dir;
}

async function call(session, id, name, args) {
  session.request(id, 'tools/call', { name, arguments: args });
  const res = await session.next();
  assert.equal(res.error, undefined, `protocol error: ${JSON.stringify(res.error)}`);
  return res.result.content[0].text;
}

test('the session start tidies the store: an index unused for long goes, a recently used one stays even if its folder is gone, this one is stamped', { timeout: 120_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-warm-store-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-warm-store-data-'));
  fs.writeFileSync(path.join(data, 'codegraph.json'), JSON.stringify({ autoIndex: true, minFilesToAutoIndex: 1 }));
  write(root, 'a.ts', 'export function alpha(): number {\n  return 1;\n}\n');
  const goneOldRoot = path.join(data, 'deleted-long-ago');
  const goneRecentRoot = path.join(data, 'deleted-project');
  const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-warm-other-'));
  // Unused for 200 days and its folder is gone: due.
  const goneOld = seedIndex(data, goneOldRoot, 200 * 86_400_000);
  // Its folder is gone too, but it served a session an hour ago: a drive that is not mounted
  // right now must not cost this index.
  const goneRecent = seedIndex(data, goneRecentRoot, 3600_000);
  const other = seedIndex(data, otherRoot, 3600_000);
  const session = start(root, data);
  try {
    session.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.equal((await session.next()).result.serverInfo.name, 'codegraph');
    const status = await waitUntilReady(root, data, 1);
    assert.equal(status?.state, 'ready', `index was not built by the handshake (status ${JSON.stringify(status)})`);
    // The sweep follows the refresh dispatch; give it a moment.
    assert.equal(await waitFor(() => !fs.existsSync(goneOld), (value) => value === true, 10_000), true, 'the index unused for 200 days is still there');
    assert.equal(fs.existsSync(goneRecent), true, 'an index used an hour ago stays, folder or no folder');
    assert.equal(fs.existsSync(other), true, 'an index of a project that is still there stays');
    assert.equal(fs.existsSync(path.join(indexFiles(root, data), 'used.at')), true, 'the index of this session is stamped as in use');
    session.notify('notifications/initialized', {});
  } finally {
    const stderr = await session.stop();
    assert.match(stderr, /codegraph: removed the index of .*deleted-long-ago \((orphan|idle), \d+ bytes\)/);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(otherRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('clean=current removes the index of this session and the next call rebuilds it, in the same process', { timeout: 120_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-warm-clean-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-warm-clean-data-'));
  fs.writeFileSync(path.join(data, 'codegraph.json'), JSON.stringify({ autoIndex: true, minFilesToAutoIndex: 1 }));
  write(root, 'a.ts', 'export function alpha(): number {\n  return 1;\n}\n');
  write(root, 'b.ts', "import { alpha } from './a';\nexport const beta = (): number => alpha(2);\n");
  const session = start(root, data);
  try {
    session.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    await session.next();
    const status = await waitUntilReady(root, data, 2);
    assert.equal(status?.state, 'ready', `index was not built by the handshake (status ${JSON.stringify(status)})`);
    session.notify('notifications/initialized', {});
    const dir = indexFiles(root, data);
    assert.equal(fs.existsSync(dir), true);
    assert.match(await call(session, 2, 'codegraph_status', { clean: 'current' }), /1 of 1 index would be removed/, 'without confirm nothing goes');
    assert.equal(fs.existsSync(dir), true);
    assert.match(await call(session, 3, 'codegraph_status', { clean: 'current', confirm: true }), /removed 1 of 1 index · \d+ KB freed/);
    assert.equal(fs.existsSync(dir), false, 'the index directory is gone');
    // The process context was rebuilt by the previous call: this one indexes the project again.
    assert.match(await call(session, 4, 'codegraph_lookup', { operation: 'search', query: 'beta' }), /(# search beta · 1 match|indexing \d+% \(results partial\))/);
    assert.equal((await waitFor(() => readStatus(root, data), (value) => value?.state === 'ready' && value.filesTotal >= 2, 60_000))?.state, 'ready', 'the index was rebuilt');
    assert.match(await call(session, 5, 'codegraph_lookup', { operation: 'search', query: 'beta' }), /# search beta · 1 match/);
  } finally {
    const stderr = await session.stop();
    assert.doesNotMatch(stderr, /uncaught|Indexer is closed|codegraph error/, 'the rebuild after the removal raised nothing');
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('a project below the auto-index floor is left alone by the handshake', { timeout: 60_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-warm-small-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-warm-small-data-'));
  write(root, 'only.ts', 'export const one = 1;\n');
  const session = start(root, data);
  try {
    session.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    await session.next();
    // The indexer still opens the database and records why it holds nothing; it must not index.
    const status = await waitFor(() => readStatus(root, data), (value) => value?.state === 'empty', 30_000);
    assert.equal(status?.state, 'empty', `one file is below the default floor of 30 (status ${JSON.stringify(status)})`);
    assert.equal(status?.reason, 'below-min-files');
    assert.equal(status?.filesTotal ?? 0, 0);
    session.notify('notifications/initialized', {});
    session.request(2, 'tools/call', { name: 'codegraph_lookup', arguments: { operation: 'search', query: 'one' } });
    const res = await session.next();
    assert.match(res.result.content[0].text, /not indexed/, res.result.content[0].text);
  } finally {
    await session.stop();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('the handshake touches no disk for a home directory or with autoIndex off', { timeout: 60_000 }, async () => {
  // A home directory is never indexed; autoIndex off means "only a manual refresh touches the
  // index". In both cases the silent start must stop before a database is opened.
  for (const [label, project, config] of [
    ['home directory', os.homedir().split(path.sep).join('/'), null],
    ['autoIndex off', fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-warm-off-')), { autoIndex: false, minFilesToAutoIndex: 1 }],
  ]) {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-warm-guard-data-'));
    if (config) {
      fs.writeFileSync(path.join(project, 'a.ts'), 'export const one = 1;\n');
      fs.writeFileSync(path.join(data, 'codegraph.json'), JSON.stringify(config));
    }
    const session = start(project, data);
    try {
      session.request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
      assert.equal((await session.next()).result.serverInfo.name, 'codegraph', `${label}: the handshake still answers`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.equal(fs.existsSync(path.join(data, 'indexes')), false, `${label}: nothing may be created under indexes/`);
    } finally {
      await session.stop();
      fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      if (config) fs.rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
});
