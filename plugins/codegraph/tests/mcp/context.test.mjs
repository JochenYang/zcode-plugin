// Runtime context (src/mcp/context.mjs): lazy creation, caching, reset, and
// the explanatory failure when the indexer module is absent.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getContext, resetContext } from '../../src/mcp/context.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEXER_MODULE = path.join(HERE, '..', '..', 'src', 'index', 'indexer.mjs');
const hasIndexer = fs.existsSync(INDEXER_MODULE);

const dirs = [];
const savedEnv = {};

function withEnv(vars, fn) {
  for (const key of Object.keys(vars)) {
    savedEnv[key] = process.env[key];
    process.env[key] = vars[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(vars)) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
    });
}

function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await resetContext();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

describe('getContext', () => {
  test('creates one context per process from ZCODE_PROJECT_DIR and ZCODE_PLUGIN_DATA; resetContext closes it', async (t) => {
    if (!hasIndexer) {
      t.skip('src/index/indexer.mjs is not present in this checkout');
      return;
    }
    const project = tmpDir('codegraph-ctx-project-');
    const data = tmpDir('codegraph-ctx-data-');
    await withEnv({ ZCODE_PROJECT_DIR: project, ZCODE_PLUGIN_DATA: data }, async () => {
      const ctx = await getContext();
      assert.equal(ctx.root, path.resolve(project));
      assert.equal(ctx.unsafe, false);
      assert.equal(typeof ctx.db.prepare, 'function');
      assert.equal(typeof ctx.indexer.ensureFresh, 'function');
      assert.equal(ctx.db, ctx.indexer.db, 'shares the indexer connection instead of opening a second one');
      assert.equal(ctx.queries, null);
      assert.equal(ctx.map, null);
      assert.equal(ctx.config.autoIndex, true, 'configuration loaded through loadConfig()');
      const status = ctx.indexer.status();
      assert.equal(status.state, 'empty');
      assert.equal(status.dirty, 0);
      assert.equal(await getContext(), ctx, 'cached');

      await resetContext();
      assert.equal(ctx.indexer.closed, true, 'reset closes the indexer');
      const again = await getContext();
      assert.notEqual(again, ctx);
      assert.equal(again.root, path.resolve(project));
    });
  });

  test('a folder that is never indexed gets no indexer and nothing in the store', async () => {
    // A workspace ZCode made itself, in a data folder of ZCode's that was moved elsewhere.
    const base = tmpDir('codegraph-ctx-host-');
    const data = path.join(base, 'data');
    const workspace = path.join(base, 'zcode-cache', '.zcode', 'workspace', 'draft-abc');
    fs.mkdirSync(data, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    await withEnv({ ZCODE_PROJECT_DIR: workspace, ZCODE_PLUGIN_DATA: data }, async () => {
      const ctx = await getContext();
      assert.equal(ctx.hostWorkspace, true);
      assert.equal(ctx.unsafe, false);
      assert.equal(ctx.indexer, null, 'nothing is opened there');
      assert.equal(ctx.db, null);
      assert.equal(ctx.config.autoIndex, true, "the user's settings are still loaded: the store is managed from such a session");
      assert.equal(await getContext(), ctx, 'cached like any context');
      await resetContext();
      assert.equal(fs.existsSync(path.join(data, 'indexes')), false, 'the store is not even created');
    });
    // A home directory: the same refusal. "Home" points at a scratch folder for this process.
    const home = path.join(base, 'home');
    fs.mkdirSync(home);
    await withEnv({ ZCODE_PROJECT_DIR: home, ZCODE_PLUGIN_DATA: data, USERPROFILE: home, HOME: home }, async () => {
      const ctx = await getContext();
      assert.equal(ctx.unsafe, true);
      assert.equal(ctx.hostWorkspace, false);
      assert.equal(ctx.indexer, null);
      assert.equal(ctx.db, null);
      await resetContext();
      assert.equal(fs.existsSync(path.join(data, 'indexes')), false);
    });
  });

  test('rejects with an explanatory error when the indexer module is missing, and does not cache the failure', async (t) => {
    if (hasIndexer) {
      t.skip('indexer module present; the missing-module path is covered by the branch above');
      return;
    }
    const project = tmpDir('codegraph-ctx-nomod-');
    const data = tmpDir('codegraph-ctx-data-');
    await withEnv({ ZCODE_PROJECT_DIR: project, ZCODE_PLUGIN_DATA: data }, async () => {
      await assert.rejects(getContext(), /indexer module \(src\/index\/indexer\.mjs\) is missing/);
      await assert.rejects(getContext(), /indexer module/, 'a failed creation is retried, not cached');
    });
  });

  test('resetContext without a context is a no-op', async () => {
    await resetContext();
    await resetContext();
  });
});
