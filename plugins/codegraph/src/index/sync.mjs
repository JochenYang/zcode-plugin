// Change detection (CONTRACTS.md §9). Freshness is the indexer's own job; the
// hooks' dirty.log only accelerates it. Three sources feed the dirty table:
//   - consumeDirtyLog: `<mtimeMs>\t<path>` lines appended by hooks, read from the
//     byte offset recorded in dirty.offset;
//   - statSweep: mtime/size of every indexed file vs the files table;
//   - watch: recursive fs.watch with a 2 s debounce (no-op where unsupported).

import fs from 'node:fs';
import path from 'node:path';
import { indexDir, dirtyLogPath, dirtyOffsetPath, displayPath } from '../paths.mjs';
import { listFiles, markDirty } from '../store/repo.mjs';
import { specForPath } from '../languages/registry.mjs';
import { atomicWriteFile } from './status.mjs';
import { statMany } from './fsstat.mjs';
import { hasIgnoredDir } from './walker.mjs';

const WATCH_DEBOUNCE_MS = 2000;
const MAX_SWEEP_FILES = 20000;

// One throttle clock per database connection: a fresh connection always gets one
// sweep, and repeated ensureFresh() calls within the window only trust dirty.log.
const lastSweep = new WeakMap();

function readOffset(offsetPath) {
  let text;
  try {
    text = fs.readFileSync(offsetPath, 'utf8');
  } catch {
    return 0; // missing, empty or unreadable: start over (re-consuming is idempotent)
  }
  const n = Number.parseInt(text.trim(), 10);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

function writeOffset(offsetPath, offset) {
  atomicWriteFile(offsetPath, String(offset));
}

// Hook paths are relative with '/'; accept native separators, a leading "./" and
// absolute paths inside the root. Anything that resolves outside the root yields
// null, whatever its spelling: `../x`, `sub/../../x`, `a/./../x`, an absolute path
// elsewhere.
export function normalizeDirtyPath(root, raw) {
  let p = String(raw).trim().replace(/\\/g, '/');
  if (!p) return null;
  if (path.isAbsolute(p)) {
    p = displayPath(root, p);
    if (path.isAbsolute(p)) return null;
  }
  // Resolve '.' and '..' segments first: a leading-'..' test alone lets `sub/../../x` through.
  const normalized = path.posix.normalize(p);
  if (!normalized || normalized === '.' || path.posix.isAbsolute(normalized)) return null;
  return normalized === '..' || normalized.startsWith('../') ? null : normalized;
}

/**
 * Consume complete lines appended to dirty.log since the last call and mark the
 * paths dirty. The index directory is never created here: without an index there
 * is nothing to mark.
 *
 * @returns {{ lines: number, paths: number }}
 */
export function consumeDirtyLog(root, db) {
  if (!fs.existsSync(indexDir(root))) return { lines: 0, paths: 0 };
  const logPath = dirtyLogPath(root);
  const offsetPath = dirtyOffsetPath(root);
  let offset = readOffset(offsetPath);

  let size;
  try {
    size = fs.statSync(logPath).size;
  } catch {
    if (offset !== 0) writeOffset(offsetPath, 0);
    return { lines: 0, paths: 0 };
  }
  if (size < offset) offset = 0; // the log was truncated or recreated
  if (size === offset) return { lines: 0, paths: 0 };

  const chunk = Buffer.alloc(size - offset);
  const fd = fs.openSync(logPath, 'r');
  let bytesRead;
  try {
    bytesRead = fs.readSync(fd, chunk, 0, chunk.length, offset);
  } finally {
    fs.closeSync(fd);
  }
  const text = chunk.subarray(0, bytesRead).toString('utf8');
  // Only whole lines: the hook may be mid-append. The last complete line ends with
  // '\n', which never appears inside a UTF-8 multi-byte sequence, so the slice is valid.
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline < 0) return { lines: 0, paths: 0 };
  const complete = text.slice(0, lastNewline + 1);

  const paths = [];
  let lines = 0;
  for (const line of complete.split('\n')) {
    if (!line) continue;
    lines++;
    const tab = line.indexOf('\t');
    if (tab <= 0) continue; // malformed: skip but advance past it
    const rel = normalizeDirtyPath(root, line.slice(tab + 1));
    if (rel) paths.push(rel);
  }
  if (paths.length) markDirty(db, paths);
  writeOffset(offsetPath, offset + Buffer.byteLength(complete, 'utf8'));
  return { lines, paths: paths.length };
}

