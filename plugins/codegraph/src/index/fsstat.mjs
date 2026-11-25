// lstat() over many paths without blocking the event loop for the whole batch.
// Windows costs tens of microseconds per statSync; spreading the calls over the
// libuv thread pool keeps a 30k-file walk well under a second. Missing paths are
// simply absent from the result.
//
// lstat, not stat: a link is never followed, here or anywhere a path becomes an indexed file
// (CONTRACTS.md §9). What a link points at can be outside the project or loop, and the one
// enumeration git gives lists a tracked link like any other file.

import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string[]} paths absolute native paths
 * @param {number} [concurrency]
 * @returns {Promise<Map<string, import('node:fs').Stats>>}
 */
export async function statMany(paths, concurrency = 128) {
  const out = new Map();
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, paths.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= paths.length) return;
      const p = paths[i];
      try {
        out.set(p, await fs.promises.lstat(p));
      } catch {
        // deleted between listing and stat, or unreadable: treated as missing
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/** Whether one directory is a link (a junction on Windows, a symbolic link elsewhere). */
export function isLinkDir(dir) {
  try {
    return fs.lstatSync(dir).isSymbolicLink();
  } catch {
    return false; // gone or unreadable: the file's own lstat says what becomes of it
  }
}

/**
 * Whether `abs` is reached through a link below `root`: a directory between the two is a link.
 * The file itself is not looked at — callers lstat it — and neither is `root`, which is the
 * project the user opened, whatever it is on disk. `isLink` answers for one directory; a caller
 * that asks about many files passes one that remembers, or one that reads a batch of stats.
 *
 * @param {string} root the project root, as the paths were built from it
 * @param {string} abs an absolute path under it
 * @param {(dir: string) => boolean} [isLink]
 */
export function underLink(root, abs, isLink = isLinkDir) {
  for (let dir = path.dirname(abs); dir !== root && dir.length > root.length; dir = path.dirname(dir)) {
    if (isLink(dir)) return true;
  }
  return false;
}
