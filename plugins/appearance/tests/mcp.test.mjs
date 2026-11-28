import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { callTool, createServer, describe as describeConfig, TOOLS } from '../src/mcp.mjs';
import { PLUGIN_VERSION } from '../src/version.mjs';

const call = async (line) => JSON.parse(await createServer().handleLine(JSON.stringify(line)));
// A tool result as the protocol wraps it, or as callTool returns it.
const text = (reply) => (reply.result ?? reply).content[0].text;
const RUNNING = { running: true, port: 4321 };
const STOPPED = { running: false, port: null };

describe('protocol', () => {
  it('answers the handshake with its version and its tools', async () => {
    const init = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.version, PLUGIN_VERSION);
    assert.deepEqual(init.result.capabilities, { tools: {} });
    const list = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.deepEqual(list.result.tools.map((tool) => tool.name), ['get_appearance', 'set_appearance']);
    for (const tool of list.result.tools) assert.equal(tool.inputSchema.additionalProperties, false);
  });

  it('answers ping, stays silent on notifications, and reports what it cannot parse', async () => {
    const server = createServer();
    assert.deepEqual(JSON.parse(await server.handleLine('{"jsonrpc":"2.0","id":7,"method":"ping"}')).result, {});
    assert.equal(await server.handleLine('{"jsonrpc":"2.0","method":"notifications/initialized"}'), null);
    assert.equal(await server.handleLine('{"jsonrpc":"2.0","method":"tools/call","params":{"name":"get_appearance"}}'), null);
    assert.equal(await server.handleLine('   '), null);
    const broken = JSON.parse(await server.handleLine('{not json'));
    assert.equal(broken.id, null);
    assert.equal(broken.error.code, -32700);
    const invalid = JSON.parse(await server.handleLine('[1,2]'));
    assert.equal(invalid.error.code, -32600);
    const unknown = JSON.parse(await server.handleLine('{"jsonrpc":"2.0","id":3,"method":"nope"}'));
    assert.equal(unknown.error.code, -32601);
    assert.equal(unknown.id, 3);
    const badTool = JSON.parse(await server.handleLine('{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"rm"}}'));
    assert.equal(badTool.error.code, -32602);
  });
});

describe('tools', () => {
  // Awaits the body before removing the directory: the tools are async, and a plain `finally`
  // would run at the body's first await.
  const inTempHome = async (run) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appearance-mcp-'));
    const file = path.join(dir, 'appearance.json');
    try {
      return await run({ file, dir });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it('reads defaults and says that the launcher is not running', () => inTempHome(async ({ file }) => {
    const reply = text(await callTool('get_appearance', {}, { file, status: STOPPED }));
    assert.match(reply, /^# appearance · defaults, no config file yet · /);
    assert.ok(reply.includes(file));
    assert.ok(reply.includes('launcher not running'));
    assert.ok(reply.includes('background: on · scope page · mask 0.72'));
    assert.ok(reply.includes('media: none set yet'));
    assert.ok(reply.includes('next: set a picture or video'));
  }));

  it('saves a change and reads it back from the file', () => inTempHome(async ({ file, dir }) => {
    const picture = path.join(dir, 'littlejochen.png');
    fs.writeFileSync(picture, 'png');
    const reply = text(await callTool('set_appearance', { setMedia: ['littlejochen.png'], scope: 'chat', mask: 0.7, rotateMinutes: 30 }, { file, cwd: dir, status: RUNNING }));
    assert.match(reply, /^# appearance · saved · /);
    assert.ok(reply.includes('launcher running (port 4321)'));
    assert.ok(reply.includes('background: on · scope chat · mask 0.7 · blur 0px · rotate every 30 min'));
    assert.ok(reply.includes(`media (1):\n  1. ${picture}`));
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(saved.background.media, [picture]);
    assert.equal(saved.background.scope, 'chat');
    const again = text(await callTool('get_appearance', {}, { file, cwd: dir, status: RUNNING }));
    assert.ok(again.includes('scope chat'));
    assert.ok(!again.includes('saved'));
    assert.ok(!again.includes('next:'), 'nothing is missing, so nothing is suggested');
  }));

  it('reports a bad change in the tool result, without touching the file', () => inTempHome(async ({ file }) => {
    const server = createServer();
    const run = (args) => server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'set_appearance', arguments: args } }));
    const unknownField = JSON.parse(await run({ opacity: 0.4 }));
    assert.equal(unknownField.result.isError, true);
    assert.match(unknownField.result.content[0].text, /appearance error: unknown field opacity/);
    const outOfRange = JSON.parse(await run({ mask: 5 }));
    assert.match(outOfRange.result.content[0].text, /background\.mask must be a number from 0 to 1/);
    const notAPicture = JSON.parse(await run({ setMedia: ['notes.txt'] }));
    assert.match(notAPicture.result.content[0].text, /not a picture/);
    assert.equal(fs.existsSync(file), false);
  }));

  it('says a saved picture is missing only when it checks the file', () => inTempHome(async ({ file }) => {
    const reply = text(await callTool('set_appearance', { setMedia: ['elsewhere.png'] }, { file, cwd: process.cwd(), status: RUNNING }));
    assert.ok(reply.includes('elsewhere.png'), 'the path is stored as given; the launcher is what reads the picture');
  }));

  it('describes the skin, and says when one of the user\'s own is kept but not in use', () => {
    const base = { background: defaultBackground(), skin: { preset: 'catppuccin', custom: null } };
    const described = (skin) => describeConfig({ ...base, skin }, { file: 'x', exists: true, changed: false, status: RUNNING });
    assert.ok(described(base.skin).includes('skin: catppuccin'));
    assert.ok(described({ preset: 'custom', custom: {} }).includes('skin: custom'));
    assert.ok(described({ preset: 'default', custom: {} }).includes('skin: default (a custom skin is kept, not in use)'));
  });

  it('tells the model where the command for the launcher program is, in this copy of the plugin', () => {
    const text = describeConfig({ background: defaultBackground(), skin: { preset: 'default', custom: null } }, { file: 'x', exists: true, changed: false, status: RUNNING });
    const line = text.split('\n').find((item) => item.startsWith('launcher program: '));
    assert.ok(line, text);
    const script = /launcher program: (\S+)/.exec(line)[1];
    assert.equal(path.basename(script), 'setup-launcher.mjs');
    assert.ok(fs.existsSync(script), 'the file is there, in this copy');
  });
});

describe('the process', () => {
  it('speaks the protocol over stdio and exits when stdin closes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appearance-mcp-proc-'));
    try {
      const child = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'bin', 'server.mjs')], { env: { ...process.env, ZCODE_APPEARANCE_HOME: dir }, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (chunk) => {
        out += chunk;
      });
      const done = new Promise((resolve) => child.once('exit', resolve));
      const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'set_appearance', arguments: { scope: 'chat' } } });
      send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
      child.stdin.end();
      assert.equal(await done, 0);
      const replies = out.trim().split('\n').map((line) => JSON.parse(line));
      assert.deepEqual(replies.map((reply) => reply.id), [1, 2, 3]);
      assert.equal(replies[0].result.serverInfo.name, 'appearance');
      assert.ok(replies[1].result.content[0].text.includes('scope chat'));
      assert.equal(replies[2].result.tools.length, TOOLS.length);
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'appearance', 'config.json'), 'utf8')).background.scope, 'chat');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function defaultBackground() {
  return { enabled: true, media: [], scope: 'page', rotateMinutes: 0, mask: 0.72, blur: 0 };
}
