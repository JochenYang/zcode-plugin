// Hook behaviour tests (CONTRACTS.md §3, §9; .devflow/codegraph-plugin/zcode-facts.md §5).
// Every case spawns the real entry point with a piped stdin, exactly like the host does,
// so the Windows pipe path (readFileSync(0) until EOF) is exercised too.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirtyLogPath, indexDir, statusPath } from '../../src/paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..', '..');
const HOOK = path.join(PLUGIN_ROOT, 'bin', 'hook.mjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-hooks-'));
const DATA = path.join(TMP, 'data');
const PROJECT = path.join(TMP, 'project', 'nested');
fs.mkdirSync(path.join(PROJECT, '.git'), { recursive: true });
fs.mkdirSync(path.join(PROJECT, 'src'), { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
// In-process copy of what the host injects, so indexDir()/statusPath() resolve for the
// assertions the same way the hook resolves them.
process.env.ZCODE_PLUGIN_DATA = DATA;
delete process.env.ZCODE_PROJECT_DIR;

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const INDEX_DIR = indexDir(PROJECT);
const DIRTY_LOG = dirtyLogPath(PROJECT);
const HOOKS_JSON = path.join(PLUGIN_ROOT, 'hooks', 'hooks.json');
const PLUGIN_JSON = path.join(PLUGIN_ROOT, '.zcode-plugin', 'plugin.json');

const ENV = { ...process.env, ZCODE_PROJECT_DIR: PROJECT, ZCODE_PLUGIN_DATA: DATA };
// The test runner itself may live in a ZCode session: its id must not leak into the hook env.
delete ENV.ZCODE_SESSION_ID;
delete ENV.CLAUDE_SESSION_ID;
delete ENV.CLAUDE_CODE_SESSION_ID;

function run(subcommand, payload, { raw, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK, subcommand], {
      cwd: PROJECT,
      env: { ...ENV, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), 20_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(raw ?? JSON.stringify(payload));
  });
}

function writeStatus(status) {
  fs.mkdirSync(INDEX_DIR, { recursive: true });
  fs.writeFileSync(
    statusPath(PROJECT),
    JSON.stringify({
      schema: 1,
      pluginVersion: '0.1.0',
      root: PROJECT,
      state: 'ready',
      indexedAt: Date.now(),
      filesTotal: 0,
      filesDone: 0,
      symbols: 0,
      languages: {},
      stale: 0,
      error: null,
      ...status,
    }),
  );
}

function removeIndex() {
  fs.rmSync(INDEX_DIR, { recursive: true, force: true });
}

function readDirtyLog() {
  try {
    return fs.readFileSync(DIRTY_LOG, 'utf8');
  } catch {
    return null;
  }
}

function expectSilent(result) {
  assert.equal(result.code, 0, `exit code (stderr: ${result.stderr})`);
  assert.equal(result.stdout, '', 'stdout must stay empty');
}

// The exact shape the host accepts (zcode-facts §5.3): one line, the event-specific
// object only, nothing else at the top level.
function expectContext(result, eventName) {
  assert.equal(result.code, 0, `exit code (stderr: ${result.stderr})`);
  assert.equal(result.stderr, '', 'diagnostics must not leak to stderr');
  assert.equal(result.stdout.trim().split('\n').length, 1, 'exactly one output line');
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(parsed), ['hookSpecificOutput']);
  assert.deepEqual(Object.keys(parsed.hookSpecificOutput).sort(), ['additionalContext', 'hookEventName']);
  assert.equal(parsed.hookSpecificOutput.hookEventName, eventName);
  const context = parsed.hookSpecificOutput.additionalContext;
  assert.equal(typeof context, 'string');
  assert.ok(context.length > 0);
  return context;
}

const estimateTokens = (text) => Math.ceil(Buffer.byteLength(text, 'utf8') / 4);

const START = { hook_event_name: 'SessionStart', source: 'startup', cwd: PROJECT };
const EDIT = (tool_name, file_path) => ({ hook_event_name: 'PostToolUse', tool_name, cwd: PROJECT, tool_input: { file_path } });

