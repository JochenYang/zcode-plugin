// Property reads (`row.membershipKind`) for a name that no symbol carries (CONTRACTS.md §8).
//
// The index records calls and type names, not a property read: it is a property of some object,
// never a reference the resolver could link, and there are too many of them to keep — a fifth
// to a third again as many rows as all references, most of them `.length` (2026-11-25, two
// repositories). So they are looked for when they are asked for: the JavaScript and TypeScript
// files are read once per worker, which remembers of each the names behind a dot; a search then
// reads the files that have the name — and a file again only when the index says it changed —
// and parses those, and tree-sitter decides. The same scan finds where the name is the key of
// an object, the attribute of a JSX element or a member of a type (CONTRACTS.md §8 "对象键").
//
// This is the one query that reads the source files, and it does so in a worker of its own
// (`propertyReadsWorker.mjs`), as every parse does (CONTRACTS.md §9): the server's main thread
// only waits for the answer and gives up after SCAN_TIMEOUT_MS. Nothing here is stored on disk,
// so nothing here needs a rebuild; what the worker keeps between two searches is exactly as
// fresh as the index, since it goes by the size and mtime the index holds. Every limit names the
// step it bounds, and a scan that hits one returns what it has with `stopped`, which the caller
// reports as a lower bound.
import { Worker } from 'node:worker_threads';
import { isSecondaryPath, prepare } from '../store/repo.mjs';

const LANGS = ['typescript', 'tsx', 'javascript'];
// More files than this with the name: it is read everywhere (`.length`, `.id`), which says
// nothing about where to look.
export const SCAN_FILES_MAX = 60;
// Every limit of a scan, with the step it bounds. A file bigger than `maxFileBytes` is skipped
// as the indexer skips it; `maxReadBytes` bounds what one request may read, so that the first
// scan of a big repository costs seconds and not the timeout, and the rest is read by the next
// ones (a repository of 17,000 JS/TS files is about 200 MB; 64 MB did not cover a third of it,
// and every scan of it gave up — 2026-11-25); `readDeadlineMs` bounds the same step in time: the
// main thread gives up on a request after `SCAN_TIMEOUT_MS` and replaces the worker, which would
// throw away what it had read, so the worker stops reading by itself at five seconds and answers
// with what it has — a slow disk then takes a few requests where a fast one takes one;
// `maxHits` is how many prefilter hits are worth parsing at all (twice what a search puts in
// front of a symbol); `maxParseBytes` bounds the parse step, the smallest files first. That one
// is about time: written code parses at about 4 MB/s and a minified bundle at about 1 MB/s
// (2026-11-25), so two megabytes are half a second in the common case and two in the worst.
// `maxKeyFiles` is where the keys are cut: higher than `maxFiles`, because a file counts there
// on the name being merely on its own in it (a variable, a parameter, an import), which is true
// of many more files than hold it as a key — at 60, one name in six whose keys are in few files
// lost them in a repository of 916 JS/TS files, at 200 one in twenty-five (2026-11-25). Keys
// have no hits to count, so what the extra files may cost is bounded by the parse step.
export const SCAN_LIMITS = Object.freeze({
  maxFiles: SCAN_FILES_MAX,
  maxKeyFiles: 200,
  maxFileBytes: 4 * 1024 * 1024,
  maxReadBytes: 512 * 1024 * 1024,
  readDeadlineMs: 5_000,
  maxHits: 400,
  maxParseBytes: 2 * 1024 * 1024,
});
export const SCAN_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 30_000;
// How many times one priming asks the worker to read: each round is one request's worth of
// reading time, and a repository of 200 MB of JS/TS takes about three on a cold disk
// (2026-11-25); a fourth is asked only if the disk is slower still.
const PRIME_ROUNDS = 4;
// An ASCII identifier, as the prefilter needs it spelled: a guess with spaces, dots or
// separators is not a property read and is not looked for.
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const NOTHING = Object.freeze({ rows: [], uses: 0, files: 0, fileIds: [], names: [], capped: false, cut: null, skipped: null });
// What the worker may say a key is: the name as the key of an object, or as a member of a type.
const KEY_KINDS = new Set(['key', 'field']);
// Rows of one line come in this order, whatever the tree yielded first.
const KIND_ORDER = new Map([['property', 0], ['key', 1], ['field', 2]]);
const FILES_SQL = `SELECT id, path, lang, size, mtime_ms FROM files WHERE lang IN (${LANGS.map(() => '?').join(', ')}) ORDER BY path`;
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
  const entry = (msg?.type === 'scan' || msg?.type === 'prime') ? pending.get(msg.id) : null;
  if (!entry) return;
  pending.delete(msg.id);
  // Every answer says what it is, so that the reply to a `prime` is never taken for a scan.
  entry.resolve(msg.type === 'prime' ? { type: 'prime', unseen: Number.isInteger(msg.unseen) && msg.unseen > 0 ? msg.unseen : 0 } : {
    type: 'scan',
    files: (Array.isArray(msg.files) ? msg.files : []).map((file) => ({
      id: file?.id,
      path: file?.path,
      hits: Array.isArray(file?.hits) ? file.hits.filter((hit) => hit && Number.isInteger(hit.line) && typeof hit.receiver === 'string') : [],
      keys: Array.isArray(file?.keys) ? file.keys.filter((key) => key && KEY_KINDS.has(key.kind) && Number.isInteger(key.line)) : [],
    })).filter((file) => Number.isInteger(file.id) && typeof file.path === 'string'),
    stopped: msg.stopped === 'bytes' || msg.stopped === 'uses' ? msg.stopped : null,
    unreadable: Number.isInteger(msg.unreadable) && msg.unreadable > 0 ? msg.unreadable : 0,
    unseen: Number.isInteger(msg.unseen) && msg.unseen > 0 ? msg.unseen : 0,
    hubs: { reads: msg.hubs?.reads === true, keys: msg.hubs?.keys === true },
  });
  if (pending.size === 0) worker?.unref();
}

