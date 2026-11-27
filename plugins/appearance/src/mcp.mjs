// Minimal MCP server: newline-delimited JSON-RPC 2.0. `handleLine` is pure so the protocol is
// unit-testable without spawning a process; `serve` wires it to stdio.
//
// Two tools read and write the appearance config. They never touch ZCode themselves: the
// launcher is a separate process that reads the same file and applies it to the running app, so
// a tool call is safe whatever the app is doing, and works the same whether or not the launcher
// is running (the settings are saved either way; they show the next time ZCode is started from
// the launcher).
import { createInterface } from 'node:readline';
import { applyPatch, BLUR_MAX, loadConfig, MASK_MAX, MASK_MIN, saveConfig, SCOPES } from './config.mjs';
import { paths } from './paths.mjs';
import { SKIN_NAMES } from './skins.mjs';
import { launcherState } from './status.mjs';
import { PLUGIN_VERSION } from './version.mjs';

const ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
};

const COLOURS = ['base', 'surface', 'text', 'accent', 'border'];
const colourProperties = Object.fromEntries(COLOURS.map((name) => [name, { type: 'string', description: `${name} colour, like #14181f` }]));
const colourSet = {
  type: 'object',
  properties: colourProperties,
  additionalProperties: false,
  description: 'Five hex colours: base (window), surface (cards, panels), text, accent (links, primary action), border.',
};

export const TOOLS = [
  {
    name: 'get_appearance',
    description:
      'Read the ZCode appearance settings (background pictures or videos, scope, tint, blur, rotation, colour skin), the config file they live in, and whether the launcher that applies them is running.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'set_appearance',
    description:
      'Change the ZCode appearance settings. Pass only what changes; anything left out keeps its value. The running launcher applies the change within a moment without restarting ZCode. Returns the resulting settings, the config path and the launcher state.',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'Show the background, or hide it without removing the settings.' },
        setMedia: {
          type: 'array',
          items: { type: 'string' },
          description: 'Replace the list of background files with these. Paths may be absolute, start with ~, or be relative to the workspace. Pictures: png, jpg, jpeg, webp, gif, bmp, avif. Videos (whole page only): mp4, webm.',
        },
        addMedia: { type: 'array', items: { type: 'string' }, description: 'Add these files to the end of the list (duplicates are skipped).' },
        removeMedia: {
          type: 'array',
          items: { type: ['string', 'integer'] },
          description: 'Remove files: their paths, or their 1-based positions in the current list.',
        },
        scope: { type: 'string', enum: SCOPES, description: 'page = behind the whole window; chat = the conversation area only (pictures only: a video is an element and cannot paint the conversation area).' },
        mask: {
          type: 'number',
          minimum: MASK_MIN,
          maximum: MASK_MAX,
          description: 'How much of the theme background colour is laid over the background, 0 to 1. Higher is easier to read: about 0.7 for a busy picture, 0.3 for a calm one.',
        },
        blur: { type: 'integer', minimum: 0, maximum: BLUR_MAX, description: 'Blur of the background in pixels (page scope only). 0 = sharp.' },
        rotateMinutes: { type: 'integer', minimum: 0, description: 'Move to the next file every N minutes; 0 = never.' },
        skin: {
          type: 'string',
          enum: SKIN_NAMES,
          description: `Colour skin preset. ${SKIN_NAMES.filter((name) => name !== 'default').map((name) => `"${name}"`).join(', ')} replace the base, surface, text, accent and border colours in both light and dark mode; "default" keeps the app's own colours, or the custom ones when customSkin is set.`,
        },
        customSkin: {
          type: ['object', 'null'],
          properties: { light: colourSet, dark: colourSet },
          additionalProperties: false,
          description: 'An own skin, used while skin is "default": { "light": { ... }, "dark": { ... } }, either mode optional. null clears it.',
        },
      },
      additionalProperties: false,
    },
  },
];

