// Minimal MCP server over stdio: newline-delimited JSON-RPC 2.0 (CONTRACTS.md §10).
// `handleLine` is pure so protocol behaviour is unit-testable without spawning; the one side
// effect, indexing at session start, is injected as `onStart` and absent unless `serve()` wires it.
import { createInterface } from 'node:readline';
import { PLUGIN_VERSION } from '../version.mjs';
import { TOOLS, callTool } from './tools.mjs';
import { INSTRUCTIONS } from './instructions.mjs';

const ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
};

// `onStart` runs when the client completes the handshake: the place to begin indexing for the
// session without waiting for the model's first tool call. It is never awaited and a failure
// only reaches stderr.
export function createServer({ tools = TOOLS, onCall = callTool, instructions = INSTRUCTIONS, onStart = null } = {}) {
  const reply = (id, result) => (id === undefined ? null : JSON.stringify({ jsonrpc: '2.0', id, result }));
  // Errors always answer, with id null when the id could not be detected (JSON-RPC 2.0 §4).
  // Notifications are filtered by the callers so they never produce a response.
  const fail = (id, code, message, data) =>
    JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: data === undefined ? { code, message } : { code, message, data } });

  async function handleLine(line) {
    const text = String(line ?? '').trim();
    if (!text) return null;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return fail(null, ERROR_CODES.PARSE_ERROR, 'Parse error');
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.method !== 'string') {
      return fail(msg?.id, ERROR_CODES.INVALID_REQUEST, 'Invalid Request');
    }
    const { id, method } = msg;
    const params = msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params) ? msg.params : {};
    const isNotification = id === undefined;
    try {
      switch (method) {
        case 'initialize': {
          if (typeof onStart === 'function') {
            try {
              const started = onStart();
              started?.catch?.((err) => process.stderr.write(`codegraph: indexing at session start failed (${err?.message ?? err})\n`));
            } catch (err) {
              process.stderr.write(`codegraph: indexing at session start failed (${err?.message ?? err})\n`);
            }
          }
          return reply(id, {
            protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'codegraph', version: PLUGIN_VERSION },
            instructions,
          });
        }
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return null;
        case 'ping':
          return reply(id, {});
        case 'tools/list':
          return reply(id, { tools });
        case 'tools/call': {
          const name = params.name;
          const args = params.arguments ?? {};
          if (isNotification) return null;
          if (typeof name !== 'string' || !tools.some((t) => t.name === name)) {
            return fail(id, ERROR_CODES.INVALID_PARAMS, `Unknown tool: ${String(name)}`);
          }
          try {
            const result = await onCall(name, args);
            return reply(id, result);
          } catch (err) {
            // Tool failures are reported in-band so the model can recover, per MCP convention.
            return reply(id, { content: [{ type: 'text', text: `codegraph error: ${err?.message ?? err}` }], isError: true });
          }
        }
        default:
          return isNotification ? null : fail(id, ERROR_CODES.METHOD_NOT_FOUND, `Method not found: ${method}`);
      }
    } catch (err) {
      return isNotification ? null : fail(id, ERROR_CODES.INTERNAL, err?.message ?? 'Internal error');
    }
  }

  return { handleLine, tools };
}

// A new project gets its first build, and an indexed project its incremental sync, when the
// session opens. Left to the model's first tool call, a new project might never be indexed: the
// SessionStart hook tells the model of an unindexed project to use Grep/Read until the index is
// ready, and a model that obeys never calls a tool. Only this per-session process can start a
// build that outlives the call, because hooks are short-lived processes.
//
// The same moment tidies the index store (src/index/storage.mjs): stamps this project's index
// as in use, then removes what the policy allows — indexes of projects that no longer exist,
// of projects not opened for `maxIdleDays`, and the least recently used ones while the store
// is over `maxTotalMB`.
async function silentIndexStart() {
  // A home or drive root is never indexed: decide that before anything opens a database there.
  const [{ resolveProjectRoot, projectKey }, { loadConfig, loadProjectConfig }] = await Promise.all([import('../paths.mjs'), import('../config.mjs')]);
  const start = (process.env.ZCODE_PROJECT_DIR ?? '').trim() || process.cwd();
  const { root, unsafe } = resolveProjectRoot(start);
  if (unsafe) return;
  // Read silently: the context below reads the same files again and reports what is wrong with them once.
  const quiet = { write() {} };
  const config = loadConfig({ project: loadProjectConfig(root, { stderr: quiet }), stderr: quiet });
  // autoIndex off means "only a manual refresh touches the index" (the plugin's own wording):
  // then nothing happens by itself here, the store included.
  if (config.autoIndex === false) return;
  const { getContext } = await import('./context.mjs');
  const { indexer } = await getContext();
  if (typeof indexer?.ensureFresh !== 'function') return;
  // 1 ms, not 0. `ensureFresh` chains its callers, and with 0 it holds the chain until the whole
  // sweep has run, so a tool call that arrived during the sweep lost its 3 s bound. With 1 ms
  // the chain is released at once and the sweep (and any build it starts) goes on in the
  // background.
  await indexer.ensureFresh({ maxWaitMs: 1 });
  const { touchUsage, sweepIndexes } = await import('../index/storage.mjs');
  touchUsage(root);
  const { removed, busy } = sweepIndexes({ keep: [projectKey(root)], maxIdleDays: config.maxIdleDays, maxTotalBytes: config.maxTotalMB * 1024 * 1024 });
  for (const entry of removed) process.stderr.write(`codegraph: removed the index of ${entry.root ?? entry.key} (${entry.reason}, ${entry.bytes} bytes)\n`);
  for (const entry of busy) process.stderr.write(`codegraph: index of ${entry.root ?? entry.key} is in use and was kept\n`);
}

// Wire the pure handler to stdin/stdout. stdout is protocol-only; diagnostics go to stderr.
// Tool calls are serialised (one index, one writer); ping and notifications bypass the queue
// so a slow tool never blocks the client's liveness checks.
export function serve({ input = process.stdin, output = process.stdout, options = {} } = {}) {
  const server = createServer({ ...options, onStart: options.onStart ?? silentIndexStart });
  const rl = createInterface({ input, crlfDelay: Infinity });
  const write = (s) => s !== null && output.write(`${s}\n`);
  let chain = Promise.resolve();
  rl.on('line', (line) => {
    let bypass = false;
    try {
      const msg = JSON.parse(line);
      bypass = typeof msg?.method === 'string' && (msg.method === 'ping' || msg.id === undefined);
    } catch {
      bypass = false;
    }
    const run = () => server.handleLine(line).then(write).catch((err) => process.stderr.write(`codegraph: ${err?.stack ?? err}\n`));
    if (bypass) run();
    else chain = chain.then(run, run);
  });
  return server;
}
