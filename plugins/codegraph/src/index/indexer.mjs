// The index core (CONTRACTS.md §9): owns the database connection, the write lock
// and the worker pool; keeps the index fresh from dirty.log, mtime scans, a
// periodic re-enumeration of the tree and the file watcher; runs full builds with
// progress reporting and resumes one a dead process left behind. Freshness is
// decided here, never by the hooks: they only accelerate.

import fs from 'node:fs';
import path from 'node:path';
import { dbPath, lockPath, resolveProjectRoot, statusPath } from '../paths.mjs';
import { openDatabase, close as closeDatabase } from '../store/db.mjs';
import {
  beginBulkLoad, beginWriteGroup, countFiles, deleteFile, dirtyCount, endBulkLoad, getFileByPath,
  listFiles as listIndexedFiles, markDirty, metaGet, metaSet, replaceFile, takeDirty,
} from '../store/repo.mjs';
import { loadSpecs, specForPath } from '../languages/registry.mjs';
import { hashSource } from '../extract/engine.mjs';
import { applyDefaults } from './defaults.mjs';
import { listFiles, compileExclude, isIndexablePath, gitIgnoredPaths } from './walker.mjs';
import { isLinkDir, underLink } from './fsstat.mjs';
import { acquireLock } from './lock.mjs';
import { readStatus, writeStatus, defaultStatus, statusFromDatabase } from './status.mjs';
import { consumeDirtyLog, statSweep, watch } from './sync.mjs';
import { createPool } from './pool.mjs';

const PROGRESS_INTERVAL_MS = 100;
// A build that failed is retried in the background at most this often.
const ERROR_RETRY_MS = 30_000;
// The tree is re-enumerated once per process (a new session is when a branch
// switch or pull is most likely to have happened) and then at most this often.
const WALK_INTERVAL_MS = 60_000;
// A foreground sync handles at most this many dirty files (about a second). A
// larger batch (branch switch, generator run) runs as a background build so the
// tool call returns partial results within maxWaitMs instead of blocking.
const FOREGROUND_SYNC_FILES = 200;
// Files per WAL commit during a build. A commit costs a few milliseconds
// whatever it contains, so one per file dominated the write phase (14 s of
// 25 s on the 1,660-file reference corpus); grouping also lets SQLite write an
// index page once per group instead of once per file. Each file keeps its own
// savepoint, so this only changes when readers see the work, never what a
// crash can leave behind (see repo.beginWriteGroup).
const WRITE_GROUP_FILES = 100;

export const REASONS = Object.freeze({
  autoIndexDisabled: 'auto-index-disabled',
  unsafeRoot: 'unsafe-root',
  belowMinFiles: 'below-min-files',
  tooManyFiles: 'too-many-files',
  noSupportedFiles: 'no-supported-files',
  buildFailed: 'build-failed',
  lockHeldReadOnly: 'lock-held-read-only',
});

/**
 * Decide whether a background full build may start. Pure: no filesystem access.
 * `supportedCount` = files a language pack claims; `total` = every enumerated
 * file (any language) — maxFiles bounds the project, not just the indexed part.
 *
 * @param {{ config: object, unsafe: boolean, supportedCount: number, total: number }} input
 * @returns {{ ok: boolean, reason: string|null, detail: string|null }}
 */
export function shouldAutoIndex({ config, unsafe, supportedCount, total }) {
  const cfg = applyDefaults(config);
  if (!cfg.autoIndex) return { ok: false, reason: REASONS.autoIndexDisabled, detail: 'autoIndex is false' };
  if (unsafe) return { ok: false, reason: REASONS.unsafeRoot, detail: 'home directory or drive root' };
  if (supportedCount < cfg.minFilesToAutoIndex) {
    return { ok: false, reason: REASONS.belowMinFiles, detail: `${supportedCount} supported file(s), minFilesToAutoIndex is ${cfg.minFilesToAutoIndex}` };
  }
  if (total > cfg.maxFiles) return { ok: false, reason: REASONS.tooManyFiles, detail: `${total} files, maxFiles is ${cfg.maxFiles}` };
  return { ok: true, reason: null, detail: null };
}