test('session-start: ready status yields file count, tool routing and stays within 120 tokens', async () => {
  writeStatus({ filesTotal: 1234, filesDone: 1234, symbols: 5678, languages: { typescript: 900, python: 300, go: 34 } });
  const context = expectContext(await run('session-start', START), 'SessionStart');
  assert.match(context, /Index ready: 1234 files, 5678 symbols \(typescript, python, go\)/);
  assert.match(context, /codegraph_lookup/);
  assert.match(context, /codegraph_map/);
  assert.match(context, /Grep\/Read/);
  assert.doesNotMatch(context, /changed since index/);
  assert.ok(estimateTokens(context) <= 120, `context is ~${estimateTokens(context)} tokens`);
});

test('session-start: stale files are reported so the model knows the graph may lag', async () => {
  writeStatus({ filesTotal: 10, symbols: 20, languages: { go: 10 }, stale: 3 });
  const context = expectContext(await run('session-start', START), 'SessionStart');
  assert.match(context, /3 file\(s\) changed since index; codegraph_status \(refresh=true\) syncs/);
  assert.ok(estimateTokens(context) <= 120);
});

test('session-start: building status reports progress and partial results', async () => {
  writeStatus({ state: 'building', filesTotal: 700, filesDone: 300, symbols: 0 });
  const context = expectContext(await run('session-start', START), 'SessionStart');
  assert.match(context, /Index building in the background: 42% \(300\/700 files\), results partial/);
  assert.match(context, /codegraph_lookup/);
  assert.ok(estimateTokens(context) <= 120);
});

test('session-start: missing status.json means not indexed and says the build starts by itself', async () => {
  removeIndex();
  const context = expectContext(await run('session-start', START), 'SessionStart');
  assert.match(context, /Not indexed: no index for this project yet/);
  assert.match(context, /If it qualifies for auto-indexing/);
  assert.match(context, /at least 30 supported files/);
  assert.match(context, /background build starts by itself with this session/);
  assert.match(context, /next message reports when it is ready; otherwise codegraph_status says why/);
  assert.doesNotMatch(context, /codegraph_lookup|refresh=true/);
  assert.equal(fs.existsSync(INDEX_DIR), false, 'reading status must not create the index dir');
});

test('session-start: index dir without status.json is still not indexed', async () => {
  fs.mkdirSync(INDEX_DIR, { recursive: true });
  const context = expectContext(await run('session-start', START), 'SessionStart');
  assert.match(context, /Not indexed/);
});

test('session-start: empty state names the reason and the config file to change', async () => {
  writeStatus({ state: 'empty', filesTotal: 0, error: 'only 4 supported files (min 30)' });
  const context = expectContext(await run('session-start', START), 'SessionStart');
  assert.match(context, /Not indexed: only 4 supported files \(min 30\)/);
  assert.match(context, /Set autoIndex true or lower minFilesToAutoIndex in .*\/data\/codegraph\.json/);
  assert.match(context, /codegraph_status \(refresh=true\)/);
  assert.ok(estimateTokens(context) <= 120);
});

test('session-start: empty state without error falls back to a generic reason', async () => {
  writeStatus({ state: 'empty', error: null });
  const context = expectContext(await run('session-start', START), 'SessionStart');
  assert.match(context, /Not indexed: auto-index conditions not met/);
});

test('session-start: a project file that switches indexing off is named instead of promising a build', async () => {
  // <root>/.zcode/codegraph.json is the project's own word on indexing; it can only switch it off.
  fs.mkdirSync(path.join(PROJECT, '.zcode'), { recursive: true });
  const file = path.join(PROJECT, '.zcode', 'codegraph.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ autoIndex: false }));
    removeIndex();
    const context = expectContext(await run('session-start', START), 'SessionStart');
    assert.match(context, /Not indexed: auto-indexing is off for this project \(\.zcode\/codegraph\.json\); use Grep\/Read here\./);
    assert.doesNotMatch(context, /background build starts by itself/);
    writeStatus({ state: 'empty' });
    assert.match(expectContext(await run('session-start', START), 'SessionStart'), /auto-indexing is off for this project/);
    // A malformed file is the server's to report; the hook falls back to the usual text.
    fs.writeFileSync(file, '{ "autoIndex": false, ');
    removeIndex();
    assert.match(expectContext(await run('session-start', START), 'SessionStart'), /Not indexed: no index for this project yet/);
    // Switched off by the user instead: the usual text, nothing about a project file.
    fs.rmSync(file);
    const config = path.join(DATA, 'codegraph.json');
    fs.writeFileSync(config, JSON.stringify({ autoIndex: false }));
    try {
      removeIndex();
      assert.match(expectContext(await run('session-start', START), 'SessionStart'), /Not indexed: no index for this project yet/);
    } finally {
      fs.rmSync(config);
    }
  } finally {
    fs.rmSync(path.join(PROJECT, '.zcode'), { recursive: true, force: true });
  }
});

