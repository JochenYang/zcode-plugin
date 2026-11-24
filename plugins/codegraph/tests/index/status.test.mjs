import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readStatus, writeStatus, defaultStatus, atomicWriteFile } from '../../src/index/status.mjs';
import { statusPath } from '../../src/paths.mjs';
import { PLUGIN_VERSION } from '../../src/version.mjs';
import { scratchDir, rmrf, useScratchData } from './_helpers.mjs';

const data = useScratchData('data-status');
const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmrf(d);
});
after(() => rmrf(data));

describe('status.json', () => {
  test('defaults carry every §3.1 field, the plugin version and a normalised root', () => {
    const dir = scratchDir('status-defaults');
    dirs.push(dir);
    assert.equal(readStatus(dir), null);
    const st = defaultStatus(dir);
    assert.deepEqual(st, {
      schema: 1,
      pluginVersion: PLUGIN_VERSION,
      root: dir.split(path.sep).join('/'),
      state: 'empty',
      indexedAt: 0,
      filesTotal: 0,
      filesDone: 0,
      symbols: 0,
      languages: {},
      stale: 0,
      error: null,
      reason: null,
    });
  });

  test('writeStatus merges a patch over the current file and is readable at once', () => {
    const dir = scratchDir('status-write');
    dirs.push(dir);
    const written = writeStatus(dir, { state: 'building', filesTotal: 12, filesDone: 3 });
    assert.equal(written.state, 'building');
    assert.equal(written.schema, 1);
    assert.equal(written.pluginVersion, PLUGIN_VERSION);
    const read = readStatus(dir);
    assert.deepEqual(read, written);
    const next = writeStatus(dir, { filesDone: 12, state: 'ready', symbols: 40, languages: { typescript: 12 }, indexedAt: 5 });
    assert.equal(next.filesTotal, 12, 'fields not in the patch survive');
    assert.equal(next.symbols, 40);
    assert.deepEqual(readStatus(dir), next);
  });

  test('writes are atomic: a temp file in the same directory, renamed over the target, nothing left behind', () => {
    const dir = scratchDir('status-atomic');
    dirs.push(dir);
    writeStatus(dir, { state: 'ready' });
    assert.deepEqual(fs.readdirSync(path.dirname(statusPath(dir))), ['status.json']);
    const first = fs.statSync(statusPath(dir));
    for (let i = 0; i < 20; i++) writeStatus(dir, { symbols: i });
    const last = fs.statSync(statusPath(dir));
    assert.notEqual(last.mtimeMs, first.mtimeMs, 'the target was rewritten');
    assert.equal(readStatus(dir).symbols, 19, 'the final content is complete and parseable');
    assert.deepEqual(fs.readdirSync(path.dirname(statusPath(dir))), ['status.json'], 'no temp files remain');
  });

  test('a corrupt file reads as null and is repaired by the next write', () => {
    const dir = scratchDir('status-corrupt');
    dirs.push(dir);
    fs.mkdirSync(path.dirname(statusPath(dir)), { recursive: true });
    fs.writeFileSync(statusPath(dir), '{"state": "ready"');
    assert.equal(readStatus(dir), null);
    const st = writeStatus(dir, { state: 'ready' });
    assert.equal(readStatus(dir).state, 'ready');
    assert.equal(st.schema, 1);
  });

  test('validates state, counters, languages, error and reason', () => {
    const dir = scratchDir('status-validate');
    dirs.push(dir);
    assert.throws(() => writeStatus(dir, { state: 'done' }), /"state" must be one of/);
    assert.throws(() => writeStatus(dir, { filesTotal: -1 }), /"filesTotal" must be a non-negative integer/);
    assert.throws(() => writeStatus(dir, { symbols: 1.5 }), /"symbols" must be a non-negative integer/);
    assert.throws(() => writeStatus(dir, { languages: [] }), /"languages" must be an object/);
    assert.throws(() => writeStatus(dir, { error: 42 }), /"error" must be a string or null/);
    assert.throws(() => writeStatus(dir, { reason: 7 }), /"reason" must be a string or null/);
    assert.throws(() => writeStatus(dir, null), /"patch" must be an object/);
    assert.equal(fs.existsSync(statusPath(dir)), false, 'nothing is written for an invalid patch');
    const ok = writeStatus(dir, { state: 'empty', reason: 'below-min-files', error: null });
    assert.equal(ok.reason, 'below-min-files');
  });

  test('atomicWriteFile replaces existing content and creates parent directories', () => {
    const dir = scratchDir('status-aw');
    dirs.push(dir);
    const file = path.join(dir, 'a', 'b', 'file.txt');
    atomicWriteFile(file, 'one');
    assert.equal(fs.readFileSync(file, 'utf8'), 'one');
    atomicWriteFile(file, 'two');
    assert.equal(fs.readFileSync(file, 'utf8'), 'two');
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['file.txt']);
  });
});
