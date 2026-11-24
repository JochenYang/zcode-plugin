#!/usr/bin/env node
// Hook entry point: `node bin/hook.mjs <session-start|user-prompt|post-tool>`, payload JSON on stdin.
//
// Contract (CONTRACTS.md §3, .devflow/codegraph-plugin/zcode-facts.md §5):
// - stdout is either empty or one JSON object. Every failure path exits 0 silently: index
//   bookkeeping must never block or fail a session.
// - The hook process has no node fallback (PATH only) and runs without the --liftoff-only
//   supervisor, so it touches only the filesystem and never loads the grammar runtime.
import fs from 'node:fs';
import path from 'node:path';
import { announcedPath, configPath, dirtyLogPath, displayPath, indexDir, resolveProjectRoot, statusPath } from '../src/paths.mjs';
import { loadProjectConfig } from '../src/config.mjs';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'ApplyPatch']);
// `cwd` is the documented field; the camel/snake variants keep the hook working if the host
// renames it. The hook cwd is the session workspace, so process.cwd() is the last resort.
const CWD_KEYS = ['cwd', 'workingDirectory', 'working_directory', 'projectDir', 'project_dir'];
const DEFAULT_MIN_FILES = 30;
// Rough token ceiling for the injected context (same byte/4 estimate as the renderer).
const MAX_CONTEXT_TOKENS = 120;

// Keyed on the kind of task, not on "looking for a name": with the latter wording a model given a
// feature request went straight to `rg` for the concept and never called the graph (T20, 2026-11-24).
const GUIDE =
  'For bug fixes, features and refactors: find code with codegraph_lookup BEFORE Grep or reading files; ' +
  'search finds symbols by name or words, symbol <name> gives the definition, callers and imports (body=true reads it), ' +
  'callers / impact show what a change breaks. Use codegraph_map instead of Glob. Grep/Read only for strings, configs, docs, node_modules.';

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parsePayload(raw) {
  if (!raw || !raw.trim()) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function workspaceOf(payload) {
  for (const key of CWD_KEYS) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  const env = process.env.ZCODE_PROJECT_DIR;
  if (env && env.trim()) return env;
  return process.cwd();
}

// status.json is written with tmp + rename, so a partial file is not expected; a missing or
// unparsable one still means "not indexed" rather than a hook failure.
function readStatus(root) {
  let raw;
  try {
    raw = fs.readFileSync(statusPath(root), 'utf8');
  } catch {
    return null;
  }
  try {
    const status = JSON.parse(raw);
    return status && typeof status === 'object' ? status : null;
  } catch {
    return null;
  }
}

function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function languageList(status) {
  const counts = status.languages && typeof status.languages === 'object' ? status.languages : {};
  const names = Object.keys(counts).sort((a, b) => (Number(counts[b]) || 0) - (Number(counts[a]) || 0));
  if (names.length === 0) return '';
  const shown = names.slice(0, 6);
  return ` (${shown.join(', ')}${names.length > shown.length ? ', …' : ''})`;
}

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// The indexer may put a long message in `error`; an index that holds nothing carries a
// machine-readable `reason` code instead (below-min-files, auto-index-disabled, …).
function reasonOf(status, fallback) {
  const text = [status.error, status.reason].find((value) => typeof value === 'string' && value.trim())?.trim() ?? fallback;
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

// The project's own file (<root>/.zcode/codegraph.json) can switch indexing off. Without
// reading it the hook would promise a background build that never starts. Problems in that
// file are the server's to report; the hook only wants the one answer.
function indexingOffByProject(root) {
  return loadProjectConfig(root, { stderr: { write() {} } })?.autoIndex === false;
}

function describeStatus(status, unsafe, { omitStale = false, omitLanguages = false, projectOff = false } = {}) {
  const offMessage =
    '[codegraph] Not indexed: auto-indexing is off for this project (.zcode/codegraph.json); use Grep/Read here.';
  if (!status) {
    if (unsafe) {
      return '[codegraph] Not indexed: this folder is a home or drive root and is never auto-indexed; use Grep/Read here.';
    }
    if (projectOff) return offMessage;
    return (
      '[codegraph] Not indexed: no index for this project yet. If it qualifies for auto-indexing ' +
      `(autoIndex on and at least ${DEFAULT_MIN_FILES} supported files), a background build starts by itself with this session ` +
      'and the next message reports when it is ready; otherwise codegraph_status says why. Until then use Grep/Read.'
    );
  }
  const state = status.state;
  if (state === 'ready') {
    const stale = count(status.stale);
    return (
      `[codegraph] Index ready: ${count(status.filesTotal)} files, ${count(status.symbols)} symbols${omitLanguages ? '' : languageList(status)}. ` +
      GUIDE +
      (!omitStale && stale > 0 ? ` ${stale} file(s) changed since index; codegraph_status (refresh=true) syncs.` : '')
    );
  }
  if (state === 'building') {
    const total = count(status.filesTotal);
    const done = Math.min(count(status.filesDone), total);
    const percent = total > 0 ? Math.floor((done / total) * 100) : 0;
    return `[codegraph] Index building in the background: ${percent}% (${done}/${total} files), results partial. ${GUIDE}`;
  }
  if (state === 'error') {
    return `[codegraph] Index error: ${reasonOf(status, 'build failed')}. Use Grep/Read until it is fixed; codegraph_status (refresh=true) retries.`;
  }
  // state 'empty' (or anything unknown): the index exists as a record but holds nothing.
  if (projectOff) return offMessage;
  return (
    `[codegraph] Not indexed: ${reasonOf(status, 'auto-index conditions not met')}. ` +
    `Set autoIndex true or lower minFilesToAutoIndex in ${configPath().split(path.sep).join('/')}, ` +
    'then call codegraph_status (refresh=true). Until it reports ready, use Grep/Read.'
  );
}

function emit(value) {
  try {
    fs.writeSync(1, `${JSON.stringify(value)}\n`);
  } catch {
    // stdout closed: nothing to do, the hook still exits 0
  }
}

// The host puts the session id in the payload and in the environment. Without one (older hosts,
// manual runs) the prompt hook stays silent: it could not tell "already told" from "not told".
function sessionIdOf(payload) {
  const raw = payload.session_id ?? payload.sessionId ?? process.env.ZCODE_SESSION_ID;
  return typeof raw === 'string' && /^[\w-]{1,128}$/.test(raw) ? raw : null;
}

function hasAnnounced(root, sessionId) {
  return fs.existsSync(announcedPath(root, sessionId));
}

// Best effort: the marker only de-duplicates the notice, so failing to write it must never cost
// the model the context (the notice then repeats at the next prompt, which is harmless).
function markAnnounced(root, sessionId) {
  try {
    const file = announcedPath(root, sessionId);
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, '', 'utf8');
    // Sessions come and go: drop markers older than a day so the directory does not grow forever.
    const cutoff = Date.now() - 24 * 60 * 60_000;
    for (const name of fs.readdirSync(dir)) {
      const entry = path.join(dir, name);
      try {
        if (fs.statSync(entry).mtimeMs < cutoff) fs.unlinkSync(entry);
      } catch {
        // another hook process may be pruning or creating the same entry
      }
    }
  } catch {
    // read-only data directory, full disk, a file where a directory should be: not this hook's job
  }
}

// The budget is a ceiling, not a veto. A ready line for a big project with changed files used to
// exceed it and then nothing at all was injected, exactly when the model needed the guidance:
// when it does not fit, drop the least important parts in order (the stale note, then the
// language list) and only give up if even that does not fit.
function contextWithinBudget(status, unsafe, projectOff) {
  const fits = (text) => Math.ceil(Buffer.byteLength(text, 'utf8') / 4) <= MAX_CONTEXT_TOKENS;
  for (const options of [{}, { omitStale: true }, { omitStale: true, omitLanguages: true }]) {
    const context = describeStatus(status, unsafe, { ...options, projectOff });
    if (fits(context)) return context;
  }
  return '';
}

// A build that was still running when the session started finishes a few seconds to a minute
// later; nothing else tells the model. Announce it once, at the first prompt after it is ready.
function userPrompt(payload) {
  const event = payload.hook_event_name ?? payload.hookEventName;
  if (event !== undefined && event !== 'UserPromptSubmit') return;
  const sessionId = sessionIdOf(payload);
  if (!sessionId) return;
  const { root, unsafe } = resolveProjectRoot(workspaceOf(payload));
  const status = readStatus(root);
  if (status?.state !== 'ready' || hasAnnounced(root, sessionId)) return;
  const context = contextWithinBudget(status, unsafe);
  if (!context) return;
  emit({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } });
  markAnnounced(root, sessionId);
}

