// Property reads (`row.membershipKind`) for a name that no symbol carries (CONTRACTS.md §8).
//
// The index records calls and type names, not a property read: it is a property of some object,
// never a reference the resolver could link, and there are too many of them to keep — a fifth
// to a third again as many rows as all references, most of them `.length` (2026-11-25, two
// repositories). So they are looked for when they are asked for: every JavaScript and
// TypeScript file is read once and searched for the name behind a dot, only the files with a
// hit are parsed, and tree-sitter decides.
//
// This is the one query that reads the source files, and it does so in a worker of its own
// (`propertyReadsWorker.mjs`), as every parse does (CONTRACTS.md §9): the server's main thread
// only waits for the answer and gives up after SCAN_TIMEOUT_MS. Nothing here is stored, so
// nothing here can be stale or needs a rebuild. Every limit names the step it bounds, and a
// scan that hits one returns what it has with `stopped`, which the caller reports as a lower
// bound.
import { Worker } from 'node:worker_threads';
import { isSecondaryPath, prepare } from '../store/repo.mjs';

const LANGS = ['typescript', 'tsx', 'javascript'];
// More files than this with a hit: the name is read everywhere (`.length`, `.id`), which says
// nothing about where to look.
export const SCAN_FILES_MAX = 60;
// Every limit of a scan, with the step it bounds. A file bigger than `maxFileBytes` is skipped
// as the indexer skips it; `maxReadBytes` bounds the read-and-search step; `maxHits` is how
// many prefilter hits are worth parsing at all (twice what a search puts in front of a symbol);
// `maxParseBytes` bounds the parse step, the smallest files first. That one is about time:
// written code parses at about 4 MB/s and a minified bundle at about 1 MB/s (2026-11-25), so
// two megabytes are half a second in the common case and two in the worst.
export const SCAN_LIMITS = Object.freeze({
  maxFiles: SCAN_FILES_MAX,
  maxFileBytes: 4 * 1024 * 1024,
  maxReadBytes: 64 * 1024 * 1024,
  maxHits: 400,
  maxParseBytes: 2 * 1024 * 1024,
});
export const SCAN_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 30_000;
// An ASCII identifier, as the prefilter needs it spelled: a guess with spaces, dots or
// separators is not a property read and is not looked for.
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const NOTHING = Object.freeze({ rows: [], uses: 0, files: 0, fileIds: [], names: [], capped: false, skipped: null });
const FILES_SQL = `SELECT id, path, lang FROM files WHERE lang IN (${LANGS.map(() => '?').join(', ')}) ORDER BY path`;
const SYMBOLS_SQL = 'SELECT name, qual, kind, start_line, end_line, start_col FROM symbols WHERE file_id = ? ORDER BY start_line, end_line DESC, start_col DESC';

let worker = null;
let ready = null;
let failed = false;
const pending = new Map();
let nextId = 1;
// How the scan worker is created. Tests substitute this to hold a worker's events in their own
// hands (one that answers late, or dies); nothing else does.
let createWorker = (url) => new Worker(url);

/**
 * Test seam: make the scan worker come from `factory`. It is called with the worker module's
 * URL and must return what `Worker` gives this module (`on`, `once`, `off`, `ref`, `unref`,
 * `postMessage`, `terminate`). `null` restores the real one. A worker that already started is
 * not replaced: set this before the first scan of a process.
 *
 * @param {((url: URL) => object) | null} factory
 */
export function setScanWorkerFactory(factory) {
  createWorker = factory ?? ((url) => new Worker(url));
}

function say(message) {
  process.stderr.write(`codegraph: property reads: ${message}\n`);
}

// The worker is gone (crashed, replaced after a timeout): what waits for it fails, and the
// next scan starts a new one.
function loseWorker() {
  for (const [id, { reject }] of pending) {
    pending.delete(id);
    reject(new Error('the scan worker went away'));
  }
  worker = null;
  ready = null;
}

