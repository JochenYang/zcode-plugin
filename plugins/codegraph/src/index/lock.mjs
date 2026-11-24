// pid-based write lock for an index directory (CONTRACTS.md §3.3). The file holds
// the owner's pid; a pid that no longer exists means the lock is stale and may be
// removed. Two processes can still both judge a lock stale at the same instant:
// each re-reads the pid right before unlinking and verifies its own pid after
// creating, which narrows the window but cannot close it on a plain filesystem.
// The database stays consistent either way (WAL + busy timeout); the cost of the
// race is duplicated work, never corruption.
//
// The file is created with O_EXCL and written right after, so a reader can see it
// empty for a moment. An empty file whose mtime is within FRESH_LOCK_MS of now is
// therefore a lock being taken right now and is waited for; an empty file older
// than that (or stamped further into the future) is a writer that died in between
// and counts as stale.
//
// `lockHeld` is the read-only counterpart: it answers whether a live process holds the
// lock and leaves the file alone. The store uses it to decide whether an index may be removed.

import fs from 'node:fs';
import path from 'node:path';

const POLL_MS = 50;
const FRESH_LOCK_MS = 2000;

// Locks held by this process, released on 'exit' so a normal shutdown leaves no
// stale file. A crash (or SIGKILL) still relies on pid liveness.
const held = new Set();
let exitHookInstalled = false;

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user.
    return err.code === 'EPERM';
  }
}

// Lock state read from the file: null = absent; FRESH = empty and just created
// (treated as held); a positive pid = that holder; -1 = anything else (stale).
const FRESH = -2;

function readPid(lockPath) {
  let text;
  let mtimeMs;
  try {
    text = fs.readFileSync(lockPath, 'utf8');
    mtimeMs = fs.statSync(lockPath).mtimeMs;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (text.trim() === '') {
    // |age| rather than 0 <= age: the filesystem clock can lead Date.now() by about a
    // millisecond on Windows, so a file created an instant ago reads as "from the future".
    const age = Date.now() - mtimeMs;
    return Math.abs(age) < FRESH_LOCK_MS ? FRESH : -1;
  }
  const pid = Number.parseInt(text.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : -1;
}

function tryCreate(lockPath) {
  try {
    fs.writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx' });
    return true;
  } catch (err) {
    // A write failure after the open leaves an empty file; it turns stale on its own after FRESH_LOCK_MS.
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

function removeStale(lockPath, expectedPid) {
  if (readPid(lockPath) !== expectedPid) return; // replaced under us: not ours to remove
  try {
    fs.unlinkSync(lockPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// One non-blocking attempt: create, or reclaim a stale lock and create.
function attempt(lockPath) {
  if (tryCreate(lockPath)) return readPid(lockPath) === process.pid;
  const pid = readPid(lockPath);
  if (pid === null) return tryCreate(lockPath) && readPid(lockPath) === process.pid;
  if (pid === FRESH || pid === process.pid || isAlive(pid)) return false;
  removeStale(lockPath, pid);
  if (tryCreate(lockPath)) return readPid(lockPath) === process.pid;
  return false;
}

function makeRelease(lockPath) {
  const release = () => {
    if (!held.has(release)) return;
    held.delete(release);
    if (readPid(lockPath) === process.pid) {
      try {
        fs.unlinkSync(lockPath);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
  };
  held.add(release);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => {
      for (const fn of [...held]) {
        try {
          fn();
        } catch {
          // best effort at shutdown
        }
      }
    });
  }
  return release;
}

const noop = () => {};

/**
 * Is a live process holding this lock right now? Read-only: a stale lock file is
 * left in place for the next writer to reclaim. A lock that cannot be read counts
 * as held, so a caller deciding whether an index may be removed stays on the safe side.
 *
 * @param {string} lockPath
 * @returns {boolean}
 */
export function lockHeld(lockPath) {
  try {
    const pid = readPid(lockPath);
    return pid !== null && (pid === FRESH || pid === process.pid || isAlive(pid));
  } catch {
    return true;
  }
}

function prepare(lockPath) {
  if (typeof lockPath !== 'string' || lockPath.trim().length === 0) {
    throw new TypeError('acquireLock: "lockPath" must be a non-empty string');
  }
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
}

/**
 * Take the lock, polling until it is free or `waitMs` has elapsed.
 *
 * @param {string} lockPath
 * @param {{ waitMs?: number }} [options]
 * @returns {Promise<{ acquired: boolean, release: () => void }>}
 */
export async function acquireLock(lockPath, { waitMs = 5000 } = {}) {
  prepare(lockPath);
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    if (attempt(lockPath)) return { acquired: true, release: makeRelease(lockPath) };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { acquired: false, release: noop };
    await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_MS, remaining)));
  }
}

/**
 * Non-blocking variant for constructors that cannot await.
 * @returns {{ acquired: boolean, release: () => void }}
 */
export function acquireLockSync(lockPath) {
  prepare(lockPath);
  return attempt(lockPath) ? { acquired: true, release: makeRelease(lockPath) } : { acquired: false, release: noop };
}
