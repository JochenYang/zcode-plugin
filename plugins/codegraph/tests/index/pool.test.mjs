import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createPool, poolSize } from '../../src/index/pool.mjs';
import { hashSource } from '../../src/extract/engine.mjs';
import { scratchDir, rmrf, writeProject, useScratchData, SAMPLE, BROKEN } from './_helpers.mjs';

const data = useScratchData('data-pool');
const dirs = [];
after(() => {
  for (const d of dirs.splice(0)) rmrf(d);
  rmrf(data);
});

describe('pool', () => {
  test('size is min(requested, 4, cpus - 1), never below 1; invalid requests fall back to the default', () => {
    const cpus = os.cpus().length;
    const expected = Math.min(4, Math.max(1, cpus - 1));
    assert.equal(poolSize(1), 1);
    assert.equal(poolSize(4), expected);
    assert.equal(poolSize(8), expected);
    assert.equal(poolSize(0), expected, 'non-positive request means "default"');
    assert.equal(poolSize(-1), expected);
    assert.equal(poolSize(undefined), expected);
    assert.equal(poolSize(2.5), expected);
  });

  test('extracts files, short-circuits unchanged content and reports per-file errors without dying', async () => {
    const dir = scratchDir('pool');
    dirs.push(dir);
    writeProject(dir, { 'a.ts': SAMPLE, 'broken.ts': BROKEN, 'notes.txt': 'x' });
    const pool = createPool({ size: 2 });
    try {
      const a = path.join(dir, 'a.ts');
      const res = await pool.extract({ type: 'extract', path: 'a.ts', abs: a, lang: 'typescript' });
      assert.equal(res.type, 'result');
      assert.equal(res.path, 'a.ts');
      assert.equal(res.extracted.lang, 'typescript');
      assert.ok(res.extracted.symbols.length >= 7);
      assert.equal(res.extracted.parseOk, true);

      const same = await pool.extract({ type: 'extract', path: 'a.ts', abs: a, lang: 'typescript', knownHash: res.extracted.hash });
      assert.deepEqual(same, { type: 'unchanged', path: 'a.ts', hash: res.extracted.hash });
      const other = await pool.extract({ type: 'extract', path: 'a.ts', abs: a, lang: 'typescript', knownHash: 'stale' });
      assert.equal(other.type, 'result');

      const broken = await pool.extract({ type: 'extract', path: 'broken.ts', abs: path.join(dir, 'broken.ts'), lang: 'typescript' });
      assert.equal(broken.type, 'result');
      assert.equal(broken.extracted.parseOk, false);
      assert.ok(broken.extracted.errorNodes > 0);

      // Unsupported file: extraction failed after the read, so the hash is reported.
      await assert.rejects(
        pool.extract({ type: 'extract', path: 'notes.txt', abs: path.join(dir, 'notes.txt'), lang: 'txt' }),
        (err) => /no language pack matches "notes.txt"/.test(err.message) && err.hash === hashSource('x'),
      );
      // Missing file: a read error with the OS code.
      await assert.rejects(
        pool.extract({ type: 'extract', path: 'missing.ts', abs: path.join(dir, 'missing.ts'), lang: 'typescript' }),
        (err) => err.code === 'ENOENT' && /cannot read missing\.ts/.test(err.message),
      );
      // The pool still works afterwards.
      const again = await pool.extract({ type: 'extract', path: 'a.ts', abs: a, lang: 'typescript' });
      assert.equal(again.type, 'result');
    } finally {
      await pool.close();
    }
    await assert.rejects(pool.extract({ type: 'extract', path: 'a.ts', abs: 'x', lang: 'typescript' }), /pool is closed/);
  });

  test('many jobs run concurrently and every one completes', async () => {
    const dir = scratchDir('pool-many');
    dirs.push(dir);
    const files = Array.from({ length: 12 }, (_, i) => `f${i}.ts`);
    writeProject(dir, Object.fromEntries(files.map((f, i) => [f, `${SAMPLE}\n// ${i}\n`])));
    const pool = createPool({ size: 2 });
    try {
      const results = await Promise.all(files.map((f) => pool.extract({ type: 'extract', path: f, abs: path.join(dir, f), lang: 'typescript' })));
      assert.equal(results.length, files.length);
      assert.ok(results.every((r) => r.type === 'result' && r.extracted.symbols.length >= 7));
      assert.equal(new Set(results.map((r) => r.extracted.hash)).size, files.length);
    } finally {
      await pool.close();
    }
  });

  test('a worker that dies mid-job rejects only that job; the replacement finishes the rest', { timeout: 30000 }, async () => {
    const pool = createPool({ size: 1, workerUrl: new URL('./_stub_worker.mjs', import.meta.url) });
    try {
      const results = await Promise.allSettled(['a.ts', 'crash.ts', 'b.ts', 'c.ts'].map((p) => pool.extract({ type: 'extract', path: p, abs: p, lang: 'typescript' })));
      assert.equal(results[0].status, 'fulfilled');
      assert.equal(results[0].value.path, 'a.ts');
      assert.equal(results[1].status, 'rejected', 'the job that killed its worker fails');
      assert.match(results[1].reason.message, /exited unexpectedly \(code 3\)/);
      assert.equal(results[1].reason.poolFatal, undefined, 'a single crash is not a pool failure');
      assert.equal(results[2].status, 'fulfilled', 'respawned worker picks up the queue');
      assert.equal(results[2].value.path, 'b.ts');
      assert.equal(results[3].status, 'fulfilled');
    } finally {
      await pool.close();
    }
  });

  test('workers that cannot start make the pool give up with a fatal error instead of hanging', { timeout: 30000 }, async () => {
    const pool = createPool({ size: 1, workerUrl: new URL('./_crash_worker.mjs', import.meta.url) });
    try {
      const jobs = ['a.ts', 'b.ts'].map((p) => pool.extract({ type: 'extract', path: p, abs: p, lang: 'typescript' }));
      const settled = await Promise.allSettled(jobs);
      assert.ok(settled.every((r) => r.status === 'rejected'), 'no job is left pending');
      for (const r of settled) {
        assert.match(r.reason.message, /workers keep crashing/);
        assert.equal(r.reason.poolFatal, true);
      }
      await assert.rejects(pool.extract({ type: 'extract', path: 'c.ts', abs: 'c.ts', lang: 'typescript' }), /pool is closed/);
    } finally {
      await pool.close();
    }
  });

  test('a worker that never answers is terminated after jobTimeoutMs: that job rejects with ETIMEDOUT, not a hang', { timeout: 30000 }, async () => {
    const pool = createPool({ size: 1, workerUrl: new URL('./_silent_worker.mjs', import.meta.url), jobTimeoutMs: 150 });
    try {
      const t0 = Date.now();
      const settled = await Promise.allSettled([
        pool.extract({ type: 'extract', path: 'stuck.ts', abs: 'stuck.ts', lang: 'typescript' }),
        pool.extract({ type: 'extract', path: 'queued.ts', abs: 'queued.ts', lang: 'typescript' }),
      ]);
      const elapsed = Date.now() - t0;
      assert.ok(settled.every((r) => r.status === 'rejected'), 'both jobs settle');
      for (const r of settled) {
        assert.equal(r.reason.code, 'ETIMEDOUT');
        assert.match(r.reason.message, /timed out after 150 ms/);
        assert.equal(r.reason.poolFatal, undefined, 'a hang is the file\'s (or the machine\'s) problem, not a pool failure');
      }
      assert.match(settled[0].reason.message, /stuck\.ts/);
      assert.match(settled[1].reason.message, /queued\.ts/, 'the replacement worker took the second job and timed out on it too');
      assert.ok(elapsed >= 140 && elapsed < 10_000, `two timeouts took ${elapsed} ms`);
    } finally {
      await pool.close();
    }
  });

  test('a worker dying on its first job three times in a row on one slot escalates to a pool failure', { timeout: 30000 }, async () => {
    const pool = createPool({ size: 2, workerUrl: new URL('./_first_job_crash_worker.mjs', import.meta.url) });
    try {
      const names = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'];
      const settled = await Promise.allSettled(names.map((p) => pool.extract({ type: 'extract', path: p, abs: p, lang: 'typescript' })));
      assert.ok(settled.every((r) => r.status === 'rejected'), 'no job is left pending');
      // The first two deaths per slot are reported as the worker's own exit; the
      // third on a slot is the evidence that the engine, not the files, is broken.
      const fatal = settled.filter((r) => r.reason.poolFatal === true);
      assert.ok(fatal.length >= 1, 'at least one job carries the pool failure');
      for (const r of fatal) assert.match(r.reason.message, /failing on their first job \(3 in a row/);
      for (const r of settled.filter((x) => x.reason.poolFatal !== true)) assert.match(r.reason.message, /exited unexpectedly \(code 7\)/);
      await assert.rejects(pool.extract({ type: 'extract', path: 'g.ts', abs: 'g.ts', lang: 'typescript' }), /pool is closed/);
    } finally {
      await pool.close();
    }
  });
});
