// Tool schemas and dispatcher for the three MCP tools (CONTRACTS.md §10).
//
// Descriptions are the frozen contract texts. Argument errors raise TypeError
// (the protocol layer turns them into in-band errors); every runtime condition
// — not indexed, building, failing query — is rendered as readable text so the
// model can recover instead of seeing a failed tool.
import fs from 'node:fs';
import path from 'node:path';
import * as graphQueries from '../graph/queries.mjs';
import { scanPropertyReads } from '../graph/propertyReads.mjs';
import * as graphMap from '../graph/map.mjs';
import * as graphStorage from '../index/storage.mjs';
import { DEFAULT_CONFIG, BUDGET_TOKENS_MAX, BUDGET_TOKENS_MIN } from '../config.mjs';
import { displayPath, isInside, projectKey } from '../paths.mjs';
import { dirtyPaths } from '../store/repo.mjs';
import { getContext, resetContext } from './context.mjs';
import * as render from '../render/text.mjs';

export const OPERATIONS = Object.freeze(['search', 'symbol', 'callers', 'callees', 'impact', 'outline', 'cycles', 'affected']);
// What `codegraph_status` may be asked to remove (CONTRACTS.md §10).
export const CLEAN_TARGETS = Object.freeze(['stale', 'all', 'current', 'project']);
export const DEPTH_RANGE = Object.freeze({ min: 1, max: 6, default: 2 });
/** `affected` walks further than `impact` by default: a test usually sits a few imports away. */
export const AFFECTED_DEPTH_DEFAULT = 3;
export const LIMIT_RANGE = Object.freeze({ min: 1, max: 200, default: 20 });
/** Paths `affected` takes in one call: the header lists them all and each one starts a lookup. */
export const FILES_MAX = 50;
export const BUDGET_RANGE = Object.freeze({ min: BUDGET_TOKENS_MIN, max: BUDGET_TOKENS_MAX });
// Bodies larger than this are not read from disk just to be replaced by a Read line.
const MAX_BODY_READ_BYTES = 8 * 1024 * 1024;

const PARAMETER = {
  operation: {
    type: 'string',
    enum: [...OPERATIONS],
    description:
      'search: symbols by name, or the places that use a name no symbol carries; symbol: one symbol with callers/callees/imports; ' +
      'callers/callees: direct relationships; impact: transitive dependents up to depth; outline: symbols of one file in source order; ' +
      'cycles: import cycles among files; affected: the test files that depend on given files.',
  },
  query: {
    type: 'string',
    description:
      'search only: symbol name, prefix, or words in any order ("parse config", "gift card redeem"). ' +
      'When no name holds every word, the longest ones anchor a partial-match search, best match first. ' +
      'When no symbol carries the name, search lists where it is used: calls and type names from the index, and for JS/TS the ' +
      'property reads (obj.field), the object keys ({ field }, also when destructuring), the attribute names of JSX elements and the ' +
      'members of types of that name, found by scanning the source. Variables and parameters and words in strings are not in the ' +
      'graph. Required for search.',
  },
  name: { type: 'string', description: 'symbol/callers/callees/impact only: bare symbol name. Required for those operations.' },
  files: {
    type: 'string',
    description:
      `affected only: "/"-separated paths relative to the workspace root, comma-separated, at most ${FILES_MAX}. Required for affected.`,
  },
  file: {
    type: 'string',
    description:
      'Path relative to the workspace root with "/" separators. Required for outline; optional elsewhere to pick one of several same-named symbols.',
  },
  depth: { type: 'integer', minimum: DEPTH_RANGE.min, maximum: DEPTH_RANGE.max, description: `impact and affected only: relationship hops to follow. impact defaults to ${DEPTH_RANGE.default}, affected to ${AFFECTED_DEPTH_DEFAULT}.` },
  limit: { type: 'integer', minimum: LIMIT_RANGE.min, maximum: LIMIT_RANGE.max, description: `Maximum rows returned; for cycles it is the number of cycles, for affected the test files. Default ${LIMIT_RANGE.default}.` },
  budget: {
    type: 'integer',
    minimum: BUDGET_RANGE.min,
    maximum: BUDGET_RANGE.max,
    description: `Token budget for the result. Default ${DEFAULT_CONFIG.defaultBudgetTokens.lookup}.`,
  },
  body: {
    type: 'boolean',
    description: `symbol only: include the source body (inline when at most ${render.INLINE_BODY_MAX_LINES} lines, otherwise a Read line with offset/limit). Default false.`,
  },
  storage: {
    type: 'boolean',
    description: 'status only: also list every project\'s index on this machine (path, state, size, last use) and the cleanup policy.',
  },
  clean: {
    type: 'string',
    enum: [...CLEAN_TARGETS],
    description:
      'status only: remove indexes. stale = what the policy allows (as when a session opens); all = every index but this project\'s; ' +
      'current = this project\'s (the next call rebuilds it); project = the one named by "project". Nothing goes without confirm=true.',
  },
  project: { type: 'string', description: 'status only, clean=project: path of the project whose index is removed.' },
  confirm: { type: 'boolean', description: 'status only, clean: must be true to remove anything; without it the call only lists what would go.' },
};