function onMessage(msg) {
  const entry = msg?.type === 'scan' ? pending.get(msg.id) : null;
  if (!entry) return;
  pending.delete(msg.id);
  entry.resolve({
    files: Array.isArray(msg.files) ? msg.files : [],
    stopped: msg.stopped ?? null,
    unreadable: Number.isInteger(msg.unreadable) && msg.unreadable > 0 ? msg.unreadable : 0,
  });
  if (pending.size === 0) worker?.unref();
}

/**
 * Start the scan worker and wait until it has loaded its parsers, once per process. Call it
 * when a process starts that will answer searches. Resolves to false when the worker cannot be
 * started, and the scan stays off for the life of the process then: the parsers are what is
 * broken, and every retry would fail the same way. A worker that crashes or stops answering is
 * replaced by the next scan.
 *
 * @returns {Promise<boolean>}
 */
export function warmPropertyReads() {
  if (ready) return ready;
  if (failed) return Promise.resolve(false);
  ready = (async () => {
    const started = createWorker(new URL('./propertyReadsWorker.mjs', import.meta.url));
    let giveUp = null; // fails the wait for 'ready' while the worker is not ready yet
    // For as long as it lives: an 'error' nobody listens to ends the process.
    started.on('error', (err) => {
      // While it starts, the wait below reports the failure; afterwards this is the only place.
      if (!giveUp) say(`the scan worker failed (${err.message})`);
      giveUp?.(err);
    });
    started.on('exit', (code) => {
      // Not this one: a worker replaced after a timeout exits too, and its going was booked then.
      if (worker !== started) {
        giveUp?.(new Error(`the scan worker exited with code ${code} before it was ready`));
        return;
      }
      say(`the scan worker exited (code ${code})`);
      loseWorker();
    });
    let timer = null;
    try {
      await new Promise((resolve, reject) => {
        giveUp = reject;
        timer = setTimeout(() => {
          void started.terminate().catch(() => {});
          reject(new Error(`the scan worker did not start in ${START_TIMEOUT_MS} ms`));
        }, START_TIMEOUT_MS);
        started.once('message', (msg) => {
          if (msg?.type !== 'ready') return;
          resolve();
        });
      });
    } finally {
      // Whichever way the wait ended: a timer left behind keeps a process alive for its whole length.
      clearTimeout(timer);
      giveUp = null;
    }
    worker = started;
    started.on('message', onMessage);
    // A 'message' listener keeps the worker referenced (and so keeps a process that has nothing
    // else to do alive, as a test run): idle it is unreferenced, and referenced again only
    // while an answer is pending.
    started.unref();
    return true;
  })().catch((err) => {
    failed = true;
    say(`off in this process (${err.message})`);
    return false;
  });
  return ready;
}

// Replace a worker that stopped answering: it may be stuck in a parse that cannot be interrupted.
async function replaceWorker() {
  const stuck = worker;
  loseWorker();
  if (stuck) await stuck.terminate().catch(() => {});
}

// The innermost definition that contains a position: a method inside a class, not the class;
// of two definitions that start on the same line, the one that starts before the position
// and nearest to it.
function ownerAt(symbols, line, column) {
  let best = null;
  for (const symbol of symbols) {
    if (symbol.start_line > line || symbol.end_line < line) continue;
    if (symbol.start_line === line && symbol.start_col > column) continue;
    const deeper = best && (symbol.start_line > best.start_line
      || (symbol.start_line === best.start_line && symbol.end_line < best.end_line)
      || (symbol.start_line === best.start_line && symbol.end_line === best.end_line && symbol.start_col > best.start_col));
    if (!best || deeper) best = symbol;
  }
  return best;
}

/**
 * The places that read `query` as a property, in the shape of `searchRefs` (CONTRACTS.md §7):
 * one row per name, receiver, file and the symbol that contains it, `kind` = `property`.
 * Source files come before tests and scripts, then by path, line and receiver, the order
 * `searchRefs` uses.
 *
 * @param {{ root: string, db: import('node:sqlite').DatabaseSync, query: string, maxFileBytes?: number,
 *   timeoutMs?: number, limits?: object }} options `maxFileBytes` is the indexer's own limit,
 *   when the caller knows it; `limits` overrides the steps' bounds for a test.
 * @returns {Promise<{ rows: object[], uses: number, files: number, fileIds: number[], names: string[],
 *   capped: boolean, skipped: null | 'not-ready' | 'not-identifier' | 'hub' | 'limit' | 'unreadable' }>}
 *   `skipped` says why there are no rows of the scan, when there are none: `hub` is a name read
 *   in more files than the scan lists, `limit` a scan that stopped at its budget for hits or
 *   bytes, `unreadable` a scan that could not read some of the files the index knows;
 *   `capped` says a limit stopped the scan or files were left out, so what it has is a lower
 *   bound.
 */