test('session-start: error state surfaces the indexer error, truncated to the budget', async () => {
  writeStatus({ state: 'error', error: `${'boom '.repeat(80)}` });
  const context = expectContext(await run('session-start', START), 'SessionStart');
  assert.match(context, /Index error: boom boom/);
  assert.match(context, /…\. Use Grep\/Read until it is fixed; codegraph_status \(refresh=true\) retries/);
  assert.ok(estimateTokens(context) <= 120);
});

test('session-start: home or drive-root workspaces say they are never auto-indexed', async () => {
  // Point the child's notion of "home" at the temp dir so the workspace (the temp dir
  // itself, no .git inside it) resolves to an unsafe root without touching the real home.
  const home = { USERPROFILE: TMP, HOME: TMP };
  const payload = { ...START, cwd: TMP };
  const context = expectContext(await run('session-start', payload, { env: { ZCODE_PROJECT_DIR: TMP, ...home } }), 'SessionStart');
  assert.match(context, /Not indexed: this folder is a home or drive root and is never auto-indexed; use Grep\/Read/);
});

test('session-start: a workspace ZCode made itself gets no context at all', async () => {
  // The layout ZCode uses for a session that was never opened on a folder: under a `.zcode`
  // directory's `workspace` folder. There is no project to index and nothing to tell the model.
  const host = path.join(TMP, 'zcode-cache', '.zcode', 'workspace', 'draft-62d72d80-6066-4336-88f9-db64d15fef8b');
  fs.mkdirSync(host, { recursive: true });
  for (const cwd of [host, path.join(TMP, 'zcode-cache', '.zcode', 'workspace', 'default')]) {
    const result = await run('session-start', { ...START, cwd }, { env: { ZCODE_PROJECT_DIR: cwd } });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '', cwd);
  }
});

test('session-start: cwd is read from cwd, workingDirectory and working_directory alike', async () => {
  writeStatus({ filesTotal: 7, symbols: 7, languages: { python: 7 } });
  for (const payload of [
    { hook_event_name: 'SessionStart', workingDirectory: PROJECT },
    { hook_event_name: 'SessionStart', working_directory: PROJECT },
    { hook_event_name: 'SessionStart' }, // falls back to ZCODE_PROJECT_DIR from the hook env
    { hook_event_name: 'SessionStart', cwd: 42 }, // non-string counts as absent
  ]) {
    const context = expectContext(await run('session-start', payload), 'SessionStart');
    assert.match(context, /Index ready: 7 files/);
  }
});

test('session-start: empty, malformed or non-object stdin exits 0 silently', async () => {
  writeStatus({ filesTotal: 1, symbols: 1 });
  for (const raw of ['', '   ', '{not json', '[]', '"string"', '42', 'null']) {
    const result = await run('session-start', null, { raw });
    assert.equal(result.code, 0, `raw=${JSON.stringify(raw)}`);
    assert.equal(result.stdout, '', `raw=${JSON.stringify(raw)} must not print`);
  }
});

test('session-start: a payload for another event is ignored (wrong event names fail the hook)', async () => {
  expectSilent(await run('session-start', { ...START, hook_event_name: 'PostToolUse' }));
});

