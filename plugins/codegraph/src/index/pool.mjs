// worker_threads pool for extraction. Workers are pulled from a shared queue as
// they become idle; a crashed worker rejects only the job it was running and is
// respawned on demand. The pool never throws from a job: `extract` rejects, the
// pool keeps serving. Workers inherit execArgv, so `--liftoff-only` applies.
//
// Two things make the pool itself give up (every job fails with `poolFatal`, so
// the indexer aborts the run instead of blaming each file): more than 3 × size
// crashes in total, and one slot whose fresh worker fails (crashes or hangs) on
// its very first job three times in a row (the engine is broken, not the files).
// A job that gets no answer within `jobTimeoutMs` is rejected and its worker
// terminated, so a hung extraction can never stall a sync forever.

import os from 'node:os';
import { Worker } from 'node:worker_threads';

const WORKER_URL = new URL('./worker.mjs', import.meta.url);
const DEFAULT_JOB_TIMEOUT_MS = 60_000;
const FIRST_TASK_DEATHS = 3;

function closedError() {
  const err = new Error('pool is closed');
  err.poolFatal = true;
  return err;
}

/** min(requested, 4, cpus - 1), never below 1 */
export function poolSize(requested = 4) {
  const n = Number.isInteger(requested) && requested > 0 ? requested : 4;
  return Math.max(1, Math.min(4, n, os.cpus().length - 1));
}

/**
 * @param {{ size?: number, workerUrl?: URL|string, jobTimeoutMs?: number }} [options]
 *   `workerUrl` exists for tests that need a stand-in worker; production code
 *   uses the default extraction worker. `jobTimeoutMs` bounds one job.
 * @returns {{ size: number, extract(job: object): Promise<object>, close(): Promise<void> }}
 */
export function createPool({ size = 4, workerUrl = WORKER_URL, jobTimeoutMs = DEFAULT_JOB_TIMEOUT_MS } = {}) {
  const n = poolSize(size);
  // `completed` counts jobs finished by the current worker of the slot (reset on
  // respawn); `firstTaskDeaths` survives respawns: it is the run of workers of this
  // slot that died while running their first job.
  const slots = Array.from({ length: n }, () => ({ worker: null, ready: false, dead: true, current: null, completed: 0, firstTaskDeaths: 0 }));
  const queue = [];
  let closed = false;
  let crashes = 0;
  const crashBudget = n * 3;

  function spawn(slot) {
    slot.dead = false;
    slot.ready = false;
    slot.current = null;
    slot.completed = 0;
    const worker = new Worker(workerUrl);
    slot.worker = worker;
    // Every handler checks that the slot still belongs to this worker: a late event
    // from a replaced worker must not touch the replacement's job or counters.
    worker.on('message', (msg) => {
      if (slot.worker !== worker) return;
      if (msg?.type === 'ready') {
        slot.ready = true;
        pump();
        return;
      }
      const job = slot.current;
      slot.current = null;
      if (!job) return;
      slot.completed++;
      clearTimeout(job.timer);
      if (msg?.type === 'error') {
        const err = new Error(msg.message ?? 'extraction failed');
        err.code = msg.code ?? null;
        err.hash = msg.hash ?? null;
        job.reject(err);
      } else {
        job.resolve(msg);
      }
      pump();
    });
    worker.on('error', (err) => {
      if (slot.worker === worker) fail(slot, err);
    });
    worker.on('exit', (code) => {
      if (slot.worker !== worker || closed || slot.dead) return;
      fail(slot, new Error(`extraction worker exited unexpectedly (code ${code})`));
    });
  }

  function fail(slot, err, terminate = false) {
    const job = slot.current;
    const worker = slot.worker;
    slot.current = null;
    slot.worker = null;
    slot.ready = false;
    slot.dead = true;
    if (job) clearTimeout(job.timer);
    // A hung worker would keep a core busy until it is terminated; a crashed one is gone already.
    if (terminate && worker) worker.terminate().catch(() => {});
    if (closed) {
      job?.reject(closedError());
      return;
    }
    crashes++;
    if (job) {
      if (slot.completed === 0) slot.firstTaskDeaths++;
      else slot.firstTaskDeaths = 0;
      if (slot.firstTaskDeaths >= FIRST_TASK_DEATHS) {
        const fatal = new Error(`codegraph: extraction workers keep failing on their first job (${slot.firstTaskDeaths} in a row on one slot); giving up`);
        job.reject(fatal);
        drain(fatal);
        return;
      }
      job.reject(err);
    }
    if (crashes > crashBudget) {
      drain(new Error(`codegraph: extraction workers keep crashing (${crashes} crashes); giving up`));
      return;
    }
    pump(); // queued jobs need a replacement worker
  }

  // A pool-level failure (every queued job fails for the same reason) is marked so
  // the indexer can abort the run instead of blaming each file.
  function drain(err) {
    err.poolFatal = true;
    closed = true;
    const pending = queue.splice(0);
    for (const j of pending) j.reject(err);
    for (const s of slots) {
      if (!s.current) continue;
      clearTimeout(s.current.timer);
      s.current.reject(err);
      s.current = null;
    }
  }

  function pump() {
    if (closed) return;
    while (queue.length > 0) {
      const slot = slots.find((s) => s.ready && !s.current);
      if (!slot) {
        // Respawn lazily, only when work is waiting.
        const dead = slots.find((s) => s.dead);
        if (dead) spawn(dead);
        return;
      }
      const job = queue.shift();
      slot.current = job;
      const worker = slot.worker;
      job.timer = setTimeout(() => {
        if (slot.worker !== worker || slot.current !== job) return;
        const err = new Error(`extraction of ${job.job.path} timed out after ${jobTimeoutMs} ms; worker terminated`);
        err.code = 'ETIMEDOUT';
        fail(slot, err, true);
      }, jobTimeoutMs);
      job.timer.unref?.();
      worker.postMessage(job.job);
    }
  }

  return {
    size: n,
    extract(job) {
      if (closed) return Promise.reject(closedError());
      return new Promise((resolve, reject) => {
        queue.push({ job, resolve, reject, timer: null });
        pump();
      });
    },
    async close() {
      if (closed && slots.every((s) => !s.worker)) return;
      drain(closedError());
      await Promise.all(slots.filter((s) => s.worker).map((s) => s.worker.terminate()));
    },
  };
}
