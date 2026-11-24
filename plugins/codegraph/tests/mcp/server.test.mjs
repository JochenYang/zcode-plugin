// Protocol-level tests for the pure JSON-RPC handler (CONTRACTS.md §10).
// The spawned-process path is covered by bin/selftest.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../src/mcp/server.mjs';

const tools = [
  { name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: { x: { type: 'number' } } } },
  { name: 'boom', description: 'throws', inputSchema: { type: 'object' } },
];

function makeServer() {
  return createServer({
    tools,
    onCall: async (name, args) => (name === 'boom' ? Promise.reject(new Error('exploded')) : { content: [{ type: 'text', text: JSON.stringify(args) }] }),
  });
}

const send = async (server, obj) => JSON.parse(await server.handleLine(typeof obj === 'string' ? obj : JSON.stringify(obj)));

test('initialize echoes the protocol version and carries instructions', async () => {
  const res = await send(makeServer(), { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  assert.equal(res.result.protocolVersion, '2025-06-18');
  assert.deepEqual(res.result.capabilities, { tools: {} });
  assert.equal(res.result.serverInfo.name, 'codegraph');
  assert.ok(res.result.instructions.includes('codegraph_lookup'));
});

test('notifications produce no output', async () => {
  const server = makeServer();
  assert.equal(await server.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })), null);
  assert.equal(await server.handleLine(''), null);
  assert.equal(await server.handleLine('   '), null);
});

test('tools/list and tools/call round-trip', async () => {
  const server = makeServer();
  const list = await send(server, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), ['echo', 'boom']);
  const call = await send(server, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { x: 1 } } });
  assert.deepEqual(call.result.content, [{ type: 'text', text: '{"x":1}' }]);
  assert.equal(call.result.isError, undefined);
});

test('tool failures are in-band (isError), never JSON-RPC errors', async () => {
  const res = await send(makeServer(), { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'boom', arguments: {} } });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /exploded/);
  assert.equal(res.error, undefined);
});

test('malformed input maps to the right JSON-RPC codes without crashing', async () => {
  const server = makeServer();
  assert.equal((await send(server, '{not json')).error.code, -32700);
  assert.equal((await send(server, { jsonrpc: '2.0', id: 5, method: 'nope' })).error.code, -32601);
  assert.equal((await send(server, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'missing' } })).error.code, -32602);
  assert.equal((await send(server, { id: 7 })).error.code, -32600);
  assert.equal((await send(server, [1, 2])).error.code, -32600);
  // the server keeps answering afterwards
  assert.deepEqual((await send(server, { jsonrpc: '2.0', id: 8, method: 'ping' })).result, {});
});

test('initialize starts the session work once and does not wait for it; no other method starts it', async () => {
  let starts = 0;
  let finish;
  const onStart = () => {
    starts += 1;
    return new Promise((resolve) => { finish = resolve; });
  };
  const server = createServer({ tools, onCall: async () => ({ content: [] }), onStart });
  const res = await send(server, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(res.result.serverInfo.name, 'codegraph', 'the handshake is answered while onStart is still pending');
  assert.equal(starts, 1);
  await send(server, { jsonrpc: '2.0', method: 'notifications/initialized' });
  await send(server, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  await send(server, { jsonrpc: '2.0', id: 3, method: 'ping' });
  assert.equal(starts, 1);
  finish();
});

test('a start that throws or rejects only reaches stderr and never breaks the handshake', async () => {
  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
  try {
    const rejecting = createServer({ tools, onCall: async () => ({ content: [] }), onStart: () => Promise.reject(new Error('disk full')) });
    assert.equal((await send(rejecting, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).result.serverInfo.name, 'codegraph');
    const throwing = createServer({ tools, onCall: async () => ({ content: [] }), onStart: () => { throw new Error('sync failure'); } });
    assert.equal((await send(throwing, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).result.serverInfo.name, 'codegraph');
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.stderr.write = original;
  }
  assert.ok(written.some((line) => /disk full/.test(line)) && written.some((line) => /sync failure/.test(line)), JSON.stringify(written));
});
