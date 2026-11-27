// The index store as a whole (CONTRACTS.md §3.4). Every project a session opens gets an index
// under <data>/indexes/<project key>/, and before this module nothing ever removed one: an
// index of a project that was deleted or abandoned stayed forever.
//
// An index may go when
//   - it is no index of any project: an entry an older version left for a folder that is never
//     indexed (a workspace ZCode made itself, a home or drive root) ('not-a-project');
//   - it last served a session more than `maxIdleDays` ago ('idle'; reported 'orphan' when its
//     project folder is also gone), when a limit is set;
//   - the store is over `maxTotalBytes` and it is among the least recently used ('over-quota');
//   - a request says `all` ('requested').
// A project folder that cannot be reached (an unplugged drive, an unmounted share) is no reason
// on its own: the age rule treats it like any other index, so it survives until it is unused
// for long, whatever the filesystem says today.
// Never removed: the project the caller keeps (the one this session works on) and any index
// whose lock a live process holds. All of it is derived data; an index that was removed is
// rebuilt the next time a session opens its project.

import fs from 'node:fs';
import path from 'node:path';
import { dataDir, indexDir, isHostWorkspacePath } from '../paths.mjs';
import { readStatusFile, atomicWriteFile } from './status.mjs';
import { lockHeld } from './lock.mjs';

const DAY_MS = 24 * 60 * 60_000;
// Written at session start and, during a long session, at most this often: the stamp of an
// index that is in use must not grow old enough to look idle.
const USAGE_INTERVAL_MS = 60 * 60_000;
const USAGE_FILE = 'used.at';
const KEY = /^[0-9a-f]{16}$/;

/** The directory every index lives under. `data` is the plugin data directory; the extension names it explicitly instead of relying on the environment. */
export function indexesDir(data = dataDir()) {
  return path.join(data, 'indexes');
}

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

// Bytes on disk of everything under `dir`. An index holds a handful of files, the session
// markers being the only directory.
function bytesOf(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += bytesOf(full);
    else if (entry.isFile()) total += sizeOf(full);
  }
  return total;
}

// The newest moment the index was used: the stamp, the status, the edit log the hooks append
// to, the lock, and the per-session markers the hooks write. A session that is open but idle
// for long still counts as long as anything of it touched the directory.
function lastUsedAt(dir, status) {
  let last = Number(status?.indexedAt) || 0;
  for (const name of [USAGE_FILE, 'status.json', 'dirty.log', 'lock']) last = Math.max(last, mtimeOf(path.join(dir, name)));
  try {
    last = Math.max(last, Number(fs.readFileSync(path.join(dir, USAGE_FILE), 'utf8')) || 0);
  } catch {
    // no stamp yet: the file times decide
  }
  try {
    for (const name of fs.readdirSync(path.join(dir, 'announced'))) last = Math.max(last, mtimeOf(path.join(dir, 'announced', name)));
  } catch {
    // no session markers
  }
  return Math.trunc(last);
}

/**
 * Record that the project's index served a session now. Never creates the index directory:
 * a project without an index has nothing to stamp.
 *
 * @param {string} root  project root
 * @param {{ now?: number }} [options]
 * @returns {boolean} whether a stamp was written
 */
export function touchUsage(root, { now = Date.now() } = {}) {
  const dir = indexDir(root);
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  const file = path.join(dir, USAGE_FILE);
  let last = 0;
  try {
    last = Number(fs.readFileSync(file, 'utf8')) || 0;
  } catch {
    // first use
  }
  // A stamp from the future (clock moved back) is rewritten rather than trusted.
  if (last <= now && now - last < USAGE_INTERVAL_MS) return false;
  try {
    atomicWriteFile(file, String(now));
    return true;
  } catch {
    return false;
  }
}