/**
 * Ask the worker something about the project's JS/TS files and wait for the answer. The files
 * come from the index with the size and mtime it holds for each: that is what the worker goes by
 * to tell a file it has read before from one it must read again, so a scan is exactly as fresh
 * as the index. Resolves to null when there is no worker or no answer in time (`timeoutMs`),
 * after saying why on stderr; never throws for those.
 *
 * @param {{ type: 'scan' | 'prime', name?: string, limits: object }} message
 * @param {{ root: string, db: import('node:sqlite').DatabaseSync, timeoutMs: number }} context
 */
async function request(message, { root, db, timeoutMs }) {
  // Asked before anything is read from the index: with no worker there is nothing to ask about.
  if (!(await warmPropertyReads())) return null;
  const files = prepare(db, FILES_SQL).all(...LANGS).map(({ id, path: rel, lang, size, mtime_ms }) => ({ id, path: rel, lang, size, mtimeMs: mtime_ms }));
  // The worker may have gone between the two awaits.
  if (!worker) return null;
  const id = nextId++;
  let timer = null;
  const answer = await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(message.type === 'prime' ? `the priming timed out after ${timeoutMs} ms` : `the scan for "${message.name ?? ''}" timed out after ${timeoutMs} ms`));
      void replaceWorker();
    }, timeoutMs);
    // Referenced for as long as the answer is pending: an idle worker lets its process exit.
    worker.ref();
    try {
      // With the time it was sent: the worker counts a request's reading time from then, so that
      // one queued behind another does not outlast the caller's patience for it.
      worker.postMessage({ ...message, id, root, files, sentAt: Date.now() });
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
  return answer;
}

/**
 * Have the worker read the project's JS/TS files, before the first search asks, so that the
 * first scan costs the files that have the name and not the project. Call it when a session
 * starts. Each round reads for one request's worth of time (`SCAN_LIMITS.readDeadlineMs`); while
 * the worker says files are left, it is asked again, `rounds` times at most — a repository of
 * 200 MB of JS/TS takes about three rounds on a cold disk (2026-11-25), and a search should not
 * be the one to finish that reading. It does not throw, and a failure only costs the first scan
 * its full read.
 *
 * @param {{ root: string, db: import('node:sqlite').DatabaseSync, maxFileBytes?: number, limits?: object, timeoutMs?: number, rounds?: number }} options
 * @returns {Promise<boolean>} whether the worker answered.
 */