export const TOOLS = Object.freeze([
  Object.freeze({
    name: 'codegraph_status',
    description:
      'Code graph index status: ready/building/empty, file and symbol counts, covered languages, stale files. ' +
      'Call it first when unsure whether the graph is usable; refresh=true forces an incremental sync. ' +
      'storage=true lists every project\'s index on this machine; clean removes indexes (only with confirm=true). ' +
      'When the project is not indexed, fall back to Read/Grep.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        refresh: { type: 'boolean', description: 'Force an incremental sync (dirty log + mtime scan) before reporting.' },
        storage: PARAMETER.storage,
        clean: PARAMETER.clean,
        project: PARAMETER.project,
        confirm: PARAMETER.confirm,
      }),
    }),
  }),
  Object.freeze({
    name: 'codegraph_lookup',
    description:
      'Locate symbols and relationships in the code graph. Use this INSTEAD of Grep to find where a function/class/variable is defined, ' +
      'who calls or uses it, what it calls, or what a change impacts. One line per symbol with exact file:line ranges; read only those ranges afterwards. ' +
      'operation=search needs query; symbol/callers/callees/impact need name (add file to disambiguate); outline needs file. ' +
      'cycles lists import cycles; affected lists the test files that depend on given files (files=...). ' +
      'symbol with body=true returns the definition source in the same call. ' +
      'Relations are marked: = import-resolved, ~ unique-name, ? unresolved/dynamic — verify ? with Grep if it matters. ' +
      'Index may lag a few seconds after external edits; codegraph_status reports staleness.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: PARAMETER,
      required: Object.freeze(['operation']),
    }),
  }),
  Object.freeze({
    name: 'codegraph_map',
    description:
      'Repository map: directories -> files -> key symbols, ranked by reference count and cut to a token budget. ' +
      'Use this INSTEAD of Glob plus reading file heads when you need to see what a project or directory contains. Symbols only, no source.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        path: { type: 'string', description: 'Limit the map to this directory or file (relative to the workspace root). Default: whole repository.' },
        budget: {
          type: 'integer',
          minimum: BUDGET_RANGE.min,
          maximum: BUDGET_RANGE.max,
          description: `Token budget for the map. Default ${DEFAULT_CONFIG.defaultBudgetTokens.map}.`,
        },
      }),
    }),
  }),
]);

// ---------- argument validation ----------

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return JSON.stringify(value);
  if (['number', 'bigint', 'boolean'].includes(typeof value)) return String(value);
  return typeof value;
}

const invalid = (tool, field, expectation, value) =>
  new TypeError(`${tool}: "${field}" ${expectation} (got ${describe(value)})`);

function checkString(tool, field, value) {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(tool, field, 'must be a non-empty string', value);
  return value.trim();
}

function checkInteger(tool, field, value, range) {
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    throw invalid(tool, field, `must be an integer between ${range.min} and ${range.max}`, value);
  }
  return value;
}

function checkBoolean(tool, field, value) {
  if (typeof value !== 'boolean') throw invalid(tool, field, 'must be a boolean', value);
  return value;
}

const REQUIRED_BY_OPERATION = Object.freeze({ search: 'query', symbol: 'name', callers: 'name', callees: 'name', impact: 'name', outline: 'file', affected: 'files' });
// Only the parameters a tool declares are validated; anything else is ignored.
const FIELDS_BY_TOOL = Object.freeze({
  codegraph_status: Object.freeze(['refresh', 'storage', 'clean', 'project', 'confirm']),
  codegraph_lookup: Object.freeze(['operation', 'query', 'name', 'files', 'file', 'depth', 'limit', 'budget', 'body']),
  codegraph_map: Object.freeze(['path', 'budget']),
});

