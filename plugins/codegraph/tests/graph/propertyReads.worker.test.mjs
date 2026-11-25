// The life of the scan worker (src/graph/propertyReads.mjs) with a worker that is not real: one
// whose events the test holds, so that what cannot be timed on a real one is pinned — the exit
// of a worker that was replaced arriving after the next one is in place, and a worker that dies
// in the middle of a scan. In a file of its own: the module keeps one worker per process, and
// this file must start without one (the factory is set before the first scan).
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Indexer } from '../../src/index/indexer.mjs';
import { primePropertyReads, scanPropertyReads, setScanWorkerFactory, warmPropertyReads } from '../../src/graph/propertyReads.mjs';
import { scratchDir, rmrf, writeProject, closeAll, useScratchData } from '../index/_helpers.mjs';

const data = useScratchData('data-propreads-worker');
const indexers = [];
const dirs = [];
// The workers the last test made. The module keeps its worker for the life of the process, so
// the one that is current is made to exit before the next test, which then starts with none.
let made = [];
afterEach(async () => {
  await closeAll(indexers);
  for (const d of dirs.splice(0)) rmrf(d);
  for (const worker of made) worker.emit('exit', 0);
  setScanWorkerFactory(null);
});
after(() => rmrf(data));

async function indexed(files) {
  const root = scratchDir('propreads-worker');
  dirs.push(root);
  writeProject(root, files);
  const ix = new Indexer({ root, config: { minFilesToAutoIndex: 1 }, workers: 2 });
  indexers.push(ix);
  await ix.buildAll();
  return { root, db: ix.db };
}
// Everything propertyReads.mjs uses of a Worker; when its events arrive is the test's to say.
class HeldWorker extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.terminated = 0;
  }
  ref() {}
  unref() {}
  postMessage(message) {
    this.sent.push(message);
  }
  async terminate() {
    this.terminated += 1;
  }
  ready() {
    this.emit('message', { type: 'ready' });
  }
  answer(message, hits) {
    this.emit('message', { type: 'scan', id: message.id, files: [{ id: message.files[0].id, path: message.files[0].path, hits }], stopped: null, unreadable: 0 });
  }
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
const NOTHING = { rows: [], uses: 0, files: 0, fileIds: [], names: [], capped: false, cut: null };
const READ = { receiver: 'row', line: 2, column: 10 };

// A project of one file, and a factory that hands out held workers, two at most: a third means
// a worker that should have stayed was dropped.
async function held() {
  const ctx = await indexed({ 'src/a.ts': 'export function f(row: Row) {\n  return row.zzqP;\n}\n' });
  made = [];
  setScanWorkerFactory(() => {
    if (made.length >= 2) throw new Error('a third scan worker was started: one that answers was dropped');
    const worker = new HeldWorker();
    made.push(worker);
    return worker;
  });
  return { ...ctx, made };
}

