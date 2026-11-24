// The index store (src/index/storage.mjs): what it holds, when an index was last used, and
// which indexes the policy may delete. Real directories under a scratch data directory.
import { test, describe, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { indexDir, projectKey } from '../../src/paths.mjs';
import { writeStatus } from '../../src/index/status.mjs';
import { listIndexes, planSweep, removeIndex, sweepIndexes, touchUsage, indexesDir } from '../../src/index/storage.mjs';
import { scratchDir, rmrf, useScratchData } from './_helpers.mjs';

const data = useScratchData('data-storage');
const dirs = [];
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
// Every test starts with an empty store: the indexes a test made go with its project directories.
afterEach(() => {
  for (const d of dirs.splice(0)) rmrf(d);
  rmrf(indexesDir());
});
after(() => rmrf(data));

function project() {
  const dir = scratchDir('storage-project');
  dirs.push(dir);
  return dir;
}

// Move a file's mtime into the past, as if nothing had touched it for `ms`.
function age(file, ms) {
  const t = new Date(Date.now() - ms);
  fs.utimesSync(file, t, t);
}

// An index as the store holds it: status, a database of `bytes`, a usage stamp, all `oldMs` old.
function fakeIndex({ root, oldMs = 0, bytes = 4096, state = 'ready', lock = false } = {}) {
  writeStatus(root, { state, filesTotal: 3, filesDone: 3, symbols: 10, languages: { typescript: 3 }, indexedAt: Date.now() - oldMs });
  const dir = indexDir(root);
  fs.writeFileSync(path.join(dir, 'graph.db'), Buffer.alloc(bytes));
  fs.writeFileSync(path.join(dir, 'graph.db-wal'), Buffer.alloc(512));
  touchUsage(root, { now: Date.now() - oldMs });
  if (lock) fs.writeFileSync(path.join(dir, 'lock'), `${process.pid}\n`);
  for (const name of ['status.json', 'graph.db', 'graph.db-wal', 'used.at', ...(lock ? ['lock'] : [])]) age(path.join(dir, name), oldMs);
  return dir;
}

const entry = (key, extra = {}) => ({
  key,
  dir: path.join(indexesDir(), key),
  root: `D:/gone/${key}`,
  state: 'ready',
  files: 3,
  symbols: 10,
  bytes: 1000,
  lastUsedAt: 0,
  inUse: false,
  orphan: false,
  ...extra,
});

describe('touchUsage', () => {
  test('stamps an existing index, never creates one, and rewrites at most once an hour', () => {
    const root = project();
    assert.equal(touchUsage(root, { now: 1000 }), false, 'no index directory: nothing to stamp');
    assert.equal(fs.existsSync(indexDir(root)), false, 'the index directory is not created');
    const dir = fakeIndex({ root, oldMs: 10 * DAY });
    const stamp = Number(fs.readFileSync(path.join(dir, 'used.at'), 'utf8'));
    assert.ok(Date.now() - stamp > 9 * DAY, 'the stamp is the age the fixture asked for');
    const now = Date.now();
    assert.equal(touchUsage(root, { now }), true);
    assert.equal(Number(fs.readFileSync(path.join(dir, 'used.at'), 'utf8')), now);
    assert.equal(touchUsage(root, { now: now + 30 * 60_000 }), false, 'half an hour later: not rewritten');
    assert.equal(touchUsage(root, { now: now + 2 * HOUR }), true, 'two hours later: rewritten');
    // A clock that went back leaves a stamp from the future: it is corrected, not trusted.
    assert.equal(touchUsage(root, { now: now - 3 * HOUR }), true);
    assert.equal(Number(fs.readFileSync(path.join(dir, 'used.at'), 'utf8')), now - 3 * HOUR);
  });
});

describe('listIndexes', () => {
  test('an empty store lists nothing', () => {
    assert.deepEqual(listIndexes(), []);
    assert.deepEqual(listIndexes(), [], 'a store directory that does not exist is not an error');
  });

  test('lists every index with its project, size and last use, least recently used first', () => {
    const a = project();
    const b = project();
    fakeIndex({ root: a, oldMs: 3 * DAY, bytes: 1000 });
    fakeIndex({ root: b, oldMs: DAY, bytes: 2000 });
    // Something that is not an index (another plugin's file, a temp directory) is ignored.
    fs.mkdirSync(indexesDir(), { recursive: true });
    fs.writeFileSync(path.join(indexesDir(), 'note.txt'), 'x');
    fs.mkdirSync(path.join(indexesDir(), 'not-a-key'), { recursive: true });
    const listed = listIndexes();
    assert.deepEqual(listed.map((e) => e.root), [a.split(path.sep).join('/'), b.split(path.sep).join('/')], 'oldest first');
    assert.deepEqual(listed.map((e) => e.key), [projectKey(a), projectKey(b)]);
    assert.deepEqual(listed.map((e) => e.bytes), [1000 + 512 + fs.statSync(path.join(indexDir(a), 'status.json')).size + fs.statSync(path.join(indexDir(a), 'used.at')).size, 2000 + 512 + fs.statSync(path.join(indexDir(b), 'status.json')).size + fs.statSync(path.join(indexDir(b), 'used.at')).size]);
    assert.equal(listed[0].state, 'ready');
    assert.deepEqual([listed[0].files, listed[0].symbols], [3, 10]);
    assert.ok(Math.abs(listed[0].lastUsedAt - (Date.now() - 3 * DAY)) < 5000, 'the stamp and file times decide');
    assert.equal(listed[0].inUse, false);
    assert.equal(listed[0].orphan, false);
  });

  test('an index whose project directory is gone is an orphan; one whose lock a live process holds is in use', () => {
    const gone = fs.mkdtempSync(path.join(data, 'gone-'));
    dirs.push(gone);
    const live = project();
    const goneDir = fakeIndex({ root: gone });
    const liveDir = fakeIndex({ root: live, lock: true });
    rmrf(gone);
    const listed = listIndexes();
    const orphan = listed.find((e) => e.dir === goneDir);
    const held = listed.find((e) => e.dir === liveDir);
    assert.equal(orphan.orphan, true);
    assert.equal(held.inUse, true);
    assert.equal(held.orphan, false);
    // A stale lock (a process that no longer exists) is not a use.
    fs.writeFileSync(path.join(liveDir, 'lock'), '4194304\n');
    assert.equal(listIndexes().find((e) => e.dir === liveDir).inUse, false);
    // Without the reachability probe nothing looks at the project folder: the automatic sweep,
    // which must not wait on an unreachable network path, gets the index with orphan unknown.
    assert.equal(listIndexes({ probe: false }).find((e) => e.dir === goneDir).orphan, false);
    // A status file that cannot be read does not hide the index.
    fs.writeFileSync(path.join(goneDir, 'status.json'), '{ "root": "D:/');
    const unreadable = listIndexes().find((e) => e.dir === goneDir);
    assert.deepEqual([unreadable.root, unreadable.state, unreadable.orphan], [null, 'unknown', false]);
  });
});

describe('planSweep', () => {
  const now = 100 * DAY;
  const keys = (plan, field) => plan[field].map((e) => e.key);

  test('without limits nothing goes, not even an index whose project folder is gone', () => {
    const entries = [entry('aaaaaaaaaaaaaaaa', { orphan: true }), entry('bbbbbbbbbbbbbbbb', { lastUsedAt: 0 }), entry('cccccccccccccccc')];
    const plan = planSweep(entries, { now });
    assert.deepEqual(keys(plan, 'remove'), []);
    assert.deepEqual(keys(plan, 'kept'), ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc']);
  });

  test('a project folder that cannot be reached today is no reason on its own: the age rule decides', () => {
    // An index on a drive that is unplugged, or a share that is not mounted, must survive a
    // session opened elsewhere; it goes only when it is unused for as long as any other index.
    const entries = [
      entry('aaaaaaaaaaaaaaaa', { orphan: true, lastUsedAt: now - DAY }),
      entry('bbbbbbbbbbbbbbbb', { orphan: true, lastUsedAt: now - 200 * DAY }),
      entry('cccccccccccccccc', { lastUsedAt: now - 200 * DAY }),
    ];
    const plan = planSweep(entries, { maxIdleDays: 90, now });
    assert.deepEqual(plan.remove.map((e) => [e.key, e.reason]), [
      ['bbbbbbbbbbbbbbbb', 'orphan'],
      ['cccccccccccccccc', 'idle'],
    ]);
    assert.deepEqual(keys(plan, 'kept'), ['aaaaaaaaaaaaaaaa']);
  });

  test('the current project and an index in use stay, whatever their age', () => {
    const entries = [
      entry('aaaaaaaaaaaaaaaa', { orphan: true, lastUsedAt: 0 }),
      entry('bbbbbbbbbbbbbbbb', { lastUsedAt: 0, inUse: true }),
      entry('cccccccccccccccc', { lastUsedAt: now - 5 * DAY }),
    ];
    const plan = planSweep(entries, { keep: ['aaaaaaaaaaaaaaaa'], maxIdleDays: 1, maxTotalBytes: 1, now });
    assert.deepEqual(keys(plan, 'remove'), ['cccccccccccccccc']);
    assert.equal(plan.remove[0].reason, 'idle');
    assert.deepEqual(keys(plan, 'kept'), ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb']);
  });

  test('idle means older than maxIdleDays; 0 switches the rule off', () => {
    const entries = [entry('aaaaaaaaaaaaaaaa', { lastUsedAt: now - 91 * DAY }), entry('bbbbbbbbbbbbbbbb', { lastUsedAt: now - 89 * DAY })];
    assert.deepEqual(keys(planSweep(entries, { maxIdleDays: 90, now }), 'remove'), ['aaaaaaaaaaaaaaaa']);
    assert.deepEqual(keys(planSweep(entries, { maxIdleDays: 0, now }), 'remove'), []);
    assert.deepEqual(keys(planSweep(entries, { now }), 'remove'), [], 'not set is off as well');
  });

  test('over the quota the least recently used indexes go until the store fits', () => {
    const entries = [
      entry('aaaaaaaaaaaaaaaa', { lastUsedAt: now - 3 * DAY, bytes: 600 }),
      entry('bbbbbbbbbbbbbbbb', { lastUsedAt: now - 2 * DAY, bytes: 600 }),
      entry('cccccccccccccccc', { lastUsedAt: now - DAY, bytes: 600 }),
    ];
    const plan = planSweep(entries, { maxTotalBytes: 1200, now });
    assert.deepEqual(keys(plan, 'remove'), ['aaaaaaaaaaaaaaaa']);
    assert.equal(plan.remove[0].reason, 'over-quota');
    assert.deepEqual(keys(plan, 'kept'), ['bbbbbbbbbbbbbbbb', 'cccccccccccccccc']);
    // The kept project and an index in use are not candidates, even when they are the oldest.
    const guarded = planSweep(
      entries.map((e) => ({ ...e, bytes: 600 })),
      { keep: ['aaaaaaaaaaaaaaaa'], maxTotalBytes: 600, now },
    );
    assert.deepEqual(keys(guarded, 'remove'), ['bbbbbbbbbbbbbbbb', 'cccccccccccccccc']);
    const inUse = planSweep(entries.map((e) => ({ ...e, lastUsedAt: now - 10 * DAY, inUse: e.key === 'aaaaaaaaaaaaaaaa' })), { maxTotalBytes: 600, now });
    assert.deepEqual(keys(inUse, 'remove'), ['bbbbbbbbbbbbbbbb', 'cccccccccccccccc']);
    // A store that fits is left alone.
    assert.deepEqual(keys(planSweep(entries, { maxTotalBytes: 1800, now }), 'remove'), []);
  });
});

describe('sweepIndexes', () => {
  test('deletes what the policy allows and reports it; the rest of the store stays', () => {
    const current = project();
    const old = project();
    const gone = fs.mkdtempSync(path.join(data, 'gone-'));
    const goneRecently = fs.mkdtempSync(path.join(data, 'gone-recent-'));
    dirs.push(gone, goneRecently);
    const currentDir = fakeIndex({ root: current, oldMs: 200 * DAY });
    const oldDir = fakeIndex({ root: old, oldMs: 200 * DAY });
    const goneDir = fakeIndex({ root: gone, oldMs: 200 * DAY });
    // A project that vanished an hour ago: its folder is gone, but it is not unused for long.
    const recentDir = fakeIndex({ root: goneRecently, oldMs: HOUR });
    rmrf(gone);
    rmrf(goneRecently);
    const result = sweepIndexes({ keep: [projectKey(current)], maxIdleDays: 90, probe: true });
    assert.deepEqual(result.removed.map((e) => [e.root, e.reason]), [
      [gone.split(path.sep).join('/'), 'orphan'],
      [old.split(path.sep).join('/'), 'idle'],
    ]);
    assert.deepEqual(result.busy, []);
    // The automatic sweep does not look at project folders (an unreachable one must not delay a
    // session start): the same indexes then go as plain "idle".
    fakeIndex({ root: old, oldMs: 200 * DAY });
    fakeIndex({ root: gone, oldMs: 200 * DAY });
    const automatic = sweepIndexes({ keep: [projectKey(current)], maxIdleDays: 90 });
    assert.deepEqual(automatic.removed.map((e) => e.reason), ['idle', 'idle']);
    assert.equal(automatic.removed.every((e) => e.orphan === false), true, 'nothing was probed');
    assert.equal(fs.existsSync(oldDir), false);
    assert.equal(fs.existsSync(goneDir), false);
    assert.equal(fs.existsSync(recentDir), true, 'a project folder that is gone does not by itself make the index due');
    assert.equal(fs.existsSync(currentDir), true, 'the current project is kept however old');
    assert.deepEqual(listIndexes().map((e) => e.root), [current.split(path.sep).join('/'), goneRecently.split(path.sep).join('/')], 'least recently used first');
  });

  test('removeIndex accepts only an index directory of this store', () => {
    const elsewhere = scratchDir('storage-elsewhere');
    dirs.push(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'keep.txt'), 'x');
    assert.throws(() => removeIndex(elsewhere), /is not an index directory of this store/);
    fs.mkdirSync(path.join(indexesDir(), 'not-a-key'), { recursive: true });
    assert.throws(() => removeIndex(path.join(indexesDir(), 'not-a-key')), /is not an index directory of this store/);
    assert.equal(fs.existsSync(path.join(elsewhere, 'keep.txt')), true);
  });

  test('the store can be named: an index of another data directory is not this store\'s, and removeIndex refuses it there', () => {
    const other = scratchDir('storage-other-data');
    dirs.push(other);
    const dir = fakeIndex({ root: project() });
    assert.equal(listIndexes({ probe: false }).length, 1, 'in the default store');
    assert.deepEqual(listIndexes({ probe: false, data: other }), [], 'and in no other data directory');
    assert.throws(() => removeIndex(dir, other), /is not an index directory of this store/);
    assert.equal(fs.existsSync(dir), true, 'the refusal comes before anything is touched');
    assert.equal(removeIndex(dir), true);
  });
});

describe('removeIndex with a busy index', { skip: process.platform !== 'win32' ? 'only Windows refuses to delete an open file' : false }, () => {
  test('an index whose database another process holds open is left complete', () => {
    const root = project();
    // Old enough to be due; only the open database keeps it.
    const dir = fakeIndex({ root, oldMs: 10 * DAY });
    const db = new DatabaseSync(path.join(dir, 'graph.db'));
    try {
      assert.equal(removeIndex(dir), false);
      assert.equal(fs.existsSync(path.join(dir, 'graph.db')), true);
      assert.equal(fs.existsSync(path.join(dir, 'status.json')), true, 'the status goes only after the database could');
      const result = sweepIndexes({ maxIdleDays: 1 });
      assert.deepEqual(result.removed, []);
      assert.equal(result.busy.length, 1, 'reported as due but kept');
    } finally {
      db.close();
    }
    assert.equal(removeIndex(dir), true);
    assert.equal(fs.existsSync(dir), false);
  });
});

describe('sweepIndexes: one index that cannot be removed does not stop the others', () => {
  test('a removal that throws is reported with its error and the sweep goes on', () => {
    const root = project();
    const dir = fakeIndex({ root, oldMs: 200 * DAY });
    const due = { ...listIndexes()[0], orphan: false };
    // An entry whose directory is not an index of this store: removeIndex refuses it by throwing.
    const refused = { ...due, key: 'ffffffffffffffff', dir: path.join(data, 'elsewhere'), reason: 'idle' };
    const result = sweepIndexes({ maxIdleDays: 90, entries: [refused, due] });
    assert.deepEqual(result.removed.map((e) => e.key), [projectKey(root)], 'the second one was still removed');
    assert.equal(result.busy.length, 1);
    assert.match(result.busy[0].error, /is not an index directory of this store/);
    assert.equal(fs.existsSync(dir), false);
  });
});