test('post-tool: Edit, Write and ApplyPatch each append one dirty line with forward slashes', async () => {
  removeIndex();
  fs.mkdirSync(INDEX_DIR, { recursive: true });
  const file = path.join(PROJECT, 'src', 'deep', 'a.ts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'export const a = 1;\n');

  const before = Date.now();
  for (const tool of ['Edit', 'Write', 'ApplyPatch']) {
    expectSilent(await run('post-tool', EDIT(tool, file)));
  }
  const log = readDirtyLog();
  assert.ok(log, 'dirty.log is written once the index dir exists');
  const lines = log.split('\n');
  assert.equal(lines.length, 4, 'three entries plus the trailing newline');
  assert.equal(lines[3], '');
  for (const line of lines.slice(0, 3)) {
    const match = /^(\d+)\t(.+)$/.exec(line);
    assert.ok(match, `line shape <mtimeMs>\t<relative path>: ${JSON.stringify(line)}`);
    assert.ok(Number(match[1]) >= before && Number(match[1]) <= Date.now(), 'timestamp is Date.now()');
    assert.equal(match[2], 'src/deep/a.ts', 'relative to the project root, / separated');
  }
});

test('post-tool: relative file paths resolve against the workspace', async () => {
  fs.rmSync(DIRTY_LOG, { force: true });
  expectSilent(await run('post-tool', EDIT('Write', 'src/b.py')));
  assert.match(readDirtyLog(), /^\d+\tsrc\/b\.py\n$/);
});

test('post-tool: Read, Bash, missing file_path and malformed stdin leave dirty.log alone', async () => {
  fs.rmSync(DIRTY_LOG, { force: true });
  for (const payload of [
    EDIT('Read', path.join(PROJECT, 'src', 'a.ts')),
    { hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd: PROJECT, tool_input: { command: 'ls' } },
    EDIT('Write', undefined),
    EDIT('Edit', ''),
    EDIT('Write', 42),
    { hook_event_name: 'PostToolUse', tool_name: 'Write', cwd: PROJECT, tool_input: 'src/a.ts' },
    { hook_event_name: 'PostToolUse', cwd: PROJECT },
  ]) {
    expectSilent(await run('post-tool', payload));
  }
  for (const raw of ['', '{not json', '[]']) {
    expectSilent(await run('post-tool', null, { raw }));
  }
  assert.equal(readDirtyLog(), null, 'nothing was appended');
});

test('post-tool: never creates the index directory', async () => {
  removeIndex();
  expectSilent(await run('post-tool', EDIT('Edit', path.join(PROJECT, 'src', 'a.ts'))));
  assert.equal(fs.existsSync(INDEX_DIR), false);
  assert.equal(fs.existsSync(path.dirname(INDEX_DIR)) && fs.readdirSync(path.dirname(INDEX_DIR)).length, 0, 'no sibling dirs either');
});

test('post-tool: files outside the project root are not logged', async () => {
  fs.mkdirSync(INDEX_DIR, { recursive: true });
  fs.rmSync(DIRTY_LOG, { force: true });
  expectSilent(await run('post-tool', EDIT('Write', path.join(TMP, 'outside.txt'))));
  expectSilent(await run('post-tool', EDIT('Write', path.join(PROJECT, '..', 'sibling.txt'))));
  assert.equal(readDirtyLog(), null);
});

test('hooks.json: parses, uses only known events, and process hooks carry only the allowed fields', () => {
  const config = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8'));
  assert.deepEqual(Object.keys(config), ['hooks']);
  const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'Stop'];
  const PROCESS_KEYS = new Set(['type', 'command', 'args', 'timeoutMs', 'statusMessage', 'enabled', 'onError']);
  for (const event of Object.keys(config.hooks)) {
    assert.ok(EVENTS.includes(event), `unknown event ${event}`);
    for (const group of config.hooks[event]) {
      assert.ok(Array.isArray(group.hooks) && group.hooks.length > 0);
      // No matcher means every prompt / tool call (zcode-facts §5.1).
      assert.ok(group.matcher === undefined || typeof group.matcher === 'string', `${event}: matcher must be a string when present`);
      for (const hook of group.hooks) {
        assert.equal(hook.type, 'process');
        for (const key of Object.keys(hook)) assert.ok(PROCESS_KEYS.has(key), `${event}: ${key} is not a process-hook field`);
        assert.equal(typeof hook.command, 'string');
        assert.ok(hook.command.length > 0);
        assert.ok(Array.isArray(hook.args) && hook.args.every((a) => typeof a === 'string'));
        assert.ok(Number.isInteger(hook.timeoutMs) && hook.timeoutMs > 0);
        assert.ok(hook.statusMessage === undefined || typeof hook.statusMessage === 'string');
        assert.equal(hook.args[0], '${ZCODE_PLUGIN_ROOT}/bin/hook.mjs');
        assert.ok(['session-start', 'user-prompt', 'post-tool'].includes(hook.args[1]));
      }
    }
  }
  assert.equal(config.hooks.SessionStart[0].matcher, '^(startup|resume|clear|compact|fork)$');
  assert.equal(config.hooks.SessionStart[0].hooks[0].args[1], 'session-start');
  assert.equal(config.hooks.SessionStart[0].hooks[0].timeoutMs, 5000);
  assert.equal(config.hooks.PostToolUse[0].matcher, '^(Edit|Write)$');
  assert.equal(config.hooks.PostToolUse[0].hooks[0].args[1], 'post-tool');
  assert.equal(config.hooks.PostToolUse[0].hooks[0].timeoutMs, 3000);
  assert.ok(fs.existsSync(HOOK), 'hooks.json points at an existing entry point');
});