describe('the life of the scan worker', () => {
  test('the exit of a worker that was replaced arrives after the next one is in place: the next one stays', async () => {
    const { root, db, made } = await held();
    const warming = warmPropertyReads();
    made[0].ready();
    assert.equal(await warming, true);

    // The first worker never answers: the scan gives up on it and has it replaced.
    const stuck = scanPropertyReads({ root, db, query: 'zzqP', timeoutMs: 5 });
    await tick();
    assert.equal(made[0].sent.length, 1);
    assert.deepEqual(await stuck, { ...NOTHING, skipped: 'not-ready' });
    assert.equal(made[0].terminated, 1);

    // The next scan starts the next worker; it is in place and answers.
    const answered = scanPropertyReads({ root, db, query: 'zzqP' });
    assert.equal(made.length, 2);
    made[1].ready();
    await tick();
    made[1].answer(made[1].sent[0], [READ]);
    assert.equal((await answered).uses, 1);

    // Now the one that was replaced exits at last (a read that could not be interrupted).
    made[0].emit('exit', 1);
    const again = scanPropertyReads({ root, db, query: 'zzqP' });
    await tick();
    assert.equal(made.length, 2);
    assert.deepEqual(made[1].sent.map((message) => message.id), [2, 3], 'the worker in place is asked, not a new one');
    made[1].answer(made[1].sent[1], [READ]);
    assert.equal((await again).uses, 1);
  });

  test('a worker that dies in the middle of a scan: that scan is not looked for, the next one starts a new worker', async () => {
    const { root, db, made } = await held();
    const warming = warmPropertyReads();
    made[0].ready();
    assert.equal(await warming, true);
    const dying = scanPropertyReads({ root, db, query: 'zzqP' });
    await tick();
    made[0].emit('error', new Error('boom'));
    const at = performance.now();
    made[0].emit('exit', 1);
    assert.deepEqual(await dying, { ...NOTHING, skipped: 'not-ready' }, 'the scan that was waiting is told, not left to time out');
    assert.ok(performance.now() - at < 2000, 'told at once');
    assert.equal(made.length, 1, 'no worker is started until one is needed');
    const next = scanPropertyReads({ root, db, query: 'zzqP' });
    made[1].ready();
    await tick();
    made[1].answer(made[1].sent[0], [READ]);
    assert.equal((await next).uses, 1);
  });

  test('priming asks again while the worker says files are left, stops when there are none, and never asks more often than it may', async () => {
    const { root, db, made } = await held();
    const warming = warmPropertyReads();
    made[0].ready();
    assert.equal(await warming, true);
    const until = async (check) => {
      for (const end = Date.now() + 2000; !check() && Date.now() < end;) await tick();
      assert.ok(check(), 'the worker was asked again');
    };
    // Three rounds: files are left after the first two, none after the third.
    const prime = primePropertyReads({ root, db, rounds: 5 });
    await until(() => made[0].sent.length === 1);
    for (const [i, unseen] of [3, 1].entries()) {
      made[0].emit('message', { type: 'prime', id: made[0].sent[i].id, unseen });
      await until(() => made[0].sent.length === i + 2);
    }
    made[0].emit('message', { type: 'prime', id: made[0].sent[2].id, unseen: 0 });
    assert.equal(await prime, true);
    await tick();
    assert.deepEqual(made[0].sent.map((message) => message.type), ['prime', 'prime', 'prime'], 'nothing is left: no fourth round');
    // A worker that always says files are left is asked `rounds` times, and no more.
    made[0].sent.length = 0;
    const bounded = primePropertyReads({ root, db, rounds: 2 });
    await until(() => made[0].sent.length === 1);
    made[0].emit('message', { type: 'prime', id: made[0].sent[0].id, unseen: 2 });
    await until(() => made[0].sent.length === 2);
    made[0].emit('message', { type: 'prime', id: made[0].sent[1].id, unseen: 2 });
    assert.equal(await bounded, true);
    await tick();
    assert.equal(made[0].sent.length, 2);
    // An answer that names nothing is not taken for a priming.
    made[0].sent.length = 0;
    const silent = primePropertyReads({ root, db, rounds: 3 });
    await until(() => made[0].sent.length === 1);
    made[0].emit('message', { id: made[0].sent[0].id });
    assert.equal(await silent, false);
    await tick();
    assert.equal(made[0].sent.length, 1, 'nothing was answered: no second round');
  });

  // It puts a real worker in place of the held ones and terminates it, so the next test starts
  // with none. The test of a worker that cannot start comes last: it switches the scan off for
  // the life of the process.
  test('with the real worker, a priming answer says how many files are left, and the priming goes on until there are none or it has asked enough', async () => {
    const { Worker } = await import('node:worker_threads');
    const ctx = await indexed({
      'src/a.ts': 'export function f(row: Row) {\n  return row.zzqP;\n}\n',
      'src/b.ts': 'export const b = other.zzqP;\n',
    });
    const answers = [];
    let real = null;
    setScanWorkerFactory((url) => {
      real = new Worker(url);
      real.on('message', (msg) => { if (msg?.type === 'prime') answers.push(msg.unseen); });
      return real;
    });
    try {
      assert.equal(await primePropertyReads(ctx), true);
      assert.deepEqual(answers, [0], 'a project that fits in one round: nothing is left');
      // Another project, and no time to read in a round: both of its files are left, every round.
      const other = await indexed({ 'src/c.ts': 'export const c = row.zzqP;\n', 'src/d.ts': 'export const d = other.zzqP;\n' });
      answers.length = 0;
      assert.equal(await primePropertyReads({ ...other, limits: { readDeadlineMs: -1 } }), true);
      assert.deepEqual(answers, [2, 2, 2, 2], 'files are left every round: asked four times, no more');
      answers.length = 0;
      assert.equal(await primePropertyReads({ ...other, limits: { readDeadlineMs: -1 }, rounds: 1 }), true);
      assert.deepEqual(answers, [2]);
    } finally {
      await real.terminate().catch(() => {});
    }
  });

  test('a worker that cannot start: the scan is off for the life of the process, and nothing waits', async () => {
    const { root, db, made } = await held();
    const warming = warmPropertyReads();
    made[0].emit('error', new Error('no such module'));
    made[0].emit('exit', 1);
    assert.equal(await warming, false);
    assert.deepEqual(await scanPropertyReads({ root, db, query: 'zzqP' }), { ...NOTHING, skipped: 'not-ready' });
    assert.equal(await warmPropertyReads(), false, 'not tried again: what is broken stays broken');
    assert.equal(made.length, 1);
    assert.equal(made[0].sent.length, 0, 'nothing was ever asked of it');
  });
});