// What the model reads back: one headline with what matters most, one line per subject, then
// what to do about it if something is missing.
export function describe(config, { file, exists, changed, status = launcherState(paths().status) }) {
  const { background, skin } = config;
  const lines = [
    `# appearance${changed ? ' · saved' : exists ? '' : ' · defaults, no config file yet'} · ${file} · launcher ${status.running ? `running (port ${status.port})` : 'not running'}`,
    `background: ${background.enabled ? 'on' : 'off'} · scope ${background.scope} · mask ${background.mask} · blur ${background.blur}px · rotate every ${background.rotateMinutes} min`,
  ];
  if (background.media.length) {
    lines.push(`media (${background.media.length}):`);
    background.media.forEach((file, index) => lines.push(`  ${index + 1}. ${file}`));
  } else {
    lines.push('media: none set yet');
  }
  lines.push(`skin: ${skin.preset}${skin.custom ? ' + custom' : ''}`);
  if (background.enabled && !background.media.length) lines.push('next: set a picture or video with setMedia before anything can show.');
  if (!status.running) lines.push('next: the launcher is not running, so this shows the next time ZCode is started from it (quit ZCode completely first).');
  return lines.join('\n');
}

export async function callTool(name, args, { file = paths().config, cwd = process.cwd(), status } = {}) {
  const loaded = loadConfig({ file, cwd });
  if (name === 'get_appearance') {
    return { content: [{ type: 'text', text: describe(loaded.config, { file, exists: loaded.exists, changed: false, status }) }] };
  }
  const next = applyPatch(loaded.config, args ?? {}, { cwd });
  saveConfig(next, { file });
  return { content: [{ type: 'text', text: describe(next, { file, exists: true, changed: true, status }) }] };
}

export function createServer({ tools = TOOLS, onCall = callTool } = {}) {
  const reply = (id, result) => (id === undefined ? null : JSON.stringify({ jsonrpc: '2.0', id, result }));
  // Errors always answer, with id null when the id could not be detected (JSON-RPC 2.0 §4).
  // Notifications are filtered by the callers so they never produce a response.
  const fail = (id, code, message) => JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  async function handleLine(line) {
    const text = String(line ?? '').trim();
    if (!text) return null;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return fail(null, ERROR_CODES.PARSE_ERROR, 'Parse error');
    }
    if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.method !== 'string') {
      return fail(message?.id, ERROR_CODES.INVALID_REQUEST, 'Invalid Request');
    }
    const { id, method } = message;
    const params = message.params && typeof message.params === 'object' && !Array.isArray(message.params) ? message.params : {};
    const isNotification = id === undefined;
    try {
      switch (method) {
        case 'initialize':
          return reply(id, {
            protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'appearance', version: PLUGIN_VERSION },
          });
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return null;
        case 'ping':
          return reply(id, {});
        case 'tools/list':
          return reply(id, { tools });
        case 'tools/call': {
          if (isNotification) return null;
          const name = params.name;
          if (typeof name !== 'string' || !tools.some((tool) => tool.name === name)) {
            return fail(id, ERROR_CODES.INVALID_PARAMS, `Unknown tool: ${String(name)}`);
          }
          try {
            return reply(id, await onCall(name, params.arguments ?? {}));
          } catch (err) {
            // Tool failures are reported in-band so the model can recover, per MCP convention.
            return reply(id, { content: [{ type: 'text', text: `appearance error: ${err?.message ?? err}` }], isError: true });
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

// stdout is protocol-only; diagnostics go to stderr. Calls are serialised because each one
// reads and writes the same file; ping and notifications bypass the queue so a slow call never
// blocks the client's liveness checks.
export function serve({ input = process.stdin, output = process.stdout, options = {} } = {}) {
  const server = createServer(options);
  const rl = createInterface({ input, crlfDelay: Infinity });
  const write = (text) => text !== null && output.write(`${text}\n`);
  let chain = Promise.resolve();
  rl.on('line', (line) => {
    let bypass = false;
    try {
      const message = JSON.parse(line);
      bypass = typeof message?.method === 'string' && (message.method === 'ping' || message.id === undefined);
    } catch {
      bypass = false;
    }
    const run = () => server.handleLine(line).then(write).catch((err) => process.stderr.write(`appearance: ${err?.stack ?? err}\n`));
    if (bypass) run();
    else chain = chain.then(run, run);
  });
  return server;
}