function validate(tool, args) {
  if (args === undefined || args === null) return {};
  if (typeof args !== 'object' || Array.isArray(args)) throw invalid(tool, 'arguments', 'must be an object', args);
  const out = {};
  for (const [field, value] of Object.entries(args)) {
    if (value === undefined || !FIELDS_BY_TOOL[tool].includes(field)) continue;
    switch (field) {
      case 'operation':
        if (!OPERATIONS.includes(value)) throw invalid(tool, field, `must be one of ${OPERATIONS.join(', ')}`, value);
        out.operation = value;
        break;
      case 'query':
      case 'name':
      case 'file':
      case 'path':
        out[field] = checkString(tool, field, value);
        break;
      case 'files': {
        // A comma-separated list; each path is normalised against the root in lookupTool.
        const text = checkString(tool, field, value);
        const parts = text.split(',').map((part) => part.trim()).filter(Boolean);
        if (parts.length === 0) throw invalid(tool, field, 'must name at least one path', value);
        if (parts.length > FILES_MAX) throw invalid(tool, field, `must name at most ${FILES_MAX} paths`, value);
        out.files = parts;
        break;
      }
      case 'depth':
        out.depth = checkInteger(tool, field, value, DEPTH_RANGE);
        break;
      case 'limit':
        out.limit = checkInteger(tool, field, value, LIMIT_RANGE);
        break;
      case 'budget':
        out.budget = checkInteger(tool, field, value, BUDGET_RANGE);
        break;
      case 'body':
      case 'refresh':
      case 'storage':
      case 'confirm':
        out[field] = checkBoolean(tool, field, value);
        break;
      case 'clean':
        if (!CLEAN_TARGETS.includes(value)) throw invalid(tool, field, `must be one of ${CLEAN_TARGETS.join(', ')}`, value);
        out.clean = value;
        break;
      case 'project':
        out.project = checkString(tool, field, value);
        break;
      default:
        break; // unknown keys are ignored: the schema documents what is used
    }
  }
  if (tool === 'codegraph_lookup') {
    if (out.operation === undefined) throw invalid(tool, 'operation', 'is required', undefined);
    const needed = REQUIRED_BY_OPERATION[out.operation];
    if (needed && !out[needed]) throw new TypeError(`${tool}: operation=${out.operation} requires "${needed}"`);
  }
  return out;
}

// ---------- graph module resolution ----------

/** Which graph modules a context uses; the real modules unless the context overrides them. */
export function resolveGraph(context) {
  return { queries: context.queries ?? graphQueries, map: context.map ?? graphMap };
}

// ---------- dispatch ----------

/**
 * Run one tool. `ctx` defaults to the process context (getContext()); tests
 * pass a fake `{ root, config, indexer, db, queries?, map? }`.
 *
 * @returns {Promise<{ content: { type: 'text', text: string }[] }>}
 */
export async function callTool(name, args, ctx) {
  if (!TOOLS.some((t) => t.name === name)) throw new TypeError(`callTool: unknown tool ${describe(name)}`);
  const params = validate(name, args);
  // An injected context belongs to the caller; only the process context may be rebuilt by a tool.
  const owned = ctx === undefined || ctx === null;
  const context = await (ctx ?? getContext());
  switch (name) {
    case 'codegraph_status':
      return statusTool(params, context, owned);
    case 'codegraph_lookup':
      return lookupTool(params, context);
    default:
      return mapTool(params, context);
  }
}

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const message = (err) => String(err?.message ?? err).replace(/\s+/g, ' ').trim();
const count = (value) => (Number.isFinite(value) ? Math.trunc(value) : 0);
const head = (rows, n) => (Array.isArray(rows) ? rows.slice(0, n) : []);
const quote = (s) => (/\s/.test(s) ? JSON.stringify(s) : s);

// Every tool syncs first (CONTRACTS.md §9: the server is the source of
// freshness) and then reads the status for the header. A sync failure does not
// abort the call — the query still runs on whatever is indexed — but is
// reported in the freshness segment.
// With indexing switched off (by the user, or by the project's own file) only a
// call that asks for a refresh touches the index; the others answer from what is stored.
async function prepare(context, { refresh = false } = {}) {
  const indexer = context.indexer;
  let syncError = null;
  const off = context.config?.autoIndex === false;
  if ((!off || refresh) && typeof indexer?.ensureFresh === 'function') {
    try {
      // `force` asks the indexer to skip its mtime-scan throttle (contract request).
      // The usage stamp tells the store this index is in use (src/index/storage.mjs).
      graphStorage.touchUsage(context.root);
      await indexer.ensureFresh(refresh ? { maxWaitMs: 3000, force: true } : undefined);
    } catch (err) {
      syncError = err;
    }
  }
  let status = null;
  if (typeof indexer?.status === 'function') {
    try {
      status = await indexer.status();
    } catch (err) {
      syncError ??= err;
    }
  }
  return { status, syncError, off };
}