/**
 * Compare every indexed file's mtime/size with the filesystem and mark the ones
 * that changed (or vanished). Throttled per connection; skipped entirely above
 * MAX_SWEEP_FILES unless forced, where only dirty.log is trusted.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ root: string, force?: boolean, throttleMs?: number }} options
 * @returns {Promise<{ skipped: boolean, reason?: string, files?: number, scanned?: number, changed?: number }>}
 */
export async function statSweep(db, { root, force = false, throttleMs = 5000 } = {}) {
  const now = Date.now();
  const last = lastSweep.get(db) ?? 0;
  if (!force && now - last < throttleMs) return { skipped: true, reason: 'throttled' };
  lastSweep.set(db, now);

  const rows = listFiles(db);
  if (rows.length > MAX_SWEEP_FILES && !force) return { skipped: true, reason: 'too-many-files', files: rows.length };

  const stats = await statMany(rows.map((r) => path.join(root, r.path)), 256);
  const changed = [];
  for (const row of rows) {
    const st = stats.get(path.join(root, row.path));
    if (!st || !st.isFile() || Math.trunc(st.mtimeMs) !== row.mtime_ms || st.size !== row.size) changed.push(row.path);
  }
  if (changed.length) markDirty(db, changed);
  return { skipped: false, files: rows.length, scanned: rows.length, changed: changed.length };
}

/**
 * Watch `root` recursively and mark changed paths dirty after a 2 s debounce.
 * Returns a no-op handle when the platform or filesystem cannot watch, so callers
 * never need to special-case it. Events under the index directory itself are
 * ignored when that directory lives inside the root (markDirty writes there and
 * would otherwise feed back into the watcher).
 *
 * @param {string} root
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{ close: () => void }}
 */
export function watch(root, db, { specs = null } = {}) {
  const pending = new Set();
  let timer = null;
  let closed = false;
  // Only paths a language pack claims can ever become index entries; build output
  // (.map, .tsbuildinfo, snapshots) churns by the thousand during a test run and
  // would otherwise flood the dirty queue and trigger a background build per call.
  const supported = (rel) => (specs ? Boolean(specForPath(rel, specs)) : true);
  const indexed = db.prepare('SELECT 1 FROM files WHERE path = ?');

  // Windows reports the parent directory for creates/deletes too; only regular
  // files (or paths that vanished, which the sync then deletes) are worth marking.
  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.size === 0) return;
    const paths = [];
    for (const rel of pending) {
      let st;
      try {
        st = fs.statSync(path.join(root, rel));
      } catch {
        // A vanished file only matters if the index knows it (the sync drops the row).
        if (indexed.get(rel)) paths.push(rel);
        continue;
      }
      if (st.isFile() && supported(rel)) paths.push(rel);
    }
    pending.clear();
    if (paths.length === 0) return;
    try {
      markDirty(db, paths);
    } catch (err) {
      process.stderr.write(`codegraph: watcher could not mark files dirty (${err.message})\n`);
    }
  }

  // Path of the index directory relative to root, or null when it lives elsewhere.
  let selfPrefix = null;
  const relIndex = path.relative(root, indexDir(root));
  if (relIndex && !relIndex.startsWith('..') && !path.isAbsolute(relIndex)) selfPrefix = relIndex.split(path.sep).join('/');
  const isOwnPath = (rel) => Boolean(selfPrefix) && (rel === selfPrefix || selfPrefix.startsWith(`${rel}/`) || rel.startsWith(`${selfPrefix}/`));

  let watcher;
  try {
    watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
      if (closed || typeof filename !== 'string' || filename.length === 0) return;
      const rel = normalizeDirtyPath(root, filename);
      if (!rel || isOwnPath(rel) || hasIgnoredDir(rel)) return;
      pending.add(rel);
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, WATCH_DEBOUNCE_MS);
      timer.unref?.();
    });
  } catch {
    return { close() {} };
  }

  watcher.on('error', (err) => {
    process.stderr.write(`codegraph: file watcher stopped (${err.message}); relying on dirty.log and mtime scans\n`);
    closed = true;
    try {
      watcher.close();
    } catch {
      // already closed
    }
    flush();
  });

  return {
    close() {
      if (closed) return;
      closed = true;
      try {
        watcher.close();
      } catch {
        // already closed
      }
      flush();
    },
  };
}