// A truncated or foreign file at the index path must not wedge the project forever:
// the index is derived data, so throw it away (db + WAL/SHM + the stale status sidecar)
// and start over. Anything else (permissions, busy) propagates unchanged.
const CORRUPT = /not a database|malformed|SQLITE_NOTADB|SQLITE_CORRUPT/i;
function openIndexDatabase(root) {
  const file = dbPath(root);
  const probe = (db) => db.prepare('SELECT COUNT(*) AS n FROM files').get();
  try {
    const db = openDatabase(file);
    try {
      probe(db);
    } catch (err) {
      closeDatabase(db);
      throw err;
    }
    return db;
  } catch (err) {
    if (!CORRUPT.test(`${err?.message ?? ''} ${err?.cause?.message ?? ''}`)) throw err;
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.rmSync(file + suffix, { force: true });
      } catch {
        // a missing sidecar is fine; a locked one will fail again on reopen with the real error
      }
    }
    try {
      fs.rmSync(statusPath(root), { force: true });
    } catch {
      // status.json is informational; a stale one is refreshed on the next write
    }
    const db = openDatabase(file);
    probe(db);
    return db;
  }
}

export class Indexer {
  /** @param {{ root: string, config?: object, workers?: number }} options */
  constructor({ root, config, workers = 4 } = {}) {
    if (typeof root !== 'string' || root.trim().length === 0) {
      throw new TypeError('Indexer: "root" must be a non-empty string');
    }
    this.root = path.resolve(root);
    this.config = applyDefaults(config);
    // Who switched indexing off, for the message that says so: the project's own file or the user.
    this.#autoIndexOffBy = config?.autoIndexOffBy === 'project' ? 'project' : null;
    this.workers = workers;
    this.#db = openIndexDatabase(this.root);

    // The index lock is held only while this instance writes (a sync, or a build it
    // started until that build ends), never for the life of the session: an idle
    // finished session would otherwise keep every later session on the project
    // read-only and unable to catch up with the tree. Queries never need the lock.
    this.readOnly = false;

    this.#unsafe = resolveProjectRoot(this.root).unsafe;
    this.#matchers = compileExclude(this.config.exclude);
    this.#specsPromise = loadSpecs();
    this.#specsPromise.catch(() => {}); // surfaced when first awaited
  }

  /** The shared connection, for the query layers. */
  get db() {
    return this.#db;
  }

  get unsafe() {
    return this.#unsafe;
  }

  get closed() {
    return this.#closed;
  }

