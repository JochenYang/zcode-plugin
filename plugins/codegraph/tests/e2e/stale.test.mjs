// T15/T17: the index follows edits made through the hook path, deletions and new files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Indexer } from '../../src/index/indexer.mjs';
import { acquireLock } from '../../src/index/lock.mjs';
import { lockPath } from '../../src/paths.mjs';
import { applyDefaults } from '../../src/index/defaults.mjs';
import { symbol, callers } from '../../src/graph/queries.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(HERE, '..', '..', 'bin', 'hook.mjs');

function write(root, rel, text) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-stale-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-stale-data-'));
  process.env.ZCODE_PLUGIN_DATA = data;
  write(root, 'a.ts', "import { beta } from './b';\nexport function alpha(): number {\n  return beta();\n}\n");
  write(root, 'b.ts', 'export function beta(): number {\n  return 1;\n}\n');
  write(root, 'c.ts', "import { alpha } from './a';\nexport const gamma = (): number => alpha();\n");
  const ix = new Indexer({ root, config: applyDefaults({ minFilesToAutoIndex: 1 }) });
  await ix.buildAll({ force: true });
  return { root, data, ix };
}

// What ZCode runs after Edit/Write: node bin/hook.mjs post-tool, with the tool payload on stdin.
function runPostTool(root, file) {
  const payload = { hook_event_name: 'PostToolUse', tool_name: 'Edit', cwd: root, tool_input: { file_path: file } };
  const r = spawnSync(process.execPath, [HOOK, 'post-tool'], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ZCODE_PROJECT_DIR: root },
  });
  assert.equal(r.status, 0, `hook exited ${r.status}: ${r.stderr}`);
  return r.stdout;
}

test('edit through the hook path: line numbers and callers follow the new source', async () => {
  const { root, data, ix } = await fixture();
  try {
    const before = symbol(ix.db, { name: 'beta' });
    assert.equal(before.symbol.startLine, 1);
    assert.equal(callers(ix.db, { name: 'beta' }).length, 1);

    // Insert three lines at the top of b.ts: beta moves from line 1 to line 4.
    const file = path.join(root, 'b.ts');
    fs.writeFileSync(file, `// shift 1\n// shift 2\n// shift 3\n${fs.readFileSync(file, 'utf8')}`);
    assert.equal(runPostTool(root, file), '');
    const dirtyLog = path.join(data, 'indexes', fs.readdirSync(path.join(data, 'indexes'))[0], 'dirty.log');
    assert.ok(fs.existsSync(dirtyLog) && fs.readFileSync(dirtyLog, 'utf8').includes('b.ts'), 'hook appended b.ts to dirty.log');

    const r = await ix.ensureFresh();
    assert.equal(r.state, 'ready');
    assert.ok(r.dirty === 0, 'dirty queue drained');
    const after = symbol(ix.db, { name: 'beta' });
    assert.equal(after.symbol.startLine, 4);
    const c = callers(ix.db, { name: 'beta' });
    assert.ok(c.some((x) => x.path === 'a.ts' && x.startLine === 3 && x.resolution === '='), 'alpha() still resolves to beta via import');
  } finally {
    await ix.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('deleted and newly added files are reconciled (branch switch without a hook)', async () => {
  const { root, data, ix } = await fixture();
  try {
    fs.rmSync(path.join(root, 'c.ts'));
    write(root, 'sub/d.ts', 'export function delta(): number {\n  return 2;\n}\n');
    await ix.ensureFresh({ force: true });
    const st = ix.status();
    assert.equal(st.state, 'ready');
    assert.equal(symbol(ix.db, { name: 'gamma' }), null, 'deleted file is gone from the index');
    const d = symbol(ix.db, { name: 'delta' });
    assert.ok(d && d.symbol.path === 'sub/d.ts', 'new file is indexed');
  } finally {
    await ix.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }
});

test('two indexers on one project: an idle session never blocks another; a held lock does', async () => {
  const { root, data, ix } = await fixture();
  const second = new Indexer({ root, config: applyDefaults({ minFilesToAutoIndex: 1 }) });
  // Stands in for another process writing: holds the project's index lock.
  const foreign = await acquireLock(lockPath(root));
  assert.equal(foreign.acquired, true, 'probe lock could be taken (ix is idle and holds nothing)');
  try {
    // ix finished its build and gave the lock back, so a fresh instance is not read-only.
    assert.equal(second.readOnly, false);
    const busy = await second.ensureFresh({ force: true });
    assert.equal(busy.readOnly, true, 'another holder makes this instance read-only for this call');
    assert.equal(busy.state, 'ready');
    assert.ok(symbol(second.db, { name: 'beta' }), 'read-only instance still answers queries');
    foreign.release();
    const r = await second.ensureFresh({ force: true });
    assert.equal(r.readOnly, false, 'the next call simply takes the lock once it is free');
    assert.equal(r.state, 'ready');
    assert.equal(second.readOnly, false);
  } finally {
    foreign.release();
    await second.close();
    await ix.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  }
});