function freshnessText(status, syncError, { off = false, refreshed = false } = {}) {
  const parts = [render.freshnessLabel(status)];
  if (off && !refreshed) parts.push('not synced: auto-indexing is off, refresh=true syncs');
  if (syncError) parts.push(`sync failed: ${message(syncError)}`);
  return parts.join(' · ');
}

function budgetOf(context, value, kind) {
  const fromConfig = context.config?.defaultBudgetTokens?.[kind];
  const chosen = value ?? (Number.isInteger(fromConfig) ? fromConfig : DEFAULT_CONFIG.defaultBudgetTokens[kind]);
  return Math.min(BUDGET_RANGE.max, Math.max(BUDGET_RANGE.min, chosen));
}

// The files a result names that are still waiting for a re-index (CONTRACTS.md §11): at most
// three paths plus the count of the rest. The header already says how many files changed; this
// is the part the model can act on (Read them). Nothing is read from the dirty table when the
// status says the index is clean, and no line is drawn without a path in common with the result.
function staleOf(context, status, paths) {
  if (!(count(status?.dirty) > 0)) return null;
  const named = [...new Set(paths.filter((p) => typeof p === 'string' && p.length > 0))];
  if (named.length === 0) return null;
  const dirty = dirtyPaths(context.db, named);
  const hit = named.filter((path) => dirty.has(path));
  if (hit.length === 0) return null;
  return { paths: hit.slice(0, 3), more: Math.max(0, hit.length - 3) };
}

function notice(operation, args, summary, hint, freshness = '') {
  return text(render.renderNotice({ operation, args, summary, hint, freshness }));
}