/**
 * Every index of the store, least recently used first.
 * @param {{ probe?: boolean, data?: string }} [options]  `probe` (default) checks whether each
 *   project folder still exists, to tell an orphan from an index in use. It is a filesystem call
 *   per project and can wait a long time for a path on an unreachable network share, so the
 *   automatic sweep does without it: the age rule does not need the answer. `data` is the
 *   plugin data directory to read (the extension names the one the host told it).
 * @returns {{ key: string, dir: string, root: string|null, state: string, files: number, filesDone: number, symbols: number,
 *   bytes: number, lastUsedAt: number, inUse: boolean, orphan: boolean, notAProject: boolean }[]}
 *   `notAProject`: an entry that holds nothing and was left for a folder that is never indexed
 *   (see `noProject`); the sweep takes it whatever the limits say
 */
export function listIndexes({ probe = true, data = dataDir() } = {}) {
  const base = indexesDir(data);
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return []; // no store yet
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !KEY.test(entry.name)) continue;
    const dir = path.join(base, entry.name);
    // A status file that cannot be read is no reason to hide the index: it is listed by key.
    const status = readStatusSafely(path.join(dir, 'status.json'));
    const root = typeof status?.root === 'string' && status.root ? status.root : null;
    out.push({
      key: entry.name,
      dir,
      root,
      state: typeof status?.state === 'string' ? status.state : 'unknown',
      files: Number(status?.filesTotal) || 0,
      // How far a build got; equals `files` once the index is ready.
      filesDone: Number(status?.filesDone) || 0,
      symbols: Number(status?.symbols) || 0,
      bytes: bytesOf(dir),
      lastUsedAt: lastUsedAt(dir, status),
      inUse: lockHeld(path.join(dir, 'lock')),
      orphan: probe && root !== null && !fs.existsSync(root),
      notAProject: noProject(root, status),
    });
  }
  return out.sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.key.localeCompare(b.key));
}

// Whether an entry is one an older version left for a folder that is never indexed: a workspace
// ZCode made itself, or a home or drive root (which was recorded as an empty index with that
// reason). Such folders get no entry any more, so the entry is no index of anything. Judged on
// the stored path alone: the store must not touch a project folder it has not probed. An entry
// that holds files is left alone whatever its path: nothing that was built is deleted for where
// it lies (the age rule takes it in the end, since no session uses it any more).
function noProject(root, status) {
  if (Number(status?.filesTotal) > 0) return false;
  if (root && isHostWorkspacePath(root)) return true;
  return status?.state === 'empty' && status.reason === 'unsafe-root';
}

function readStatusSafely(file) {
  try {
    return readStatusFile(file);
  } catch {
    return null;
  }
}

/**
 * Which indexes may be removed, and why. Pure: no filesystem access, so the policy can be
 * tested on made-up entries.
 *
 * @param {ReturnType<typeof listIndexes>} entries
 * @param {{ keep?: string[], maxIdleDays?: number, maxTotalBytes?: number, all?: boolean, now?: number }} [options]
 *   `keep` lists project keys that stay whatever their age (the project of this session);
 *   `all` marks every other index, for an explicit request to empty the store
 * @returns {{ remove: Array<object & { reason: 'not-a-project'|'orphan'|'idle'|'over-quota'|'requested' }>, kept: object[] }}
 */