test('plugin.json: every ${user_config.*} reference is declared and no hooks field duplicates hooks.json', () => {
  const manifest = JSON.parse(fs.readFileSync(PLUGIN_JSON, 'utf8'));
  const server = manifest.mcpServers.codegraph;
  const referenced = new Set();
  for (const [key, value] of Object.entries(server.env)) {
    assert.match(key, /^CODEGRAPH_[A-Z_]+$/);
    const match = /^\$\{user_config\.([A-Za-z_]+)\}$/.exec(value);
    assert.ok(match, `${key} must come from user_config, got ${value}`);
    referenced.add(match[1]);
  }
  assert.deepEqual([...referenced].sort(), Object.keys(manifest.userConfig).sort());
  assert.deepEqual(
    Object.keys(server.env).sort(),
    ['CODEGRAPH_AUTO_INDEX', 'CODEGRAPH_EXCLUDE', 'CODEGRAPH_LIFTOFF_ONLY', 'CODEGRAPH_MAX_FILES', 'CODEGRAPH_MAX_IDLE_DAYS', 'CODEGRAPH_MAX_TOTAL_MB', 'CODEGRAPH_MIN_FILES'],
  );
  assert.equal(manifest.userConfig.autoIndex.type, 'boolean');
  assert.equal(manifest.userConfig.liftoffOnly.type, 'boolean');
  assert.equal(manifest.userConfig.minFiles.default, 30);
  assert.equal(manifest.userConfig.maxFiles.default, 30000);
  // The store policy is a pair of settings like the others: a form field or the environment.
  assert.equal(manifest.userConfig.maxIdleDays.type, 'number');
  assert.deepEqual([manifest.userConfig.maxIdleDays.default, manifest.userConfig.maxTotalMB.default], [90, 0]);
  assert.equal(manifest.commands, 'commands');
  assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, manifest.commands, 'codegraph.md')));
  // hooks/hooks.json is loaded by convention; declaring it again in the manifest makes the
  // host warn about a duplicate file (or run the hooks twice for the object form).
  assert.equal('hooks' in manifest, false);
});

