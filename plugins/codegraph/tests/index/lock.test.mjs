import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { acquireLock, acquireLockSync } from '../../src/index/lock.mjs';
import { scratchDir, rmrf, sleep } from './_helpers.mjs';

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmrf(d);
});

function lockFile() {
  const dir = scratchDir('lock');
  dirs.push(dir);
  return path.join(dir, 'nested', 'lock');
}

// A pid that certainly no longer exists: a child that already exited.
function deadPid() {
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(child.status, 0);
  return child.pid;
}

async function waitFor(file) {
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(file)) return;
    await sleep(20);
  }
  throw new Error(`lock file ${file} never appeared`);
}

describe('acquireLock', () => {
  test('a live pid blocks; waiting gives up after waitMs without touching the foreign lock', async () => {
    const lock = lockFile();
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, `${process.pid}\n`);
    const t0 = Date.now();
    const denied = await acquireLock(lock, { waitMs: 150 });
    assert.equal(denied.acquired, false);
    assert.ok(Date.now() - t0 >= 120, 'waits roughly waitMs before giving up');
    denied.release(); // no-op, must not remove the other holder's file
    assert.equal(fs.readFileSync(lock, 'utf8').trim(), String(process.pid));
  });

  test('a stale pid is reclaimed and release removes only our own lock', async () => {
    const lock = lockFile();
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, `${deadPid()}\n`);
    const got = await acquireLock(lock, { waitMs: 0 });
    assert.equal(got.acquired, true);
    assert.equal(fs.readFileSync(lock, 'utf8').trim(), String(process.pid));
    got.release();
    assert.equal(fs.existsSync(lock), false);
    got.release(); // idempotent
  });

  test('creates the lock directory on demand and reports the holder', async () => {
    const lock = lockFile();
    const got = await acquireLock(lock);
    assert.equal(got.acquired, true);
    assert.equal(fs.readFileSync(lock, 'utf8').trim(), String(process.pid));
    got.release();
  });

  test('garbage content counts as stale', async () => {
    const lock = lockFile();
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, 'not a pid');
    const got = await acquireLock(lock, { waitMs: 0 });
    assert.equal(got.acquired, true);
    got.release();
  });

  test('an empty lock younger than 2 s is a holder mid-write (waited for); an older or future-stamped empty lock is stale', async () => {
    const lock = lockFile();
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    // O_EXCL creates the file before the pid is written: another process can see it empty.
    const fd = fs.openSync(lock, 'wx');
    fs.closeSync(fd);
    const denied = await acquireLock(lock, { waitMs: 200 });
    assert.equal(denied.acquired, false, 'an empty lock that was just created is treated as held');
    assert.equal(fs.readFileSync(lock, 'utf8'), '', 'and the waiter did not remove it');
    // The writer finishes: the waiter now sees the live pid.
    fs.writeFileSync(lock, `${process.pid}\n`);
    assert.equal((await acquireLock(lock, { waitMs: 0 })).acquired, false, 'own pid counts as held');
    // Nobody finished writing and 2 s passed: the file is a dead writer's leftover.
    fs.writeFileSync(lock, '');
    const old = new Date(Date.now() - 5000);
    fs.utimesSync(lock, old, old);
    const got = await acquireLock(lock, { waitMs: 0 });
    assert.equal(got.acquired, true, 'an old empty lock counts as stale');
    assert.equal(fs.readFileSync(lock, 'utf8').trim(), String(process.pid));
    got.release();
    // An empty lock stamped in the future (clock skew) must not block forever either.
    const fd2 = fs.openSync(lock, 'wx');
    fs.closeSync(fd2);
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(lock, future, future);
    const synced = acquireLockSync(lock);
    assert.equal(synced.acquired, true, 'future mtime: stale');
    synced.release();
  });

  test('waits for a holder that exits on its own', async () => {
    const lock = lockFile();
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    const child = spawn(process.execPath, ['-e', `
      require('node:fs').writeFileSync(process.argv[1], String(process.pid));
      setTimeout(() => {}, 400);
    `, lock], { stdio: 'ignore' });
    try {
      await waitFor(lock);
      const t0 = Date.now();
      const got = await acquireLock(lock, { waitMs: 4000 });
      const waited = Date.now() - t0;
      assert.equal(got.acquired, true);
      assert.ok(waited >= 250, `should have waited for the holder (waited ${waited}ms)`);
      assert.equal(fs.readFileSync(lock, 'utf8').trim(), String(process.pid));
      got.release();
    } finally {
      child.kill();
    }
  });

  test('release never removes a lock that was taken over by someone else', async () => {
    const lock = lockFile();
    const got = await acquireLock(lock);
    assert.equal(got.acquired, true);
    fs.writeFileSync(lock, '424242\n');
    got.release();
    assert.equal(fs.readFileSync(lock, 'utf8').trim(), '424242');
  });

  test('acquireLockSync takes a free lock and refuses a held one', () => {
    const lock = lockFile();
    const got = acquireLockSync(lock);
    assert.equal(got.acquired, true);
    const second = acquireLockSync(lock);
    assert.equal(second.acquired, false);
    second.release();
    assert.equal(fs.readFileSync(lock, 'utf8').trim(), String(process.pid));
    got.release();
    assert.equal(fs.existsSync(lock), false);
  });

  test('rejects an empty path', async () => {
    await assert.rejects(acquireLock(''), TypeError);
    assert.throws(() => acquireLockSync('  '), TypeError);
  });
});
