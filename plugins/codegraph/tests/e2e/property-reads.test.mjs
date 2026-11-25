// A name that is only read as a property (`row.membershipKind`) or used as the key of an object
// (`{ membershipKind }`) is found by scanning the JS/TS source when a search has no symbol to
// show (src/graph/propertyReads.mjs). The parsers are loaded when the session starts, so the
// first such search of the session has them.
// Real server process, real grammars, throw-away project and data directory.
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function write(root, rel, text) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

const project = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-e2e-propreads-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-e2e-propreads-data-'));
  fs.writeFileSync(path.join(data, 'codegraph.json'), JSON.stringify({ autoIndex: true, minFilesToAutoIndex: 1 }));
  // The T20 names in the shapes that reach the index (a call) and the ones that do not (reads
  // and object keys).
  write(root, 'src/account.ts', [
    'export function loadAccount(row: Row, policy: Policy, client: Client) {',
    '  const kind = row.membershipKind;',
    '  const attempts = policy?.retryCount;',
    '  if (client.takePendingDeepLink(attempts)) return requirePersonalAccount(kind);',
    '  return { membershipKind: kind };',
    '}',
    '',
  ].join('\n'));
  // Shares a word with membershipKind: the symbol search answers with it alone (a partial match).
  write(root, 'src/cache.ts', 'export function membershipCache(): void {}\n');
  // The same read in a language whose attribute reads are in the index.
  write(root, 'tools/probe.py', 'def f(row):\n    return row.membershipKind\n');
  return { root, data };
};

const cleanup = ({ root, data }) => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
};

const textOf = (res) => res.result?.content?.[0]?.text ?? JSON.stringify(res);

test('a search with no symbol lists the property reads and object keys found in the source, merged with what the index has', async () => {
  const { root, data } = project();
  const child = spawn(process.execPath, [SERVER], { cwd: root, env: { ...process.env, ZCODE_PLUGIN_DATA: data, ZCODE_PROJECT_DIR: root }, stdio: ['pipe', 'pipe', 'pipe'] });
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
  const request = (id, method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  const search = async (id, query) => {
    request(id, 'tools/call', { name: 'codegraph_lookup', arguments: { operation: 'search', query } });
    return textOf(await next());
  };
  try {
    request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    await next();
    const status = path.join(data, 'indexes', projectKey(root), 'status.json');
    for (const deadline = Date.now() + 60_000; Date.now() < deadline; await sleep(200)) {
      try {
        if (JSON.parse(fs.readFileSync(status, 'utf8')).state === 'ready') break;
      } catch {
        // no status yet
      }
    }
    // The parsers are loaded in the background at session start.
    for (const deadline = Date.now() + 30_000; Date.now() < deadline; await sleep(200)) {
      const out = await search(2, 'retryCount');
      if (out.includes('property read')) break;
    }
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

    // The index has the Python read and the symbol that shares a word; the scan has the JS read
    // and the key of the object that is returned.
    const merged = (await search(3, 'membershipKind')).split('\n');
    assert.equal(merged[0].split(' · ').slice(0, 3).join(' · '), '# search membershipKind · no symbol carries this name; 3 uses in 2 files (membershipKind) · also in symbol names: membershipCache');
    assert.deepEqual(merged.slice(1, 4), [' property row.membershipKind ×1 in loadAccount src/account.ts:2', '      key membershipKind ×1 in loadAccount src/account.ts:5', '      ref membershipKind ×1 in f tools/probe.py:2']);
    assert.ok(merged.at(-1).startsWith('hint: no symbol carries this name; the rows are places that use it: calls and type names from the index, and property reads (obj.name), object keys ({ name }) and members of types found by scanning the JS/TS source just now.'), merged.at(-1));

    // The index has nothing: the scan alone, and the header says so.
    const only = (await search(4, 'retryCount')).split('\n');
    assert.ok(only[0].startsWith('# search retryCount · no symbol carries this name; 1 property read in 1 file (retryCount) · also in symbol names: loadAccount'), only[0]);
    assert.equal(only[1], ' property policy.retryCount ×1 in loadAccount src/account.ts:3');
    assert.ok(only.at(-1).startsWith('hint: no symbol carries this name; the rows are property reads (obj.name), object keys ({ name }) and members of types, found by scanning the JavaScript and TypeScript source just now; the index had no call or type of that name.'), only.at(-1));

    // A call is in the index and the scan adds nothing: the hint says where to look for the rest.
    const call = (await search(5, 'takePendingDeepLink')).split('\n');
    assert.equal(call[0].split(' · ').slice(0, 2).join(' · '), '# search takePendingDeepLink · no symbol carries this name; 1 use in 1 file (takePendingDeepLink)');
    assert.equal(call[1], '     call client.takePendingDeepLink ×1 in loadAccount src/account.ts:4');
    assert.ok(call.at(-1).startsWith('hint: no symbol carries this name; the rows are places that use it: calls and type names from the index. JS/TS property reads (obj.field) and object keys ({ field }) were looked for in the source: there were none.'), call.at(-1));

    // Nothing anywhere, and the empty hint now says what is searched too.
    const none = (await search(6, 'zzqNothing')).split('\n');
    assert.ok(none[0].startsWith('# search zzqNothing · no matches · '), none[0]);
    assert.ok(none.at(-1).startsWith('hint: search matches symbol names and names that are used here without a definition (calls, type names, and in JS/TS property reads such as obj.field and object keys such as { field });'), none.at(-1));
    assert.equal(stderr, '');
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('close', resolve));
    cleanup({ root, data });
  }
});