test('a ready line that does not fit the budget sheds its least important parts instead of vanishing', async () => {
  // Eight languages and changed files pushed this line past 120 tokens, and the hook then
  // injected nothing: no status, no guidance, right when the project had changed.
  const languages = { typescript: 9000, tsx: 3000, javascript: 2000, swift: 1800, rust: 900, python: 700, csharp: 300, go: 200 };
  writeStatus({ filesTotal: 17830, symbols: 177793, languages, stale: 7 });
  const shed = expectContext(await run('session-start', START), 'SessionStart');
  assert.match(shed, /Index ready: 17830 files, 177793 symbols \(typescript/);
  assert.doesNotMatch(shed, /changed since index/, 'the stale note is the first thing to go');
  assert.match(shed, /codegraph_lookup BEFORE Grep/, 'the guidance stays');
  writeStatus({ filesTotal: 178301234567, symbols: 1234567890123, languages, stale: 7 });
  const big = expectContext(await run('session-start', START), 'SessionStart');
  assert.match(big, /Index ready: 178301234567 files, 1234567890123 symbols \(typescript/);
  assert.match(big, /codegraph_lookup BEFORE Grep/);
});

// user-prompt: the readiness notice for an index that finished after the session started.
describe('user-prompt', () => {
  const READY = { state: 'ready', filesTotal: 10, filesDone: 10, symbols: 5, languages: { typescript: 10 }, stale: 0 };
  const PROMPT = (extra = {}) => ({ hook_event_name: 'UserPromptSubmit', prompt: 'continue', cwd: PROJECT, session_id: 'sess_a', ...extra });
  const marker = (id) => path.join(INDEX_DIR, 'announced', id);

  test('stays silent while there is no index or the build is still running, and without a session id', async () => {
    removeIndex();
    expectSilent(await run('user-prompt', PROMPT()));
    assert.equal(fs.existsSync(INDEX_DIR), false, 'a prompt never creates the index dir');
    writeStatus({ state: 'building', filesTotal: 10, filesDone: 3 });
    expectSilent(await run('user-prompt', PROMPT()));
    writeStatus({ ...READY, state: 'empty', reason: 'too few supported files' });
    expectSilent(await run('user-prompt', PROMPT()));
    // Ready, but the host gave no session id: it could not tell "told" from "not told".
    writeStatus(READY);
    expectSilent(await run('user-prompt', PROMPT({ session_id: undefined })));
    // A session id is a file name: anything but a plain identifier is ignored.
    expectSilent(await run('user-prompt', PROMPT({ session_id: '../escape' })));
    assert.deepEqual(fs.existsSync(path.join(INDEX_DIR, 'announced')), false);
  });

  test('announces a ready index once per session, at the first prompt after it is ready', async () => {
    writeStatus(READY);
    const context = expectContext(await run('user-prompt', PROMPT()), 'UserPromptSubmit');
    assert.match(context, /^\[codegraph\] Index ready: 10 files, 5 symbols \(typescript\)\. /);
    assert.match(context, /codegraph_lookup BEFORE Grep/);
    assert.equal(fs.existsSync(marker('sess_a')), true, 'the session is remembered');
    expectSilent(await run('user-prompt', PROMPT()));
    expectSilent(await run('user-prompt', PROMPT({ prompt: 'and now something else' })));
    expectContext(await run('user-prompt', PROMPT({ session_id: 'sess_b' })), 'UserPromptSubmit');
  });

  test('a session that was told at start that the index is ready is not told again', async () => {
    writeStatus(READY);
    expectContext(await run('session-start', { ...START, session_id: 'sess_c' }), 'SessionStart');
    expectSilent(await run('user-prompt', PROMPT({ session_id: 'sess_c' })));
    // A session that started while the index was still building is told when it is ready.
    removeIndex();
    writeStatus({ state: 'building', filesTotal: 10, filesDone: 1 });
    expectContext(await run('session-start', { ...START, session_id: 'sess_d' }), 'SessionStart');
    writeStatus(READY);
    expectContext(await run('user-prompt', PROMPT({ session_id: 'sess_d' })), 'UserPromptSubmit');
  });

  test('the session id may come from the environment; markers older than a day are pruned', async () => {
    writeStatus(READY);
    expectContext(await run('user-prompt', { hook_event_name: 'UserPromptSubmit', cwd: PROJECT }, { env: { ZCODE_SESSION_ID: 'sess_env' } }), 'UserPromptSubmit');
    expectSilent(await run('user-prompt', { hook_event_name: 'UserPromptSubmit', cwd: PROJECT }, { env: { ZCODE_SESSION_ID: 'sess_env' } }));
    const old = marker('sess_old');
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60_000);
    fs.writeFileSync(old, '', 'utf8');
    fs.utimesSync(old, twoDaysAgo, twoDaysAgo);
    expectContext(await run('user-prompt', PROMPT({ session_id: 'sess_new' })), 'UserPromptSubmit');
    assert.equal(fs.existsSync(old), false, 'a two-day-old marker is removed');
    assert.equal(fs.existsSync(marker('sess_env')), true, 'a fresh marker of another session stays');
  });

  test('a payload for another event is ignored', async () => {
    writeStatus(READY);
    expectSilent(await run('user-prompt', PROMPT({ hook_event_name: 'PostToolUse' })));
  });

  test('a marker that cannot be written never costs the model the context', async () => {
    // A file where the marker directory should be: every write below it fails.
    removeIndex();
    writeStatus(READY);
    fs.writeFileSync(path.join(INDEX_DIR, 'announced'), 'not a directory', 'utf8');
    expectContext(await run('session-start', { ...START, session_id: 'sess_ro' }), 'SessionStart');
    // Not told at start (the session had another id): the prompt hook still speaks.
    expectContext(await run('user-prompt', PROMPT({ session_id: 'sess_ro' })), 'UserPromptSubmit');
    // The marker could not be written, so the notice repeats: harmless, and better than silence.
    expectContext(await run('user-prompt', PROMPT({ session_id: 'sess_ro' })), 'UserPromptSubmit');
  });

  test('an index that holds nothing names the indexer\'s reason code', async () => {
    writeStatus({ state: 'empty', reason: 'below-min-files', error: null });
    const context = expectContext(await run('session-start', START), 'SessionStart');
    assert.match(context, /Not indexed: below-min-files\. /);
  });
});
