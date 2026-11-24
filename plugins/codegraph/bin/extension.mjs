/**
 * codegraph — extension code for the ZCode desktop app (CONTRACTS.md §14).
 *
 * Nothing here is needed for indexing itself. It adds the surface the tools and the slash
 * command cannot give: a status item in the composer toolbar that shows the state of this
 * session's index, a command that opens the storage view (the item's click target, and the
 * side pane entry), and that view — every project's index on this machine, with delete and
 * policy controls, drawn with ZCode's own theme and utilities (ui/index.html).
 *
 * Two rules run through the file.
 *  - This process is shared with every other plugin's extension code. Nothing here may sit in
 *    a synchronous call on a path that may not answer (a project folder on a share that went
 *    away): every project path is probed first, asynchronously and with a timeout, and a path
 *    that did not answer is left alone for that round. The plugin's own data folder is local
 *    and read synchronously, like the MCP server reads it.
 *  - The view decides nothing on its own: every action is a tool call whose `run` lives here,
 *    next to the store, and "which projects are open" comes from the host, not from the page.
 *
 * Runtime is zero-dependency: the host injects `ctx`.
 */

import path from 'node:path';
import fs from 'node:fs';
import { readStatusFile } from '../src/index/status.mjs';
import { dataDir, projectKey, resolveProjectRoot } from '../src/paths.mjs';
import { fileSettings, loadProjectConfig } from '../src/config.mjs';
import { indexesDir, listIndexes, planSweep, removeListed } from '../src/index/storage.mjs';
import { resolvePolicy, slotFor, viewData, viewStrings } from '../src/extension/describe.mjs';

export const SLOT_ID = 'codegraph.status';
export const VIEW_ID = 'codegraph.storage';
export const COMMAND_ID = 'codegraph.storage';
export const TOOL_NAMES = Object.freeze(['list', 'remove', 'clean', 'policy']);
// The status item is refreshed often while an index is being built somewhere, rarely otherwise.
export const BUILDING_REFRESH_MS = 5000;
export const IDLE_REFRESH_MS = 60_000;
// How long a path gets to answer before the extension gives up on it for this round.
export const PATH_TIMEOUT_MS = 1500;

const MB = 1024 * 1024;
const POLICY_KEYS = ['maxIdleDays', 'maxTotalMB'];
const quiet = { write() {} };

const display = (value) => String(value ?? '').split(path.sep).join('/');
const isCount = (value) => typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** Where the host keeps this plugin's data; the environment only when the host did not say. */
function dataDirectory(ctx) {
  const named = ctx?.extension?.dataPath;
  return typeof named === 'string' && named.trim() ? path.resolve(named.trim()) : dataDir();
}

// The one call the extension makes on a path it does not own. Tests replace `stat` to make a
// path that never answers.
export const io = { stat: (target) => fs.promises.stat(target) };

/**
 * Ask a path whether it is there, without ever waiting longer than `timeoutMs`.
 *
 * @param {string} target
 * @param {number} timeoutMs
 * @returns {Promise<'there'|'missing'|'unknown'>}  `unknown`: no answer in time, or an error
 *   that says nothing about the path (permissions, a share that is reconnecting)
 */
function probe(target, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (!done) {
        done = true;
        resolve(value);
      }
    };
    const timer = setTimeout(() => finish('unknown'), timeoutMs);
    try {
      io.stat(target).then(
        () => {
          clearTimeout(timer);
          finish('there');
        },
        (err) => {
          clearTimeout(timer);
          finish(err?.code === 'ENOENT' || err?.code === 'ENOTDIR' ? 'missing' : 'unknown');
        },
      );
    } catch {
      // a stat that throws outright says as little as one that never answers
      clearTimeout(timer);
      finish('unknown');
    }
  });
}

/**
 * Mark indexes whose project folder is gone. A folder that did not answer in time counts as
 * "still there": a missing folder only changes a label, it never decides anything.
 *
 * @param {object[]} entries  from `listIndexes({ probe: false })`
 * @param {number} [timeoutMs]
 */
