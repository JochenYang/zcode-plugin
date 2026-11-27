// A session whose workspace is one ZCode made itself is no project of the user's. ZCode gives a
// session that was never opened on a folder a workspace under a `.zcode` directory's `workspace`
// folder (`draft-<id>`, `default`, …), in the profile or wherever its data was moved. For such a
// folder nothing is indexed and nothing reaches the store: the session-start hook says nothing,
// and every tool answers in one line. Real server process, the real hook, throw-away folders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listIndexes } from '../../src/index/storage.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..', '..');
const SERVER = path.join(PLUGIN, 'bin', 'server.mjs');
const HOOK = path.join(PLUGIN, 'bin', 'hook.mjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-host-workspace-'));
const DATA = path.join(TMP, 'data');
// Where ZCode keeps its data, and the workspaces it makes under it, as seen on 2026-11-27.
const HOST = path.join(TMP, 'zcode-cache', '.zcode', 'workspace');
const WORKSPACE = path.join(HOST, 'draft-62d72d80-6066-4336-88f9-db64d15fef8b');
for (const dir of [DATA, WORKSPACE, path.join(WORKSPACE, 'src'), path.join(HOST, 'default')]) fs.mkdirSync(dir, { recursive: true });

test.after(() => fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const ENV = { ...process.env, ZCODE_PROJECT_DIR: WORKSPACE, ZCODE_PLUGIN_ROOT: PLUGIN, ZCODE_PLUGIN_DATA: DATA };
const toolText = (res) => res.result?.content?.map((c) => c.text ?? '').join('\n') ?? res.error?.message ?? JSON.stringify(res);
const store = () => listIndexes({ probe: false, data: DATA });
// The server runs with its working directory inside the scratch tree: it has to be gone before
// the tree is removed (Windows keeps a directory that is someone's working directory).
const stop = (child) => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve();
  child.once('close', resolve);
  child.kill();
});

test('the session-start hook says nothing for a workspace ZCode made itself', () => {
  const hook = spawnSync(process.execPath, [HOOK, 'session-start'], {
    cwd: WORKSPACE,
    env: ENV,
    input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: WORKSPACE, session_id: 'host-workspace-test' }),
    encoding: 'utf8',
  });
  assert.equal(hook.status, 0);
  assert.equal(hook.stdout, '', 'no context is injected: there is no project to talk about');
});

test('nothing is written to the store, and every tool answers in one line', async (t) => {
  const child = spawn(process.execPath, [SERVER], { cwd: WORKSPACE, env: ENV, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => stop(child));
  let buffer = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const waiters = [];
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim()) waiters.shift()?.(JSON.parse(line));
    }
  });
  let nextId = 1;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    waiters.push(resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => reject(new Error(`timeout: ${method}`)), 30_000);
  });

  const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(init.result.serverInfo.name, 'codegraph');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  // Give a session start that wrongly went ahead the time it needs to leave something behind.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.deepEqual(store(), [], 'no entry in the store');

  const hint = 'hint: this is a workspace ZCode made for a session without a folder (under a .zcode/workspace directory); it gets no index and no entry in the index store. Use Grep/Read here.';
  assert.equal(toolText(await request('tools/call', { name: 'codegraph_status', arguments: {} })), `# status · not a project folder\n${hint}`);
  assert.equal(toolText(await request('tools/call', { name: 'codegraph_lookup', arguments: { operation: 'search', query: 'parse' } })), `# search parse · not a project folder\n${hint}`);
  assert.equal(toolText(await request('tools/call', { name: 'codegraph_map', arguments: { path: 'src' } })), `# map src · not a project folder\n${hint}`);
  // A refresh asked for explicitly changes nothing either.
  assert.equal(toolText(await request('tools/call', { name: 'codegraph_status', arguments: { refresh: true } })), `# status refresh=true · not a project folder\n${hint}`);
  // The store is the whole machine's: it is listed from here like from any session (the hint
  // closes the result, as any footer), and still nothing is written for this folder.
  assert.equal(toolText(await request('tools/call', { name: 'codegraph_status', arguments: { storage: true } })), [
    '# status · not a project folder',
    'indexes: 0 projects · 0 KB in all',
    `under ${path.join(DATA, 'indexes').split(path.sep).join('/')}`,
    'policy: indexes unused for more than 90 days are removed when a session opens; there is no size limit; an index whose project folder is gone goes by the same age rule',
    hint,
  ].join('\n'));
  assert.deepEqual(store(), [], 'still no entry after the tools were called');
  assert.equal(fs.existsSync(path.join(DATA, 'indexes')), false, 'the store directory itself is not created');
  // The one line the server says in any session without a configuration file is not about this folder.
  const logged = stderr.split('\n').filter((line) => line.trim() && !/^codegraph: no config file at .*; using defaults$/.test(line));
  assert.deepEqual(logged, [], 'nothing else was logged');
});

test("the workspace's older sibling (`default`) and a folder inside a draft workspace are treated the same", () => {
  for (const workspace of [path.join(HOST, 'default'), path.join(WORKSPACE, 'src')]) {
    const hook = spawnSync(process.execPath, [HOOK, 'session-start'], {
      cwd: workspace,
      env: { ...ENV, ZCODE_PROJECT_DIR: workspace },
      input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: workspace }),
      encoding: 'utf8',
    });
    assert.equal(hook.stdout, '', workspace);
  }
});