export async function scanPropertyReads({ root, db, query, maxFileBytes = SCAN_LIMITS.maxFileBytes, timeoutMs = SCAN_TIMEOUT_MS, limits = {} }) {
  const name = typeof query === 'string' ? query.trim() : '';
  if (!IDENTIFIER.test(name)) return { ...NOTHING, skipped: 'not-identifier' };
  if (!(await warmPropertyReads())) return { ...NOTHING, skipped: 'not-ready' };
  const files = prepare(db, FILES_SQL).all(...LANGS).map(({ id, path: rel, lang }) => ({ id, path: rel, lang }));
  // The worker may have gone between the two awaits.
  if (!worker) return { ...NOTHING, skipped: 'not-ready' };
  const id = nextId++;
  let timer = null;
  const answer = await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`the scan for "${name}" timed out after ${timeoutMs} ms`));
      void replaceWorker();
    }, timeoutMs);
    // Referenced for as long as the answer is pending: an idle worker lets its process exit.
    worker.ref();
    try {
      worker.postMessage({ type: 'scan', id, root, name, files, limits: { ...SCAN_LIMITS, maxFileBytes, ...limits } });
    } catch (err) {
      // Not sent, so nothing will answer it: it must not wait for a timeout that replaces the worker.
      pending.delete(id);
      clearTimeout(timer);
      reject(err);
    }
  }).catch((err) => {
    say(err.message);
    return null;
  });
  clearTimeout(timer);
  if (pending.size === 0) worker?.unref();
  if (!answer) return { ...NOTHING, skipped: 'not-ready' };
  // Files the scan could not read make what it has a lower bound, and "none" not quite true.
  const short = answer.unreadable > 0;
  if (answer.files.length === 0) {
    // A cut with nothing to show for it: said as why, so that "none" is not claimed.
    return { ...NOTHING, capped: answer.stopped !== null, skipped: answer.stopped === 'files' ? 'hub' : answer.stopped ? 'limit' : short ? 'unreadable' : null };
  }

  const rows = [];
  const fileIds = [];
  let uses = 0;
  const ordered = [...answer.files].sort((a, b) => Number(isSecondaryPath(a.path)) - Number(isSecondaryPath(b.path)) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of ordered) {
    const symbols = prepare(db, SYMBOLS_SQL).all(file.id);
    // Per file: receiver x containing symbol -> how many reads and where the first one is.
    const groups = new Map();
    for (const hit of file.hits) {
      const owner = ownerAt(symbols, hit.line, hit.column);
      const key = `${hit.receiver}\u0000${owner?.qual ?? ''}`;
      let group = groups.get(key);
      if (!group) {
        group = { name, kind: 'property', receiver: hit.receiver, count: 0, start_line: hit.line, file_id: file.id, path: file.path, owner: owner?.name ?? null, owner_qual: owner?.qual ?? null, owner_kind: owner?.kind ?? null };
        groups.set(key, group);
      }
      group.count += 1;
      if (hit.line < group.start_line) group.start_line = hit.line;
    }
    // By line, then by receiver: which of one line's rows comes first does not depend on the
    // order the tree yielded them in.
    const inFile = [...groups.values()].sort((a, b) => a.start_line - b.start_line || (a.receiver < b.receiver ? -1 : a.receiver > b.receiver ? 1 : 0));
    for (const row of inFile) uses += row.count;
    fileIds.push(file.id);
    rows.push(...inFile);
  }
  return { rows, uses, files: fileIds.length, fileIds, names: rows.length > 0 ? [name] : [], capped: answer.stopped !== null || short, skipped: null };
}