  /**
   * status.json fields plus live numbers: dirty entries, read-only flag, the
   * machine-readable reason of an empty/error state (plus its text) and files
   * stored with parse errors.
   */
  status() {
    this.#assertOpen();
    // A lost status file must not hide an index that holds content: the tools would answer
    // "not indexed" for a database that can serve the query.
    const stored = readStatus(this.root) ?? (countFiles(this.#db) > 0 ? statusFromDatabase(this.#db, this.root) : defaultStatus(this.root));
    const parseErrors = Number(this.#db.prepare('SELECT COUNT(*) AS count FROM files WHERE parse_ok = 0').get().count);
    // A read-only session must not write status.json (it would overwrite the lock
    // holder's building/ready state), so its own reason lives only here.
    const reason = stored.reason ?? (this.readOnly && stored.state === 'empty' ? REASONS.lockHeldReadOnly : null);
    return {
      ...stored,
      reason,
      reasonDetail: metaGet(this.#db, 'reasonDetail') || null,
      dirty: dirtyCount(this.#db),
      readOnly: this.readOnly,
      // True while a background refresh (sweep/reconcile/sync) is still running: what
      // the index holds may predate the working tree until the next call.
      syncing: this.#refreshing !== null,
      // True while this process is building. Unlike the stored state it does not stay
      // 'building' after a process died: a tool that must not race a build asks this.
      building: this.#building !== null,
      parseErrors,
    };
  }

  /** cb({ filesTotal, filesDone, state }) during builds. Returns an unsubscribe function. */
  onProgress(cb) {
    if (typeof cb !== 'function') throw new TypeError('Indexer.onProgress: "cb" must be a function');
    this.#progress.add(cb);
    return () => this.#progress.delete(cb);
  }

  /**
   * Bring the index up to date: consume dirty.log, scan mtimes, reconcile the tree
   * with the index, sync what changed, and start a background full build when the
   * index is empty (or errored, or left 'building' by a dead process) and
   * auto-indexing allows it. Waits at most `maxWaitMs` for that build. `force`
   * bypasses the stat-scan throttle and always re-enumerates the tree.
   *
   * @param {{ maxWaitMs?: number, force?: boolean }} [options]
   * @returns {Promise<{ state: string, partial: boolean, reason: string|null, dirty: number, readOnly: boolean }>}
   */
  ensureFresh({ maxWaitMs = 3000, force = false } = {}) {
    const run = this.#chain.then(() => this.#ensureFresh({ maxWaitMs, force }));
    this.#chain = run.catch(() => {});
    return run;
  }

  /**
   * Foreground full build. Deletes rows that are no longer part of the walked
   * set; with force=false files whose mtime and size are unchanged are skipped.
   * Rejects when another process holds the lock.
   */
  buildAll({ force = false } = {}) {
    const run = this.#chain.then(async () => {
      this.#assertOpen();
      if (!(await this.#acquireForWrite())) {
        throw new Error(`cannot build: the index for ${this.root} is locked by another process (${lockPath(this.root)})`);
      }
      try {
        if (this.#building) await this.#building.catch(() => {});
        this.#assertOpen();
        return await this.#build({ listing: await this.#listFiles(), force });
      } finally {
        this.#releaseLockIfIdle();
      }
    });
    this.#chain = run.catch(() => {});
    return run;
  }

  /** Release the watcher, the workers, the database and the lock. Idempotent. */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#watcher?.close();
    this.#watcher = null;
    const pool = this.#pool;
    this.#pool = null;
    if (pool) await pool.close();
    // A refresh in flight may still be about to start a build: let it settle first.
    if (this.#refreshing) await this.#refreshing;
    if (this.#building) await this.#building.catch(() => {});
    try {
      closeDatabase(this.#db);
    } finally {
      this.#releaseLock();
    }
  }

  // -------------------------------------------------------------------------

  #db;
  #releaseLock = () => {};
  #holdingLock = false;
  #refreshing = null;
  #unsafe;
  #matchers;
  #autoIndexOffBy = null;
  #specsPromise;
  #closed = false;
  #pool = null;
  #watcher = null;
  #pipeline = null;
  #building = null;
  #chain = Promise.resolve();
  #progress = new Set();
  #progressTotal = 0;
  #progressDone = 0;
  #progressEnabled = false;
  #lastProgressAt = 0;
  #committed = 0;
  // Incremental syncs resolve each changed file right after writing it; a full
  // build defers to one resolveAll over the finished index.
  #resolvePerFile = true;
  // Whether this process already reconciled the tree with the index (see #reconcileListing).
  #walked = false;

  #assertOpen() {
    if (this.#closed) throw new Error('Indexer is closed');
  }

  async #specs() {
    const all = await this.#specsPromise;
    return this.config.languages ? all.filter((s) => this.config.languages.includes(s.id)) : all;
  }

  async #listFiles() {
    return listFiles(this.root, { config: this.config, specs: await this.#specs() });
  }

  #ensurePool() {
    if (!this.#pool) this.#pool = createPool({ size: this.workers });
    return this.#pool;
  }

  async #ensureWatch() {
    if (this.#watcher || this.#closed) return;
    // The watcher only marks files a language pack claims, so build output from a
    // test run never floods the dirty queue.
    this.#watcher = watch(this.root, this.#db, { specs: await this.#specs() });
    if (this.#closed) this.#watcher?.close();
  }

  async #ensurePipeline() {
    this.#pipeline ??= await import('../resolve/pipeline.mjs');
    return this.#pipeline;
  }

  #emitProgress(state, force = false) {
    const now = Date.now();
    if (!force && now - this.#lastProgressAt < PROGRESS_INTERVAL_MS) return;
    this.#lastProgressAt = now;
    if (state === 'building') writeStatus(this.root, { state: 'building', filesDone: this.#progressDone });
    const event = { filesTotal: this.#progressTotal, filesDone: this.#progressDone, state };
    for (const cb of this.#progress) {
      try {
        cb(event);
      } catch (err) {
        process.stderr.write(`codegraph: progress callback threw (${err.message})\n`);
      }
    }
  }

  // Take the project's index lock for a write. Held until the write (or a build it
  // started) is over; a lock held elsewhere makes this instance read-only for now —
  // the next call simply tries again, so an idle holder never blocks the project.
  async #acquireForWrite() {
    if (this.#holdingLock) return true;
    const lock = await acquireLock(lockPath(this.root), { waitMs: 0 });
    if (!lock.acquired) {
      this.readOnly = true;
      return false;
    }
    this.#releaseLock = lock.release;
    this.#holdingLock = true;
    this.readOnly = false;
    return true;
  }

  #releaseLockIfIdle() {
    if (!this.#holdingLock || this.#building) return;
    this.#releaseLock();
    this.#releaseLock = () => {};
    this.#holdingLock = false;
  }

  #snapshot() {
    const st = this.status();
    return { state: st.state, partial: Boolean(this.#building) || st.state === 'building', reason: st.reason, dirty: st.dirty, readOnly: this.readOnly };
  }

  // The refresh work itself; only one runs at a time per instance (#refreshing).
  async #refreshWork({ force }) {
    if (this.#building) return;
    consumeDirtyLog(this.root, this.#db);
    // Only the lock holder gets here, so this is the one place a lost status file can be
    // rewritten for the hooks and the other sessions. Its age is the database file's.
    if (!readStatus(this.root) && countFiles(this.#db) > 0) {
      this.#writeReadyStatus(statusFromDatabase(this.#db, this.root).indexedAt || Date.now());
    }
    const stored = readStatus(this.root);
    // Only a lock holder writes 'building'; holding the lock without a build of our
    // own means the process that wrote it died mid-build. Resume it instead of
    // reporting 'building' forever: the listing says what is missing and unchanged
    // files are skipped by mtime/size, so this costs only the unfinished part. An
    // empty index goes through the regular decision below (limits may have changed),
    // and so does everything while automatic builds are switched off.
    if (stored?.state === 'building' && countFiles(this.#db) > 0 && this.config.autoIndex && !this.#unsafe) {
      this.#startBuild({ listing: await this.#listFiles() });
    } else {
      await this.#refresh({ force, stored });
    }
  }

  async #ensureFresh({ maxWaitMs, force }) {
    this.#assertOpen();
    if (!(await this.#acquireForWrite())) return this.#snapshot();
    try {
      // The sweep/reconcile/sync prefix is synchronous on this thread and can take
      // tens of seconds on a big tree after a branch switch; the tool call must not
      // wait for it. Run it in the background and answer within maxWaitMs with the
      // current snapshot (dirty / building flags included).
      this.#refreshing ??= this.#refreshWork({ force })
        .catch((err) => {
          process.stderr.write(`codegraph: refresh failed (${err?.message ?? err})\n`);
        })
        .finally(() => {
          this.#refreshing = null;
          // A build in flight keeps the lock until it ends (#startBuild releases it).
          this.#releaseLockIfIdle();
        });
      const work = this.#refreshing;
      const startedAt = Date.now();
      if (!(this.#building && maxWaitMs > 0) && maxWaitMs > 0) {
        let timer;
        await Promise.race([work, new Promise((resolve) => { timer = setTimeout(resolve, maxWaitMs); })]);
        clearTimeout(timer);
      } else if (!(this.#building) && maxWaitMs === 0) {
        // maxWaitMs 0 means "dispatch, do not wait for the build": the sweep still runs
        // to completion so the caller sees the build it asked for.
        await work;
      }
      // The refresh may have started a build; spend what is left of the budget on it,
      // so a caller with a large maxWaitMs still gets the finished index.
      if (this.#building && maxWaitMs > 0) {
        const remaining = maxWaitMs - (Date.now() - startedAt);
        if (remaining > 0) await this.#waitBuild(remaining);
      }
      return this.#snapshot();
    } catch (err) {
      this.#releaseLockIfIdle();
      throw err;
    }
  }

  // Steady state: stat sweep, tree reconciliation, incremental sync (or a background
  // build for a large batch), then the first build when the index is empty or errored.
  async #refresh({ force, stored }) {
    const hadFiles = countFiles(this.#db) > 0;
    if (hadFiles) await this.#ensureWatch();
    await statSweep(this.#db, { root: this.root, force });
    const walk = hadFiles ? await this.#reconcileListing({ force }) : null;
    const dirty = dirtyCount(this.#db);
    if (dirty > 0 && countFiles(this.#db) > 0) {
      if (dirty >= FOREGROUND_SYNC_FILES) {
        // Too much for a foreground sync: a non-force build re-indexes exactly the
        // changed files (stat decides) and reports progress like any other build.
        this.#startBuild({ listing: await this.#listFiles() });
      } else {
        await this.#sync();
      }
    } else if (walk?.removed) {
      this.#writeReadyStatus();
      await this.#resolvePending();
    }
    // A stale 'building' that is not resumed (automatic builds off) still must not be served as such.
    if (stored?.state === 'building' && !this.#building) this.#writeReadyStatus();

    const indexed = countFiles(this.#db);
    if (indexed > 0 && stored?.state !== 'error') return;
    const lastAttempt = Number(metaGet(this.#db, 'lastBuildAttemptAt') ?? 0);
    // An empty index is retried on every call; an errored one only after a cool-down.
    const due = indexed === 0 || Date.now() - lastAttempt >= ERROR_RETRY_MS;
    if (!due) return;
    const decision = await this.#autoIndexDecision();
    if (decision.ok) {
      this.#startBuild({ listing: decision.listing });
    } else if (indexed === 0) {
      // An errored index keeps 'error' (and 'build-failed'); only an empty one takes the refusal.
      metaSet(this.#db, 'reasonDetail', decision.detail ?? '');
      writeStatus(this.root, { state: 'empty', reason: decision.reason, error: null });
    }
  }

  // Hooks only report edits. Files that appear or vanish without one (git pull,
  // branch switch, generators, rm) are reconciled against a fresh listing: paths
  // the index does not know go to the dirty table for #sync, rows the walker no
  // longer lists (deleted, excluded, oversized, beyond maxFiles) are dropped with
  // their dirty entries. At most every WALK_INTERVAL_MS plus once per process;
  // `force` always walks.
  async #reconcileListing({ force = false }) {
    const now = Date.now();
    const last = Number(metaGet(this.#db, 'lastWalkAt') ?? 0);
    if (!force && this.#walked && now - last < WALK_INTERVAL_MS) return { walked: false, added: 0, removed: 0 };
    const { files } = await this.#listFiles();
    this.#walked = true;
    metaSet(this.#db, 'lastWalkAt', String(now));
    const listed = new Set(files.map((f) => f.path));
    const known = new Set();
    let removed = 0;
    for (const row of listIndexedFiles(this.#db)) {
      known.add(row.path);
      if (!listed.has(row.path) && deleteFile(this.#db, row.path)) removed++;
    }
    const added = files.filter((f) => !known.has(f.path)).map((f) => f.path);
    if (added.length) markDirty(this.#db, added);
    return { walked: true, added: added.length, removed };
  }

  async #autoIndexDecision() {
    if (!this.config.autoIndex) {
      const detail = this.#autoIndexOffBy === 'project' ? 'autoIndex is false in .zcode/codegraph.json of the project' : 'autoIndex is false';
      return { ok: false, reason: REASONS.autoIndexDisabled, detail };
    }
    if (this.#unsafe) return { ok: false, reason: REASONS.unsafeRoot, detail: 'home directory or drive root' };
    const listing = await this.#listFiles();
    const decision = shouldAutoIndex({
      config: this.config,
      unsafe: this.#unsafe,
      supportedCount: listing.files.length,
      total: listing.total,
    });
    return { ...decision, listing };
  }

  #startBuild({ listing, force = false }) {
    metaSet(this.#db, 'lastBuildAttemptAt', String(Date.now()));
    metaSet(this.#db, 'reasonDetail', '');
    const run = this.#build({ listing, force })
      .catch((err) => {
        if (this.#closed) return;
        const message = err?.message ?? String(err);
        try {
          metaSet(this.#db, 'reasonDetail', message);
          writeStatus(this.root, { state: 'error', reason: REASONS.buildFailed, error: message });
        } catch (writeErr) {
          process.stderr.write(`codegraph: cannot record build error (${writeErr.message})\n`);
        }
      })
      .finally(() => {
        this.#building = null;
        // The lock was taken for this build (see #acquireForWrite); give it back once
        // the build is over so another session can write.
        this.#releaseLockIfIdle();
      });
    this.#building = run;
    return run;
  }

  async #waitBuild(maxWaitMs) {
    const build = this.#building;
    if (!build) return;
    let timer;
    await Promise.race([build.catch(() => {}), new Promise((resolve) => { timer = setTimeout(resolve, maxWaitMs); })]);
    clearTimeout(timer);
  }

  #languages() {
    const out = {};
    for (const row of this.#db.prepare('SELECT lang, COUNT(*) AS count FROM files GROUP BY lang').all()) out[row.lang] = Number(row.count);
    return out;
  }

  #symbolCount() {
    return Number(this.#db.prepare('SELECT COUNT(*) AS count FROM symbols').get().count);
  }

  async #finishBuild(state, reason = null) {
    const n = countFiles(this.#db);
    writeStatus(this.root, {
      state,
      reason,
      indexedAt: Date.now(),
      filesTotal: n,
      filesDone: n,
      symbols: this.#symbolCount(),
      languages: this.#languages(),
      stale: dirtyCount(this.#db),
      error: null,
    });
    this.#emitProgress(state, true);
    if (n > 0) await this.#ensureWatch();
  }

  // Walked set vs database: rows outside the set are gone (deleted, excluded or
  // beyond maxFiles) and must not linger in search results.
  #pruneTo(keep) {
    for (const row of listIndexedFiles(this.#db)) {
      if (!keep.has(row.path)) deleteFile(this.#db, row.path);
    }
  }

  // Dirty entries accumulated during a build are only kept for files that really
  // differ from what was just indexed (edited while the build ran).
  #reconcileDirty(keep) {
    for (const { path: rel } of takeDirty(this.#db, Number.MAX_SAFE_INTEGER)) {
      if (!keep.has(rel)) continue;
      const row = getFileByPath(this.#db, rel);
      let st;
      try {
        st = fs.lstatSync(path.join(this.root, rel));
      } catch {
        continue;
      }
      if (row && st.isFile() && Math.trunc(st.mtimeMs) === row.mtime_ms && st.size === row.size) continue;
      markDirty(this.#db, [rel]);
    }
  }

  async #build({ listing, force = false }) {
    const total = listing.files.length;
    this.#progressTotal = total;
    this.#progressDone = 0;
    this.#progressEnabled = true;
    this.#resolvePerFile = false;
    this.#committed = 0;
    // One checkpoint for the whole build instead of one per commit (see
    // #deferCheckpoints); restored in the finally, error path included.
    const checkpoint = this.#deferCheckpoints();
    metaSet(this.#db, 'reasonDetail', '');
    try {
      // 'building' goes out before the first await: a caller that starts a build in
      // the background and returns at once (maxWaitMs 0) must still see this state.
      writeStatus(this.root, { state: 'building', reason: null, filesTotal: total, filesDone: 0, error: null });
      this.#emitProgress('building', true);
      await this.#ensurePipeline();
      if (total === 0) {
        this.#pruneTo(new Set());
        await this.#finishBuild('empty', REASONS.noSupportedFiles);
        return this.status();
      }
      const keep = new Set(listing.files.map((f) => f.path));
      // A build that (re)writes every file loads in bulk: no index maintenance
      // and no per-row FK checks during the load, one index build and one
      // foreign_key_check at the end (repo.beginBulkLoad). Only here: a sync
      // keeps the index usable row by row.
      const bulk = force || countFiles(this.#db) === 0;
      if (bulk) beginBulkLoad(this.#db);
      try {
        this.#pruneTo(keep);
        const existing = new Map(listIndexedFiles(this.#db).map((r) => [r.path, r]));
        const jobs = [];
        for (const file of listing.files) {
          const row = existing.get(file.path);
          if (!force && row && row.mtime_ms === file.mtimeMs && row.size === file.size) {
            this.#progressDone++;
            continue;
          }
          jobs.push({ file, knownHash: force ? null : row?.hash ?? null });
        }
        await this.#runJobs(jobs);
      } finally {
        // Before anything queries the index: the resolver needs the indexes.
        // Also the error path, so a failed build never leaves them dropped.
        if (bulk) endBulkLoad(this.#db);
      }
      if (this.#closed) return null;
      // Refs are resolved once over the complete index: resolveAll builds its lookup
      // tables a single time, where a resolveFile per file would rebuild them for
      // every file and resolve early files against a still-partial index. A build
      // that committed nothing still resolves when refs are pending: a previous
      // process may have died between writing files and this step.
      if (this.#committed > 0 || this.#hasPendingRefs()) this.#pipeline.resolveAll(this.#db);
      this.#reconcileDirty(keep);
      checkpoint(); // the index is complete: one pass of the WAL back into the file
      const indexed = countFiles(this.#db) > 0;
      await this.#finishBuild(indexed ? 'ready' : 'empty', indexed ? null : REASONS.noSupportedFiles);
      return this.status();
    } catch (err) {
      // Both entry points (background #startBuild and a foreground buildAll) must leave a
      // machine-readable error behind; otherwise status.json stays at 'building' forever.
      if (!this.#closed) {
        this.#emitProgress('error', true);
        const message = err?.message ?? String(err);
        try {
          metaSet(this.#db, 'reasonDetail', message);
          writeStatus(this.root, { state: 'error', reason: REASONS.buildFailed, error: message });
        } catch (writeErr) {
          process.stderr.write(`codegraph: cannot record build error (${writeErr.message})\n`);
        }
      }
      throw err;
    } finally {
      checkpoint();
      this.#progressEnabled = false;
    }
  }

  // A commit past the autocheckpoint threshold copies the WAL back into the
  // database page by page, and a build dirties the refs pages twice (load,
  // then resolve): measured 6.9 s of a 17 s build in checkpoints. A build
  // turns autocheckpoint off and copies the WAL once at the end, so every page
  // is written to the file once; the setting is restored for the syncs that
  // follow, whose commits are small and checkpoint as before. The returned
  // function is idempotent and safe on the error path.
  #deferCheckpoints() {
    const previous = Number(this.#db.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint);
    this.#db.exec('PRAGMA wal_autocheckpoint = 0');
    let done = false;
    return () => {
      if (done) return;
      done = true;
      try {
        // TRUNCATE so the WAL file does not keep the build's high-water mark on disk; with a
        // concurrent reader it degrades to what PASSIVE would have done.
        this.#db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } finally {
        this.#db.exec(`PRAGMA wal_autocheckpoint = ${previous}`);
      }
    };
  }

  // Fixed number of runners pulling from a shared cursor, so at most
  // 4 * poolSize extractions are in flight and results never pile up in memory.
  async #runJobs(jobs) {
    const pool = this.#ensurePool();
    const runners = Math.max(2, pool.size * 4);
    let next = 0;
    let failure = null;
    // Commits are grouped (WRITE_GROUP_FILES); the group opens lazily before the
    // first write and is closed once at the end, including on the error path.
    let endGroup = null;
    let sinceCommit = 0;
    const body = async () => {
      while (!failure && !this.#closed) {
        const i = next++;
        if (i >= jobs.length) return;
        const { file, knownHash } = jobs[i];
        let result;
        try {
          result = await pool.extract({ type: 'extract', path: file.path, abs: file.abs, lang: file.lang, knownHash });
        } catch (err) {
          if (err?.poolFatal) {
            failure = err; // the pool itself is down: not this file's fault
            return;
          }
          this.#fileError(file, err);
          continue;
        }
        try {
          endGroup ??= beginWriteGroup(this.#db);
          this.#commit(file, result);
          if (++sinceCommit >= WRITE_GROUP_FILES) {
            endGroup();
            endGroup = null;
            sinceCommit = 0;
          }
        } catch (err) {
          failure = err;
          return;
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: runners }, body));
    } finally {
      endGroup?.();
    }
    if (failure) throw failure;
  }

  // One file per transaction (repo.replaceFile). During a sync the file's refs are
  // resolved right here; a build resolves everything once at the end. A storage
  // failure here is a contract violation and aborts the run; the per-file errors
  // that may be retried are handled in #fileError.
  #commit(file, result) {
    if (result.type === 'unchanged') {
      // Content identical to the stored extraction: only the stat fingerprint moved.
      this.#db.prepare('UPDATE files SET mtime_ms = ?, size = ? WHERE path = ?').run(file.mtimeMs, file.size, file.path);
    } else {
      const extracted = result.extracted;
      const { fileId } = replaceFile(
        this.#db,
        {
          path: file.path,
          lang: file.lang,
          hash: extracted.hash,
          mtimeMs: file.mtimeMs,
          size: file.size,
          parseOk: extracted.parseOk,
          errorNodes: extracted.errorNodes,
          indexedAt: Date.now(),
        },
        extracted,
      );
      if (this.#resolvePerFile) this.#pipeline.resolveFile(this.#db, fileId);
      this.#committed++;
    }
    this.#progressDone++;
    if (this.#progressEnabled) this.#emitProgress('building');
  }

  #fileError(file, err) {
    if (!this.#closed) {
      const code = err?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') {
        deleteFile(this.#db, file.path);
      } else if (err?.hash || code === 'ETIMEDOUT') {
        // Read succeeded, extraction failed: record it as a parse failure so a broken
        // file is not re-attempted on every sync; it is retried once it changes. A
        // worker terminated on timeout never reports its hash, so take it here.
        const hash = err?.hash ?? this.#hashNow(file.abs);
        if (hash) {
          replaceFile(
            this.#db,
            { path: file.path, lang: file.lang, hash, mtimeMs: file.mtimeMs, size: file.size, parseOk: false, errorNodes: 0, indexedAt: Date.now() },
            {},
          );
        } else {
          markDirty(this.#db, [file.path]);
        }
      } else {
        markDirty(this.#db, [file.path]); // unreadable right now: try again next time
      }
      process.stderr.write(`codegraph: failed to index ${file.path}: ${err?.message ?? err}\n`);
    }
    this.#progressDone++;
    if (this.#progressEnabled) this.#emitProgress('building');
  }

  // sha256 of a file read on the main thread (only after a worker timed out), or
  // null when it can no longer be read.
  #hashNow(abs) {
    try {
      return hashSource(fs.readFileSync(abs, 'utf8'));
    } catch {
      return null;
    }
  }

  // Refs the store nulled (their target was deleted) or a killed process never
  // classified: both mean "resolve before serving". No index on resolution, so
  // this is a scan that stops at the first pending row.
  #hasPendingRefs() {
    return Boolean(this.#db.prepare('SELECT 1 FROM refs WHERE resolution IS NULL LIMIT 1').get());
  }

  // For paths that deleted rows without running #sync (the tree reconciliation):
  // a deletion nulls the refs that pointed at the file's symbols, and only a build
  // or a resolver pass would pick them up again.
  async #resolvePending() {
    if (!this.#hasPendingRefs()) return;
    await this.#ensurePipeline();
    this.#pipeline.resolveAll(this.#db);
  }

  // status.json from the database after an incremental change. An errored index
  // keeps 'error' so the build retry path keeps ownership of it.
  #writeReadyStatus(indexedAt = Date.now()) {
    if (readStatus(this.root)?.state === 'error') return;
    const n = countFiles(this.#db);
    writeStatus(this.root, {
      state: n > 0 ? 'ready' : 'empty',
      reason: n > 0 ? null : REASONS.noSupportedFiles,
      indexedAt,
      filesTotal: n,
      filesDone: n,
      symbols: this.#symbolCount(),
      languages: this.#languages(),
      stale: dirtyCount(this.#db),
      error: null,
    });
  }

  // Re-index what the dirty table holds: vanished files are deleted, unsupported
  // or oversized ones dropped, the rest extracted through the pool.
  async #sync() {
    await this.#ensurePipeline();
    const specs = await this.#specs();
    this.#resolvePerFile = true;
    this.#committed = 0;
    let removed = 0;
    // Drain the dirty table once: a path that fails below is marked dirty again for
    // the *next* sync, so re-reading the table in a loop would spin on it.
    const batch = takeDirty(this.#db, Number.MAX_SAFE_INTEGER);
    const jobs = [];
    // Dirty paths come from the watcher or a hook, outside the listing that applies .gitignore,
    // so git is asked about them, once per sync: a new path that is ignored never enters, and a
    // path .gitignore took up since it was indexed leaves here rather than at the next listing.
    // Tracked files are never reported, as in the listing.
    const rows = new Map(batch.map(({ path: rel }) => [rel, getFileByPath(this.#db, rel)]));
    const asked = batch
      .filter(({ path: rel }) => specForPath(rel, specs) && isIndexablePath(rel, this.#matchers))
      .map(({ path }) => path);
    let ignored;
    try {
      ignored = await gitIgnoredPaths(this.root, asked);
    } catch (err) {
      // The batch is out of the dirty table already: put it back before the failure travels.
      if (!this.#closed) markDirty(this.#db, batch.map(({ path }) => path));
      throw err;
    }
    // One look per directory for the whole batch.
    const linkDirs = new Map();
    const isLink = (dir) => {
      let verdict = linkDirs.get(dir);
      if (verdict === undefined) linkDirs.set(dir, (verdict = isLinkDir(dir)));
      return verdict;
    };
    for (const { path: rel } of batch) {
      const abs = path.join(this.root, rel);
      let st;
      try {
        // lstat, as everywhere: a symlink never enters the index, nor does a file behind a
        // directory link (it can point outside the root or loop).
        st = fs.lstatSync(abs);
      } catch {
        if (rows.get(rel) && deleteFile(this.#db, rel)) removed++;
        continue;
      }
      const row = rows.get(rel);
      const spec = specForPath(rel, specs);
      // Same admission rules as the walker: a dirty entry (hook-written, so external
      // input) must not get node_modules, excluded or git-ignored files into the index.
      if (st.isSymbolicLink() || !st.isFile() || !spec || st.size > this.config.maxFileBytes || !isIndexablePath(rel, this.#matchers) || ignored?.has(rel) || underLink(this.root, abs, isLink)) {
        if (row && deleteFile(this.#db, rel)) removed++;
        continue;
      }
      jobs.push({ file: { path: rel, abs, lang: spec.id, size: st.size, mtimeMs: Math.trunc(st.mtimeMs) }, knownHash: row?.hash ?? null });
    }
    if (jobs.length > 0) {
      try {
        await this.#runJobs(jobs);
      } catch (err) {
        // Not finished (pool down or a storage error): keep them pending for the next
        // sync instead of losing them; unchanged ones will hash-skip.
        if (!this.#closed) markDirty(this.#db, jobs.map((j) => j.file.path));
        throw err;
      }
    }
    if (this.#closed) return;
    if (this.#committed > 0 || removed > 0) {
      this.#writeReadyStatus();
      // Deleting a file nulls the refs that pointed at its symbols (see
      // repo.deleteFile); when nothing was re-indexed no resolveFile ran to pick
      // them up again.
      if (this.#committed === 0) this.#pipeline.resolveAll(this.#db);
      await this.#ensureWatch();
    } else {
      // A previous sync may have died between writing a file and resolving its refs.
      await this.#resolvePending();
    }
  }
}
