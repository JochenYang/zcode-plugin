#!/usr/bin/env node
// Offline self-checks. `--self-test` is the Gate 0 minimum; other flags are added
// as lanes land (--grammars, --licenses, --perf).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const log = (...a) => process.stdout.write(`${a.join(' ')}\n`);

async function protocolTest() {
  const { createServer } = await import('../src/mcp/server.mjs');
  const tools = [
    { name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: { x: { type: 'number' } } } },
    { name: 'boom', description: 'throws', inputSchema: { type: 'object' } },
  ];
  const server = createServer({ tools, onCall: async (name, args) => (name === 'boom' ? Promise.reject(new Error('exploded')) : { content: [{ type: 'text', text: JSON.stringify(args) }] }) });
  const send = async (obj) => JSON.parse(await server.handleLine(typeof obj === 'string' ? obj : JSON.stringify(obj)));

  const init = await send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'selftest', version: '0' } } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.ok(init.result.instructions.length > 50, 'initialize must carry instructions');
  assert.equal(init.result.serverInfo.name, 'codegraph');
  assert.equal(await server.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })), null);
  const list = await send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), ['echo', 'boom']);
  const call = await send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { x: 1 } } });
  assert.equal(JSON.parse(call.result.content[0].text).x, 1);
  const boom = await send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'boom', arguments: {} } });
  assert.equal(boom.result.isError, true, 'tool errors are reported in-band');
  const unknownTool = await send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } });
  assert.equal(unknownTool.error.code, -32602);
  assert.equal((await send('{not json')).error.code, -32700);
  assert.equal((await send({ jsonrpc: '2.0', id: 6, method: 'does/not/exist' })).error.code, -32601);
  assert.equal(await server.handleLine('   '), null);
  return 9;
}

function lineReader(child) {
  let buffer = '';
  const waiters = [];
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      const w = waiters.shift();
      if (w) w.resolve(line);
    }
  });
  return () => new Promise((resolve, reject) => {
    waiters.push({ resolve });
    setTimeout(() => reject(new Error('timeout waiting for server line')), 15000);
  });
}

async function spawnTest() {
  // The handshake now starts indexing in the background: run the child in an empty directory
  // with a throw-away data directory, so nothing real is read or written.
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-selftest-data-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'server.mjs')], {
    cwd: data,
    env: { ...process.env, ZCODE_PLUGIN_DATA: data, ZCODE_PROJECT_DIR: data },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const next = lineReader(child);
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
    const init = JSON.parse(await next());
    assert.equal(init.result.protocolVersion, '2025-06-18');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`);
    const pong = JSON.parse(await next());
    assert.deepEqual(pong.result, {});
    assert.equal(pong.id, 2);
    child.stdin.write('garbage\n');
    assert.equal(JSON.parse(await next()).error.code, -32700);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' })}\n`);
    const list = JSON.parse(await next());
    assert.ok(Array.isArray(list.result.tools));
    return 4;
  } finally {
    child.kill();
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

async function sqliteTest() {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-selftest-'));
  const file = path.join(dir, 't.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE t(x INTEGER)');
  db.prepare('INSERT INTO t VALUES (?)').run(42);
  assert.equal(db.prepare('SELECT x FROM t').get().x, 42);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  return 2;
}

async function grammarsTest() {
  // Runs in its own process: it loads every grammar, which needs the V8 flag handled by the script itself.
  const smoke = path.join(ROOT, 'grammars', 'tools', 'smoke.mjs');
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [smoke], { stdio: ['ignore', 'pipe', 'inherit'] });
    const lines = [];
    child.stdout.on('data', (d) => lines.push(String(d)));
    child.on('exit', (c) => {
      const text = lines.join('');
      process.stdout.write(text);
      resolve(c);
    });
  });
  assert.equal(code, 0, `grammar smoke exited ${code}`);
  return 1;
}

async function licensesTest() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'grammars', 'manifest.json'), 'utf8'));
  const notices = fs.readFileSync(path.join(ROOT, 'THIRD-PARTY-NOTICES.md'), 'utf8');
  // First cell of every table row, possibly listing several grammars ("| cfml, cfscript, cfquery |").
  const listed = new Set(
    notices
      .split('\n')
      .filter((l) => l.startsWith('| '))
      .flatMap((l) => l.split('|')[1].split(',').map((s) => s.trim().toLowerCase())),
  );
  const missing = manifest.filter((e) => !listed.has(e.grammar.toLowerCase()));
  assert.deepEqual(missing.map((e) => e.grammar), [], 'grammars without a THIRD-PARTY-NOTICES row');
  for (const e of manifest) {
    assert.ok(fs.existsSync(path.join(ROOT, 'grammars', e.file)), `missing ${e.file}`);
    assert.ok(fs.existsSync(path.join(ROOT, 'grammars', 'LICENSES', `${e.grammar}.txt`)), `missing LICENSES/${e.grammar}.txt`);
    const data = fs.readFileSync(path.join(ROOT, 'grammars', e.file));
    assert.equal(data.length, e.bytes, `${e.file}: manifest bytes ${e.bytes} != ${data.length}`);
    assert.equal(crypto.createHash('sha256').update(data).digest('hex'), e.sha256, `${e.file}: sha256 differs from manifest`);
  }
  // Every shipped query must compile against its grammar (a stale .scm silently disables locals resolution).
  const { initTreeSitter, loadLanguage, queryTextFor } = await import('../grammars/loader.mjs');
  const { GRAMMARS_DIR } = await import('../src/paths.mjs');
  const { Query } = await initTreeSitter();
  const queriesDir = path.join(GRAMMARS_DIR, 'queries');
  let compiled = 0;
  for (const grammar of fs.existsSync(queriesDir) ? fs.readdirSync(queriesDir) : []) {
    for (const name of ['tags', 'locals']) {
      const text = queryTextFor(grammar, name);
      if (!text) continue;
      new Query(await loadLanguage(grammar), text);
      compiled++;
    }
  }
  log(`self-test: ${compiled} query files compile against their grammars`);
  log(`self-test: ${manifest.length} grammars have notices, license files, matching sha256 and wasm on disk`);
  return manifest.length * 5 + compiled;
}

async function main() {
  const flag = process.argv[2] ?? '--self-test';
  let n = 0;
  if (flag === '--self-test') {
    n += await protocolTest();
    log(`self-test: protocol handler OK (${n} assertions)`);
    n += await spawnTest();
    log('self-test: spawned server handshake OK');
    n += await sqliteTest();
    log('self-test: node:sqlite OK');
    log(`self-test: PASS (${n} assertions)`);
    return;
  }
  if (flag === '--grammars') {
    await grammarsTest();
    return;
  }
  if (flag === '--licenses') {
    n += await licensesTest();
    log(`self-test: PASS (${n} checks)`);
    return;
  }
  process.stderr.write(`unknown flag ${flag}; expected --self-test | --grammars | --licenses\n`);
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`self-test: FAIL ${err?.stack ?? err}\n`);
  process.exit(1);
});
