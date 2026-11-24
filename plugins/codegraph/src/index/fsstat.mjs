// stat() over many paths without blocking the event loop for the whole batch.
// Windows costs tens of microseconds per statSync; spreading the calls over the
// libuv thread pool keeps a 30k-file walk well under a second. Missing paths are
// simply absent from the result.

import fs from 'node:fs';

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
        out.set(p, await fs.promises.stat(p));
      } catch {
        // deleted between listing and stat, or unreadable: treated as missing
      }
    }
  });
  await Promise.all(workers);
  return out;
}