export async function primePropertyReads({ root, db, maxFileBytes = SCAN_LIMITS.maxFileBytes, limits = {}, timeoutMs = SCAN_TIMEOUT_MS, rounds = PRIME_ROUNDS }) {
  let answered = false;
  for (let round = 0; round < rounds; round += 1) {
    const answer = await request({ type: 'prime', limits: { ...SCAN_LIMITS, maxFileBytes, ...limits } }, { root, db, timeoutMs });
    // Not answered: the worker is gone or too slow, which `request` has said on stderr.
    if (!answer || answer.type !== 'prime') break;
    answered = true;
    if (answer.unseen === 0) break;
  }
  return answered;
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
    // Nothing is left of the attempt but the fact that it failed: `failed` alone keeps the next
    // scan from trying again in this process.
    loseWorker();
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
 * Where `query` is met in the JS/TS source, in the shape of `searchRefs` (CONTRACTS.md §7):
 * one row per name, receiver, file and the symbol that contains it. Three kinds of row:
 * `property` — read behind a dot (`obj.name`), one row per receiver; `key` — the key of an
 * object (`{ name: 1 }`, `{ name }`, `const { name } = x`); `field` — a member of an interface
 * or of a type literal. Source files come before tests and scripts, then by path; in a file by
 * line, then property, key, field, then by receiver.
 *
 * @param {{ root: string, db: import('node:sqlite').DatabaseSync, query: string, maxFileBytes?: number,
 *   timeoutMs?: number, limits?: object }} options `maxFileBytes` is the indexer's own limit,
 *   when the caller knows it; `limits` overrides the steps' bounds for a test.
 * @returns {Promise<{ rows: object[], uses: number, files: number, fileIds: number[], names: string[],
 *   capped: boolean, cut: null | 'reads' | 'keys', skipped: null | 'not-ready' | 'not-identifier' | 'hub' | 'limit' | 'unreadable' }>}
 *   `skipped` says why there are no rows of the scan, when there are none: `hub` is a name met
 *   in more files than the scan lists (behind a dot, or as a key — each lookup is cut on its
 *   own, and only a lookup that is cut gives nothing), `limit` a scan that stopped at its budget
 *   for hits or bytes — or that did not get to every file within what one request may read —,
 *   `unreadable` a scan that could not read some of the files the index knows; `capped` says a
 *   limit stopped the scan or files were left out, so what it has is a lower bound. With rows,
 *   `cut` names the lookup that was cut while the other one has them: the rows are one side of
 *   the name, which makes them a lower bound too.
 */
export async function scanPropertyReads({ root, db, query, maxFileBytes = SCAN_LIMITS.maxFileBytes, timeoutMs = SCAN_TIMEOUT_MS, limits = {} }) {
  const name = typeof query === 'string' ? query.trim() : '';
  if (!IDENTIFIER.test(name)) return { ...NOTHING, skipped: 'not-identifier' };
  const answer = await request({ type: 'scan', name, limits: { ...SCAN_LIMITS, maxFileBytes, ...limits } }, { root, db, timeoutMs });
  // Not answered: the worker is gone or too slow, which `request` has said on stderr.
  if (!answer || answer.type !== 'scan') return { ...NOTHING, skipped: 'not-ready' };
  // Files the scan could not read, or did not get to, make what it has a lower bound, and "none"
  // not quite true.
  const short = answer.unreadable > 0 || answer.unseen > 0;
  if (answer.files.length === 0) {
    // A cut with nothing to show for it: said as why, so that "none" is not claimed. What could
    // not be read is not a count of anything, so it alone does not make the answer a lower bound.
    const skipped = answer.stopped ? 'limit' : answer.hubs.reads || answer.hubs.keys ? 'hub' : answer.unseen > 0 ? 'limit' : answer.unreadable > 0 ? 'unreadable' : null;
    return { ...NOTHING, capped: skipped === 'hub' || skipped === 'limit', skipped };
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
    // Keys: kind x containing symbol. A member of a type is owned by the type, a key of a
    // literal by the function or the module level.
    for (const key of file.keys) {
      const owner = ownerAt(symbols, key.line, key.column);
      const at = `${key.kind}\u0000${owner?.qual ?? ''}`;
      let group = groups.get(at);
      if (!group) {
        group = { name, kind: key.kind, receiver: null, count: 0, start_line: key.line, file_id: file.id, path: file.path, owner: owner?.name ?? null, owner_qual: owner?.qual ?? null, owner_kind: owner?.kind ?? null };
        groups.set(at, group);
      }
      group.count += 1;
      if (key.line < group.start_line) group.start_line = key.line;
    }
    // By line, then by kind, then by receiver: which of one line's rows comes first does not
    // depend on the order the tree yielded them in.
    const inFile = [...groups.values()].sort((a, b) => a.start_line - b.start_line
      || (KIND_ORDER.get(a.kind) ?? 9) - (KIND_ORDER.get(b.kind) ?? 9)
      || ((a.receiver ?? '') < (b.receiver ?? '') ? -1 : (a.receiver ?? '') > (b.receiver ?? '') ? 1 : 0));
    for (const row of inFile) uses += row.count;
    fileIds.push(file.id);
    rows.push(...inFile);
  }
  // A lookup that was cut while the other has rows: what is listed is one side of the name, and
  // the caller is told which side is missing.
  const cut = answer.hubs.reads ? 'reads' : answer.hubs.keys ? 'keys' : null;
  return { rows, uses, files: fileIds.length, fileIds, names: rows.length > 0 ? [name] : [], capped: answer.stopped !== null || short || cut !== null, cut, skipped: null };
}