export function planSweep(entries, { keep = [], maxIdleDays = 0, maxTotalBytes = 0, all = false, now = Date.now() } = {}) {
  const keptKeys = new Set(keep);
  const removable = entries
    .filter((entry) => !keptKeys.has(entry.key) && !entry.inUse)
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.key.localeCompare(b.key));
  const verdict = new Map();
  const idleMs = maxIdleDays > 0 ? maxIdleDays * DAY_MS : 0;
  for (const entry of removable) {
    if (entry.notAProject === true) verdict.set(entry.key, 'not-a-project');
    else if (all) verdict.set(entry.key, 'requested');
    else if (idleMs > 0 && now - entry.lastUsedAt > idleMs) verdict.set(entry.key, entry.orphan ? 'orphan' : 'idle');
  }
  if (maxTotalBytes > 0) {
    let total = entries.reduce((sum, entry) => (verdict.has(entry.key) ? sum : sum + entry.bytes), 0);
    for (const entry of removable) {
      if (total <= maxTotalBytes) break;
      if (verdict.has(entry.key)) continue;
      verdict.set(entry.key, 'over-quota');
      total -= entry.bytes;
    }
  }
  // Reported in the order they would have gone: what is no index at all first, then the certain
  // garbage, then the oldest.
  const rank = { 'not-a-project': 0, orphan: 1, idle: 2, 'over-quota': 3, requested: 4 };
  const remove = entries
    .filter((entry) => verdict.has(entry.key))
    .map((entry) => ({ ...entry, reason: verdict.get(entry.key) }))
    .sort((a, b) => rank[a.reason] - rank[b.reason] || a.lastUsedAt - b.lastUsedAt || a.key.localeCompare(b.key));
  return { remove, kept: entries.filter((entry) => !verdict.has(entry.key)) };
}

/**
 * Delete one index directory. Only a direct child of the store named by a project key is
 * accepted, so a wrong path can never remove anything else.
 *
 * @param {string} dir
 * @param {string} [data]  the plugin data directory the store is read from
 * @returns {boolean} false when nothing was removed: a file of the index is open elsewhere
 *   (Windows keeps an open file locked), the filesystem refused, or the directory is not empty
 *   after the retries. Only a path outside the store throws.
 */
export function removeIndex(dir, data = dataDir()) {
  if (path.dirname(path.resolve(dir)) !== path.resolve(indexesDir(data)) || !KEY.test(path.basename(dir))) {
    throw new Error(`removeIndex: ${dir} is not an index directory of this store`);
  }
  const options = { force: true, maxRetries: 3, retryDelay: 50 };
  // The database files are the only ones another process can hold open. They go first, so an
  // index that is busy is left complete instead of losing its status around a database that stays.
  // Every filesystem error means "not now": the caller reports it and the next sweep retries.
  try {
    for (const name of ['graph.db', 'graph.db-wal', 'graph.db-shm']) fs.rmSync(path.join(dir, name), options);
    fs.rmSync(dir, { ...options, recursive: true });
  } catch (err) {
    if (typeof err?.code === 'string') return false;
    throw err;
  }
  return true;
}

/**
 * Delete one listed index unless a live process holds its lock. Read again right before the
 * removal: a session may have opened the project since the listing.
 *
 * @param {{ dir: string }} entry  from `listIndexes`
 * @param {string} [data]  the plugin data directory the store is read from
 * @returns {boolean} false when the index is in use or could not be removed
 */
export function removeListed(entry, data = dataDir()) {
  return !lockHeld(path.join(entry.dir, 'lock')) && removeIndex(entry.dir, data);
}

/**
 * Apply the policy to the store. One index that cannot be removed does not stop the others.
 *
 * @param {{ keep?: string[], maxIdleDays?: number, maxTotalBytes?: number, now?: number, probe?: boolean, entries?: object[] }} [options]
 *   `entries` defaults to a listing without the reachability probe (see `listIndexes`)
 * @returns {{ removed: object[], busy: object[] }} indexes that were deleted, and those that
 *   were due but could not be deleted (`error` names the filesystem error, when there was one)
 */
export function sweepIndexes({ keep = [], maxIdleDays = 0, maxTotalBytes = 0, now = Date.now(), probe = false, data = dataDir(), entries = listIndexes({ probe, data }) } = {}) {
  const { remove } = planSweep(entries, { keep, maxIdleDays, maxTotalBytes, now });
  const removed = [];
  const busy = [];
  for (const entry of remove) {
    try {
      (removeListed(entry, data) ? removed : busy).push(entry);
    } catch (err) {
      busy.push({ ...entry, error: err?.code ?? String(err?.message ?? err) });
    }
  }
  return { removed, busy };
}