export async function withReachability(entries, timeoutMs = PATH_TIMEOUT_MS) {
  const answers = await Promise.all(entries.map((entry) => (entry.root ? probe(entry.root, timeoutMs) : 'unknown')));
  return entries.map((entry, i) => (answers[i] === 'missing' ? { ...entry, orphan: true } : entry));
}

/**
 * Activate the extension. Resolves when the open sessions have been read once and the status
 * items drawn, so a host (or a test) can wait for the first paint.
 *
 * @param {object} ctx  injected by the host
 * @param {{ buildingRefreshMs?: number, idleRefreshMs?: number, pathTimeoutMs?: number }} [timing]  tests shorten or lengthen the waits
 * @returns {Promise<{ dispose: () => void }>}
 */
export async function activate(ctx, { buildingRefreshMs = BUILDING_REFRESH_MS, idleRefreshMs = IDLE_REFRESH_MS, pathTimeoutMs = PATH_TIMEOUT_MS } = {}) {
  const data = dataDirectory(ctx);
  const log = (message) => {
    try {
      if (typeof ctx?.log?.error === 'function') ctx.log.error(`codegraph: ${message}`);
      else process.stderr.write(`codegraph: ${message}\n`);
    } catch {
      // the log is a courtesy
    }
  };
  const state = { locale: '', sessions: new Map(), building: new Set(), timer: null };

  // ---------------------------------------------------------------- locale

  const readLocale = () => {
    try {
      const env = ctx?.env?.get?.();
      if (env && typeof env.locale === 'string') state.locale = env.locale;
    } catch {
      // an older host
    }
  };
  readLocale();
  try {
    ctx?.env?.onDidChange?.((env) => {
      if (env && typeof env.locale === 'string') state.locale = env.locale;
    });
  } catch {
    // optional
  }

  // ------------------------------------------------------- open sessions

  const remember = (item) => {
    const id = item?.sessionId;
    const workspace = item?.workspace?.workspacePath;
    if (typeof id !== 'string' || !id || typeof workspace !== 'string' || !workspace) return null;
    state.sessions.set(id, workspace);
    return id;
  };

  // The project keys of every open session: their indexes are never removed from the view. A
  // workspace that did not answer in time has no key here, so its index is then like any other
  // and is rebuilt if it is removed.
  async function openKeys() {
    const keys = new Set();
    for (const workspace of state.sessions.values()) {
      if ((await probe(workspace, pathTimeoutMs)) === 'unknown') continue;
      try {
        const { root, unsafe } = resolveProjectRoot(workspace);
        if (!unsafe) keys.add(projectKey(root));
      } catch {
        // a workspace that cannot be resolved has no index to protect
      }
    }
    return [...keys];
  }

  // ------------------------------------------------------- status item

  const setSlot = (sessionId, patch) => {
    try {
      Promise.resolve(ctx?.slots?.update?.(SLOT_ID, patch, { sessionId })).catch?.(() => {});
    } catch (err) {
      log(`status item: ${err?.message ?? err}`);
    }
  };

  async function paint(closed) {
    // A session that closed takes its item with it; the composer of that session may still be on screen.
    for (const id of closed) setSlot(id, { visible: false });
    const open = [...state.sessions];
    const answers = await Promise.all(open.map(([, workspace]) => probe(workspace, pathTimeoutMs)));
    // No probe of the project folders here: this runs on a timer, and only a label would change.
    const entries = listIndexes({ probe: false, data });
    const sizes = new Map(entries.map((entry) => [entry.key, entry.bytes]));
    const building = new Set();
    for (const [index, [sessionId, workspace]] of open.entries()) {
      let patch = { visible: false };
      // From here to the end of the loop is synchronous. That is safe only on a path that has
      // just answered; one that did not gets no item this round.
      if (answers[index] !== 'unknown') {
        try {
          const { root, unsafe } = resolveProjectRoot(workspace);
          if (!unsafe) {
            const key = projectKey(root);
            const status = readStatusFile(path.join(data, 'indexes', key, 'status.json'));
            const off = (!status || status.state === 'empty') && loadProjectConfig(root, { stderr: quiet })?.autoIndex === false;
            const slot = slotFor(status, { projectOff: off, locale: state.locale, root: display(root), bytes: sizes.get(key) ?? 0 });
            if (slot.visible) {
              patch = { text: slot.text, tooltip: slot.tooltip, visible: true };
              if (status?.state === 'building') building.add(sessionId);
            }
          }
        } catch (err) {
          log(`status item: ${err?.message ?? err}`);
        }
      }
      // The session may have closed while its path was being asked.
      if (state.sessions.get(sessionId) !== workspace) continue;
      setSlot(sessionId, patch);
    }
    state.building = building;
  }

  // One paint at a time. With a probe in the middle of it, two could otherwise interleave and
  // the older one bring back the item of a session the newer one had just removed.
  let painting = Promise.resolve();
  const paintOnce = (closed) => {
    const run = painting.then(() => paint(closed));
    painting = run.catch(() => {});
    return run;
  };

  // Counts reads of the session list. A read that comes back after a newer one started carries
  // old news (the host's answer can be older than a change event that arrived meanwhile) and
  // is dropped rather than applied over it.
  let reads = 0;

  async function syncSessions(list) {
    const ticket = ++reads;
    let sessions = list;
    if (sessions === undefined) {
      try {
        sessions = await ctx?.workbench?.visibleSessions?.();
      } catch (err) {
        log(`visible sessions: ${err?.message ?? err}`);
        return;
      }
      if (ticket !== reads) return;
    }
    const seen = new Set(Array.isArray(sessions) ? sessions.map(remember) : []);
    const closed = [...state.sessions.keys()].filter((id) => !seen.has(id));
    for (const id of closed) state.sessions.delete(id);
    await paintOnce(closed);
  }

  // Set once the extension is disposed: a refresh that is already running must not arm the next one.
  let disposed = false;
  const schedule = () => {
    if (disposed) return;
    clearTimeout(state.timer);
    // Nothing in this loop may end in an unhandled rejection: the process is shared, and Node
    // ends it on one.
    state.timer = setTimeout(() => {
      syncSessions().catch((err) => log(`refresh: ${err?.message ?? err}`)).finally(schedule);
    }, state.building.size > 0 ? buildingRefreshMs : idleRefreshMs);
    state.timer.unref?.();
  };

  try {
    ctx?.workbench?.onDidChange?.((change) => {
      if (change && Array.isArray(change.sessions)) syncSessions(change.sessions).catch((err) => log(`sessions: ${err?.message ?? err}`));
    });
  } catch (err) {
    log(`workbench change: ${err?.message ?? err}`);
  }

  // ---------------------------------------------------------- the policy

  async function policy() {
    let user = {};
    try {
      user = (await ctx?.settings?.get?.())?.values ?? {};
    } catch {
      // without settings the file and the defaults decide
    }
    return resolvePolicy({ file: fileSettings(POLICY_KEYS, { file: path.join(data, 'codegraph.json'), stderr: quiet }), user });
  }

  // ------------------------------------------------------------ the view

  const t = () => viewStrings(state.locale);
  const sizeOf = (entries) => viewData(entries, {}, { locale: state.locale }).totals.size;
  const dueFor = (entries, limits, keep) =>
    planSweep(entries, { keep, maxIdleDays: limits.maxIdleDays, maxTotalBytes: limits.maxTotalMB * MB }).remove;

  async function snapshot() {
    const limits = await policy();
    const [entries, current] = await Promise.all([withReachability(listIndexes({ probe: false, data }), pathTimeoutMs), openKeys()]);
    return viewData(entries, limits, { current, locale: state.locale, storeDir: indexesDir(data), due: dueFor(entries, limits, current) });
  }

  // What a tool answers after it changed the store: the message, and the store as it is now.
  // Should the store not be readable just then, no `data` comes along and the page reads it again.
  const done = (message) => snapshot().then((data) => ({ ok: true, message, data }), () => ({ ok: true, message }));
  const failed = (message) => ({ ok: false, message });

  async function removeOne({ key } = {}) {
    if (typeof key !== 'string' || !key) return failed(t().noKey);
    const entries = listIndexes({ probe: false, data });
    const entry = entries.find((item) => item.key === key);
    if (!entry) return failed(t().kept(key, t().unknownKey));
    const project = display(entry.root ?? key);
    if ((await openKeys()).includes(key)) return failed(t().kept(project, t().blocked.current));
    if (entry.inUse) return failed(t().kept(project, t().blocked['in-use']));
    const size = sizeOf([entry]);
    return removeListed(entry, data) ? done(t().removed(project, size)) : failed(t().kept(project, t().keptBusy));
  }

  async function cleanDue() {
    const limits = await policy();
    const [entries, keep] = await Promise.all([withReachability(listIndexes({ probe: false, data }), pathTimeoutMs), openKeys()]);
    const due = dueFor(entries, limits, keep);
    if (due.length === 0) return done(t().nothingDue);
    const removed = [];
    const kept = [];
    for (const [index, entry] of due.entries()) {
      (removeListed(entry, data) ? removed : kept).push(entry);
      // The rest of this shared process gets to run between two deletions.
      if (index < due.length - 1) await new Promise((resolve) => setImmediate(resolve));
    }
    const message = [
      removed.length > 0 ? t().removedN(removed.length, sizeOf(removed)) : null,
      ...kept.map((entry) => t().kept(display(entry.root ?? entry.key), t().keptBusy)),
    ].filter(Boolean).join(' ');
    // Due, and not one of them could be removed: that is a failure to whoever asked for it.
    return { ...(await done(message)), ok: removed.length > 0 };
  }

  async function setPolicy(args = {}) {
    const values = {};
    for (const key of POLICY_KEYS) {
      if (args[key] === undefined) continue;
      if (!isCount(args[key])) return failed(t().failed(`${key} must be a whole number of 0 or more`));
      values[key] = args[key];
    }
    if (Object.keys(values).length === 0) return done('');
    if (typeof ctx?.settings?.update !== 'function') return failed(t().failed('the settings are not available in this host'));
    try {
      await ctx.settings.update({ values });
    } catch (err) {
      return failed(t().failed(err?.message ?? String(err)));
    }
    return done(t().saved);
  }

  // A tool answers; it never throws. What it returns is the page's `structuredContent`.
  const tool = (description, inputSchema, run) => ({
    description,
    inputSchema,
    run: async (args, call) => {
      try {
        return await run(args ?? {}, call);
      } catch (err) {
        log(`view tool: ${err?.message ?? err}`);
        return failed(t().failed(err?.message ?? String(err)));
      }
    },
  });
  const counted = { type: 'integer', minimum: 0 };

  try {
    ctx?.views?.register?.(VIEW_ID, {
      entry: 'ui/index.html',
      tools: {
        list: tool('Every index on this machine, the policy in force and what is due.', { type: 'object', properties: {} }, () =>
          snapshot().then((data) => ({ ok: true, data }))),
        remove: tool('Remove one index. Refused for the project of an open session and for an index in use.', { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] }, removeOne),
        clean: tool('Remove what the policy says is due.', { type: 'object', properties: {} }, cleanDue),
        policy: tool('Set the store policy (idle days, total MB). 0 switches a limit off.', { type: 'object', properties: { maxIdleDays: counted, maxTotalMB: counted } }, setPolicy),
      },
    });
  } catch (err) {
    log(`view: ${err?.message ?? err}`);
  }

  // ---------------------------------------------------------- the command

  try {
    ctx?.commands?.register?.(COMMAND_ID, async () => {
      try {
        await ctx.views.open(VIEW_ID, 'app');
        return { ok: true };
      } catch (err) {
        log(`open view: ${err?.message ?? err}`);
        return { ok: false, message: t().failed(err?.message ?? String(err)) };
      }
    });
  } catch (err) {
    log(`command: ${err?.message ?? err}`);
  }

  await syncSessions();
  schedule();
  return {
    /** Stops the refresh loop: for a test that started one, or a host that shuts the extension down. */
    dispose() {
      disposed = true;
      clearTimeout(state.timer);
    },
  };
}
