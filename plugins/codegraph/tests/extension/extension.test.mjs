// The extension (bin/extension.mjs) against a fake host: the status item, the command and the
// tools the storage view calls. Real directories under a scratch data directory; the timers are
// stretched so nothing ticks during a test.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { activate, withReachability, io, TOOL_NAMES, SLOT_ID, VIEW_ID, COMMAND_ID } from '../../bin/extension.mjs';
import { projectKey } from '../../src/paths.mjs';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DAY = 24 * 60 * 60_000;
const dirs = [];
const mk = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

// A project folder; `off` gives it a .zcode/codegraph.json that switches indexing off.
function project({ off = false } = {}) {
  const dir = mk('codegraph-ext-project-');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  if (off) {
    fs.mkdirSync(path.join(dir, '.zcode'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.zcode', 'codegraph.json'), JSON.stringify({ autoIndex: false }));
  }
  return dir;
}

// An index of `project` in the store, the way an old one looks.
function seed(data, project, { ageMs = 0, state = 'ready', files = 10, filesDone = files, bytes = 4096, lock = false } = {}) {
  const dir = path.join(data, 'indexes', projectKey(project));
  fs.mkdirSync(dir, { recursive: true });
  const stamp = Date.now() - ageMs;
  const when = new Date(stamp);
  const filesOnDisk = {
    'status.json': JSON.stringify({ root: project.split(path.sep).join('/'), state, indexedAt: stamp, filesTotal: files, filesDone, symbols: files * 2, languages: { typescript: 1 }, stale: 0, error: null, reason: null }),
    'graph.db': 'x'.repeat(bytes),
    'used.at': String(stamp),
    ...(lock ? { lock: `${process.pid}\n` } : {}),
  };
  for (const [name, content] of Object.entries(filesOnDisk)) {
    fs.writeFileSync(path.join(dir, name), content);
    fs.utimesSync(path.join(dir, name), when, when);
  }
  return dir;
}

function fakeHost({ data, sessions = [], locale = 'en-US' } = {}) {
  const host = {
    slots: [],
    opened: [],
    changes: [],
    commands: new Map(),
    settings: { values: {} },
    sessions,
    view: null,
  };
  host.ctx = {
    extension: { id: 'codegraph', version: '0.1.0', path: PLUGIN, dataPath: data },
    env: { get: () => ({ locale }), onDidChange: () => {} },
    log: { error() {} },
    slots: { update: (id, patch, scope) => { host.slots.push({ id, patch, scope }); } },
    workbench: {
      visibleSessions: async () => host.sessions,
      onDidChange: (cb) => { host.changes.push(cb); },
    },
    settings: {
      get: async () => ({ values: { ...host.settings.values } }),
      update: async ({ values }) => { Object.assign(host.settings.values, values); },
    },
    views: { register: (id, definition) => { host.view = { id, definition }; }, open: async (id, scope) => { host.opened.push({ id, scope }); } },
    commands: { register: (id, handler) => { host.commands.set(id, handler); } },
  };
  return host;
}

const session = (sessionId, workspacePath) => ({ sessionId, workspace: { workspacePath }, isDraft: false, focused: false });
const lastPatch = (host, sessionId) => host.slots.filter((entry) => entry.scope?.sessionId === sessionId).at(-1)?.patch;
const tools = (host) => host.view.definition.tools;
const NO_TICK = { idleRefreshMs: 1e9, buildingRefreshMs: 1e9 };

// Wait until `ready` holds, for up to `limitMs`; returns whether it came to hold.
async function until(ready, limitMs = 3000) {
  const deadline = Date.now() + limitMs;
  while (!ready() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  return Boolean(ready());
}

describe('status item', () => {
  test('one item per open session: file count when ready, the percentage while building, "off" when the project switched indexing off, hidden without an index', async () => {
    const data = mk('codegraph-ext-data-');
    const ready = project();
    const building = project();
    const bare = project();
    const off = project({ off: true });
    seed(data, ready, { files: 291, bytes: 8 * 1024 * 1024, ageMs: 2 * 60_000 });
    seed(data, building, { state: 'building', files: 700, filesDone: 100 });
    const host = fakeHost({ data, sessions: [session('s-ready', ready), session('s-building', building), session('s-bare', bare), session('s-off', off)] });

    await activate(host.ctx, NO_TICK);

    assert.deepEqual([...new Set(host.slots.map((entry) => entry.id))], [SLOT_ID]);
    assert.equal(lastPatch(host, 's-ready').text, '291 files');
    assert.equal(lastPatch(host, 's-ready').visible, true);
    assert.equal(lastPatch(host, 's-ready').tooltip, `Code graph index\n${ready.split(path.sep).join('/')}\n291 files · 582 symbols · 8.0 MB · 2m ago\nClick to manage the indexes on this machine`);
    assert.deepEqual({ text: lastPatch(host, 's-building').text, tooltip: lastPatch(host, 's-building').tooltip.split('\n')[2] }, { text: '14%', tooltip: 'Indexing 100 of 700 files; results are partial until it is ready' });
    assert.deepEqual(lastPatch(host, 's-bare'), { visible: false }, 'no index and nothing switched off: the hooks already talk');
    assert.equal(lastPatch(host, 's-off').text, 'off');
    assert.match(lastPatch(host, 's-off').tooltip, /Indexing is off for this project/);
  });

  test('speaks the session language; a workspace that is a home or drive root shows nothing', async () => {
    const data = mk('codegraph-ext-data-');
    const ready = project();
    seed(data, ready, { files: 291 });
    const home = os.homedir();
    const host = fakeHost({ data, sessions: [session('s1', ready), session('s-home', home)], locale: 'zh-CN' });
    await activate(host.ctx, NO_TICK);
    assert.equal(lastPatch(host, 's1').text, '291 个文件');
    assert.match(lastPatch(host, 's1').tooltip, /点击管理本机上的索引$/);
    assert.deepEqual(lastPatch(host, 's-home'), { visible: false });
  });

  test('open sessions that come and go are followed, and a build in progress refreshes the item often', async () => {
    const data = mk('codegraph-ext-data-');
    const a = project();
    const b = project();
    seed(data, a, { state: 'building', files: 10, filesDone: 2 });
    seed(data, b, { files: 5 });
    const host = fakeHost({ data, sessions: [session('a', a)] });
    const realSetTimeout = globalThis.setTimeout;
    const delays = [];
    globalThis.setTimeout = (fn, ms, ...rest) => { delays.push(ms); return realSetTimeout(fn, ms, ...rest); };
    let handle;
    try {
      // The probe of a project path arms a timer of its own; 12345 tells it apart from the refresh.
      handle = await activate(host.ctx, { pathTimeoutMs: 12345 });
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    assert.deepEqual(delays.filter((ms) => ms !== 12345), [5000], 'a build somewhere: the short interval');
    // The host reports a new session and a closed one.
    for (const cb of host.changes) cb({ sessions: [session('b', b)] });
    assert.equal(await until(() => lastPatch(host, 'b')?.text === '5 files'), true, 'the new session gets its item');
    assert.deepEqual(lastPatch(host, 'a'), { visible: false }, 'the session that closed loses its item');
    handle.dispose();
  });

  test('a refresh that meets a path that throws and a host that stops answering is logged, never ends the process, and the loop goes on until told to stop', async () => {
    const data = mk('codegraph-ext-data-');
    const a = project();
    seed(data, a, { files: 5 });
    const host = fakeHost({ data, sessions: [session('a', a)] });
    const lines = [];
    host.ctx.log.error = (line) => lines.push(String(line));
    const realStat = io.stat;
    const rejections = [];
    const listen = (reason) => rejections.push(reason);
    process.on('unhandledRejection', listen);
    try {
      io.stat = () => {
        throw new Error('stat is gone');
      };
      const handle = await activate(host.ctx, { idleRefreshMs: 5, buildingRefreshMs: 5, pathTimeoutMs: 5 });
      const seen = host.slots.length;
      assert.equal(await until(() => host.slots.length >= seen + 3), true, 'the item is repainted on every tick');
      assert.ok(host.slots.slice(seen).every((entry) => entry.patch.visible === false), 'as hidden: nothing is claimed about a path that throws');
      host.ctx.workbench.visibleSessions = async () => {
        throw new Error('host is gone');
      };
      const before = lines.length;
      assert.equal(await until(() => lines.length > before), true, 'a host that stopped answering is logged');
      handle.dispose();
      const stopped = host.slots.length;
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(host.slots.length, stopped, 'dispose ends the loop');
    } finally {
      process.off('unhandledRejection', listen);
      io.stat = realStat;
    }
    assert.deepEqual(rejections, [], 'nothing is left unhandled in a process shared with every other plugin');
    assert.ok(lines.some((line) => /host is gone/.test(line)), lines.join('\n'));
  });

  test('clean: when every due index is stuck, it says so as a failure and removes nothing', { skip: process.platform !== 'win32' ? 'only Windows refuses to delete an open file' : false }, async () => {
    const data = mk('codegraph-ext-data-');
    const stuck = project();
    const dir = seed(data, stuck, { ageMs: 200 * DAY });
    // A database another process holds open: Windows will not delete it. (A read-only file is no
    // obstacle: Node clears that bit and deletes it anyway.)
    const held = new DatabaseSync(path.join(dir, 'graph.db'));
    const host = fakeHost({ data });
    try {
      await activate(host.ctx, NO_TICK);
      const out = await tools(host).clean.run({});
      assert.equal(out.ok, false, 'asked to clean, and could not clean one');
      assert.match(out.message, /was kept/);
      assert.equal(fs.existsSync(dir), true);
    } finally {
      held.close();
    }
  });

  test('a workspace that does not answer in time is left alone: no item, no protection, and no waiting', async () => {
    const data = mk('codegraph-ext-data-');
    const away = project();
    seed(data, away, { files: 40 });
    const host = fakeHost({ data, sessions: [session('s-away', away)] });
    const realStat = io.stat;
    // A share that went away: the call never comes back.
    io.stat = (target) => (String(target) === away ? new Promise(() => {}) : realStat(target));
    try {
      const started = Date.now();
      await activate(host.ctx, { ...NO_TICK, pathTimeoutMs: 20 });
      assert.ok(Date.now() - started < 1000, `activation waited ${Date.now() - started} ms`);
      assert.deepEqual(lastPatch(host, 's-away'), { visible: false }, 'nothing is claimed about a path that did not answer');
      const out = await tools(host).list.run({});
      assert.deepEqual([out.data.rows[0].blocked, out.data.rows[0].removable], [null, true], 'with no key to protect, the index is like any other');
    } finally {
      io.stat = realStat;
    }
  });

  test('an answer about the open sessions that arrives after a newer one is dropped, not applied over it', async () => {
    const data = mk('codegraph-ext-data-');
    const a = project();
    seed(data, a, { files: 5 });
    const host = fakeHost({ data, sessions: [session('a', a)] });
    // The host answers the question slowly, and a change event gets there first: the session is gone.
    let release = () => {};
    host.ctx.workbench.visibleSessions = () => new Promise((resolve) => { release = () => resolve(host.sessions); });
    const ready = activate(host.ctx, NO_TICK);
    for (const cb of host.changes) cb({ sessions: [] });
    release();
    await ready;
    const drawn = (id) => host.slots.some((entry) => entry.scope?.sessionId === id && entry.patch.visible);
    assert.equal(drawn('a'), false, 'a session the newest news says is closed is not drawn from older news');
  });

  test('a paint that was already waiting for a path when its session closed does not bring the item back', async () => {
    const data = mk('codegraph-ext-data-');
    const a = project();
    seed(data, a, { files: 5 });
    const host = fakeHost({ data, sessions: [session('a', a)] });
    const realStat = io.stat;
    // The workspace answers, slowly; `delivered` counts the answers, so the test can wait for the
    // paint that was waiting on one.
    let delivered = 0;
    io.stat = (target) => (String(target) === a ? new Promise((resolve, reject) => setTimeout(() => { delivered += 1; realStat(target).then(resolve, reject); }, 60)) : realStat(target));
    try {
      await activate(host.ctx, NO_TICK);
      assert.equal(lastPatch(host, 'a').visible, true, 'drawn while the session is open');
      // A change starts a paint, which waits for the path; before it comes back the session closes.
      const before = host.slots.length;
      for (const cb of host.changes) cb({ sessions: [session('a', a)] });
      // Let that paint begin, so that it is the one waiting on the path when the next event lands.
      await new Promise((resolve) => setImmediate(resolve));
      for (const cb of host.changes) cb({ sessions: [] });
      assert.equal(await until(() => delivered >= 2 && host.slots.length > before), true, 'the waiting paint got its answer, and the closing one had its say');
      await new Promise((resolve) => setImmediate(resolve));
      // Drawn once while open, hidden once on closing, and never again: the paint that had been
      // waiting did not draw the session a second time on its way out.
      assert.deepEqual(
        host.slots.filter((entry) => entry.scope?.sessionId === 'a').map((entry) => entry.patch.visible),
        [true, false],
      );
    } finally {
      io.stat = realStat;
    }
  });

  test('dispose ends the loop even while a refresh is waiting on the host', async () => {
    const data = mk('codegraph-ext-data-');
    const a = project();
    seed(data, a, { files: 5 });
    const host = fakeHost({ data, sessions: [session('a', a)] });
    // The first tick's read of the session list hangs until the test lets it go.
    let release = () => {};
    const hanging = new Promise((resolve) => { release = () => resolve(host.sessions); });
    let reads = 0;
    host.ctx.workbench.visibleSessions = async () => {
      reads += 1;
      return reads === 2 ? hanging : host.sessions;
    };
    const handle = await activate(host.ctx, { idleRefreshMs: 5, buildingRefreshMs: 5 });
    try {
      assert.equal(await until(() => reads >= 2), true, 'a refresh is waiting on the host');
      handle.dispose();
      release();
      await new Promise((resolve) => setTimeout(resolve, 60));
      const [readsAfter, patchesAfter] = [reads, host.slots.length];
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.deepEqual([reads, host.slots.length], [readsAfter, patchesAfter], 'the refresh that was running did not arm the next one');
    } finally {
      handle.dispose();
    }
  });
});

describe('withReachability', () => {
  test('a project folder that is gone marks its index; one that did not answer, or an index without a root, is left as it is', async () => {
    const entries = [{ key: 'a'.repeat(16), root: 'D:/gone' }, { key: 'b'.repeat(16), root: 'D:/away' }, { key: 'c'.repeat(16), root: null }];
    const realStat = io.stat;
    io.stat = (target) => (String(target).endsWith('away') ? new Promise(() => {}) : Promise.reject(Object.assign(new Error('no such file'), { code: 'ENOENT' })));
    try {
      const out = await withReachability(entries, 20);
      assert.deepEqual(out.map((entry) => entry.orphan), [true, undefined, undefined]);
      assert.equal(entries[0].orphan, undefined, 'what came in is not changed');
    } finally {
      io.stat = realStat;
    }
  });
});

describe('command', () => {
  test('the manifest declares exactly what the extension registers; the host refuses the rest with "not-declared"', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.zcode-plugin', 'plugin.json'), 'utf8'));
    const [status] = manifest.slots['composer.status'];
    const [launcher] = manifest.slots['sidePane.launcher'];
    assert.deepEqual([status.id, status.target], [SLOT_ID, { command: COMMAND_ID }]);
    assert.deepEqual([launcher.id, launcher.target], [VIEW_ID, { view: VIEW_ID }]);
    assert.deepEqual(manifest.extension.contributes.commands.map((item) => item.id), [COMMAND_ID]);
    assert.deepEqual(manifest.extension.contributes.views.map((item) => item.id), [VIEW_ID]);
    // `onAvailable` covers the view and the command; nothing else has to wake the extension.
    assert.deepEqual(manifest.extension.activationEvents, ['onAvailable']);
    assert.equal(fs.existsSync(path.join(PLUGIN, manifest.extension.main)), true, manifest.extension.main);
    // The desktop app only draws what it knows; anything else is dropped without a word.
    const ICONS = /^(activity|bell|bot|chart-bar|chart-pie|pie-chart|clock|cpu|database|eye|file-text|gauge|git-branch|git-merge|git-pull-request|globe|info|layers|list|log-in|log-out|message-square|puzzle|sparkles|terminal|timer|zap)$/;
    for (const item of [status, launcher, manifest.extension.contributes.views[0]]) assert.match(item.icon, ICONS, `${item.id}: icon the app can draw`);
  });

  test('opens the storage view for the whole app; a host that refuses gets a result, never an exception', async () => {
    const data = mk('codegraph-ext-data-');
    const host = fakeHost({ data });
    await activate(host.ctx, NO_TICK);
    assert.deepEqual([...host.commands.keys()], [COMMAND_ID]);
    assert.deepEqual(await host.commands.get(COMMAND_ID)({ scope: { kind: 'session', sessionId: 's1' } }), { ok: true });
    assert.deepEqual(host.opened, [{ id: VIEW_ID, scope: 'app' }]);
    const refusing = fakeHost({ data });
    refusing.ctx.views.open = async () => { throw new Error('view is not available'); };
    await activate(refusing.ctx, NO_TICK);
    const result = await refusing.commands.get(COMMAND_ID)({});
    assert.equal(result.ok, false);
    assert.match(result.message, /view is not available/);
  });
});

describe('storage view tools', () => {
  test('the view is registered with its page and four tools whose names are the contract', async () => {
    const data = mk('codegraph-ext-data-');
    const host = fakeHost({ data });
    await activate(host.ctx, NO_TICK);
    assert.equal(host.view.id, VIEW_ID);
    assert.equal(host.view.definition.entry, 'ui/index.html');
    assert.equal(fs.existsSync(path.join(PLUGIN, host.view.definition.entry)), true, 'the page is part of the plugin');
    assert.deepEqual(Object.keys(tools(host)), [...TOOL_NAMES]);
    for (const tool of Object.values(tools(host))) assert.equal(typeof tool.run, 'function');
  });

  test('list: every index, the open session marked, what is due under the policy, in the session language', async () => {
    const data = mk('codegraph-ext-data-');
    const current = project();
    const recent = project();
    const old = project();
    seed(data, current, { files: 40, ageMs: 60_000 });
    seed(data, recent, { ageMs: 60_000 });
    seed(data, old, { ageMs: 200 * DAY });
    const host = fakeHost({ data, sessions: [session('s1', current)], locale: 'zh-CN' });
    await activate(host.ctx, NO_TICK);
    const out = await tools(host).list.run({}, { view: { scope: { kind: 'app' } } });
    assert.equal(out.ok, true);
    assert.equal(out.data.locale, 'zh');
    assert.equal(out.data.storeDir, path.join(data, 'indexes').split(path.sep).join('/'));
    assert.equal(out.data.totals.projects, 3);
    assert.deepEqual(out.data.totals.due, 1, 'the index unused for 200 days');
    const byPath = Object.fromEntries(out.data.rows.map((row) => [row.path, row]));
    assert.deepEqual([byPath[current.split(path.sep).join('/')].blocked, byPath[old.split(path.sep).join('/')].removable], ['current', true]);
    assert.equal(out.data.text.title, '代码图谱索引');
  });

  test('remove: refuses the project of an open session and an index in use, removes another and returns a fresh snapshot', async () => {
    const data = mk('codegraph-ext-data-');
    const current = project();
    const busy = project();
    const other = project();
    seed(data, current, { files: 40, ageMs: 60_000 });
    seed(data, busy, { lock: true, ageMs: 60_000 });
    seed(data, other, { ageMs: 60_000 });
    const host = fakeHost({ data, sessions: [session('s1', current)] });
    await activate(host.ctx, NO_TICK);
    const remove = tools(host).remove;
    const keyOf = (dir) => projectKey(dir);
    assert.match((await remove.run({ key: keyOf(current) })).message, /was kept: The project of an open session/);
    assert.match((await remove.run({ key: keyOf(busy) })).message, /was kept: Another session is writing it/);
    assert.match((await remove.run({ key: 'ffffffffffffffff' })).message, /was kept: there is no such index/);
    assert.match((await remove.run({})).message, /the index was not named/);
    assert.equal(fs.existsSync(path.join(data, 'indexes', keyOf(other))), true, 'nothing was removed by a refused call');
    const gone = await remove.run({ key: keyOf(other) });
    assert.equal(gone.ok, true);
    assert.equal(gone.message, `Removed the index of ${other.split(path.sep).join('/')}, 4 KB freed.`);
    assert.equal(fs.existsSync(path.join(data, 'indexes', keyOf(other))), false);
    assert.equal(gone.data.totals.projects, 2, 'the page gets the store as it is now');
  });

  test('clean: removes what the policy says is due, keeps an index that is due and in use, and says so', async () => {
    const data = mk('codegraph-ext-data-');
    const current = project();
    const old = project();
    const oldBusy = project();
    seed(data, current, { ageMs: 60_000 });
    seed(data, old, { ageMs: 200 * DAY });
    seed(data, oldBusy, { ageMs: 200 * DAY, lock: true });
    const host = fakeHost({ data, sessions: [session('s1', current)], locale: 'zh-CN' });
    await activate(host.ctx, NO_TICK);
    const out = await tools(host).clean.run({});
    assert.equal(fs.existsSync(path.join(data, 'indexes', projectKey(old))), false);
    assert.equal(fs.existsSync(path.join(data, 'indexes', projectKey(oldBusy))), true, 'in use: never a candidate');
    assert.match(out.message, /^已删除 1 个索引，释放 [\d.]+ [KM]B。$/);
    assert.equal(out.data.totals.projects, 2);
    assert.equal((await tools(host).clean.run({})).message, '没有到期的索引。');
  });

  test('policy: validated, saved through the plugin settings, and a limit the file fixed wins over the setting', async () => {
    const data = mk('codegraph-ext-data-');
    const p = project();
    seed(data, p, { ageMs: 200 * DAY });
    const host = fakeHost({ data });
    await activate(host.ctx, NO_TICK);
    const policy = tools(host).policy;
    assert.match((await policy.run({ maxIdleDays: -1 })).message, /maxIdleDays must be a whole number/);
    assert.equal((await policy.run({ maxTotalMB: 'many' })).ok, false);
    const saved = await policy.run({ maxIdleDays: 30, maxTotalMB: 2048 });
    assert.equal(saved.ok, true);
    assert.equal(saved.message, 'Saved. It applies the next time a session opens.');
    assert.deepEqual(host.settings.values, { maxIdleDays: 30, maxTotalMB: 2048 });
    assert.deepEqual([saved.data.policy.maxIdleDays, saved.data.policy.maxTotalMB], [30, 2048]);
    assert.deepEqual(saved.data.policy.fixedByFile, { maxIdleDays: false, maxTotalMB: false });
    assert.equal(saved.data.totals.due, 1, '200 idle days is past a 30-day limit');
    // The user's file says "keep every index": the setting no longer applies, and the page says why.
    fs.writeFileSync(path.join(data, 'codegraph.json'), JSON.stringify({ maxIdleDays: 0 }));
    const listed = await tools(host).list.run({});
    assert.equal(listed.data.policy.maxIdleDays, 0);
    assert.deepEqual(listed.data.policy.fixedByFile, { maxIdleDays: true, maxTotalMB: false });
    assert.equal(listed.data.totals.due, 0);
    assert.equal(listed.data.text.fixedByFile, 'Set by codegraph.json; change it there.');
    const noSettings = fakeHost({ data });
    delete noSettings.ctx.settings;
    await activate(noSettings.ctx, NO_TICK);
    assert.equal((await tools(noSettings).policy.run({ maxIdleDays: 5 })).ok, false);
  });
});
