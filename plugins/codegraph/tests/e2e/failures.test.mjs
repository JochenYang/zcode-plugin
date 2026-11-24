// T19: failure safety — old Node, no network, corrupted index.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRequire, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Indexer } from '../../src/index/indexer.mjs';
import { applyDefaults } from '../../src/index/defaults.mjs';
import { symbol } from '../../src/graph/queries.mjs';
import { enforceNodeFloor } from '../../src/bootstrap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..', '..');
const require = createRequire(import.meta.url);

test('old Node gets an actionable message and exit 1 before anything is imported', () => {
  // `process.versions` is read-only, so the check is a function and is exercised directly.
  const written = [];
  let exited = 0;
  assert.equal(enforceNodeFloor('20.0.0', { write: (s) => written.push(s) }, (code) => (exited = code)), true);
  assert.equal(exited, 1);
  assert.match(written[0], /Node >= 22\.13 is required/);
  assert.match(written[0], /20\.0\.0/);
  assert.equal(enforceNodeFloor('22.13.0', { write: () => assert.fail('must not write') }, () => assert.fail('must not exit')), false);
  assert.equal(enforceNodeFloor('24.21.0', { write: () => assert.fail('must not write') }, () => assert.fail('must not exit')), false);
  // The real entry wires it: the module is imported before anything that needs node:sqlite.
  const entry = fs.readFileSync(path.join(PLUGIN, 'bin', 'server.mjs'), 'utf8');
  assert.match(entry, /enforceNodeFloor\(\);/);
});

test('indexing and querying never touch the network', async () => {
  const calls = [];
  // Patch the CommonJS built-ins and re-sync so the plugin's ESM named imports see the spies too.
  const http = require('node:http');
  const https = require('node:https');
  const net = require('node:net');
  const originals = { fetch: globalThis.fetch, httpRequest: http.request, httpsRequest: https.request, netConnect: net.connect };
  const spy = (name) => (...args) => {
    calls.push(name);
    throw new Error(`network access attempted: ${name}`);
  };
  globalThis.fetch = spy('fetch');
  http.request = spy('http.request');
  https.request = spy('https.request');
  net.connect = spy('net.connect');
  syncBuiltinESMExports();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-offline-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-offline-data-'));
  process.env.ZCODE_PLUGIN_DATA = data;
  fs.writeFileSync(path.join(root, 'a.ts'), 'export function alpha(): number {\n  return 1;\n}\n');
  let ix;
  try {
    ix = new Indexer({ root, config: applyDefaults({ minFilesToAutoIndex: 1 }) });
    await ix.buildAll({ force: true });
    assert.ok(symbol(ix.db, { name: 'alpha' }));
    assert.deepEqual(calls, []);
  } finally {
    globalThis.fetch = originals.fetch;
    http.request = originals.httpRequest;
    https.request = originals.httpsRequest;
    net.connect = originals.netConnect;
    syncBuiltinESMExports();
    if (ix) await ix.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('a corrupted index file is rebuilt instead of failing forever', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-corrupt-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-corrupt-data-'));
  process.env.ZCODE_PLUGIN_DATA = data;
  fs.writeFileSync(path.join(root, 'a.ts'), 'export function alpha(): number {\n  return 1;\n}\n');
  const first = new Indexer({ root, config: applyDefaults({ minFilesToAutoIndex: 1 }) });
  await first.buildAll({ force: true });
  const dbFile = path.join(data, 'indexes', fs.readdirSync(path.join(data, 'indexes'))[0], 'graph.db');
  await first.close();
  fs.writeFileSync(dbFile, Buffer.alloc(64 * 1024, 0x5a));
  let second;
  try {
    second = new Indexer({ root, config: applyDefaults({ minFilesToAutoIndex: 1 }) });
    const r = await second.ensureFresh({ maxWaitMs: 15000 });
    assert.equal(r.state, 'ready', `state after corrupt reopen: ${JSON.stringify(r)}`);
    assert.ok(symbol(second.db, { name: 'alpha' }), 'index was rebuilt');
  } finally {
    if (second) await second.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }
});