function sessionStart(payload) {
  const event = payload.hook_event_name ?? payload.hookEventName;
  if (event !== undefined && event !== 'SessionStart') return;
  const { root, unsafe } = resolveProjectRoot(workspaceOf(payload));
  const status = readStatus(root);
  const context = contextWithinBudget(status, unsafe, indexingOffByProject(root));
  if (!context) return;
  emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } });
  // This line already tells the model the index is ready: the prompt hook must not repeat it.
  const sessionId = sessionIdOf(payload);
  if (status?.state === 'ready' && sessionId) markAnnounced(root, sessionId);
}

function postTool(payload) {
  if (!EDIT_TOOLS.has(payload.tool_name)) return;
  const input = payload.tool_input;
  const file = input && typeof input === 'object' && !Array.isArray(input) ? input.file_path : null;
  if (typeof file !== 'string' || !file) return;

  const workspace = workspaceOf(payload);
  const { root } = resolveProjectRoot(workspace);
  // No index directory means nothing to mark dirty: the hook never creates it.
  if (!isDirectory(indexDir(root))) return;

  // displayPath keeps relative paths '/'-separated and returns absolute paths for anything
  // outside the root; those are not in the index, so they are skipped.
  const relative = displayPath(root, path.resolve(workspace, file));
  if (!relative || path.isAbsolute(relative)) return;
  // A newline inside a path would forge a second dirty.log line; drop it rather than write it.
  fs.appendFileSync(dirtyLogPath(root), `${Date.now()}\t${relative.replace(/[\r\n]/g, '')}\n`, 'utf8');
}

function main() {
  const [subcommand] = process.argv.slice(2);
  if (subcommand !== 'session-start' && subcommand !== 'user-prompt' && subcommand !== 'post-tool') return;
  const payload = parsePayload(readStdin());
  if (!payload) return;
  if (subcommand === 'session-start') sessionStart(payload);
  else if (subcommand === 'user-prompt') userPrompt(payload);
  else postTool(payload);
}

try {
  main();
} catch {
  // Never surface a failure: a hook error would fail the session for bookkeeping's sake.
}
process.exit(0);