// Paths reach the index as '/'-separated and relative to the root; accept the
// native separator and absolute paths inside the workspace as well.
function normalizePath(root, value) {
  if (value === undefined) return undefined;
  let p = path.isAbsolute(value) ? displayPath(root, value) : value;
  if (process.platform === 'win32') p = p.split('\\').join('/');
  return p.replace(/^\.\//, '').replace(/^\/+/, '');
}

const storageOf = (context) => {
  const storage = context.storage ?? graphStorage;
  const config = context.config ?? {};
  const idle = Number(config.maxIdleDays) > 0 ? `indexes unused for more than ${config.maxIdleDays} days are removed when a session opens` : 'indexes are never removed for being unused';
  const quota = Number(config.maxTotalMB) > 0 ? `the least recently used go above ${config.maxTotalMB} MB in total` : 'there is no size limit';
  return {
    entries: storage.listIndexes(),
    dir: storage.indexesDir().split(path.sep).join('/'),
    policy: `${idle}; ${quota}; an index whose project folder is gone goes by the same age rule`,
  };
};

// Fold a project path the way the store compares them (separators, trailing slash, case on Windows).
function foldPath(value) {
  const folded = String(value).trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? folded.toLowerCase() : folded;
}

/**
 * `clean`: remove indexes on request. Without `confirm: true` nothing is deleted; the call
 * lists what would go, so the model can show it and ask first.
 */
async function cleanTool(p, context, owned) {
  const storage = context.storage ?? graphStorage;
  const config = context.config ?? {};
  const current = projectKey(context.root);
  const entries = storage.listIndexes();
  const target = p.clean;
  let remove = [];
  if (target === 'current') {
    // Closing the indexer waits for a build in flight (a minute or more on a large project),
    // and the index would only be deleted when it is finished: refuse instead of hanging.
    const live = typeof context.indexer?.status === 'function' ? context.indexer.status() : null;
    if (live?.building === true) {
      return text(`# status clean=current\nthe index of this project is being built in this session (${count(live.filesDone)} of ${count(live.filesTotal)} files); call again once codegraph_status says ready`);
    }
    const mine = entries.find((entry) => entry.key === current);
    if (mine) remove = [{ ...mine, reason: 'requested' }];
  } else if (target === 'project') {
    const wanted = foldPath(p.project ?? '');
    const hit = entries.find((entry) => entry.key === wanted || (entry.root && foldPath(entry.root) === wanted));
    if (!hit) {
      return text(`# status clean=project\nno index of ${JSON.stringify(String(p.project ?? ''))} in this store; codegraph_status (storage=true) lists them`);
    }
    if (hit.key === current) return text(`# status clean=project\n${JSON.stringify(String(p.project ?? ''))} is the project of this session: use clean="current"`);
    remove = [{ ...hit, reason: 'requested' }];
  } else {
    remove = storage.planSweep(entries, {
      keep: [current],
      all: target === 'all',
      maxIdleDays: config.maxIdleDays ?? 0,
      maxTotalBytes: (config.maxTotalMB ?? 0) * 1024 * 1024,
    }).remove;
  }
  const input = { target, remove, total: entries.length, done: false };
  // An index a live process holds is never a candidate; for "all" and "stale" the user should
  // still see that it exists and why it stayed.
  const held = entries.filter((entry) => entry.inUse && entry.key !== current);
  if (p.confirm !== true) return text(render.renderClean({ ...input, busy: target === 'all' || target === 'stale' ? held : [] }));

  const removed = [];
  const busy = [];
  for (const entry of remove) {
    try {
      // This session's own index: close the handle first, or Windows keeps the files locked.
      if (entry.key === current) await context.indexer?.close?.();
      (storage.removeListed(entry) ? removed : busy).push(entry);
    } catch (err) {
      busy.push({ ...entry, error: err?.code ?? String(err?.message ?? err) });
      process.stderr.write(`codegraph: could not remove the index of ${entry.root ?? entry.key} (${err?.message ?? err})\n`);
    }
  }
  // The process context held the closed indexer: the next call has to build a new one.
  if (owned && removed.some((entry) => entry.key === current)) await resetContext();
  return text(render.renderClean({ ...input, removed, busy: [...held, ...busy], done: true }));
}

async function statusTool(p, context, owned = false) {
  if (p.clean !== undefined) return cleanTool(p, context, owned);
  const refresh = p.refresh === true;
  const { status, syncError, off } = await prepare(context, { refresh });
  // Who switched indexing off decides where the user is told to turn it back on.
  const offBy = off ? context.config.autoIndexOffBy ?? 'config' : null;
  const meta = { refresh, syncError, offBy };
  if (p.storage === true) meta.storage = storageOf(context);
  return text(render.renderStatus(status, meta));
}

async function lookupTool(p, context) {
  const { status, syncError, off } = await prepare(context);
  const freshness = freshnessText(status, syncError, { off });
  const budget = budgetOf(context, p.budget, 'lookup');
  const { operation } = p;
  const file = normalizePath(context.root, p.file);
  // `affected` names files, not one symbol, and its list reads better unquoted; a path named
  // twice is asked about once (the query dedupes too; the header echoes what is asked).
  const affectedFiles = operation === 'affected'
    ? [...new Set((p.files ?? []).map((value) => normalizePath(context.root, value)))]
    : null;
  const args = operation === 'search'
    ? quote(p.query)
    : operation === 'outline'
      ? quote(file)
      : operation === 'affected'
        ? affectedFiles.join(', ')
        : quote([p.name, file].filter(Boolean).join(' '));
  if (status?.state === 'empty') {
    return notice(operation, args, 'not indexed', 'project is not indexed; use Read/Grep for now. codegraph_status explains why.');
  }
  const { queries } = resolveGraph(context);
  const { db } = context;
  const limit = p.limit ?? LIMIT_RANGE.default;
  const meta = { budget, freshness };
  try {
    switch (operation) {
      case 'search': {
        // A name that is only read as a property (`row.membershipKind`) is not in the index. When
        // no symbol carries the name — the symbol search alone tells — the JS/TS source is
        // scanned for it, in a worker, so this process keeps answering; the one `search` below
        // then has both sources.
        const ask = { query: p.query, kind: null, limit: limit + 1 };
        const info = {};
        const scan = queries.searchIsPartial(db, ask)
          ? await scanPropertyReads({ root: context.root, db, query: p.query, maxFileBytes: context.config.maxFileBytes })
          : null;
        const rows = queries.search(db, ask, info, scan ? { propertyReads: () => scan } : undefined);
        const shown = head(rows, limit);
        return text(render.renderSearch(shown, {
          ...meta, query: p.query, more: rows.length > limit, ...info, stale: staleOf(context, status, shown.map((row) => row.path)),
        }));
      }
      case 'symbol': {
        const result = queries.symbol(db, { name: p.name, path: file, qual: undefined });
        const body = p.body && result?.symbol ? readBody(context.root, result.symbol) : null;
        const mentioned = result
          ? [result.symbol?.path, ...(result.callers ?? []).map((row) => row.path), ...(result.callees ?? []).map((row) => row.path)]
          : [];
        return text(render.renderSymbol(result, { ...meta, name: p.name, file, body, stale: staleOf(context, status, mentioned) }));
      }
      case 'callers':
      case 'callees': {
        const rows = queries[operation](db, { name: p.name, path: file, limit: limit + 1 });
        const shown = head(rows, limit);
        const out = { ...meta, name: p.name, file, more: rows.length > limit, stale: staleOf(context, status, shown.map((row) => row.path)) };
        return text(operation === 'callers' ? render.renderCallers(shown, out) : render.renderCallees(shown, out));
      }
      case 'impact': {
        const depth = p.depth ?? DEPTH_RANGE.default;
        const result = queries.impact(db, { name: p.name, path: file, depth });
        const nodes = Array.isArray(result?.nodes) ? result.nodes : [];
        const shown = head(nodes, limit);
        return text(
          render.renderImpact(
            { ...result, nodes: shown },
            { ...meta, name: p.name, file, depth, more: nodes.length > limit, stale: staleOf(context, status, shown.map((node) => node.path)) },
          ),
        );
      }
      case 'outline': {
        const rows = queries.outline(db, { path: file });
        return text(render.renderOutline(rows, { ...meta, file, stale: staleOf(context, status, [file]) }));
      }
      case 'cycles': {
        // `limit` is the number of cycles; the query reports `total`, so the renderer can show
        // "(N of M shown)" without asking for one more.
        return text(render.renderCycles(queries.importCycles(db, { limit }), meta));
      }
      case 'affected': {
        const depth = p.depth ?? AFFECTED_DEPTH_DEFAULT;
        // One more test file than asked for, the same probe the other row lists use.
        const result = queries.affectedTests(db, { files: affectedFiles, depth, limit: limit + 1 });
        const shown = head(result.tests, limit);
        return text(
          render.renderAffected(
            { ...result, tests: shown },
            { ...meta, files: affectedFiles, depth, more: result.tests.length > limit },
          ),
        );
      }
      default:
        throw invalid('codegraph_lookup', 'operation', `must be one of ${OPERATIONS.join(', ')}`, p.operation);
    }
  } catch (err) {
    return notice(operation, args, 'query failed', `the index could not be queried (${message(err)}); codegraph_status reports the index state.`, freshness);
  }
}

async function mapTool(p, context) {
  const { status, syncError, off } = await prepare(context);
  const freshness = freshnessText(status, syncError, { off });
  const budget = budgetOf(context, p.budget, 'map');
  const target = normalizePath(context.root, p.path);
  if (status?.state === 'empty') {
    return notice('map', quote(target ?? ''), 'not indexed', 'project is not indexed; use Glob/Read for now. codegraph_status explains why.');
  }
  const { map } = resolveGraph(context);
  try {
    const result = map.repoMap(context.db, { path: target, budgetTokens: budget });
    return text(render.renderMap(result, { path: target, budget, freshness }));
  } catch (err) {
    return notice('map', quote(target ?? ''), 'query failed', `the index could not be queried (${message(err)}); codegraph_status reports the index state.`, freshness);
  }
}

// Source body for operation=symbol: `{ lines }` when it can be inlined,
// `{ lineCount }` when only the Read line is needed, `{ error }` when unreadable.
function readBody(root, symbol) {
  const rel = String(symbol.path ?? '');
  const start = symbol.startLine ?? symbol.start_line;
  const end = symbol.endLine ?? symbol.end_line;
  const lineCount = Number.isInteger(start) && Number.isInteger(end) ? end - start + 1 : 0;
  if (!Number.isInteger(start) || lineCount < 1) return { error: 'symbol has no line range in the index' };
  if (lineCount > render.INLINE_BODY_MAX_LINES) return { lineCount };
  const abs = path.resolve(root, rel);
  if (!isInside(root, abs)) return { error: `path is outside the workspace: ${rel}` };
  try {
    if (fs.statSync(abs).size > MAX_BODY_READ_BYTES) return { lineCount };
    const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/).slice(start - 1, end);
    return { lines };
  } catch (err) {
    return { error: `cannot read ${rel} (${err?.code ?? message(err)}); the index may be stale` };
  }
}
